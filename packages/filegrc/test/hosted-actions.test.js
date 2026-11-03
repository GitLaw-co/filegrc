import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";
import { applyPendingDecisions, actionFilters, filterActions } from "../src/action-register.js";
import { runCli } from "../src/cli.js";
import { signSession } from "../src/hosted-auth.js";
import { serveWorkspace } from "../src/server.js";
import { APP_SCRIPT } from "../src/web.js";
import { loadWorkspace } from "../src/workspace.js";
import { makeComprehensiveWorkspace } from "./fixtures.js";
import { captureCli } from "./helpers.js";

const execute = promisify(execFile);
const SESSION_SECRET = "test-session-secret-with-enough-length";
const OWNER = "person-example";
const OTHER = "person-independent-approver-example";
const BRANCH = "action-decisions";

const git = async (cwd, args) => (await execute("git", args, { cwd })).stdout.trim();
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function action(id, fields = {}) {
  return {
    id,
    title: `Question ${id}`,
    ownerId: OWNER,
    status: "proposed",
    priority: "p2",
    blocksPeriodStart: false,
    due: "2026-11-20",
    question: `What should ${id} say?`,
    suggestedAnswer: `Suggested answer for ${id}.`,
    evidence: [{ label: "Vendor page", url: "https://example.com/vendor" }, { label: "Policy", path: "policies/access.md" }],
    confidence: "medium",
    kind: "decision",
    source: { type: "agent", ref: "nightly" },
    links: [],
    createdOn: "2026-11-01",
    updatedOn: "2026-11-01",
    decision: null,
    history: [],
    ...fields
  };
}

// A trunk-mode workspace with an action register, pushed to a bare remote whose
// main branch the server must never move when someone decides.
async function fixture(context, { adminEmails } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "filegrc-hosted-actions-"));
  const root = join(parent, "workspace");
  const remote = join(parent, "remote.git");
  await makeComprehensiveWorkspace(root, "13");
  for (const entry of (await loadWorkspace(root)).entries.filter(({ record }) => ["policy", "document", "training"].includes(record.type))) {
    const record = { ...entry.record, status: "approved" };
    for (const field of ["effectiveOn", "activationBasis", "activatedOn", "activatedByIds", "activatedContentRevisions"]) delete record[field];
    await writeFile(entry.path, json(record));
  }
  const owner = (await loadWorkspace(root)).entries.find(({ record }) => record.id === OWNER);
  await writeFile(owner.path, json({ ...owner.record, email: "jordan.lee@example.test" }));
  await writeFile(join(root, "data", "renderer.json"), json({
    id: "renderer-settings", type: "renderer-settings", title: "Renderer settings", showOnboarding: false,
    repositoryMode: "trunk", authoritativeBranch: "main", repositoryRemote: "origin"
  }));
  await mkdir(join(root, "actions"));
  await writeFile(join(root, "actions", "schema.json"), json({ type: "object" }));
  await writeFile(join(root, "actions", "ACT-001.json"), json(action("ACT-001", { priority: "p1", blocksPeriodStart: true })));
  await writeFile(join(root, "actions", "ACT-002.json"), json(action("ACT-002", { ownerId: OTHER, title: "Other <script>x</script>" })));
  await writeFile(join(root, "actions", "ACT-003.json"), json(action("ACT-003", { status: "done", suggestedAnswer: "" })));
  await writeFile(join(root, "actions", "ACT-004.json"), json(action("ACT-004", {
    evidence: [{ label: "Unsafe", url: "javascript:alert(1)" }]
  })));
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "FileGRC Server"]);
  await git(root, ["config", "user.email", "server@example.test"]);
  await git(root, ["config", "commit.gpgSign", "false"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Create test workspace"]);
  await git(parent, ["init", "--bare", "--initial-branch=main", remote]);
  await git(root, ["remote", "add", "origin", remote]);
  await git(root, ["push", "-u", "origin", "main"]);
  const running = await serveWorkspace(root, {
    port: 0,
    env: {},
    hostedAuth: {
      clientId: "test-client.apps.example.com",
      clientSecret: "test-client-secret",
      allowedDomain: "example.test",
      sessionSecret: SESSION_SECRET,
      publicUrl: "https://filegrc.example.com",
      ...(adminEmails ? { adminEmails } : {})
    }
  });
  context.after(async () => {
    await new Promise((resolve) => running.server.close(resolve));
    await rm(parent, { recursive: true, force: true });
  });
  const as = (personId) => `filegrc_session=${signSession({ personId, exp: Math.floor(Date.now() / 1000) + 600 }, SESSION_SECRET)}`;
  const decide = (personId, fields, headers = {}) => fetch(`${running.url}/actions`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: as(personId), "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...headers },
    body: new URLSearchParams(fields).toString()
  });
  const page = async (personId, query = "") => {
    const response = await fetch(`${running.url}/actions${query}`, { headers: { cookie: as(personId) } });
    return { status: response.status, body: await response.text() };
  };
  return { root, remote, url: running.url, as, decide, page };
}

const decisionFiles = async (remote) => {
  const listing = await git(remote, ["ls-tree", "-r", "--name-only", BRANCH]).catch(() => "");
  return listing ? listing.split("\n") : [];
};

test("signed-in people see their own open actions by default and can filter the rest", async (context) => {
  const { url, page } = await fixture(context);
  const signedOut = await fetch(`${url}/actions`, { redirect: "manual" });
  assert.equal(signedOut.status, 302);

  const mine = await page(OWNER);
  assert.equal(mine.status, 200);
  assert.match(mine.body, /id="ACT-001"/);
  assert.match(mine.body, /id="ACT-004"/);
  assert.doesNotMatch(mine.body, /id="ACT-002"/, "another owner's action is filtered out by default");
  assert.doesNotMatch(mine.body, /id="ACT-003"/, "a done action does not wait for a decision");
  assert.match(mine.body, /What should ACT-001 say\?/);
  assert.match(mine.body, /Suggested answer for ACT-001\./);
  assert.match(mine.body, /<a href="https:\/\/example\.com\/vendor" rel="noopener noreferrer" target="_blank">Vendor page<\/a>/);
  assert.match(mine.body, /Policy <code>policies\/access\.md<\/code>/);
  assert.match(mine.body, /aria-current="true">Jordan Lee<\/a>/);
  assert.match(mine.body, /class="filter-chip" href="[^"]*"[^>]*>Owner: Jordan Lee/);
  assert.match(mine.body, /Status: Waiting for a decision/);
  assert.match(mine.body, /2 of 4 actions/);
  assert.match(mine.body, /P1 · Blocks the period start/);

  const everyone = await page(OWNER, "?owner=&status=all");
  for (const id of ["ACT-001", "ACT-002", "ACT-003", "ACT-004"]) assert.match(everyone.body, new RegExp(`id="${id}"`));
  assert.match(everyone.body, /Other &lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(everyone.body, /<script>/);
  assert.doesNotMatch(everyone.body, /href="javascript:/);
  assert.doesNotMatch(everyone.body, /schema/);

  const blocking = await page(OWNER, "?owner=&status=waiting&blocks=yes");
  assert.match(blocking.body, /id="ACT-001"/);
  assert.doesNotMatch(blocking.body, /id="ACT-004"/);
  const p2 = await page(OWNER, "?owner=&status=all&priority=p2");
  assert.doesNotMatch(p2.body, /id="ACT-001"/);
  const search = await page(OWNER, "?q=act-004&owner=&status=all");
  assert.match(search.body, /id="ACT-004"/);
  assert.doesNotMatch(search.body, /id="ACT-001"/);
  assert.match(search.body, /Search: act-004/);

  // Buttons only where the viewer may decide.
  assert.match(everyone.body, /name="actionId" value="ACT-001">/);
  assert.doesNotMatch(everyone.body, /name="actionId" value="ACT-002">/);
  assert.match(everyone.body, /Only Independent Approver or an admin can decide on this action\./);
});

test("approving saves one decision file on the decisions branch and leaves main alone", async (context) => {
  const { root, remote, decide, page } = await fixture(context);
  const mainBefore = await git(remote, ["rev-parse", "main"]);
  const headBefore = await git(root, ["rev-parse", "HEAD"]);

  const response = await decide(OWNER, { actionId: "ACT-001", decision: "approve", owner: "", status: "all" });
  assert.equal(response.status, 303, await response.text());
  assert.equal(response.headers.get("location"), "/actions?owner=&status=all&decided=ACT-001&outcome=approved#ACT-001");

  assert.equal(await git(remote, ["rev-parse", "main"]), mainBefore);
  assert.equal(await git(root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(await git(root, ["status", "--porcelain"]), "");
  const files = await decisionFiles(remote);
  assert.equal(files.length, 1);
  assert.match(files[0], /^actions\/decisions\/ACT-001\/\d{8}T\d{9}Z-[a-f0-9]{6}\.json$/);
  const saved = JSON.parse(await git(remote, ["show", `${BRANCH}:${files[0]}`]));
  assert.deepEqual(Object.keys(saved), ["id", "actionId", "outcome", "by", "email", "on", "note", "approvedAnswer", "actionStatusBefore"]);
  assert.equal(saved.actionId, "ACT-001");
  assert.equal(saved.outcome, "approved");
  assert.equal(saved.by, OWNER);
  assert.equal(saved.email, "jordan.lee@example.test");
  assert.match(saved.on, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(files[0], `actions/decisions/ACT-001/${saved.id}.json`);
  assert.equal(saved.approvedAnswer, "Suggested answer for ACT-001.");
  assert.equal(saved.actionStatusBefore, "proposed");
  assert.equal(await git(remote, ["log", "-1", "--format=%an <%ae>|%s", BRANCH]), "Jordan Lee <jordan.lee@example.test>|Approve ACT-001: Question ACT-001");

  const after = await page(OWNER, "?owner=&status=all&decided=ACT-001&outcome=approved");
  assert.match(after.body, /role="status">Approved ACT-001\./);
  const card = after.body.slice(after.body.indexOf('id="ACT-001"'), after.body.indexOf('id="ACT-002"'));
  assert.match(card, /<dt>Status<\/dt><dd>Accepted<\/dd>/);
  assert.match(card, /Waiting to be filed in the register/);
  assert.doesNotMatch(card, /name="decision"/, "a settled action offers no more buttons");

  const again = await decide(OWNER, { actionId: "ACT-001", decision: "reject", note: "Changed my mind" });
  assert.equal(again.status, 409);
  assert.match(await again.text(), /already accepted/);
  assert.equal((await decisionFiles(remote)).length, 1);

  const validation = await captureCli(runCli, ["validate", "--root", root]);
  assert.equal(validation.exitCode, 0, validation.stdout + validation.stderr);
});

test("feedback keeps the action open, reject needs a reason, and each decision is its own file", async (context) => {
  const { remote, decide, page } = await fixture(context);
  const empty = await decide(OWNER, { actionId: "ACT-004", decision: "feedback", note: "  " });
  assert.equal(empty.status, 400);
  assert.match(await empty.text(), /Feedback is required/);
  const noReason = await decide(OWNER, { actionId: "ACT-004", decision: "reject" });
  assert.equal(noReason.status, 400);
  assert.equal((await decisionFiles(remote)).length, 0);

  assert.equal((await decide(OWNER, { actionId: "ACT-004", decision: "feedback", note: "Cite the 2026 contract." })).status, 303);
  const open = await page(OWNER);
  const card = open.body.slice(open.body.indexOf('id="ACT-004"'));
  assert.match(card, /<dt>Status<\/dt><dd>Answer proposed<\/dd>/);
  assert.match(card, /<strong>Feedback<\/strong> by Jordan Lee on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC: Cite the 2026 contract\./);
  assert.match(card, /name="decision" value="approve"/);

  assert.equal((await decide(OWNER, { actionId: "ACT-004", decision: "reject", note: "Out of scope" })).status, 303);
  const files = await decisionFiles(remote);
  assert.equal(files.length, 2);
  const outcomes = await Promise.all(files.map(async (file) => JSON.parse(await git(remote, ["show", `${BRANCH}:${file}`])).outcome));
  assert.deepEqual(outcomes.sort(), ["feedback", "rejected"]);
  assert.equal(await git(remote, ["rev-list", "--count", BRANCH]), "2");
});

test("only the owner or an admin can decide; everyone else and cross-site posts change nothing", async (context) => {
  const { remote, decide, page } = await fixture(context, { adminEmails: "approver@example.test" });
  const foreign = await fixture(context);
  const denied = await foreign.decide(OTHER, { actionId: "ACT-001", decision: "approve" });
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /Only the action&#39;s owner or an admin/);
  assert.equal((await decisionFiles(foreign.remote)).length, 0);

  const crossSite = await decide(OWNER, { actionId: "ACT-001", decision: "approve" }, { "sec-fetch-site": "cross-site" });
  assert.equal(crossSite.status, 403);
  const signedOut = await fetch(`${new URL(crossSite.url).origin}/actions`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    body: "actionId=ACT-001&decision=approve"
  });
  assert.equal(signedOut.status, 302, "a signed-out post goes to sign-in");
  assert.equal((await decisionFiles(remote)).length, 0);

  // The admin owns ACT-002 and may also decide on ACT-001.
  assert.match((await page(OTHER, "?owner=&status=all")).body, /name="actionId" value="ACT-001">/);
  assert.equal((await decide(OTHER, { actionId: "ACT-001", decision: "approve" })).status, 303);
  const [file] = await decisionFiles(remote);
  const saved = JSON.parse(await git(remote, ["show", `${BRANCH}:${file}`]));
  assert.deepEqual([saved.by, saved.email], [OTHER, "approver@example.test"]);
});

test("a decision stops showing as pending once the register records it", async (context) => {
  const { root, decide, page } = await fixture(context);
  assert.equal((await decide(OWNER, { actionId: "ACT-004", decision: "feedback", note: "Add the SOC report." })).status, 303);
  const pending = (await page(OWNER)).body;
  assert.match(pending, /Add the SOC report\./);
  const path = (await git(root, ["ls-tree", "-r", "--name-only", `origin/${BRANCH}`])).split("\n").find((file) => file.includes("/ACT-004/"));
  const saved = JSON.parse(await git(root, ["show", `origin/${BRANCH}:${path}`]));

  // The register copies the decision into history as it is and keeps the status.
  await writeFile(join(root, "actions", "ACT-004.json"), json(action("ACT-004", {
    status: "proposed",
    history: [{ outcome: saved.outcome, by: saved.by, on: saved.on, note: saved.note }]
  })));
  assert.doesNotMatch((await page(OWNER)).body, /Add the SOC report\./);
});

test("a line after a list renders after the list", async () => {
  const { renderMarkdown } = await import("../src/markdown.js");
  assert.equal(renderMarkdown("1. First\n2. Second\nTakes ~20 minutes."), "<ol><li>First</li><li>Second</li></ol>\n<p>Takes ~20 minutes.</p>");
});

test("pending decisions apply in time order and the register's own decision wins", () => {
  const base = action("ACT-009");
  const decision = (id, outcome, on) => ({ id, actionId: "ACT-009", outcome, by: OWNER, on, note: "" });
  const [viewed] = applyPendingDecisions([base], [
    decision("20261103T120000000Z-bbbbbb", "approved", "2026-11-03T12:00:00.000Z"),
    decision("20261103T110000000Z-aaaaaa", "feedback", "2026-11-03T11:00:00.000Z"),
    decision("20261103T130000000Z-cccccc", "rejected", "2026-11-03T13:00:00.000Z")
  ]);
  assert.equal(viewed.status, "accepted");
  assert.deepEqual(viewed.pendingDecisions.map(({ outcome }) => outcome), ["feedback", "approved"]);
  const [folded] = applyPendingDecisions([{ ...base, decision: { outcome: "approved", by: OWNER, on: "2026-11-03T12:00:00.000Z" } }], [
    decision("20261103T120000000Z-bbbbbb", "approved", "2026-11-03T12:00:00.000Z")
  ]);
  assert.deepEqual(folded.pendingDecisions, []);
  const [closed] = applyPendingDecisions([{ ...base, status: "done" }], [decision("20261103T120000000Z-bbbbbb", "rejected", "2026-11-03T12:00:00.000Z")]);
  assert.equal(closed.status, "done");

  assert.deepEqual(actionFilters(new URLSearchParams(), OWNER), { q: "", owner: OWNER, status: "waiting", priority: "", blocks: "" });
  assert.deepEqual(actionFilters(new URLSearchParams("owner=&status=bogus&priority=p9"), OWNER), { q: "", owner: "", status: "waiting", priority: "", blocks: "" });
  const sorted = filterActions([action("B", { priority: "p2" }), action("A", { priority: "p1", due: "2026-12-01" }), action("C", { priority: "p1", due: "2026-11-15" })], { owner: "", status: "all" });
  assert.deepEqual(sorted.map(({ id }) => id), ["C", "A", "B"]);
});

test("the sidebar links to Actions when the register exists and shows the workspace's brand", async (context) => {
  const { root, url, as } = await fixture(context);
  const index = await (await fetch(`${url}/`, { headers: { cookie: as(OWNER) } })).text();
  assert.match(index, /data-actions-href="\/actions"/);
  const source = APP_SCRIPT.slice(APP_SCRIPT.indexOf("function helpNavigation"), APP_SCRIPT.indexOf("function hostedNavigation"));
  const navigation = (dataset) => vm.runInNewContext(source + "\nhelpNavigation()", { document: { body: { dataset } }, esc: String });
  assert.equal(navigation({ actionsHref: "/actions", helpHref: "/faq" }), '<a class="help-nav" href="/actions">Actions</a><a class="help-nav" href="/faq">Help</a>');
  assert.equal(navigation({}), "");

  assert.ok(APP_SCRIPT.includes('esc(state.workspace.brandName || "FileGRC")'));
  assert.ok(APP_SCRIPT.includes('esc(state.workspace.brandSubtitle || "SOC 2 workspace")'));
  const workspace = (await loadWorkspace(root)).entries.find(({ record }) => record.type === "workspace");
  await writeFile(workspace.path, json({ ...workspace.record, brandName: "Example", brandSubtitle: "SOC 2 portal" }));
  const validation = await captureCli(runCli, ["validate", "--root", root]);
  assert.equal(validation.exitCode, 0, validation.stdout + validation.stderr);
});

test("anyone signed in can suggest a change; it is saved beside decisions, never on main", async (context) => {
  const { root, remote, url, as } = await fixture(context);
  const mainBefore = await git(remote, ["rev-parse", "main"]);
  const send = (personId, body, headers = {}) => fetch(`${url}/api/suggestions`, {
    method: "POST",
    headers: { ...(personId ? { cookie: as(personId) } : {}), "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(body)
  });
  assert.equal((await send(null, { recordType: "control", recordId: "control-example", text: "x" })).status, 401);
  assert.equal((await send(OTHER, { recordType: "control", recordId: "control-example", text: "x" }, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await send(OTHER, { recordType: "control", recordId: "control-example", text: " " })).status, 400);
  assert.equal((await send(OTHER, { recordType: "nonsense", text: "x" })).status, 400);
  assert.equal((await send(OTHER, { recordType: "control", recordId: "control-missing", text: "x" })).status, 404);
  assert.equal((await decisionFiles(remote)).length, 0);

  const response = await send(OTHER, { recordType: "control", recordId: "control-example", text: "The owner left in October." });
  assert.equal(response.status, 201, await response.clone().text());
  const files = await decisionFiles(remote);
  assert.equal(files.length, 1);
  assert.match(files[0], /^actions\/suggestions\/\d{8}T\d{9}Z-control-example-[a-f0-9]{6}\.json$/);
  const saved = JSON.parse(await git(remote, ["show", `${BRANCH}:${files[0]}`]));
  assert.deepEqual(saved, {
    id: files[0].slice("actions/suggestions/".length, -".json".length),
    kind: "suggestion",
    recordType: "control",
    recordId: "control-example",
    recordTitle: saved.recordTitle,
    recordPath: "data/controls/control-example.json",
    text: "The owner left in October.",
    by: OTHER,
    email: "approver@example.test",
    on: saved.on
  });
  assert.deepEqual((await (await response).json()).suggestion.id, saved.id);
  assert.equal(await git(remote, ["rev-parse", "main"]), mainBefore);
  assert.equal(await git(root, ["status", "--porcelain"]), "");

  // A list page suggests against the collection.
  assert.equal((await send(OWNER, { recordType: "control", text: "Add a control for laptops." })).status, 201);
  const collection = (await decisionFiles(remote)).find((file) => /-control-[a-f0-9]{6}\.json$/.test(file));
  assert.equal(JSON.parse(await git(remote, ["show", `${BRANCH}:${collection}`])).recordId, null);

  const index = await (await fetch(`${url}/`, { headers: { cookie: as(OWNER) } })).text();
  assert.match(index, /data-suggest-href="\/api\/suggestions"/);
});

test("the How it works text comes from faq/suggest-a-change.md when the workspace has one", async (context) => {
  const { root, url, as } = await fixture(context);
  const guide = async () => (await (await fetch(`${url}/api/suggestions/guide`, { headers: { cookie: as(OWNER) } })).json()).html;
  assert.match(await guide(), /<li>Your suggestion becomes an action in the action register\.<\/li>/);
  await mkdir(join(root, "faq"));
  await writeFile(join(root, "faq", "suggest-a-change.md"), "# Suggesting a change\n\nAsk **the security lead** first.\n\n<script>x</script>\n");
  const custom = await guide();
  assert.match(custom, /Ask <strong>the security lead<\/strong> first\./);
  assert.doesNotMatch(custom, /Suggesting a change/, "the page title is not repeated inside the dialog");
  assert.doesNotMatch(custom, /<script>/);
});

test("list pages and the dialog render the shared toolbar and suggestion markup", () => {
  const start = APP_SCRIPT.indexOf("function filterToolbar");
  const source = APP_SCRIPT.slice(start, APP_SCRIPT.indexOf("function setupFilterToolbar"));
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const html = vm.runInNewContext(source + "\nfilterToolbar(input)", {
    esc: escape, properCase: (value) => value[0].toUpperCase() + value.slice(1), filterOptionLabel: String,
    input: { searchLabel: "Filter controls", searchPlaceholder: "Search controls", filters: [{ name: "status", label: "status", values: ["active", "<b>"] }], count: "2 records" }
  });
  assert.match(html, /<div class="filter-toolbar" role="search" aria-label="Filter controls">/);
  assert.match(html, /<input id="list-search" type="search" placeholder="Search controls"/);
  assert.match(html, /<summary aria-label="Filter by status">Status<span class="filter-caret" aria-hidden="true">▾<\/span><\/summary>/);
  assert.match(html, /<button type="button" data-value="active" aria-pressed="false">active<\/button>/);
  assert.match(html, /data-value="&lt;b>"/);
  assert.match(html, /<input type="hidden" class="field-filter" data-field="status" data-label="Status" value="">/);
  assert.match(html, /<span id="result-count" class="filter-count" aria-live="polite">2 records<\/span>/);
  assert.match(html, /<div class="filter-chips" hidden><\/div>/);
  assert.ok(APP_SCRIPT.includes('"Escape" && menu.open'));
  assert.ok(APP_SCRIPT.includes("Sent. The agent will propose the change for approval."));
  assert.ok(APP_SCRIPT.includes("<summary>How it works</summary>"));
  assert.ok(APP_SCRIPT.includes("<h3>Change it yourself</h3>"));
  assert.ok(APP_SCRIPT.includes(`'<button class="button" id="edit-resource">Edit</button>' : "") + suggestChangeButton() + recordMenu`));
});

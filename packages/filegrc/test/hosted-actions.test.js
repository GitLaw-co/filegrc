import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";
import { actionAnswerRevision, actionOptions, actionPullRequests, actionTables, answerRevision, applyPendingDecisions, actionFilters, actionWaitingOn, applyPendingReviews, createActionRegister, filterActions, githubRepositoryFromRemote, parsePendingReviews, resolveWaitingOn, summarizeActions } from "../src/action-register.js";
import { runCli } from "../src/cli.js";
import { signSession } from "../src/hosted-auth.js";
import { serveWorkspace } from "../src/server.js";
import { compareActionsByUrgency } from "../src/action-status.js";
import { APP_SCRIPT, APP_STYLES } from "../src/web.js";
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
const seen = (id) => answerRevision(`Suggested answer for ${id}.`);

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
async function fixture(context, { adminEmails, serve = {} } = {}) {
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
  await writeFile(join(root, "actions", "ACT-003.json"), json(action("ACT-003", { status: "done", suggestedAnswer: "", kind: "approval" })));
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
    ...serve,
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

// One group of the Actions page: "action-needs", "action-others" or "action-done-group".
const group = (body, name) => {
  const start = body.indexOf(`<section class="action-group ${name}"`);
  if (start === -1) return "";
  const end = body.indexOf('<section class="action-group ', start + 1);
  return body.slice(start, end === -1 ? undefined : end);
};

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
  const needs = group(mine.body, "action-needs");
  assert.match(needs, /<h2 class="action-group-title">Needs you <span class="action-group-count">2<\/span><\/h2>/);
  assert.ok(needs.indexOf('id="ACT-001"') > 0 && needs.indexOf('id="ACT-001"') < needs.indexOf('id="ACT-004"'), "what blocks the period start comes first");
  assert.doesNotMatch(needs, /id="ACT-00[23]"/);
  assert.match(group(mine.body, "action-others"), /<summary><strong>Independent Approver<\/strong> · 1<\/summary>[\s\S]*id="ACT-002"/, "another owner's action waits under their name");
  assert.match(group(mine.body, "action-done-group"), /id="ACT-003"/, "a done action sits behind Show done");
  assert.match(mine.body, /<input type="checkbox" id="action-show-done" data-show-done> Show done <span class="action-person-count">1<\/span>/);
  assert.doesNotMatch(mine.body, /id="action-show-done"[^>]*checked/, "Show done starts off");
  assert.match(mine.body, /<strong>1 of 3 done<\/strong> <span class="action-progress-who">You<\/span>/);
  assert.match(mine.body, /<span class="impact-tag">1 blocks the period start[^<]*<\/span>/);
  assert.match(mine.body, /<progress class="action-progress-bar" max="3" value="1">/);
  // The question is the card's lead; the long answer, evidence and links are Background.
  const first = mine.body.slice(mine.body.indexOf('id="ACT-001"'), mine.body.indexOf('id="ACT-004"'));
  assert.match(first, /<div class="action-why markdown"><p>What should ACT-001 say\?<\/p><\/div>/);
  assert.match(first, /<details class="action-background"><summary>Background<\/summary>[\s\S]*Suggested answer for ACT-001\./);
  assert.match(first, /<a href="https:\/\/example\.com\/vendor" rel="noopener noreferrer" target="_blank">Vendor page<\/a>/);
  assert.match(first, /Policy <code>policies\/access\.md<\/code>/);
  assert.ok(first.indexOf('name="decision" value="approve"') < first.indexOf("action-background"), "Approve sits on the card, before Background");
  assert.match(mine.body, /aria-current="true">Me <span class="action-person-count" aria-label="2 waiting">2<\/span><\/a>/);
  assert.match(mine.body, />Everyone <span class="action-person-count" aria-label="3 waiting">3<\/span><\/a>/);
  assert.match(mine.body, />Independent Approver <span class="action-person-count" aria-label="1 waiting">1<\/span><\/a>/);
  assert.doesNotMatch(mine.body, /class="filter-chip"/, "the default view has no filter chips");
  assert.match(mine.body, /2 of 4 actions/);
  assert.match(mine.body, /<span class="impact-tag">Blocks [^<]+<\/span><span class="priority-chip">P1<\/span><span class="status-pill tone-blue" data-task-status="to-review">To review<\/span>/);
  assert.doesNotMatch(mine.body, /data-status-word="failing"|>Failing</);

  const everyone = await page(OWNER, "?owner=&status=all");
  for (const id of ["ACT-001", "ACT-002", "ACT-003", "ACT-004"]) assert.match(everyone.body, new RegExp(`id="${id}"`));
  assert.match(everyone.body, /Other &lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(everyone.body, /<script>x/);
  assert.equal(everyone.body.match(/<script>/g).length, 1, "only the page's own menu script");
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
  assert.match(search.body.slice(search.body.indexOf('id="ACT-004"')), /<details class="action-background" open>/, "a single match opens its Background");
  assert.doesNotMatch(everyone.body, /<details class="action-background" open>/, "a list starts closed");
  assert.match(everyone.body, /<h2 class="action-group-title">Actions <span class="action-group-count">4<\/span><\/h2>/);
  assert.doesNotMatch(everyone.body, /<section class="action-group action-(others|done-group)"|id="action-show-done"/, "an explicit status shows one plain list");
  assert.match(everyone.body, /class="filter-chip" href="[^"]*"[^>]*>Status: Any/);
  const theirs = await page(OWNER, `?owner=${OTHER}&status=waiting`);
  assert.match(group(theirs.body, "action-needs"), /Waiting on Independent Approver[\s\S]*id="ACT-002"/);
  assert.match(theirs.body, /<strong>0 of 1 done<\/strong> <span class="action-progress-who">Independent Approver<\/span>/);
  assert.match(everyone.body, /aria-label="Filter by type"/);
  const signoffs = await page(OWNER, "?owner=&status=all&type=approval");
  assert.match(signoffs.body, /id="ACT-003"/);
  assert.doesNotMatch(signoffs.body, /id="ACT-001"/);
  assert.match(signoffs.body, /Type: Sign-off /);
  const byLabel = await page(OWNER, "?q=sign-off&owner=&status=all");
  assert.match(byLabel.body, /id="ACT-003"/);
  assert.doesNotMatch(byLabel.body, /id="ACT-001"/);

  // Buttons only where the viewer may decide.
  assert.match(everyone.body, /name="actionId" value="ACT-001">/);
  assert.doesNotMatch(everyone.body, /name="actionId" value="ACT-002">/);
  assert.match(everyone.body, /Only Independent Approver or an admin can respond to this action\./);
});

test("approving saves one decision file on the decisions branch and leaves main alone", async (context) => {
  const { root, remote, decide, page } = await fixture(context);
  const mainBefore = await git(remote, ["rev-parse", "main"]);
  const headBefore = await git(root, ["rev-parse", "HEAD"]);

  // An Approve names the answer the owner read; a stale or missing one is refused.
  for (const stale of [{}, { answerRevision: answerRevision("An older answer.") }]) {
    const refused = await decide(OWNER, { actionId: "ACT-001", decision: "approve", ...stale });
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /changed after you opened the page/);
  }
  assert.equal((await decisionFiles(remote)).length, 0);
  const shown = await page(OWNER);
  assert.match(shown.body, new RegExp(`name="answerRevision" value="${seen("ACT-001")}"`));

  const response = await decide(OWNER, { actionId: "ACT-001", decision: "approve", answerRevision: seen("ACT-001"), owner: "", status: "all" });
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
  const card = after.body.slice(after.body.indexOf('id="ACT-001"'), after.body.indexOf("</details>", after.body.indexOf('id="ACT-001"')));
  assert.match(card, /<span class="status-pill tone-green-muted" data-task-status="accepted">Accepted<\/span>/);
  assert.match(card, /not yet in the register/);
  assert.doesNotMatch(card, /name="decision"/, "a settled action offers no more buttons");

  const again = await decide(OWNER, { actionId: "ACT-001", decision: "reject", note: "Changed my mind" });
  assert.equal(again.status, 409);
  assert.match(await again.text(), /already accepted/);
  assert.equal((await decisionFiles(remote)).length, 1);

  const validation = await captureCli(runCli, ["validate", "--root", root]);
  assert.equal(validation.exitCode, 0, validation.stdout + validation.stderr);
});

test("an Approve names the version of each linked pull request and is refused once it moves", async (context) => {
  const { root, remote, decide, page } = await fixture(context, { serve: { actionPullRequestRepository: "Example-Org/Program" } });
  // Pull request refs live on the remote, as GitHub keeps refs/pull/<n>/head.
  const pushHead = async (number, message) => {
    const commit = await git(root, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", message]);
    await git(root, ["push", "--force", "origin", `${commit}:refs/pull/${number}/head`]);
    return commit;
  };
  await writeFile(join(root, "actions", "ACT-005.json"), json(action("ACT-005", {
    kind: "approval",
    links: ["https://github.com/example-org/program/pull/7", "https://github.com/other-org/elsewhere/pull/9"]
  })));
  await writeFile(join(root, "actions", "ACT-006.json"), json(action("ACT-006", {
    kind: "approval",
    links: ["https://github.com/example-org/program/pull/7/files", "https://github.com/example-org/program/pull/8"]
  })));
  const first = await pushHead(7, "First version");
  const eight = await pushHead(8, "Pull request 8");

  const shown = await page(OWNER);
  const card = shown.body.slice(shown.body.indexOf('id="ACT-005"'), shown.body.indexOf('id="ACT-006"'));
  assert.match(card, new RegExp(`This approves pull request <a href="https://github.com/example-org/program/pull/7/files"[^>]*>#7</a> at version <code>${first.slice(0, 7)}</code>`));
  assert.match(card, new RegExp(`name="pullRequestVersions" value="7:${first}"`));
  assert.doesNotMatch(card, /pull request <a[^>]*>#9/, "a pull request of another repository is not bound");

  const second = await pushHead(7, "Second version");
  for (const stale of [{}, { pullRequestVersions: `7:${first}` }]) {
    const refused = await decide(OWNER, { actionId: "ACT-005", decision: "approve", answerRevision: seen("ACT-005"), ...stale });
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /The pull request changed since you opened this page/);
  }
  assert.equal((await decisionFiles(remote)).length, 0);

  const approved = await decide(OWNER, { actionId: "ACT-005", decision: "approve", answerRevision: seen("ACT-005"), pullRequestVersions: `7:${second}` });
  assert.equal(approved.status, 303, await approved.text());
  const both = await decide(OWNER, { actionId: "ACT-006", decision: "approve", answerRevision: seen("ACT-006"), pullRequestVersions: `7:${second},8:${eight}` });
  assert.equal(both.status, 303, await both.text());
  const saved = await Promise.all((await decisionFiles(remote)).map(async (file) => JSON.parse(await git(remote, ["show", `${BRANCH}:${file}`]))));
  const byAction = Object.fromEntries(saved.map((decision) => [decision.actionId, decision]));
  assert.deepEqual(byAction["ACT-005"].pullRequest, { url: "https://github.com/example-org/program/pull/7", number: 7, headSha: second });
  assert.equal(byAction["ACT-005"].pullRequests, undefined);
  assert.deepEqual(byAction["ACT-006"].pullRequests, [
    { url: "https://github.com/example-org/program/pull/7", number: 7, headSha: second },
    { url: "https://github.com/example-org/program/pull/8", number: 8, headSha: eight }
  ]);
});

test("pull request links are matched against the program repository", () => {
  assert.equal(githubRepositoryFromRemote("git@github.com:GitLaw-co/compliance.git"), "gitlaw-co/compliance");
  assert.equal(githubRepositoryFromRemote("https://github.com/GitLaw-co/compliance"), "gitlaw-co/compliance");
  assert.equal(githubRepositoryFromRemote("ssh://git@github.com/GitLaw-co/compliance.git"), "gitlaw-co/compliance");
  assert.equal(githubRepositoryFromRemote("/srv/remote.git"), null);
  assert.deepEqual(actionPullRequests({ links: { "Pull request": { url: "https://github.com/GitLaw-co/compliance/pull/75" } } }, "gitlaw-co/compliance"),
    [{ url: "https://github.com/GitLaw-co/compliance/pull/75", number: 75 }]);
  assert.deepEqual(actionPullRequests({ links: ["https://github.com/GitLaw-co/compliance/pull/75"] }, null), []);
  assert.deepEqual(actionPullRequests({ links: ["https://github.com/GitLaw-co/compliance/issues/75", "http://github.com/GitLaw-co/compliance/pull/75"] }, "gitlaw-co/compliance"), []);
});

test("feedback keeps the action open, reject needs a reason, and each decision is its own file", async (context) => {
  const { remote, decide, page } = await fixture(context);
  const empty = await decide(OWNER, { actionId: "ACT-004", decision: "feedback", note: "  " });
  assert.equal(empty.status, 400);
  assert.match(await empty.text(), /Write your message to the agent/);
  const noReason = await decide(OWNER, { actionId: "ACT-004", decision: "reject" });
  assert.equal(noReason.status, 400);
  assert.equal((await decisionFiles(remote)).length, 0);

  assert.equal((await decide(OWNER, { actionId: "ACT-004", decision: "feedback", note: "Cite the 2026 contract." })).status, 303);
  const open = await page(OWNER);
  const card = open.body.slice(open.body.indexOf('id="ACT-004"'));
  assert.match(card, /<strong>Message to the agent<\/strong> · Jordan Lee · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · <span class="action-entry-pending">not yet in the register<\/span><div class="action-entry-note">Cite the 2026 contract\.<\/div>/);
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
  assert.equal((await decide(OTHER, { actionId: "ACT-001", decision: "approve", answerRevision: seen("ACT-001") })).status, 303);
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
  const filed = (await page(OWNER)).body;
  assert.doesNotMatch(filed, /not yet in the register/);
  assert.match(filed, /<div class="action-entry-note">Add the SOC report\.<\/div>/, "the register's history shows in the card's record");
});

test("a task is marked done or part done; a decision is approved", async (context) => {
  const { root, remote, decide, page } = await fixture(context);
  await writeFile(join(root, "actions", "ACT-004.json"), json(action("ACT-004", { kind: "fix", status: "open" })));
  const body = (await page(OWNER)).body;
  const task = body.slice(body.indexOf('id="ACT-004"'));
  const decision = body.slice(body.indexOf('id="ACT-001"'), body.indexOf('id="ACT-004"'));
  assert.match(task, /<span class="action-kind">Task<\/span>/);
  assert.match(task, /<h4>Steps<\/h4>/);
  assert.match(task, /<label class="button primary" for="ACT-004-pick-done">Mark as done<\/label>/, "Mark as done is the task's primary button");
  for (const value of ["done", "progress", "feedback", "reject"]) assert.match(task, new RegExp(`name="decision" value="${value}"`));
  assert.doesNotMatch(task, /name="decision" value="approve"/, "a task has nothing to approve");
  assert.match(decision, /name="decision" value="approve"/);
  assert.doesNotMatch(decision, /name="decision" value="(done|progress)"/);

  const noNote = await decide(OWNER, { actionId: "ACT-004", decision: "done", note: " " });
  assert.equal(noNote.status, 400);
  assert.match(await noNote.text(), /Say what you did/);
  assert.equal((await decide(OWNER, { actionId: "ACT-004", decision: "progress", note: "Step 1 done." })).status, 303);
  assert.match((await page(OWNER)).body, /id="ACT-004"/, "progress keeps the task waiting");
  assert.equal((await decide(OWNER, { actionId: "ACT-004", decision: "done", note: "All steps done on 4 Nov." })).status, 303);
  const after = await page(OWNER, "?owner=&status=all&decided=ACT-004&outcome=done");
  assert.match(after.body, /role="status">Marked as done: ACT-004\./);
  assert.match(after.body.slice(after.body.indexOf('id="ACT-004"')), /<span class="status-pill tone-green-muted" data-task-status="done">Done<\/span>/);
  const settled = (await page(OWNER)).body;
  assert.doesNotMatch(group(settled, "action-needs"), /id="ACT-004"/, "a done task no longer waits");
  assert.match(group(settled, "action-done-group"), /id="ACT-004"/);
  const outcomes = await Promise.all((await decisionFiles(remote)).map(async (file) => JSON.parse(await git(remote, ["show", `${BRANCH}:${file}`])).outcome));
  assert.deepEqual(outcomes.sort(), ["done", "progress"]);
});

test("a decision with options is answered by one click on a choice, recorded in the note", async (context) => {
  const { root, remote, decide, page } = await fixture(context);
  const options = [
    { value: "remove", label: "Remove the bypass", detail: "Changes need a second review.", recommended: true },
    { value: "exception", label: "Keep it as an exception" },
    { value: "remove", label: "Duplicate value is dropped" },
    { label: "No value is dropped" }
  ];
  const tables = [{
    title: "Accounts that skip review",
    note: "Read 26 Nov.",
    cols: ["Account", "Repository"],
    rows: [["release-bot", "web-app"], { Account: "<b>ci</b>", Repository: "deploy" }, "not a row"]
  }];
  await writeFile(join(root, "actions", "ACT-004.json"), json(action("ACT-004", {
    why: "A change can reach production **unreviewed**.", options, tables
  })));
  const body = (await page(OWNER)).body;
  const card = body.slice(body.indexOf('id="ACT-004"'));
  const revision = actionAnswerRevision({ suggestedAnswer: "Suggested answer for ACT-004.", options });
  assert.notEqual(revision, seen("ACT-004"), "the options are part of what an Approve covers");
  assert.match(card, /<div class="action-why markdown"><p>A change can reach production <strong>unreviewed<\/strong>\.<\/p><\/div>/);
  assert.match(card, /<details class="action-background">[\s\S]*<h4>Question<\/h4><div class="markdown"><p>What should ACT-004 say\?/, "the question moves to Background when there is a why");
  assert.match(card, /<p class="action-table-title">Accounts that skip review<\/p>[\s\S]*<th scope="col">Account<\/th><th scope="col">Repository<\/th>[\s\S]*<td>release-bot<\/td><td>web-app<\/td><\/tr><tr><td>&lt;b&gt;ci&lt;\/b&gt;<\/td><td>deploy<\/td><\/tr><\/tbody>[\s\S]*<p class="action-table-note">Read 26 Nov\.<\/p>/);
  assert.equal((card.match(/<form class="action-option"/g) ?? []).length, 2);
  assert.match(card, new RegExp(`<form class="action-option" method="post" action="/actions"><input type="hidden" name="actionId" value="ACT-004"><input type="hidden" name="decision" value="approve"><input type="hidden" name="option" value="remove"><input type="hidden" name="answerRevision" value="${revision}">`));
  assert.match(card, /<button class="button primary" type="submit">Remove the bypass<\/button><small>Changes need a second review\.<\/small>/);
  assert.match(card, /<button class="button outline" type="submit">Keep it as an exception<\/button>/);
  assert.doesNotMatch(card, /class="action-quick"/, "with options there is no plain Approve");
  assert.ok(card.indexOf("action-table") < card.indexOf("action-option") && card.indexOf("action-option") < card.indexOf("action-background"));

  const noChoice = await decide(OWNER, { actionId: "ACT-004", decision: "approve", answerRevision: revision });
  assert.equal(noChoice.status, 400);
  assert.match(await noChoice.text(), /Choose one of the options for ACT-004/);
  const unknown = await decide(OWNER, { actionId: "ACT-004", decision: "approve", option: "bogus", answerRevision: revision });
  assert.equal(unknown.status, 400);
  const stale = await decide(OWNER, { actionId: "ACT-004", decision: "approve", option: "exception", answerRevision: seen("ACT-004") });
  assert.equal(stale.status, 409, "a page opened before the options changed cannot approve");
  assert.equal((await decisionFiles(remote)).length, 0);

  const chosen = await decide(OWNER, { actionId: "ACT-004", decision: "approve", option: "exception", note: "The release job needs it.", answerRevision: revision });
  assert.equal(chosen.status, 303, await chosen.text());
  const [file] = await decisionFiles(remote);
  const saved = JSON.parse(await git(remote, ["show", `${BRANCH}:${file}`]));
  assert.equal(saved.outcome, "approved");
  assert.equal(saved.note, "Chose: Keep it as an exception\n\nThe release job needs it.");
  assert.deepEqual(saved.option, { value: "exception", label: "Keep it as an exception" });
  assert.equal(saved.approvedAnswer, "Suggested answer for ACT-004.");
  const after = (await page(OWNER)).body;
  assert.match(group(after, "action-done-group"), /<strong>Approved<\/strong> · Jordan Lee · [^<]+ · <span class="action-entry-pending">not yet in the register<\/span><div class="action-entry-note">Chose: Keep it as an exception/);

  // An action whose only answer is a choice needs no suggested answer.
  await writeFile(join(root, "actions", "ACT-001.json"), json(action("ACT-001", { suggestedAnswer: "", options: [{ value: "yes", label: "Yes" }] })));
  const bare = await decide(OWNER, { actionId: "ACT-001", decision: "approve", option: "yes", answerRevision: actionAnswerRevision({ suggestedAnswer: "", options: [{ value: "yes", label: "Yes" }] }) });
  assert.equal(bare.status, 303, await bare.text());

  // The new fields live in actions/, outside data/, so the workspace stays valid.
  const validation = await captureCli(runCli, ["validate", "--root", root]);
  assert.equal(validation.exitCode, 0, validation.stdout + validation.stderr);
});

test("options and tables are read defensively and an action without them is unchanged", () => {
  assert.deepEqual(actionOptions({}), []);
  assert.deepEqual(actionOptions({ options: "yes" }), []);
  assert.deepEqual(actionOptions({ options: [null, { value: " a ", label: " A ", detail: " ", recommended: "yes" }, { value: "a", label: "Again" }, { value: "b" }, { value: "x".repeat(101), label: "Long" }] }),
    [{ value: "a", label: "A" }]);
  assert.deepEqual(actionTables({ tables: [{ cols: [] , rows: [] }, { cols: ["A"] }, { title: " T ", cols: ["A", "B"], rows: [[1, true, "extra"], [null], { B: "b" }] }] }),
    [{ title: "T", cols: ["A", "B"], rows: [["1", "true"], ["", ""], ["", "b"]] }]);
  assert.equal(actionAnswerRevision({ suggestedAnswer: "Same." }), answerRevision("Same."));
  assert.equal(actionAnswerRevision({ suggestedAnswer: "Same.", options: [{ value: "only-label" }] }), answerRevision("Same."), "malformed options leave the revision alone");
  assert.notEqual(actionAnswerRevision({ suggestedAnswer: "Same.", options: [{ value: "a", label: "A" }] }),
    actionAnswerRevision({ suggestedAnswer: "Same.", options: [{ value: "a", label: "B" }] }));
});

test("the Actions page orders by what blocks the period start, then overdue, then priority", () => {
  const actions = [
    { id: "ACT-7", status: "done", blocksPeriodStart: true, priority: "p1" },
    { id: "ACT-6", status: "open", priority: "p1", due: "2026-12-30" },
    { id: "ACT-5", status: "open", priority: "p3", due: "2026-11-01" },
    { id: "ACT-4", status: "proposed", priority: "p2", blocksPeriodStart: true, due: "2026-12-20" },
    { id: "ACT-3", status: "open", priority: "p3", blocksPeriodStart: true, due: "2026-11-02" },
    { id: "ACT-2", status: "open", priority: "p1", blocksPeriodStart: true, due: "2026-12-10" }
  ];
  assert.deepEqual([...actions].sort(compareActionsByUrgency("2026-11-27")).map(({ id }) => id), ["ACT-3", "ACT-2", "ACT-4", "ACT-5", "ACT-6", "ACT-7"]);
});

test("Show done is a CSS toggle the app remembers per browser", () => {
  assert.match(APP_STYLES, /\.action-done-group\{display:none\}\.action-page:has\(#action-show-done:checked\) \.action-done-group\{display:block\}/);
  const wiring = APP_SCRIPT.slice(APP_SCRIPT.indexOf("function wireActionsPage"), APP_SCRIPT.indexOf("function overviewSectionStatus"));
  const store = new Map();
  let changed;
  const checkbox = { checked: false, addEventListener: (type, listener) => { changed = listener; } };
  const main = { querySelector: (selector) => (selector === "[data-show-done]" ? checkbox : null), querySelectorAll: () => [] };
  const window = { localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) } };
  const run = () => vm.runInNewContext(`${wiring}\nwireActionsPage(main, {})`, { main, window, location: {}, URLSearchParams, FormData: class {} });
  run();
  assert.equal(checkbox.checked, false);
  checkbox.checked = true;
  changed();
  assert.equal(store.get("filegrc.actions.showDone.v1"), "1");
  checkbox.checked = false;
  run();
  assert.equal(checkbox.checked, true, "the next visit starts with Show done ticked");
  window.localStorage.getItem = () => { throw new Error("blocked"); };
  assert.doesNotThrow(run, "blocked storage leaves the default");
});

test("decisions can never be pointed at the authoritative branch", async (context) => {
  const { root } = await fixture(context);
  for (const branch of ["main", "MASTER", "trunk"]) {
    assert.throws(() => createActionRegister(root, { decisionsBranch: branch }), /cannot go to/);
  }
  // The checked-out branch is refused even when renderer settings name no authoritative branch.
  await git(root, ["checkout", "-q", "-b", "release"]);
  const register = createActionRegister(root, { decisionsBranch: "release" });
  await assert.rejects(register.decide({ actionId: "ACT-001", outcome: "feedback", note: "x", viewer: { personId: OWNER, email: "jordan.lee@example.test" } }), /other than the authoritative branch/);
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

  assert.deepEqual(actionFilters(new URLSearchParams(), OWNER), { q: "", owner: OWNER, status: "waiting", priority: "", type: "", blocks: "" });
  assert.deepEqual(actionFilters(new URLSearchParams("owner=&status=bogus&priority=p9&type=bogus"), OWNER), { q: "", owner: "", status: "waiting", priority: "", type: "", blocks: "" });
  assert.equal(actionFilters(new URLSearchParams("type=approval"), OWNER).type, "approval");
  const kinds = [action("T", { kind: "fix" }), action("D", { kind: "decision" }), action("S", { kind: "approval" }), action("U", { kind: undefined })];
  assert.deepEqual(filterActions(kinds, { status: "all", type: "fix" }).map(({ id }) => id), ["T"]);
  assert.deepEqual(filterActions(kinds, { status: "all", type: "decision" }).map(({ id }) => id).sort(), ["D", "U"]);
  assert.deepEqual(filterActions(kinds, { status: "all", q: "sign-off" }).map(({ id }) => id), ["S"]);
  const sorted = filterActions([action("B", { priority: "p2" }), action("A", { priority: "p1", due: "2026-12-01" }), action("C", { priority: "p1", due: "2026-11-15" })], { owner: "", status: "all" });
  assert.deepEqual(sorted.map(({ id }) => id), ["C", "A", "B"]);
});

test("the sidebar links to Actions when the register exists and shows the workspace's brand", async (context) => {
  const { root, url, as } = await fixture(context);
  const index = await (await fetch(`${url}/`, { headers: { cookie: as(OWNER) } })).text();
  assert.match(index, /data-actions-href="\/actions"/);
  assert.match(index, /data-acknowledgements-href="\/acknowledgements"/);
  assert.doesNotMatch(index, /data-auditor-links-href/);
  const source = APP_SCRIPT.slice(APP_SCRIPT.indexOf("function helpNavigation"), APP_SCRIPT.indexOf("function sidebarGuidePanel"))
    + APP_SCRIPT.slice(APP_SCRIPT.indexOf("function navLink"), APP_SCRIPT.indexOf("function navIcon"));
  const navigation = (dataset, route = {}) => vm.runInNewContext(source + `
    helpNavigation(route) + "|" + [{ server: "actionsHref", href: "#/actions", label: "Actions", route: "actions" }, { server: "acknowledgementsHref", href: "#/acknowledgements", label: "My policies and training", route: "acknowledgements" }]
      .map((link) => navLink(link, route)?.html || "").join("")`, {
    document: { body: { dataset } }, esc: String, route, state: { actionSummary: { counts: { waiting: 3 } }, model: { resources: {} } }
  });
  assert.equal(navigation({ actionsHref: "/actions", helpHref: "/faq", acknowledgementsHref: "/acknowledgements" }, { name: "actions" }), '<a class="help-nav" href="#/help">Help</a>|<a class="sp-link current" href="#/actions" aria-current="page"><span>Actions</span><span class="sidebar-action-count" aria-label="3 waiting for your decision">3</span></a><a class="sp-link" href="#/acknowledgements"><span>My policies and training</span></a>');
  assert.match(navigation({ acknowledgementsHref: "/acknowledgements" }, { name: "acknowledgements" }), /<a class="sp-link current" href="#\/acknowledgements" aria-current="page"><span>My policies and training<\/span><\/a>/);
  assert.equal(navigation({}), "|");

  assert.ok(APP_SCRIPT.includes('esc(state.workspace.brandName || document.body.dataset.appName || "FileGRC")'));
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

test("the overview summary counts the signed-in person's waiting actions, or everyone's", async (context) => {
  const summary = summarizeActions([
    action("A", { priority: "p1", blocksPeriodStart: true, due: "2026-11-01" }),
    action("B", { due: "2026-12-01" }),
    action("C", { ownerId: OTHER, blocksPeriodStart: true }),
    action("D", { status: "done" })
  ], { viewerPersonId: OWNER, today: "2026-11-03" });
  assert.equal(summary.scope, "viewer");
  assert.deepEqual(summary.counts, { waiting: 2, blocking: 1, overdue: 1, waitingEveryone: 3, blockingEveryone: 2, overdueEveryone: 1, toReview: 2, toReviewEveryone: 3, dueSoonEveryone: 0, blocked: 0, blockedEveryone: 0, awaitingReview: 0, awaitingReviewEveryone: 0 });
  assert.deepEqual(summary.items.map(({ id, overdue }) => [id, overdue]), [["A", true], ["B", false]]);
  assert.equal(summarizeActions([action("B", { due: "2026-12-01" })], { today: "2026-11-17" }).counts.dueSoonEveryone, 1);
  assert.equal(summarizeActions([action("B", { due: "2026-12-01" })], { today: "2026-11-16" }).counts.dueSoonEveryone, 0);
  assert.equal(summarizeActions([action("A"), action("C", { ownerId: OTHER })]).scope, "everyone");

  const { url, as } = await fixture(context);
  const response = await fetch(`${url}/api/actions/summary`, { headers: { cookie: as(OWNER) } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.summary.scope, "viewer");
  assert.deepEqual(body.summary.items.map(({ id }) => id), ["ACT-001", "ACT-004"]);
  assert.equal(body.summary.viewerPersonId, OWNER);
  assert.equal(body.summary.items[0].ownerName.length > 0, true);
  const anonymous = await fetch(`${url}/api/actions/summary`, { redirect: "manual" });
  assert.equal(anonymous.status, 401);
});

test("waitingOn blocks an action while what it waits on is open, and releases it once that is settled", () => {
  assert.deepEqual(actionWaitingOn(action("A", { waitingOn: [{ action: " B " }, { label: "Sprinto's answer", until: "2026-12-01" }, { label: "x", until: "soon" }, { until: "2026-12-01" }, "B", null] })),
    [{ action: "B" }, { label: "Sprinto's answer", until: "2026-12-01" }, { label: "x" }]);
  assert.deepEqual(actionWaitingOn(action("A")), []);
  const blockedBy = (actions, id) => resolveWaitingOn(actions).actions.find((item) => item.id === id).blockedBy;
  for (const status of ["open", "proposed", "accepted"]) {
    assert.deepEqual(blockedBy([action("A", { waitingOn: [{ action: "B" }] }), action("B", { status })], "A"), [{ action: "B", title: "Question B", status }]);
  }
  for (const status of ["done", "dropped", "rejected"]) {
    assert.deepEqual(blockedBy([action("A", { waitingOn: [{ action: "B" }] }), action("B", { status })], "A"), [], `${status} no longer blocks`);
  }
  assert.deepEqual(blockedBy([action("A", { waitingOn: [{ label: "Sprinto's answer" }] })], "A"), [{ label: "Sprinto's answer" }], "a label blocks until it is removed");
  assert.deepEqual(blockedBy([action("A", { status: "done", waitingOn: [{ label: "Sprinto" }] })], "A"), [], "a closed action is never blocked");

  const { actions, problems } = resolveWaitingOn([
    action("A", { waitingOn: [{ action: "ACT-404" }, { action: "A" }] }),
    action("B", { waitingOn: "C" })
  ]);
  assert.deepEqual(actions.map(({ blockedBy: list }) => list), [[], []]);
  assert.deepEqual(problems, [
    "A waits on ACT-404, which is not in the register, so that entry does not block it.",
    "A waits on A, which is not another action, so that entry does not block it.",
    "B has a waitingOn that is not a list, so it is not treated as blocked."
  ]);

  // A response not yet filed counts: marking B done releases A at once.
  const pending = applyPendingDecisions([action("A", { waitingOn: [{ action: "B" }] }), action("B", { kind: "fix", status: "open" })],
    [{ id: "20261120T000000000Z-aaaaaa", actionId: "B", outcome: "done", by: OWNER, on: "2026-11-20T00:00:00.000Z", note: "Done." }]);
  assert.deepEqual(blockedBy(pending, "A"), []);

  const summary = summarizeActions([
    action("A", { waitingOn: [{ action: "B" }], blocksPeriodStart: true }),
    action("B", { ownerId: OTHER }),
    action("C", { waitingOn: [{ label: "Sprinto" }], ownerId: OTHER }),
    action("D")
  ], { viewerPersonId: OWNER, today: "2026-11-03" });
  assert.equal(summary.counts.waiting, 1);
  assert.equal(summary.counts.blocking, 0, "a blocked action is not counted as blocking the start");
  assert.equal(summary.counts.waitingEveryone, 2);
  assert.equal(summary.counts.blocked, 1);
  assert.equal(summary.counts.blockedEveryone, 2);
  assert.deepEqual(summary.items.map(({ id }) => id), ["D"]);
});

test("Needs you moves blocked actions into a closed Blocked group and every card says what it waits on", async (context) => {
  const { root, url, as, page } = await fixture(context);
  await writeFile(join(root, "actions", "ACT-004.json"), json(action("ACT-004", { waitingOn: [{ action: "ACT-002" }] })));
  await writeFile(join(root, "actions", "ACT-005.json"), json(action("ACT-005", { waitingOn: [{ label: "Sprinto's answer on the extension", until: "2026-12-01" }] })));
  await writeFile(join(root, "actions", "ACT-006.json"), json(action("ACT-006", { waitingOn: [{ action: "ACT-003" }, { action: "ACT-999" }] })));

  const mine = await page(OWNER);
  const needs = group(mine.body, "action-needs");
  assert.match(needs, /<h2 class="action-group-title">Needs you <span class="action-group-count">2<\/span><\/h2>/);
  const [list, blocked] = needs.split('<details class="action-blocked-group">');
  assert.match(list, /id="ACT-001"/);
  assert.match(list, /id="ACT-006"/, "waiting on a done action or an unknown one does not block");
  assert.doesNotMatch(list, /id="ACT-00[45]"/);
  assert.match(blocked, /^<summary><strong>Blocked<\/strong> · 2<\/summary>/);
  assert.match(blocked, /id="ACT-004"[\s\S]*<p class="action-waiting-on">Waiting on: <a href="\/actions\?q=ACT-002&amp;owner=&amp;status=all">ACT-002<\/a> Other &lt;script&gt;x&lt;\/script&gt;<\/p>/);
  assert.match(blocked, /id="ACT-005"[\s\S]*<p class="action-waiting-on">Waiting on: Sprinto&#39;s answer on the extension <span class="action-waiting-until">\(until 2026-12-01\)<\/span><\/p>/);
  assert.doesNotMatch(list, /action-waiting-on/);
  assert.match(mine.body, /ACT-006 waits on ACT-999, which is not in the register, so that entry does not block it\./);
  assert.match(mine.body, /aria-current="true">Me <span class="action-person-count" aria-label="2 waiting">2<\/span><\/a>/);

  // The line shows in every view, not only Needs you.
  const everyone = await page(OWNER, "?owner=&status=all");
  assert.doesNotMatch(everyone.body, /action-blocked-group/);
  assert.match(everyone.body, /id="ACT-004"[\s\S]*?<p class="action-waiting-on">Waiting on: <a href="\/actions[^"]*">ACT-002<\/a>/);

  const response = await fetch(`${url}/api/actions/summary`, { headers: { cookie: as(OWNER) } });
  const { summary } = await response.json();
  assert.equal(summary.counts.waiting, 2);
  assert.equal(summary.counts.blocked, 2);
  assert.deepEqual(summary.items.map(({ id }) => id), ["ACT-001", "ACT-006"]);
});

test("pending.json marks open actions an open pull request closes, and stale or bad entries do not", () => {
  const problems = [];
  const pending = parsePendingReviews(json({ generatedAt: "2026-11-28T07:30:00Z", entries: [
    { actionId: "A", status: "done", pullRequest: { number: 214, url: "https://github.com/o/r/pull/214" }, waitingFor: "person-ankit" },
    { actionId: "B", status: "dropped", pullRequest: { number: 7, url: "javascript:alert(1)" } },
    { actionId: "C", status: "accepted", pullRequest: { number: 8 } },
    { actionId: "D", status: "done", pullRequest: { number: 9 } },
    { actionId: "ACT-404", status: "done", pullRequest: { number: 10 } }
  ] }), problems);
  assert.deepEqual(pending.slice(0, 2), [
    { actionId: "A", status: "done", pullRequest: { number: 214, url: "https://github.com/o/r/pull/214" }, waitingFor: "person-ankit" },
    { actionId: "B", status: "dropped", pullRequest: { number: 7, url: null }, waitingFor: null }
  ]);
  assert.equal(pending.length, 4);
  assert.equal(problems.length, 1, "an entry with a status other than done or dropped is skipped");
  assert.deepEqual(parsePendingReviews("{", []), []);

  const { actions, problems: stale } = applyPendingReviews([action("A"), action("B", { status: "open" }), action("D", { status: "done" })], pending);
  assert.deepEqual(stale, ["actions/pending.json names ACT-404, which is not in the register."]);
  assert.equal(actions[0].pendingReview.waitingFor, "person-ankit");
  assert.equal(actions[1].pendingReview.status, "dropped");
  assert.equal(actions[2].pendingReview, undefined, "an action already closed on main ignores its entry");

  const summary = summarizeActions(resolveWaitingOn(actions).actions, { viewerPersonId: OWNER, today: "2026-11-03" });
  assert.equal(summary.counts.waiting, 0);
  assert.equal(summary.counts.awaitingReview, 2);
  assert.equal(summary.counts.blocked, 2);
});

test("Needs you moves actions an open pull request closes into Done, waiting for approval", async (context) => {
  const { root, url, as, page } = await fixture(context);
  await writeFile(join(root, "actions", "pending.json"), json({ generatedAt: "2026-11-28T07:30:00Z", entries: [
    { actionId: "ACT-001", status: "done", pullRequest: { number: 214, url: "https://github.com/GitLaw-co/compliance/pull/214" }, waitingFor: OTHER },
    { actionId: "ACT-003", status: "done", pullRequest: { number: 99 } }
  ] }));
  await writeFile(join(root, "actions", "ACT-005.json"), json(action("ACT-005", { waitingOn: [{ label: "Sprinto" }] })));

  const mine = await page(OWNER);
  assert.doesNotMatch(mine.body, /pending\.json was skipped|ACT-003, which/, "pending.json is not read as an action, and a closed action's entry is ignored quietly");
  const needs = group(mine.body, "action-needs");
  assert.match(needs, /<h2 class="action-group-title">Needs you <span class="action-group-count">1<\/span><\/h2>/);
  const [list, review, blocked] = needs.split('<details class="action-blocked-group">');
  assert.match(list, /id="ACT-004"/);
  assert.doesNotMatch(list, /id="ACT-001"/);
  assert.match(review, /^<summary><strong>Done, waiting for approval<\/strong> · 1<\/summary>/);
  assert.match(review, /id="ACT-001"[\s\S]*<p class="action-waiting-on">Done — waiting for [^<]+ in <a href="https:\/\/github\.com\/GitLaw-co\/compliance\/pull\/214">#214<\/a><\/p>/);
  assert.doesNotMatch(review, /Waiting on:/);
  assert.match(blocked, /^<summary><strong>Blocked<\/strong> · 1<\/summary>[\s\S]*id="ACT-005"/);

  const response = await fetch(`${url}/api/actions/summary`, { headers: { cookie: as(OWNER) } });
  const { summary } = await response.json();
  assert.equal(summary.counts.waiting, 1);
  assert.equal(summary.counts.awaitingReview, 1);
  assert.deepEqual(summary.items.map(({ id }) => id), ["ACT-004"]);
});

test("with a register branch, the page reads actions from that branch, not the workspace, and decisions still apply", async (context) => {
  const { root, remote, url, as, page, decide } = await fixture(context, { serve: { actionRegisterBranch: "actions", actionRefreshMs: 0 } });
  // The branch holds a newer register: ACT-001 has new wording and ACT-009 exists only there.
  await git(root, ["switch", "-c", "actions"]);
  await writeFile(join(root, "actions", "ACT-001.json"), json(action("ACT-001", { title: "Wording from the actions branch", priority: "p1", blocksPeriodStart: true })));
  await writeFile(join(root, "actions", "ACT-009.json"), json(action("ACT-009", { title: "Only on the actions branch" })));
  await git(root, ["add", "actions"]);
  await git(root, ["commit", "-m", "Update the register without a pull request"]);
  await git(root, ["push", "origin", "actions"]);
  await git(root, ["switch", "main"]);
  await git(root, ["reset", "--hard"]);

  const shown = await page(OWNER);
  assert.match(shown.body, /Wording from the actions branch/);
  assert.match(shown.body, /id="ACT-009"/);
  assert.doesNotMatch(shown.body, /Question ACT-001/, "the workspace copy is not shown");
  assert.equal(await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]), "main", "the checked-out branch is untouched");

  const response = await decide(OWNER, { actionId: "ACT-009", decision: "approve", answerRevision: seen("ACT-009"), owner: "", status: "all" });
  assert.equal(response.status, 303);
  const after = await page(OWNER, "?owner=&status=all");
  assert.match(after.body, /id="ACT-009"[\s\S]*?Approved/);
  assert.equal(await git(remote, ["rev-parse", "main"]), await git(root, ["rev-parse", "main"]), "main never moves");

  const index = await fetch(url, { headers: { cookie: as(OWNER) } });
  assert.match(await index.text(), /href="[^"]*actions/, "the sidebar links to Actions");
});

test("a missing register branch shows no register", async (context) => {
  const { page } = await fixture(context, { serve: { actionRegisterBranch: "actions", actionRefreshMs: 0 } });
  const shown = await page(OWNER);
  assert.doesNotMatch(shown.body, /id="ACT-001"/);
});

test("Actions opens inside the app: browsers are sent to #/actions and the app loads a fragment", async (context) => {
  const { url, as, decide } = await fixture(context);
  // fetch() sets its own Sec-Fetch-Mode, so a browser navigation needs a raw request.
  const navigate = await new Promise((resolve, reject) => {
    request(`${url}/actions?owner=&status=all`, { headers: { cookie: as(OWNER), "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } }, (response) => {
      response.resume();
      resolve({ status: response.statusCode, location: response.headers.location });
    }).on("error", reject).end();
  });
  assert.equal(navigate.status, 302);
  assert.equal(navigate.location, "/#/actions?owner=&status=all");
  const fragment = await (await fetch(`${url}/actions?fragment=1&owner=&status=all`, { headers: { cookie: as(OWNER) } })).text();
  assert.doesNotMatch(fragment, /<!doctype html>/i);
  assert.match(fragment, /^<div class="action-page">/);
  assert.match(fragment, /href="#\/actions\?q=&amp;owner=&amp;status=all/);
  const decided = await decide(OWNER, { actionId: "ACT-001", decision: "approve", answerRevision: seen("ACT-001"), owner: "", status: "all", fragment: "1" });
  assert.equal(decided.status, 303);
  assert.match(decided.headers.get("location"), /^\/actions\?owner=&status=all&decided=ACT-001&outcome=approved&fragment=1#ACT-001$/);
});

test("a workspace guide replaces the Autopilot promotion and validates", async (context) => {
  const { root } = await fixture(context);
  const source = APP_SCRIPT.slice(APP_SCRIPT.indexOf("function sidebarGuidePanel"), APP_SCRIPT.indexOf("function hostedNavigation"))
    + APP_SCRIPT.slice(APP_SCRIPT.indexOf("function workspaceGuide"), APP_SCRIPT.indexOf("function renderFirstOperatingTasks"));
  const panel = (workspace) => vm.runInNewContext(source + "\nsidebarGuidePanel()", {
    state: { workspace }, esc: String, HOSTED_AUTOMATION: { compactMessage: "Promo" }, hostedNavigation: () => "https://autopilot.example"
  });
  const guided = panel({ guideTitle: "How we work", guideMessage: "Read this first.", guideHref: "#/help/how-we-work" });
  assert.match(guided, /How we work/);
  assert.match(guided, /href="#\/help\/how-we-work"/);
  assert.doesNotMatch(guided, /autopilot/i);
  assert.match(panel({}), /Autopilot/);
  assert.match(panel({ guideHref: "javascript:alert(1)" }), /Autopilot/);
  const workspace = (await loadWorkspace(root)).entries.find(({ record }) => record.type === "workspace");
  await writeFile(workspace.path, json({ ...workspace.record, guideTitle: "How we work", guideMessage: "Read this first.", guideHref: "#/help/how-we-work" }));
  const validation = await captureCli(runCli, ["validate", "--root", root]);
  assert.equal(validation.exitCode, 0, validation.stdout + validation.stderr);
});

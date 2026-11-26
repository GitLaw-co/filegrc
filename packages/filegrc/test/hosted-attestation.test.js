import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runCli } from "../src/cli.js";
import { contentRevision } from "../src/files.js";
import { signSession } from "../src/hosted-auth.js";
import { listOwedAttestations } from "../src/resource-mutation.js";
import { serveWorkspace } from "../src/server.js";
import { formatCalendarDate } from "../src/time.js";
import { APP_STYLES, stripDocumentHeader } from "../src/web.js";
import { loadWorkspace } from "../src/workspace.js";
import { makeComprehensiveWorkspace } from "./fixtures.js";
import { captureCli } from "./helpers.js";

const execute = promisify(execFile);
const SESSION_SECRET = "test-session-secret-with-enough-length";
const WORKER = "person-example";
const OUTSIDER = "person-independent-approver-example";
const TRAINING = "training-example";

const git = async (cwd, args) => (await execute("git", args, { cwd })).stdout.trim();

// One approved training linked to the HR-02 training Control. Its audience is
// the internal workforce: the internal worker owes it, the external reviewer does not.
async function fixture(context, { repositoryMode = "trunk" } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "filegrc-hosted-attestation-"));
  const root = join(parent, "workspace");
  const remote = join(parent, "remote.git");
  await makeComprehensiveWorkspace(root, "13");
  // Approved, not yet activated content keeps the workspace valid without a
  // schedule-set review, so trunk writes accept it.
  for (const entry of (await loadWorkspace(root)).entries.filter(({ record }) => ["policy", "document", "training"].includes(record.type))) {
    const record = { ...entry.record, status: "approved" };
    for (const field of ["effectiveOn", "activationBasis", "activatedOn", "activatedByIds", "activatedContentRevisions"]) delete record[field];
    await writeFile(entry.path, `${JSON.stringify(record, null, 2)}\n`);
  }
  // Hosted sign-in matches a Person by email, so a signed-in Person has one.
  const worker = (await loadWorkspace(root)).entries.find(({ record }) => record.id === WORKER);
  await writeFile(worker.path, `${JSON.stringify({ ...worker.record, email: "jordan.lee@example.test" }, null, 2)}\n`);
  const controlPath = join(root, "data", "controls", "control-example.json");
  const control = JSON.parse(await readFile(controlPath, "utf8"));
  await writeFile(controlPath, `${JSON.stringify({ ...control, code: "HR-02" }, null, 2)}\n`);
  // Trunk mode: browser writes commit to main and push to origin.
  await writeFile(join(root, "data", "renderer.json"), `${JSON.stringify({
    id: "renderer-settings", type: "renderer-settings", title: "Renderer settings", showOnboarding: false,
    repositoryMode, authoritativeBranch: "main", repositoryRemote: "origin"
  }, null, 2)}\n`);
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
      publicUrl: "https://filegrc.example.com"
    }
  });
  context.after(async () => {
    await new Promise((resolve) => running.server.close(resolve));
    await rm(parent, { recursive: true, force: true });
  });
  const as = (personId) => `filegrc_session=${signSession({ personId, exp: Math.floor(Date.now() / 1000) + 600 }, SESSION_SECRET)}`;
  return { root, remote, url: running.url, as };
}

async function waitForPush(root, remote) {
  const head = await git(root, ["rev-parse", "HEAD"]);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await git(remote, ["rev-parse", "main"]) === head) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("The attestation commit was not pushed.");
}

test("the acknowledgements page lists owed training for its audience only", async (context) => {
  const { root, url, as } = await fixture(context);
  assert.deepEqual((await listOwedAttestations(root, WORKER)).map(({ subjectId }) => subjectId), [TRAINING]);
  assert.deepEqual(await listOwedAttestations(root, OUTSIDER), []);

  const worker = await fetch(`${url}/acknowledgements`, { headers: { cookie: as(WORKER) } });
  assert.equal(worker.status, 200);
  const page = await worker.text();
  // The list links each owed item to its reader; confirming happens there.
  assert.match(page, /My policies and training/);
  assert.match(page, /0 of 1 done/);
  assert.match(page, new RegExp(`href="/acknowledgements\\?item=${TRAINING}"[^>]*>Security Awareness Training<`));
  assert.doesNotMatch(page, /name="subjectResourceId"/);
  // The app shell locks html/body scrolling; a standalone page must opt out or long content cannot be read.
  assert.match(page, /<body class="standalone-page">/);

  const reader = await (await fetch(`${url}/acknowledgements?item=${TRAINING}`, { headers: { cookie: as(WORKER) } })).text();
  assert.match(reader, /<h1>Security Awareness Training<\/h1>/);
  assert.match(reader, new RegExp(`<form class="ack-confirm" method="post" action="/acknowledgements">\\s*<input type="hidden" name="subjectResourceId" value="${TRAINING}">`));
  assert.match(reader, />I have completed Security Awareness Training</);
  assert.match(reader, /min read/);

  const outsider = await (await fetch(`${url}/acknowledgements`, { headers: { cookie: as(OUTSIDER) } })).text();
  assert.doesNotMatch(outsider, /Security Awareness Training/);
  assert.match(outsider, /You're up to date/);
  const notOwed = await (await fetch(`${url}/acknowledgements?item=${TRAINING}`, { headers: { cookie: as(OUTSIDER) } })).text();
  assert.match(notOwed, /That item is not waiting for you/);
  assert.doesNotMatch(notOwed, /name="subjectResourceId"/);

  const signedOut = await fetch(`${url}/acknowledgements`, { redirect: "manual" });
  assert.equal(signedOut.status, 302);
});

test("submitting records the session's person, binds the current revision and commits one file", async (context) => {
  const { root, remote, url, as } = await fixture(context);
  const before = await git(root, ["rev-parse", "HEAD"]);
  const trainingRevision = contentRevision((await execute("git", ["show", `${before}:data/training/training-example.md`], { cwd: root })).stdout);

  const notOwed = await fetch(`${url}/acknowledgements`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: as(OUTSIDER), "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    body: new URLSearchParams({ subjectResourceId: TRAINING }).toString()
  });
  assert.equal(notOwed.status, 400);
  assert.equal(await git(root, ["rev-parse", "HEAD"]), before);

  // The body names another person; the session decides who attests.
  const response = await fetch(`${url}/acknowledgements`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: as(WORKER), "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    body: new URLSearchParams({ subjectResourceId: TRAINING, personId: OUTSIDER }).toString()
  });
  assert.equal(response.status, 303, await response.text());
  assert.equal(response.headers.get("location"), "/acknowledgements?done=training-example");

  assert.equal(await git(root, ["rev-list", "--count", `${before}..HEAD`]), "1");
  const changed = (await git(root, ["show", "--name-only", "--format=", "HEAD"])).split("\n");
  assert.equal(changed.length, 1);
  assert.match(changed[0], /^data\/attestations\/[a-z0-9-]+\.json$/);
  const person = (await loadWorkspace(root)).resources.find(({ id }) => id === WORKER);
  assert.equal(await git(root, ["log", "-1", "--format=%an <%ae>"]), `${person.title} <${person.email}>`);
  assert.equal(await git(root, ["log", "-1", "--format=%cn <%ce>"]), "FileGRC Server <server@example.test>");
  assert.match(await git(root, ["log", "-1", "--format=%s"]), /^Record attestation: Security Awareness Training completion \(person-example\)$/);

  const record = JSON.parse(await readFile(join(root, changed[0]), "utf8"));
  assert.equal(record.type, "attestation");
  assert.equal(record.personId, WORKER);
  assert.deepEqual(record.subjectResourceIds, [TRAINING]);
  assert.equal(record.status, "completed");
  assert.equal(record.attestationMethod, "git-approval");
  assert.deepEqual(record.contentRevisions, { "training/training-example.md": trainingRevision });
  await waitForPush(root, remote);

  assert.deepEqual(await listOwedAttestations(root, WORKER), []);
  // Completed work stays listed, read-only.
  const after = await (await fetch(`${url}/acknowledgements?done=${TRAINING}`, { headers: { cookie: as(WORKER) } })).text();
  assert.match(after, /committed to the program repository/);
  assert.match(after, /1 of 1 done/);
  assert.match(after, /You're up to date/);
  assert.match(after, new RegExp(`Security Awareness Training</span>[\\s\\S]*Done on ${formatCalendarDate(record.completedOn)}`));
  assert.doesNotMatch(after, /name="subjectResourceId"/);
  const validation = await captureCli(runCli, ["validate", "--root", root]);
  assert.equal(validation.exitCode, 0, validation.stdout + validation.stderr);
});

test("outside trunk mode an acknowledgement is saved on the decisions branch, never on main", async (context) => {
  const { root, remote, url, as } = await fixture(context, { repositoryMode: "manual" });
  const mainBefore = await git(remote, ["rev-parse", "main"]);
  const headBefore = await git(root, ["rev-parse", "HEAD"]);
  const post = () => fetch(`${url}/acknowledgements`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: as(WORKER), "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    body: new URLSearchParams({ subjectResourceId: TRAINING }).toString()
  });
  const response = await post();
  assert.equal(response.status, 303, await response.text());
  assert.equal(await git(remote, ["rev-parse", "main"]), mainBefore);
  assert.equal(await git(root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(await git(root, ["status", "--porcelain"]), "");

  const files = (await git(remote, ["ls-tree", "-r", "--name-only", "action-decisions"])).split("\n");
  assert.equal(files.length, 1);
  assert.match(files[0], /^data\/attestations\/[a-z0-9-]+\.json$/);
  const record = JSON.parse(await git(remote, ["show", `action-decisions:${files[0]}`]));
  assert.equal(record.personId, WORKER);
  assert.deepEqual(record.subjectResourceIds, [TRAINING]);
  assert.equal(record.attestationMethod, "git-approval");
  assert.deepEqual(Object.keys(record.contentRevisions), ["training/training-example.md"]);
  const person = (await loadWorkspace(root)).resources.find(({ id }) => id === WORKER);
  assert.equal(await git(remote, ["log", "-1", "--format=%an <%ae>", "action-decisions"]), `${person.title} <${person.email}>`);

  // The page counts it as done, and a second submit is refused.
  const page = await (await fetch(`${url}/acknowledgements?done=${TRAINING}`, { headers: { cookie: as(WORKER) } })).text();
  assert.match(page, /saved and is added to the program record at the next review/);
  assert.match(page, /Done on /);
  assert.doesNotMatch(page, new RegExp(`value="${TRAINING}"`));
  const again = await post();
  assert.equal(again.status, 409);
  assert.equal((await git(remote, ["ls-tree", "-r", "--name-only", "action-decisions"])).split("\n").length, 1);
});

test("standalone pages scroll the viewport, not a body that cannot scroll", () => {
  // overflow:auto on body made it a scroll container with auto height, and Basecoat's
  // overscroll-behavior:none on body kept wheel and trackpad scrolling from reaching the viewport.
  const rule = /html:has\(>body\.standalone-page\),body\.standalone-page\{([^}]*)\}/.exec(APP_STYLES);
  assert.ok(rule, "the standalone-page opt-out rule is missing");
  assert.match(rule[1], /overflow:visible/);
  assert.doesNotMatch(rule[1], /overflow:(auto|scroll|hidden)/);
  assert.match(APP_STYLES, /body\.standalone-page\{overscroll-behavior:auto\}/);
});

test("the reader drops a spec header block and the repeated title", () => {
  const source = "Status: Approved\nOwner: @gitlaw\nLast-Reviewed: 2026-03-23\nLayer: 20-policies\nDepends-On: none\n\n# HR Security Procedure\n\nVersion 1\n\n## Objective\n\nText.";
  assert.equal(stripDocumentHeader(source, "HR Security Procedure"), "\nVersion 1\n\n## Objective\n\nText.");
  assert.equal(stripDocumentHeader("Status: Approved • Owner: @gitlaw\n\nBody", "Other"), "Body");
  // A document without the block keeps its opening line, even one shaped like a field.
  assert.equal(stripDocumentHeader("Purpose: keep data safe.\n\nBody", "Policy"), "Purpose: keep data safe.\n\nBody");
  assert.equal(stripDocumentHeader("# Another heading\n\nBody", "Policy"), "# Another heading\n\nBody");
});

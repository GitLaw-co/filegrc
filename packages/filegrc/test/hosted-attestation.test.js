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
async function fixture(context) {
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
  const controlPath = join(root, "data", "controls", "control-example.json");
  const control = JSON.parse(await readFile(controlPath, "utf8"));
  await writeFile(controlPath, `${JSON.stringify({ ...control, code: "HR-02" }, null, 2)}\n`);
  // Trunk mode: browser writes commit to main and push to origin.
  await writeFile(join(root, "data", "renderer.json"), `${JSON.stringify({
    id: "renderer-settings", type: "renderer-settings", title: "Renderer settings", showOnboarding: false,
    repositoryMode: "trunk", authoritativeBranch: "main", repositoryRemote: "origin"
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
  assert.match(page, /Security Awareness Training/);
  assert.match(page, new RegExp(`name="subjectResourceId" value="${TRAINING}"`));

  const outsider = await (await fetch(`${url}/acknowledgements`, { headers: { cookie: as(OUTSIDER) } })).text();
  assert.doesNotMatch(outsider, /Security Awareness Training/);
  assert.match(outsider, /nothing to acknowledge/i);

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
  const validation = await captureCli(runCli, ["validate", "--root", root]);
  assert.equal(validation.exitCode, 0, validation.stdout + validation.stderr);
});

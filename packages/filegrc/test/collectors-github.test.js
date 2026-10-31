import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { executeCli } from "./helpers.js";
import { makeComprehensiveWorkspace } from "./fixtures.js";

const cli = fileURLToPath(new URL("../bin/filegrc.js", import.meta.url));
const execute = (args) => executeCli(runCli, process.execPath, [cli, ...args]);
const run = promisify(execFile);

const RESPONSES = {
  "/orgs/acme-example": { login: "acme-example", two_factor_requirement_enabled: true },
  "/repos/acme-example/app": { full_name: "acme-example/app", default_branch: "main" },
  "/repos/acme-example/app/branches/main": { name: "main", protected: false }
};

async function setup(context, { token = "stub-token" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "filegrc-collect-github-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { records } = await makeComprehensiveWorkspace(root, "13");
  const program = records.find(({ type }) => type === "program");
  const control = records.find(({ type, id }) => type === "control" && program.controlIds.includes(id));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const body = RESPONSES[request.url];
    response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? { message: "Not Found" }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const saved = { token: process.env.GITHUB_TOKEN, url: process.env.GITHUB_API_URL };
  if (token) process.env.GITHUB_TOKEN = token;
  else delete process.env.GITHUB_TOKEN;
  process.env.GITHUB_API_URL = `http://127.0.0.1:${server.address().port}`;
  context.after(() => {
    for (const [name, value] of [["GITHUB_TOKEN", saved.token], ["GITHUB_API_URL", saved.url]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return new Promise((done) => server.close(done));
  });
  const args = (mode) => [
    "collect", "github", mode, "--org", "acme-example", "--repos", "acme-example/app",
    "--component", "component-example", "--collector", "person-example",
    "--classification", "classification-example", "--controls", control.id, "--root", root
  ];
  return { root, control, requests, args };
}

async function dataSnapshot(root) {
  const files = await readdir(join(root, "data"), { recursive: true, withFileTypes: true });
  const paths = files.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")])));
}

test("collect github --preview prints check and evidence payloads and writes nothing", async (context) => {
  const { root, requests, args } = await setup(context);
  const before = await dataSnapshot(root);
  const { stdout } = await execute(args("--preview"));
  assert.match(stdout, /Create automated-check\/automated-check-github-org-2fa-acme-example/);
  assert.match(stdout, /Create automated-check\/automated-check-github-branch-protection-acme-example-app/);
  assert.match(stdout, /Create evidence\/evidence-github-org-2fa-acme-example-\d{8}t\d{6}z\tpassed/);
  assert.match(stdout, /Create evidence\/evidence-github-branch-protection-acme-example-app-\d{8}t\d{6}z\tfailed/);
  assert.match(stdout, /"sourceComponentId": "component-example"/);
  assert.match(stdout, /No workspace files were changed\./);
  assert.deepEqual(await dataSnapshot(root), before);
  assert.ok(requests.every(({ authorization }) => authorization === "Bearer stub-token"));
  assert.doesNotMatch(stdout, /stub-token/);
});

test("collect github --apply writes valid checks and results naming the source Component and collector", async (context) => {
  const { root, control, args } = await setup(context);
  const result = JSON.parse((await execute([...args("--apply"), "--json"])).stdout);
  assert.equal(result.created.length, 4);
  const validation = JSON.parse((await execute(["validate", root, "--json"]).catch((failure) => failure)).stdout);
  assert.deepEqual(validation.diagnostics.filter(({ severity, path }) => severity === "error" && /github/.test(path)), []);
  const evidenceIds = result.created.filter((id) => id.startsWith("evidence-"));
  assert.equal(evidenceIds.length, 2);
  for (const id of evidenceIds) {
    const record = JSON.parse(await readFile(join(root, "data", "evidence", id, "evidence.json"), "utf8"));
    assert.equal(record.sourceComponentId, "component-example");
    assert.deepEqual(record.collectorIds, ["person-example"]);
    assert.deepEqual(record.controlIds, [control.id]);
    const markdown = (await readdir(join(root, "data", "evidence", id))).filter((name) => name.endsWith(".md"));
    assert.equal(markdown.length, 1);
    assert.match(await readFile(join(root, "data", "evidence", id, markdown[0]), "utf8"), /GET \/(orgs|repos)\//);
  }
  const check = JSON.parse(await readFile(join(root, "data", "automated-checks", "automated-check-github-org-2fa-acme-example.json"), "utf8"));
  assert.equal(check.sourceComponentId, "component-example");
  assert.equal(check.status, "active");
  const rerun = JSON.parse((await execute([...args("--preview").filter((arg, index, all) => arg !== "--controls" && all[index - 1] !== "--controls"), "--json"])).stdout);
  assert.deepEqual(rerun.checks, []);
  assert.deepEqual(rerun.evidence.map(({ record }) => record.controlIds), [[control.id], [control.id]]);
});

test("collect github without a token exits non-zero with a plain message and writes nothing", async (context) => {
  const { root, requests, args } = await setup(context, { token: null });
  const before = await dataSnapshot(root);
  const failure = await run(process.execPath, [cli, ...args("--apply")], { env: process.env }).then(() => null, (error) => error);
  assert.ok(failure, "collect must fail without a token");
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /^Set GITHUB_TOKEN to a read-only token/);
  assert.deepEqual(requests, []);
  assert.deepEqual(await dataSnapshot(root), before);
});

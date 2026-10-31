import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
const VARIABLES = ["FILEGRC_GCP_CREDENTIALS", "FILEGRC_GCP_TOKEN_URL", "FILEGRC_GCP_API_URL"];

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const KEY = JSON.stringify({
  type: "service_account",
  project_id: "demo-project",
  private_key_id: "test-key-id",
  private_key: PRIVATE_PEM,
  client_email: "collector@demo-project.iam.gserviceaccount.com"
});
const KEY_BODY = PRIVATE_PEM.split("\n")[1];

const AUDITED = { auditConfigs: [{ service: "allServices", auditLogConfigs: [{ logType: "ADMIN_READ" }, { logType: "DATA_READ" }, { logType: "DATA_WRITE" }] }] };
const PRIVATE_POLICY = { bindings: [{ role: "roles/owner", members: ["user:owner@example.com"] }], ...AUDITED };
const PUBLIC_POLICY = { bindings: [{ role: "roles/viewer", members: ["group:team@example.com", "allUsers"] }] };

async function setup(context, { credentials = KEY, policy = PRIVATE_POLICY } = {}) {
  const root = await mkdtemp(join(tmpdir(), "filegrc-collect-gcp-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { records } = await makeComprehensiveWorkspace(root, "13");
  const program = records.find(({ type }) => type === "program");
  const control = records.find(({ type, id }) => type === "control" && program.controlIds.includes(id));
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      const reply = request.method !== "POST" ? null
        : request.url === "/token" ? { access_token: "stub-access-token", token_type: "Bearer", expires_in: 3600 }
          : request.url === "/v1/projects/demo-project:getIamPolicy" && request.headers.authorization === "Bearer stub-access-token" ? policy
            : null;
      response.writeHead(reply ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(reply ?? { error: { message: "Not Found" } }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  const base = `http://127.0.0.1:${server.address().port}`;
  if (credentials) process.env.FILEGRC_GCP_CREDENTIALS = credentials;
  else delete process.env.FILEGRC_GCP_CREDENTIALS;
  process.env.FILEGRC_GCP_TOKEN_URL = `${base}/token`;
  process.env.FILEGRC_GCP_API_URL = base;
  context.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return new Promise((done) => server.close(done));
  });
  const args = (mode, { project = "demo-project" } = {}) => [
    "collect", "gcp", mode, ...(project ? ["--project", project] : []),
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

test("collect gcp --preview prints check and evidence payloads and writes nothing", async (context) => {
  const { root, requests, args } = await setup(context);
  const before = await dataSnapshot(root);
  const { stdout } = await execute(args("--preview"));
  assert.match(stdout, /Create automated-check\/automated-check-gcp-public-iam-demo-project\n/);
  assert.match(stdout, /Create automated-check\/automated-check-gcp-data-access-audit-demo-project\n/);
  assert.match(stdout, /Create evidence\/evidence-gcp-public-iam-demo-project-\d{8}t\d{6}z\tpassed/);
  assert.match(stdout, /Create evidence\/evidence-gcp-data-access-audit-demo-project-\d{8}t\d{6}z\tpassed/);
  assert.match(stdout, /No workspace files were changed\./);
  assert.deepEqual(await dataSnapshot(root), before);
  assert.deepEqual(requests.map(({ url }) => url), ["/token", "/v1/projects/demo-project:getIamPolicy"]);
  assert.doesNotMatch(stdout, /stub-access-token/);
  assert.ok(!stdout.includes(KEY_BODY));
});

test("collect gcp signs the token request with the service account key for a read-only scope", async (context) => {
  const { requests, args } = await setup(context);
  await execute(args("--preview"));
  const form = new URLSearchParams(requests.find(({ url }) => url === "/token").body);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [header, claims, signature] = form.get("assertion").split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url"));
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT", kid: "test-key-id" });
  const payload = JSON.parse(Buffer.from(claims, "base64url"));
  assert.equal(payload.scope, "https://www.googleapis.com/auth/cloud-platform.read-only");
  assert.equal(payload.iss, "collector@demo-project.iam.gserviceaccount.com");
  assert.equal(payload.aud, process.env.FILEGRC_GCP_TOKEN_URL);
  assert.equal(payload.exp - payload.iat, 3600);
});

test("collect gcp fails the public IAM check and names allUsers on roles/viewer", async (context) => {
  const { args } = await setup(context, { policy: PUBLIC_POLICY });
  const result = JSON.parse((await execute([...args("--preview"), "--json"])).stdout);
  const [publicIam, dataAccess] = result.evidence;
  assert.equal(publicIam.record.operatingResult, "failed");
  assert.match(publicIam.content.content, /^- roles\/viewer allUsers$/m);
  assert.doesNotMatch(publicIam.content.content, /group:team/);
  assert.equal(dataAccess.record.operatingResult, "failed");
  assert.match(dataAccess.content.content, /- missing: DATA_READ, DATA_WRITE/);
});

test("collect gcp --apply with a key file writes valid records naming the source Component and collector", async (context) => {
  const keyDir = await mkdtemp(join(tmpdir(), "filegrc-gcp-key-"));
  context.after(() => rm(keyDir, { recursive: true, force: true }));
  await writeFile(join(keyDir, "key.json"), KEY);
  const { root, control, args } = await setup(context, { credentials: join(keyDir, "key.json") });
  const { stdout } = await execute([...args("--apply"), "--json"]);
  assert.ok(!stdout.includes(KEY_BODY));
  const result = JSON.parse(stdout);
  assert.equal(result.created.length, 4);
  const validation = JSON.parse((await execute(["validate", root, "--json"]).catch((failure) => failure)).stdout);
  assert.deepEqual(validation.diagnostics.filter(({ severity, path }) => severity === "error" && /gcp/.test(path)), []);
  for (const id of result.created.filter((created) => created.startsWith("evidence-"))) {
    const record = JSON.parse(await readFile(join(root, "data", "evidence", id, "evidence.json"), "utf8"));
    assert.equal(record.sourceComponentId, "component-example");
    assert.deepEqual(record.collectorIds, ["person-example"]);
    assert.deepEqual(record.controlIds, [control.id]);
    assert.equal(record.operatingResult, "passed");
  }
  const check = JSON.parse(await readFile(join(root, "data", "automated-checks", "automated-check-gcp-public-iam-demo-project.json"), "utf8"));
  assert.equal(check.sourceComponentId, "component-example");
});

for (const [name, options, message] of [
  ["without credentials", { credentials: null }, /^Set FILEGRC_GCP_CREDENTIALS to a read-only token/],
  ["without --project", { project: null }, /^Pass --project <project-id>/],
  ["with an unparsable key", { credentials: `{ ${KEY.slice(1, -1)}` }, /^FILEGRC_GCP_CREDENTIALS must be a service account key in JSON/]
]) {
  test(`collect gcp ${name} exits non-zero with a plain message, writes nothing and never prints the key`, async (context) => {
    const { root, requests, args } = await setup(context, options);
    const before = await dataSnapshot(root);
    const failure = await run(process.execPath, [cli, ...args("--apply", options)], { env: process.env }).then(() => null, (error) => error);
    assert.ok(failure, "collect must fail");
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, message);
    assert.ok(!`${failure.stdout}${failure.stderr}`.includes(KEY_BODY));
    assert.deepEqual(requests, []);
    assert.deepEqual(await dataSnapshot(root), before);
  });
}

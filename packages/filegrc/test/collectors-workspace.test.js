import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
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
const VARIABLES = ["FILEGRC_WORKSPACE_CREDENTIALS", "FILEGRC_WORKSPACE_TOKEN_URL", "FILEGRC_WORKSPACE_API_URL"];
const USERS_PATH = "/admin/directory/v1/users";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const KEY = JSON.stringify({ private_key: PRIVATE_PEM, client_email: "collector@demo-project.iam.gserviceaccount.com" });
const KEY_BODY = PRIVATE_PEM.split("\n")[1];

const user = (name, fields = {}) => ({ primaryEmail: `${name}@example.com`, isEnrolledIn2Sv: true, isAdmin: false, suspended: false, ...fields });
const ENROLLED = [
  [user("admin", { isAdmin: true }), user("ana"), user("ben", { isAdmin: true })],
  [user("cleo"), user("dev", { isAdmin: true }), user("old", { isEnrolledIn2Sv: false, suspended: true })]
];

async function setup(context, { credentials = KEY, pages = ENROLLED } = {}) {
  const root = await mkdtemp(join(tmpdir(), "filegrc-collect-workspace-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { records } = await makeComprehensiveWorkspace(root, "13");
  const { controlIds } = records.find(({ type }) => type === "program");
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url, body });
      const url = new URL(request.url, "http://127.0.0.1");
      const index = Number(url.searchParams.get("pageToken") || 0);
      const reply = request.method === "POST" && url.pathname === "/token" ? { access_token: "stub-access-token", token_type: "Bearer", expires_in: 3600 }
        : request.method === "GET" && url.pathname === USERS_PATH && url.searchParams.get("customer") === "my_customer"
          && request.headers.authorization === "Bearer stub-access-token" && pages[index]
          ? { users: pages[index], ...(pages[index + 1] ? { nextPageToken: String(index + 1) } : {}) }
          : null;
      response.writeHead(reply ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(reply ?? { error: { message: "Not Found" } }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  const base = `http://127.0.0.1:${server.address().port}`;
  if (credentials) process.env.FILEGRC_WORKSPACE_CREDENTIALS = credentials;
  else delete process.env.FILEGRC_WORKSPACE_CREDENTIALS;
  process.env.FILEGRC_WORKSPACE_TOKEN_URL = `${base}/token`;
  process.env.FILEGRC_WORKSPACE_API_URL = base;
  context.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return new Promise((done) => server.close(done));
  });
  const args = (mode, { admin = "admin@example.com", extra = [] } = {}) => [
    "collect", "workspace", mode, ...(admin ? ["--admin", admin] : []), ...extra,
    "--component", "component-example", "--collector", "person-example",
    "--classification", "classification-example", "--controls", controlIds[0], "--root", root
  ];
  return { root, requests, args };
}

async function dataSnapshot(root) {
  const files = await readdir(join(root, "data"), { recursive: true, withFileTypes: true });
  const paths = files.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")])));
}

async function preview(args, extra) {
  return JSON.parse((await execute([...args("--preview", { extra }), "--json"])).stdout).evidence;
}

test("collect workspace --preview reads both user pages, prints both payload pairs and writes nothing", async (context) => {
  const { root, requests, args } = await setup(context);
  const before = await dataSnapshot(root);
  const { stdout } = await execute(args("--preview"));
  assert.match(stdout, /Create automated-check\/automated-check-workspace-2sv-enrolment\n/);
  assert.match(stdout, /Create automated-check\/automated-check-workspace-admin-count\n/);
  assert.match(stdout, /Create evidence\/evidence-workspace-2sv-enrolment-\d{8}t\d{6}z\tpassed/);
  assert.match(stdout, /Create evidence\/evidence-workspace-admin-count-\d{8}t\d{6}z\tpassed/);
  assert.match(stdout, /No workspace files were changed\./);
  assert.deepEqual(await dataSnapshot(root), before);
  const listed = requests.filter(({ url }) => url.startsWith(USERS_PATH)).map(({ url }) => new URL(url, "http://127.0.0.1").searchParams.get("pageToken"));
  assert.deepEqual(listed, [null, "1"]);
  assert.ok(!stdout.includes("stub-access-token") && !stdout.includes(KEY_BODY));
});

test("collect workspace signs a delegated token request for --admin with the directory read-only scope", async (context) => {
  const { requests, args } = await setup(context);
  await execute(args("--preview"));
  const form = new URLSearchParams(requests.find(({ url }) => url === "/token").body);
  const [header, claims, signature] = form.get("assertion").split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url"));
  const payload = JSON.parse(Buffer.from(claims, "base64url"));
  assert.equal(payload.sub, "admin@example.com");
  assert.equal(payload.scope, "https://www.googleapis.com/auth/admin.directory.user.readonly");
  assert.equal(payload.aud, process.env.FILEGRC_WORKSPACE_TOKEN_URL);
});

test("collect workspace fails 2-step verification for an active unenrolled user and ignores a suspended one", async (context) => {
  const { args } = await setup(context, { pages: [[...ENROLLED[0], user("eve", { isEnrolledIn2Sv: false })], ENROLLED[1]] });
  const [enrolment] = await preview(args);
  assert.equal(enrolment.record.operatingResult, "failed");
  assert.match(enrolment.content.content, /^- eve@example\.com$/m);
  assert.doesNotMatch(enrolment.content.content, /old@example\.com/);
});

test("collect workspace fails the admin count above --max-admins and passes at the limit", async (context) => {
  const { args } = await setup(context, { pages: [[...ENROLLED[0], user("fay", { isAdmin: true })], ENROLLED[1]] });
  const [, four] = await preview(args);
  assert.equal(four.record.operatingResult, "failed");
  assert.match(four.content.content, /- users with isAdmin: 4\n- allowed: 3/);
  const [, raised] = await preview(args, ["--max-admins", "4"]);
  assert.equal(raised.record.operatingResult, "passed");
});

for (const [name, options, message] of [
  ["without credentials", { credentials: null }, /^Set FILEGRC_WORKSPACE_CREDENTIALS to a read-only token/],
  ["without --admin", { admin: null }, /^Pass --admin <email>/]
]) {
  test(`collect workspace ${name} exits non-zero with a plain message and writes nothing`, async (context) => {
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

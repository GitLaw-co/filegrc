import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
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
const VARIABLES = ["FILEGRC_WORKSPACE_CREDENTIALS", "FILEGRC_WORKSPACE_TOKEN_URL", "FILEGRC_WORKSPACE_API_URL", "FILEGRC_CLOUD_IDENTITY_API_URL"];
const USERS_PATH = "/admin/directory/v1/users";
const DIRECTORY_SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";
const DEVICES_SCOPE = "https://www.googleapis.com/auth/cloud-identity.devices.readonly";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = JSON.stringify({ private_key: privateKey.export({ type: "pkcs8", format: "pem" }), client_email: "collector@demo-project.iam.gserviceaccount.com" });
const USERS = [{ primaryEmail: "admin@example.com", isEnrolledIn2Sv: true, isAdmin: true, suspended: false }];

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
const device = (id, fields) => ({ name: `devices/${id}`, model: "Laptop", encryptionState: "ENCRYPTED", lastSyncTime: daysAgo(1), ...fields });
const owner = (name, fields = {}) => ({
  name: `users/${name}`, userEmail: `${name}@example.com`, passwordState: "PASSWORD_SET", managementState: "APPROVED", firstSyncTime: "2026-01-05T09:00:00Z", ...fields
});
// Two pages: three current laptops, an older sync of the same Mac serial, and a
// Mac last synced 31 days ago.
const PAGES = [
  [device("mac", { deviceType: "MAC_OS", osVersion: "MacOS 15.2.0", serialNumber: "SERIAL-MAC", model: "MacBook Pro" }),
    device("win", { deviceType: "WINDOWS", osVersion: "Windows 10.0.22631", serialNumber: "SERIAL-WIN", lastSyncTime: daysAgo(2) })],
  [device("linux", { deviceType: "LINUX", osVersion: "Linux 6.8.0", serialNumber: "SERIAL-LINUX" }),
    device("mac-old", { deviceType: "MAC_OS", osVersion: "MacOS 14.6.0", serialNumber: "SERIAL-MAC", lastSyncTime: daysAgo(5) }),
    device("mac-stale", { deviceType: "MAC_OS", osVersion: "MacOS 10.15.7", serialNumber: "SERIAL-STALE", model: "MacBook Air", lastSyncTime: daysAgo(31) })]
];
const DEVICE_USERS = { mac: [owner("ana")], win: [owner("ben")], linux: [owner("cleo")], "mac-old": [owner("ana")], "mac-stale": [owner("dev")] };

async function setup(context, { pages = PAGES, deviceUsers = DEVICE_USERS } = {}) {
  const root = await mkdtemp(join(tmpdir(), "filegrc-collect-workspace-devices-"));
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
      const authorized = request.headers.authorization === "Bearer stub-access-token";
      const index = Number(url.searchParams.get("pageToken") || 0);
      const users = /^\/v1\/devices\/([^/]+)\/deviceUsers$/.exec(url.pathname);
      const reply = request.method === "POST" && url.pathname === "/token" ? { access_token: "stub-access-token", token_type: "Bearer", expires_in: 3600 }
        : !authorized ? null
          : url.pathname === USERS_PATH ? { users: USERS }
            : url.searchParams.get("customer") !== "customers/my_customer" ? null
              : url.pathname === "/v1/devices" && pages[index] ? { devices: pages[index], ...(pages[index + 1] ? { nextPageToken: String(index + 1) } : {}) }
                : users && deviceUsers[users[1]] ? { deviceUsers: deviceUsers[users[1]] }
                  : null;
      response.writeHead(reply ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(reply ?? { error: { message: "Not Found" } }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.FILEGRC_WORKSPACE_CREDENTIALS = KEY;
  process.env.FILEGRC_WORKSPACE_TOKEN_URL = `${base}/token`;
  process.env.FILEGRC_WORKSPACE_API_URL = base;
  process.env.FILEGRC_CLOUD_IDENTITY_API_URL = base;
  context.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return new Promise((done) => server.close(done));
  });
  const args = (extra = []) => [
    "collect", "workspace", "--preview", "--admin", "admin@example.com", ...extra,
    "--component", "component-example", "--collector", "person-example",
    "--classification", "classification-example", "--controls", controlIds[0], "--root", root
  ];
  const preview = async (extra = ["--devices"]) => {
    const { evidence } = JSON.parse((await execute([...args(extra), "--json"])).stdout);
    return Object.fromEntries(evidence.map(({ record, content }) => [record.id.replace(/^evidence-|-\d{8}t\d{6}z$/g, ""), { result: record.operatingResult, text: content.content }]));
  };
  return { root, requests, args, preview };
}

async function dataSnapshot(root) {
  const files = await readdir(join(root, "data"), { recursive: true, withFileTypes: true });
  const paths = files.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")])));
}

const scopeOf = (requests) => JSON.parse(Buffer.from(new URLSearchParams(requests.find(({ url }) => url === "/token").body).get("assertion").split(".")[1], "base64url")).scope;

test("collect workspace --devices --preview prints the inventory and four device runs beside the user runs and writes nothing", async (context) => {
  const { root, requests, args } = await setup(context);
  const before = await dataSnapshot(root);
  const { stdout } = await execute(args(["--devices"]));
  for (const key of ["2sv-enrolment", "admin-count", "device-inventory", "device-encryption", "device-screen-lock", "device-os-supported", "device-owner"]) {
    assert.match(stdout, new RegExp(`Create automated-check/automated-check-workspace-${key}\\n`));
    assert.match(stdout, new RegExp(`Create evidence/evidence-workspace-${key}-\\d{8}t\\d{6}z\\tpassed`));
  }
  assert.match(stdout, /No workspace files were changed\./);
  assert.deepEqual(await dataSnapshot(root), before);
  const pages = requests.filter(({ url }) => url.startsWith("/v1/devices?")).map(({ url }) => new URL(url, "http://127.0.0.1").searchParams.get("pageToken"));
  assert.deepEqual(pages, [null, "1"]);
  assert.equal(scopeOf(requests), `${DIRECTORY_SCOPE} ${DEVICES_SCOPE}`);
  assert.ok(!stdout.includes("stub-access-token"));
});

test("collect workspace without --devices keeps the directory scope and the two user runs only", async (context) => {
  const { requests, preview } = await setup(context);
  assert.deepEqual(Object.keys(await preview([])), ["workspace-2sv-enrolment", "workspace-admin-count"]);
  assert.equal(scopeOf(requests), DIRECTORY_SCOPE);
  assert.ok(!requests.some(({ url }) => url.startsWith("/v1/")));
});

test("the device inventory lists each kept device and counts stale and duplicate devices", async (context) => {
  const { preview } = await setup(context);
  const { "workspace-device-inventory": inventory } = await preview();
  assert.equal(inventory.result, "passed");
  assert.match(inventory.text, /- devices listed: 5\n- dropped as stale \(no sync in the last 30 days\): 1\n- dropped as duplicate serial number: 1\n- kept: 3/);
  assert.match(inventory.text, /\| Owner email \| Device type \| OS version \| encryptionState \| passwordState \| managementState \| lastSyncTime \| firstSyncTime \|/);
  const mac = PAGES[0][0];
  assert.ok(inventory.text.includes(`| ana@example.com | MAC_OS | MacOS 15.2.0 | ENCRYPTED | PASSWORD_SET | APPROVED | ${mac.lastSyncTime} | 2026-01-05T09:00:00Z |`));
  assert.match(inventory.text, /\| ben@example\.com \| WINDOWS \|/);
  assert.match(inventory.text, /\| cleo@example\.com \| LINUX \|/);
  assert.doesNotMatch(inventory.text, /dev@example\.com|MacOS 14\.6\.0/);
});

test("--since-days 60 keeps the device last synced 31 days ago and fails its macOS 10.15.7", async (context) => {
  const { preview } = await setup(context);
  const runs = await preview(["--devices", "--since-days", "60"]);
  assert.match(runs["workspace-device-inventory"].text, /- dropped as stale \(no sync in the last 60 days\): 0\n- dropped as duplicate serial number: 1\n- kept: 4/);
  assert.equal(runs["workspace-device-os-supported"].result, "failed");
  assert.match(runs["workspace-device-os-supported"].text, /^- dev@example\.com \(MAC_OS, MacBook Air\): MacOS 10\.15\.7, below macOS 15$/m);
});

test("unsupported Windows encryption is not reported and fails; a missing screen lock and owner email fail; Linux is not checked", async (context) => {
  const pages = [[{ ...PAGES[0][0], name: "devices/nolock" }, { ...PAGES[0][1], encryptionState: "ENCRYPTION_UNSUPPORTED" }], [PAGES[1][0], { ...PAGES[1][0], name: "devices/anon", serialNumber: "SERIAL-ANON" }]];
  const { preview } = await setup(context, {
    pages,
    deviceUsers: { ...DEVICE_USERS, nolock: [owner("ana", { passwordState: "PASSWORD_NOT_SET" })], anon: [owner("x", { userEmail: undefined })] }
  });
  const runs = await preview();
  assert.equal(runs["workspace-device-encryption"].result, "failed");
  assert.match(runs["workspace-device-encryption"].text, /^- ben@example\.com \(WINDOWS, Laptop\): not reported \(ENCRYPTION_UNSUPPORTED\)$/m);
  assert.equal(runs["workspace-device-screen-lock"].result, "failed");
  assert.match(runs["workspace-device-screen-lock"].text, /^- ana@example\.com \(MAC_OS, MacBook Pro\): no device user with passwordState PASSWORD_SET$/m);
  assert.equal(runs["workspace-device-owner"].result, "failed");
  assert.match(runs["workspace-device-owner"].text, /^- no owner email \(LINUX, Laptop\): no device user with an email$/m);
  assert.equal(runs["workspace-device-os-supported"].result, "passed");
  assert.match(runs["workspace-device-os-supported"].text, /- not checked \(not macOS or Windows\): 2\n\n- cleo@example\.com \(LINUX, Laptop\): not checked/);
});

test("all-encrypted devices pass encryption, and a Windows build below --min-windows-build fails", async (context) => {
  const { preview } = await setup(context);
  const runs = await preview(["--devices", "--min-windows-build", "26100"]);
  assert.equal(runs["workspace-device-encryption"].result, "passed");
  assert.match(runs["workspace-device-encryption"].text, /^- failing: 0$/m);
  assert.equal(runs["workspace-device-os-supported"].result, "failed");
  assert.match(runs["workspace-device-os-supported"].text, /^- ben@example\.com \(WINDOWS, Laptop\): Windows 10\.0\.22631, below Windows build 26100$/m);
});

test("with no recently synced device the inventory and every device check fail", async (context) => {
  const { preview } = await setup(context, { pages: [[PAGES[1][2]]] });
  const runs = await preview();
  for (const key of ["inventory", "encryption", "screen-lock", "os-supported", "owner"]) assert.equal(runs[`workspace-device-${key}`].result, "failed", key);
  assert.match(runs["workspace-device-inventory"].text, /^- kept: 0$/m);
});

test("--since-days must be a whole number of 1 or more", async (context) => {
  const { requests, args } = await setup(context);
  await assert.rejects(execute(args(["--devices", "--since-days", "0"])), /--since-days must be a whole number of 1 or more\./);
  assert.deepEqual(requests, []);
});

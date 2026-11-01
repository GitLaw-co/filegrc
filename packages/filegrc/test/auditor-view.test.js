import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createResources, loadWorkspace, migrateModel } from "../src/index.js";
import { signSession } from "../src/hosted-auth.js";
import { auditorLinkSecretFromEnv } from "../src/auditor-view.js";
import { createFilegrcServer } from "../src/server.js";
import { makeWorkspace } from "./helpers.js";

const execute = promisify(execFile);
const git = (root, args) => execute("git", args, { cwd: root }).then(({ stdout }) => stdout.trim());
const coverage = { kind: "range", startsOn: "2026-01-01", endsOn: "2026-06-30" };

async function makeTaggedAuditWorkspace(context) {
  const root = await mkdtemp(join(tmpdir(), "filegrc-auditor-view-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await makeWorkspace(root);
  while (Number((await loadWorkspace(root)).workspace.dataModelVersion) < 9) await migrateModel(root);
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "user.email", "test@example.test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "Create model v9 workspace"]);
  await mkdir(join(root, "data", "evidence", "evidence-access-review-sample"), { recursive: true });
  await writeFile(join(root, "data", "evidence", "evidence-access-review-sample", "review.csv"), "person,reviewed\nperson-owner,yes\n");
  await createResources(root, [
    { id: "framework-security", type: "framework", title: "Security criteria", status: "active", version: "1" },
    { id: "requirement-security", type: "requirement", title: "Security requirement", frameworkId: "framework-security", reference: "SEC1" },
    {
      id: "system-audit-source", type: "system", title: "Audit source", status: "active",
      purpose: "Provide the scoped service used for the audit test.", servicesProvided: ["Audit population source"],
      boundary: "The test audit source system.", criticality: "high", ownerIds: ["person-owner"]
    },
    {
      id: "component-audit-source", type: "component", title: "Audit source component", status: "planned",
      componentKind: "service", description: "Authoritative source for the audit population export.",
      evidenceSourceKinds: ["population-export"], evidenceOwnerIds: ["person-owner"], ownerIds: ["person-owner"]
    },
    {
      id: "control-access-review", type: "control", title: "Quarterly access review", status: "planned",
      statement: "Management reviews access.", ownerIds: ["person-owner"], requirementIds: ["requirement-security"],
      code: "ACC-01", activity: "Review access.", operationMode: "manual", operationPattern: "scheduled",
      systemIds: ["system-audit-source"]
    },
    {
      id: "audit-type-2", type: "audit", title: "Type 2 examination", status: "planned", auditKind: "soc-2-type-2",
      programId: "program-test-soc-2-program", frameworkIds: ["framework-security"], requirementIds: ["requirement-security"],
      controlIds: ["control-access-review"], systemIds: ["system-audit-source"], scope: "Production service",
      ownerIds: ["person-owner"], coverage
    },
    {
      id: "evidence-access-population", type: "evidence", title: "Access review population export", status: "verified",
      artifactKind: "population-export", sourceKind: "component", sourceDescription: "Directory export",
      collectedOn: "2026-07-01", generatedAt: "2026-07-01T12:00:00Z", timezone: "UTC",
      queryDescription: "All access reviews in the period.", populationCount: 1,
      completenessValidation: "Reconciled to the source total.", accuracyValidation: "Checked the item to the source.",
      collectorIds: ["person-owner"], verifierIds: ["person-approver"], verifiedOn: "2026-07-01",
      classificationId: "internal", coverage, sourceComponentId: "component-audit-source",
      auditIds: ["audit-type-2"], controlIds: ["control-access-review"]
    },
    {
      id: "evidence-access-review-sample", type: "evidence", title: "Sampled access review", status: "verified",
      artifactKind: "business-record", sourceKind: "file", sourceDescription: "Signed review worksheet",
      collectedOn: "2026-07-01", collectorIds: ["person-owner"], verifierIds: ["person-approver"], verifiedOn: "2026-07-01",
      classificationId: "internal", coverage, auditIds: ["audit-type-2"], controlIds: ["control-access-review"],
      filePaths: ["evidence/evidence-access-review-sample/review.csv"]
    },
    {
      id: "audit-population-access-review", type: "audit-population", title: "Access review population",
      status: "reconciled", auditId: "audit-type-2", populationKind: "access-review-population",
      controlIds: ["control-access-review"], sourceComponentId: "component-audit-source",
      sourceEvidenceId: "evidence-access-population", reconciledByIds: ["person-owner"], reconciledOn: "2026-07-01",
      conclusion: "complete", ownerIds: ["person-owner"], coverage
    },
    {
      id: "control-test-access-review", type: "control-test", title: "Access review control test", status: "complete",
      controlId: "control-access-review", testKinds: ["operating-effectiveness"], performedBy: "management",
      auditId: "audit-type-2", testerIds: ["person-owner"], sampleSize: 1,
      populationId: "audit-population-access-review", sampleEvidenceIds: ["evidence-access-review-sample"],
      evidenceIds: ["evidence-access-review-sample"], exceptionCount: 0, reviewerIds: ["person-approver"],
      reviewedOn: "2026-07-02", completedOn: "2026-07-02", outcome: "passed", coverage
    }
  ]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "Prepare audit"]);
  await git(root, ["tag", "audit-2026"]);
  const control = (await loadWorkspace(root)).entries.find(({ record }) => record.id === "control-access-review");
  await writeFile(join(root, "data", control.relativePath), `${JSON.stringify({ ...control.record, title: "Monthly access review" }, null, 2)}\n`);
  await git(root, ["commit", "--quiet", "-am", "Change the control after the audit tag"]);
  return root;
}

async function startServer(context, root) {
  let clock = Date.parse("2026-10-31T09:00:00Z");
  const server = createFilegrcServer(root, { now: () => clock });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, advance: (ms) => { clock += ms; } };
}

test("serves the control tests as of the audit tag with expiring evidence links", async (context) => {
  const root = await makeTaggedAuditWorkspace(context);
  const { base, advance } = await startServer(context, root);
  const tagged = await git(root, ["rev-parse", "audit-2026^{commit}"]);
  const created = await fetch(`${base}/api/auditor-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag: "audit-2026", auditId: "audit-type-2", hours: 2 })
  });
  assert.equal(created.status, 201);
  const link = await created.json();
  assert.equal(link.commit, tagged);
  const auditorBase = new URL(link.url).origin;
  assert.notEqual(auditorBase, base);

  const view = await fetch(link.url);
  assert.equal(view.status, 200);
  assert.equal(view.headers.get("set-cookie"), null);
  const html = await view.text();
  assert.match(html, /ACC-01 Quarterly access review/);
  assert.doesNotMatch(html, /Monthly access review/);
  assert.match(html, /control-test-access-review/);
  assert.match(html, /does not decide whether that evidence is sufficient/);

  const evidenceUrl = /href="([^"]+review\.csv[^"]*)"/.exec(html)[1].replaceAll("&amp;", "&");
  const evidence = await fetch(`${auditorBase}${evidenceUrl}`);
  assert.equal(evidence.status, 200);
  assert.equal(await evidence.text(), "person,reviewed\nperson-owner,yes\n");

  const altered = evidenceUrl.replace("evidence-access-review-sample", "evidence-access-population");
  assert.equal((await fetch(`${auditorBase}${altered}`)).status, 403);
  assert.equal((await fetch(link.url.replace("audit-2026", "audit-2027"))).status, 403);

  advance(60 * 60_000 + 1);
  assert.equal((await fetch(`${auditorBase}${evidenceUrl}`)).status, 403);
  assert.equal((await fetch(link.url)).status, 200);
  advance(60 * 60_000);
  assert.equal((await fetch(link.url)).status, 403);
});

test("refuses every write on the auditor listener and changes no file", async (context) => {
  const root = await makeTaggedAuditWorkspace(context);
  const { base } = await startServer(context, root);
  const link = await (await fetch(`${base}/api/auditor-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag: "audit-2026", auditId: "audit-type-2" })
  })).json();
  const auditorBase = new URL(link.url).origin;
  const viewPath = new URL(link.url).pathname;
  assert.equal((await fetch(link.url)).status, 200);
  const controlPath = join(root, "data", "controls", "control-access-review.json");
  const before = await readFile(controlPath, "utf8");
  const headers = { "content-type": "application/json" };
  const writes = [
    ["POST", "/api/resources", { record: { id: "control-extra", type: "control", title: "Extra" } }],
    ["PUT", "/api/resource/control/control-access-review", { record: { ...JSON.parse(before), title: "Changed" }, revision: "x" }],
    ["DELETE", "/api/resource/control/control-access-review?revision=x"],
    ["PUT", "/api/content", { path: "controls/control-access-review.md", source: "Changed", revision: "x" }],
    ["POST", "/api/commit", { message: "Auditor commit" }],
    ["POST", "/api/auditor-links", { tag: "audit-2026", auditId: "audit-type-2" }],
    ["POST", viewPath],
    ["PUT", viewPath],
    ["DELETE", viewPath]
  ];
  for (const [method, path, body] of writes) {
    const response = await fetch(`${auditorBase}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.equal((await fetch(`${auditorBase}/api/state`)).status, 404);
  assert.doesNotMatch(await (await fetch(`${base}${viewPath}${new URL(link.url).search}`)).text(), /FileGRC auditor view/);
  assert.equal(await readFile(controlPath, "utf8"), before);
  assert.equal(await git(root, ["status", "--porcelain"]), "");
});

test("a malformed request target gets 400 from the auditor listener and does not stop it", async (context) => {
  const root = await makeTaggedAuditWorkspace(context);
  const { base } = await startServer(context, root);
  const link = await (await fetch(`${base}/api/auditor-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag: "audit-2026", auditId: "audit-type-2" })
  })).json();
  const { port } = new URL(link.url);
  const reply = await new Promise((resolve, reject) => {
    const socket = connect(Number(port), "127.0.0.1", () => socket.end("GET http://[::1/auditor/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
  assert.match(reply, /^HTTP\/1\.1 400 /);
  assert.equal((await fetch(link.url)).status, 200);
});

const PUBLIC_URL = "https://filegrc.example.com";
const SESSION_SECRET = "test-session-secret-with-enough-length";

// A hosted server on loopback. Links name the public URL; `local` maps one back
// to this listener, as the TLS proxy in front of it would.
async function startHostedServer(context, root, options = {}) {
  const clock = options.clock ?? { now: Date.parse("2026-10-31T09:00:00Z") };
  const server = createFilegrcServer(root, {
    now: () => clock.now,
    auditorSecret: options.auditorSecret,
    hostedAuth: {
      clientId: "client", clientSecret: "secret", allowedDomain: "example.com", sessionSecret: SESSION_SECRET,
      publicUrl: PUBLIC_URL, adminEmails: "security@example.com"
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise((resolve) => server.close(resolve));
  context.after(() => (server.listening ? close() : undefined));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `filegrc_session=${signSession({ personId: "person-owner", exp: Math.floor(Date.now() / 1000) + 600 }, SESSION_SECRET)}`;
  const issue = async (body) => {
    const response = await fetch(`${base}/api/auditor-links`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  return { base, cookie, clock, close, issue, local: (url) => url.replace(PUBLIC_URL, base) };
}

test("a hosted admin issues a link from the form and the issue is logged", async (context) => {
  const root = await makeTaggedAuditWorkspace(context);
  const { base, cookie, local } = await startHostedServer(context, root);
  const logged = context.mock.method(console, "log", () => {});

  const response = await fetch(`${base}/api/auditor-links`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tag: "audit-2026", auditId: "audit-type-2", hours: "3" })
  });
  assert.equal(response.status, 201);
  const linkUrl = /aria-label="Auditor link" value="([^"]+)"/.exec(await response.text())[1].replaceAll("&amp;", "&");
  assert.ok(linkUrl.startsWith(`${PUBLIC_URL}/auditor/audit-2026/audit-type-2?`), linkUrl);
  assert.equal((await fetch(local(linkUrl))).status, 200);

  const lines = logged.mock.calls.map(({ arguments: [line] }) => line).filter((line) => line.startsWith("[filegrc audit] "));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0].slice("[filegrc audit] ".length)), {
    event: "auditor-link-issued", personId: "person-owner", email: "security@example.com",
    tag: "audit-2026", auditId: "audit-type-2", commit: await git(root, ["rev-parse", "audit-2026^{commit}"]),
    expiresAt: "2026-10-31T12:00:00.000Z"
  });
});

test("hosted mode serves signed auditor pages on the public URL without sign-in, GET only", async (context) => {
  const root = await makeTaggedAuditWorkspace(context);
  const { base, clock, issue, local } = await startHostedServer(context, root);
  const link = await issue({ tag: "audit-2026", auditId: "audit-type-2", hours: 1 });
  assert.equal(new URL(link.url).origin, PUBLIC_URL);

  const view = await fetch(local(link.url), { redirect: "manual" });
  assert.equal(view.status, 200);
  assert.equal(view.headers.get("set-cookie"), null);
  const html = await view.text();
  assert.match(html, /ACC-01 Quarterly access review/);
  const evidenceUrl = /href="([^"]+review\.csv[^"]*)"/.exec(html)[1].replaceAll("&amp;", "&");
  assert.equal(await (await fetch(`${base}${evidenceUrl}`)).text(), "person,reviewed\nperson-owner,yes\n");

  const viewPath = new URL(link.url).pathname;
  const signed = new URL(link.url).search;
  const tampered = local(link.url).replace(/signature=([a-f0-9])/, (_, digit) => `signature=${digit === "0" ? "1" : "0"}`);
  for (const path of [tampered, `${base}${viewPath}`, `${base}/auditor/audit-2026/audit-other${signed}`]) {
    const response = await fetch(path, { redirect: "manual" });
    assert.equal(response.status, 403, path);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await fetch(`${base}${viewPath}${signed}`, { method, headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 403, method);
  }
  // The signature does not open editing routes, and they still need a session.
  assert.equal((await fetch(`${base}/api/state${signed}`)).status, 401);
  assert.equal((await fetch(`${base}/${signed}`, { redirect: "manual" })).status, 302);
  // Only the /auditor/ prefix skips sign-in; look-alike and encoded paths do not reach editing routes.
  assert.equal((await fetch(`${base}/auditorX/audit-2026/audit-type-2${signed}`, { redirect: "manual" })).status, 302);
  assert.equal((await fetch(`${base}/auditor${signed}`, { redirect: "manual" })).status, 302);
  assert.equal((await fetch(`${base}/auditor/..%2Fapi%2Fstate${signed}`)).status, 403);
  assert.equal((await fetch(`${base}${viewPath}${signed}`, { method: "HEAD" })).status, 403);
  assert.equal(view.headers.get("cache-control"), "no-store");

  clock.now += 60 * 60_000;
  assert.equal((await fetch(local(link.url))).status, 403);
});

test("with a fixed auditor link secret, hosted links stay valid across a restart", async (context) => {
  const root = await makeTaggedAuditWorkspace(context);
  const auditorSecret = auditorLinkSecretFromEnv({ FILEGRC_AUDITOR_LINK_SECRET: "a-fixed-auditor-link-secret-of-32+chars" });
  const first = await startHostedServer(context, root, { auditorSecret });
  const link = await first.issue({ tag: "audit-2026", auditId: "audit-type-2" });
  assert.equal((await fetch(first.local(link.url))).status, 200);
  await first.close();

  const second = await startHostedServer(context, root, { auditorSecret });
  assert.equal((await fetch(second.local(link.url))).status, 200);
  const withoutSecret = await startHostedServer(context, root);
  assert.equal((await fetch(withoutSecret.local(link.url))).status, 403);
});

test("FILEGRC_AUDITOR_LINK_SECRET is optional and must be at least 32 characters", () => {
  assert.equal(auditorLinkSecretFromEnv({}), undefined);
  assert.equal(auditorLinkSecretFromEnv({ FILEGRC_AUDITOR_LINK_SECRET: "  " }), undefined);
  assert.throws(() => auditorLinkSecretFromEnv({ FILEGRC_AUDITOR_LINK_SECRET: "short" }), /at least 32 characters/);
  assert.equal(auditorLinkSecretFromEnv({ FILEGRC_AUDITOR_LINK_SECRET: "x".repeat(32) }), "x".repeat(32));
});

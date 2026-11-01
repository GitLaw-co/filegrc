import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createResources, loadWorkspace, migrateModel } from "../src/index.js";
import { signSession } from "../src/hosted-auth.js";
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

test("a hosted admin issues a link from the form and the issue is logged", async (context) => {
  const root = await makeTaggedAuditWorkspace(context);
  const sessionSecret = "test-session-secret-with-enough-length";
  const server = createFilegrcServer(root, {
    now: () => Date.parse("2026-10-31T09:00:00Z"),
    hostedAuth: {
      clientId: "client", clientSecret: "secret", allowedDomain: "example.com", sessionSecret,
      publicUrl: "https://filegrc.example.com", adminEmails: "security@example.com"
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `filegrc_session=${signSession({ personId: "person-owner", exp: Math.floor(Date.now() / 1000) + 600 }, sessionSecret)}`;
  const logged = context.mock.method(console, "log", () => {});

  const response = await fetch(`${base}/api/auditor-links`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tag: "audit-2026", auditId: "audit-type-2", hours: "3" })
  });
  assert.equal(response.status, 201);
  const linkUrl = /aria-label="Auditor link" value="([^"]+)"/.exec(await response.text())[1].replaceAll("&amp;", "&");
  assert.equal((await fetch(linkUrl)).status, 200);

  const lines = logged.mock.calls.map(({ arguments: [line] }) => line).filter((line) => line.startsWith("[filegrc audit] "));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0].slice("[filegrc audit] ".length)), {
    event: "auditor-link-issued", personId: "person-owner", email: "security@example.com",
    tag: "audit-2026", auditId: "audit-type-2", commit: await git(root, ["rev-parse", "audit-2026^{commit}"]),
    expiresAt: "2026-10-31T12:00:00.000Z"
  });
});

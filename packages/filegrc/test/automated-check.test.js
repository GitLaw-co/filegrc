import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { executeCli, writeJson } from "./helpers.js";
import { makeComprehensiveWorkspace } from "./fixtures.js";

const cli = fileURLToPath(new URL("../bin/filegrc.js", import.meta.url));
const execute = (args) => executeCli(runCli, process.execPath, [cli, ...args]);

async function workspace(context) {
  const root = await mkdtemp(join(tmpdir(), "filegrc-automated-check-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { records } = await makeComprehensiveWorkspace(root, "13");
  const program = records.find(({ type }) => type === "program");
  const control = records.find(({ type, id }) => type === "control" && program.controlIds.includes(id));
  return { root, control };
}

function check(controlIds, overrides = {}) {
  return {
    id: "automated-check-mfa",
    type: "automated-check",
    title: "MFA enforced for code hosting members",
    status: "active",
    controlIds,
    sourceComponentId: "component-example",
    expectedCondition: "Every code hosting organization member has multi-factor authentication enabled.",
    cadence: "daily",
    ...overrides
  };
}

function runResult(id, sourceGeneratedAt, operatingResult) {
  return {
    id,
    type: "evidence",
    title: `MFA check run ${sourceGeneratedAt}`,
    status: "collected",
    artifactKind: "system-export",
    sourceKind: "component",
    sourceComponentId: "component-example",
    sourceDescription: "Automated check run output.",
    sourceResourceIds: ["automated-check-mfa"],
    collectedOn: sourceGeneratedAt.slice(0, 10),
    collectorIds: ["person-example"],
    classificationId: "classification-example",
    sourceGeneratedAt,
    operatingResult
  };
}

async function writeCheck(root, record) {
  await mkdir(join(root, "data", "automated-checks"), { recursive: true });
  await writeJson(join(root, "data", "automated-checks", `${record.id}.json`), record);
}

async function writeEvidence(root, record) {
  await mkdir(join(root, "data", "evidence", record.id), { recursive: true });
  await writeJson(join(root, "data", "evidence", record.id, "evidence.json"), record);
}

async function diagnostics(root) {
  return JSON.parse((await execute(["validate", root, "--json"]).catch((failure) => failure)).stdout).diagnostics;
}

test("guide and scaffold describe automated checks from the model", async (context) => {
  const { root } = await workspace(context);
  const guide = JSON.parse((await execute(["guide", "automated-check", "--root", root, "--json"])).stdout);
  assert.equal(guide.type, "automated-check");
  assert.match(JSON.stringify(guide), /expectedCondition/);
  assert.match(JSON.stringify(guide), /sourceResourceIds/);
  const scaffold = JSON.parse((await execute(["scaffold", "automated-check", "--title", "MFA check", "--root", root])).stdout);
  const record = scaffold.record ?? scaffold;
  assert.equal(record.type, "automated-check");
  assert.equal(record.status, "draft");
});

test("validate names an automated check that links an unknown Control", async (context) => {
  const { root } = await workspace(context);
  await writeCheck(root, check(["control-does-not-exist"]));
  const found = (await diagnostics(root)).find(({ code, path }) => code === "missing-reference" && path.includes("automated-check-mfa"));
  assert.match(found.message, /controlIds references unknown ID "control-does-not-exist"/);
});

test("validate requires a run time, result, and matching source Component on a check result", async (context) => {
  const { root, control } = await workspace(context);
  await writeCheck(root, check([control.id]));
  await writeEvidence(root, { ...runResult("evidence-mfa-run", "2026-09-10T06:00:00Z", undefined), sourceComponentId: undefined, sourceKind: "file", filePaths: undefined, operatingResult: undefined });
  const codes = (await diagnostics(root)).filter(({ path }) => path.includes("evidence-mfa-run")).map(({ code }) => code);
  assert.ok(codes.includes("incomplete-automated-check-result"));
  assert.ok(codes.includes("automated-check-source-mismatch"));
});

test("program readiness shows a failing latest check result on its Control", async (context) => {
  const { root, control } = await workspace(context);
  await writeCheck(root, check([control.id]));
  await writeEvidence(root, runResult("evidence-mfa-run-1", "2026-09-10T06:00:00Z", "passed"));
  await writeEvidence(root, runResult("evidence-mfa-run-2", "2026-09-11T06:00:00Z", "failed"));
  await writeEvidence(root, runResult("evidence-mfa-run-3", "2026-09-20T06:00:00Z", "passed"));
  const validation = await diagnostics(root);
  assert.deepEqual(validation.filter(({ path, severity }) => severity === "error" && /mfa/.test(path)), []);
  const item = JSON.parse((await execute([
    "program-readiness", "--root", root, "--as-of", "2026-09-12", "--control", control.id, "--json"
  ])).stdout);
  assert.deepEqual(item.automatedChecks, [{
    checkId: "automated-check-mfa",
    title: "MFA enforced for code hosting members",
    cadence: "daily",
    latestResult: "failed",
    latestRunAt: "2026-09-11T06:00:00Z",
    latestEvidenceId: "evidence-mfa-run-2"
  }]);
});

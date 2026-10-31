import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFilegrc } from "../../create-filegrc/src/index.js";
import { assessProgramReadiness, loadWorkspace, planWorkspaceSetup, setupWorkspace, validateWorkspace } from "../src/index.js";
import { runCli } from "../src/cli.js";
import { executeCli } from "./helpers.js";

const cliPath = fileURLToPath(new URL("../bin/filegrc.js", import.meta.url));
const execute = (args) => executeCli(runCli, process.execPath, [cliPath, ...args]);
const TRUST_SERVICES_FRAMEWORK_ID = "framework-aicpa-trust-services-criteria";
const setup = {
  serviceName: "Example Service",
  boundary: "The production application and its supporting operations.",
  ownerId: "person-program-lead",
  criticality: "high",
  classificationId: "confidential",
  internetExposed: true,
  programGoal: "readiness",
  draft: true
};

async function freshWorkspace(context) {
  const parent = await mkdtemp(join(tmpdir(), "filegrc-soc2-categories-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  const filegrcVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  await createFilegrc({ target: root, yes: true, install: false, filegrcVersion, policyOwnerEmail: "security@example.com", timezone: "UTC" });
  const lockPath = join(root, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.packages["node_modules/filegrc"] = { version: filegrcVersion };
  await writeFile(lockPath, JSON.stringify(lock));
  return root;
}

function optionalCategoryReferences(loaded) {
  return loaded.resources
    .filter(({ type, reference }) => type === "requirement" && /^[AC]1\./.test(reference))
    .map(({ reference }) => reference)
    .sort();
}

async function assertValid(root) {
  const result = await validateWorkspace(root);
  assert.deepEqual(result.diagnostics.filter(({ severity }) => severity === "error"), []);
}

async function criteriaItem(root) {
  const readiness = await assessProgramReadiness(root);
  return readiness.stages.flatMap(({ items }) => items).find(({ id }) => id === "criteria");
}

async function selectTrustServicesFramework(root) {
  const path = join(root, "data", "programs", "program-soc-2.json");
  const program = JSON.parse(await readFile(path, "utf8"));
  program.frameworkIds = [...new Set([...(program.frameworkIds || []), TRUST_SERVICES_FRAMEWORK_ID])];
  await writeFile(path, `${JSON.stringify(program, null, 2)}\n`);
}

test("a fresh workspace stays Security-only and readiness lists no A1 or C1 decisions", async (context) => {
  const root = await freshWorkspace(context);
  assert.deepEqual(optionalCategoryReferences(await loadWorkspace(root)), []);
  await assertValid(root);

  const result = await setupWorkspace(root, setup);
  assert.deepEqual(result.requirements, []);
  await selectTrustServicesFramework(root);
  const loaded = await loadWorkspace(root);
  assert.deepEqual(optionalCategoryReferences(loaded), []);
  const criteria = await criteriaItem(root);
  assert.ok(criteria.missingDecisionRequirementIds.includes("requirement-soc2-cc1-1"));
  assert.equal(criteria.missingDecisionRequirementIds.some((id) => /requirement-soc2-[ac]1-/.test(id)), false);
  await assertValid(root);
});

test("selecting Availability creates A1 requirements that readiness asks the Program to decide", async (context) => {
  const root = await freshWorkspace(context);
  const preview = await planWorkspaceSetup(root, { ...setup, trustServicesCategories: ["availability"] });
  assert.equal(preview.changes.requirements, 3);
  assert.deepEqual(optionalCategoryReferences(await loadWorkspace(root)), []);

  const result = await setupWorkspace(root, { ...setup, trustServicesCategories: ["availability"] });
  assert.deepEqual(result.requirements.map(({ id }) => id), [
    "requirement-soc2-a1-1",
    "requirement-soc2-a1-2",
    "requirement-soc2-a1-3"
  ]);
  const loaded = await loadWorkspace(root);
  assert.deepEqual(optionalCategoryReferences(loaded), ["A1.1", "A1.2", "A1.3"]);
  const a11 = loaded.resources.find(({ id }) => id === "requirement-soc2-a1-1");
  assert.equal(a11.frameworkId, TRUST_SERVICES_FRAMEWORK_ID);
  assert.deepEqual(a11.externalIds, { "aicpa.tsc": "A1.1" });
  assert.deepEqual(a11.tags, ["availability"]);
  const program = loaded.resources.find(({ type }) => type === "program");
  assert.ok(program.frameworkIds.includes(TRUST_SERVICES_FRAMEWORK_ID));
  assert.equal(program.requirementApplicability.some(({ requirementId }) => requirementId.startsWith("requirement-soc2-a1-")), false);

  const criteria = await criteriaItem(root);
  for (const id of ["requirement-soc2-a1-1", "requirement-soc2-a1-2", "requirement-soc2-a1-3"]) {
    assert.ok(criteria.missingDecisionRequirementIds.includes(id), id);
  }
  assert.equal(criteria.missingDecisionRequirementIds.some((id) => id.startsWith("requirement-soc2-c1-")), false);
  await assertValid(root);

  const repeated = await setupWorkspace(root, { ...setup, trustServicesCategories: ["availability"] });
  assert.deepEqual(repeated.requirements, []);
});

test("selecting Confidentiality through the CLI creates C1 requirements only", async (context) => {
  const root = await freshWorkspace(context);
  const payloadPath = join(root, "..", "setup.json");
  await writeFile(payloadPath, JSON.stringify({ ...setup, trustServicesCategories: ["confidentiality"] }));
  const preview = JSON.parse((await execute(["setup", payloadPath, "--root", root, "--preview", "--json"])).stdout);
  assert.deepEqual(preview.requirementIds, ["requirement-soc2-c1-1", "requirement-soc2-c1-2"]);

  await execute(["setup", payloadPath, "--root", root, "--json"]);
  assert.deepEqual(optionalCategoryReferences(await loadWorkspace(root)), ["C1.1", "C1.2"]);
  const criteria = await criteriaItem(root);
  assert.ok(criteria.missingDecisionRequirementIds.includes("requirement-soc2-c1-1"));
  assert.ok(criteria.missingDecisionRequirementIds.includes("requirement-soc2-c1-2"));
  assert.equal(criteria.missingDecisionRequirementIds.some((id) => id.startsWith("requirement-soc2-a1-")), false);
  await assertValid(root);
});

test("setup rejects Trust Services Categories without an optional criteria catalogue", async (context) => {
  const root = await freshWorkspace(context);
  await assert.rejects(
    setupWorkspace(root, { ...setup, trustServicesCategories: ["privacy"] }),
    /trustServicesCategories may include only availability, confidentiality/
  );
  assert.deepEqual(optionalCategoryReferences(await loadWorkspace(root)), []);
});

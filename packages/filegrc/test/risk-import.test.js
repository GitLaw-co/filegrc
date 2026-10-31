import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { resourcePath } from "../src/files.js";
import { parseCsv } from "../src/risk-import.js";
import { loadWorkspace } from "../src/workspace.js";
import { executeCli, writeJson } from "./helpers.js";
import { makeComprehensiveWorkspace } from "./fixtures.js";

const cli = fileURLToPath(new URL("../bin/filegrc.js", import.meta.url));
const execute = (args) => executeCli(runCli, process.execPath, [cli, ...args]);

const STARTER_METHODOLOGY = {
  method: "5x5 likelihood and impact",
  likelihoodScale: ["Rare", "Unlikely", "Possible", "Likely", "Almost certain"],
  impactScale: ["Negligible", "Minor", "Moderate", "Major", "Severe"],
  ratingBands: { low: "1-4", medium: "5-9", high: "10-16", critical: "17-25" }
};

const REGISTER = [
  "Title,Description,Owner,Category,Response,Score,Likelihood,Impact,Notes",
  "Laptop theft,\"Unencrypted laptop lost, exposing customer data\",person-example,security,mitigate,12,,,from old register",
  "Cloud outage,Primary region unavailable,person-example,availability;security,monitor,,Likely,Major,",
  "Phishing,Staff credential theft,person-example,security,mitigate,6,2,3,"
].join("\r\n");

async function workspace(context) {
  const root = await mkdtemp(join(tmpdir(), "filegrc-risk-import-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { records } = await makeComprehensiveWorkspace(root, "13");
  const loaded = await loadWorkspace(root);
  const program = records.find(({ type }) => type === "program");
  await writeJson(resourcePath(loaded.root, loaded.model, program), { ...program, riskMethodology: STARTER_METHODOLOGY });
  const file = join(root, "register.csv");
  await writeFile(file, REGISTER);
  return { root, file };
}

async function dataSnapshot(root) {
  const files = await readdir(join(root, "data"), { recursive: true, withFileTypes: true });
  const paths = files.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")])));
}

async function riskErrors(root) {
  const result = JSON.parse((await execute(["validate", root, "--json"]).catch((failure) => failure)).stdout);
  return result.diagnostics.filter(({ severity, path }) => severity === "error" && path.startsWith("data/risks/"));
}

test("parseCsv handles quotes, escaped quotes, embedded newlines, CRLF and a byte order mark", () => {
  assert.deepEqual(parseCsv("﻿a,b\r\n\"x, \"\"y\"\"\",\"line\nbreak\"\n"), [["a", "b"], ["x, \"y\"", "line\nbreak"]]);
  assert.throws(() => parseCsv("a\n\"open"), /unterminated quoted field/);
});

test("preview lists three proposed risks and writes nothing", async (context) => {
  const { root, file } = await workspace(context);
  const before = await dataSnapshot(root);
  const plan = JSON.parse((await execute(["import-risks", file, "--preview", "--root", root, "--json"])).stdout);
  assert.equal(plan.proposed.length, 3);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ignoredColumns, ["Notes"]);
  for (const payload of plan.proposed) {
    assert.equal(payload.record.type, "risk");
    assert.deepEqual(payload.content, {});
  }
  const text = (await execute(["import-risks", file, "--preview", "--root", root])).stdout;
  assert.match(text, /risk\/risk-laptop-theft/);
  assert.match(text, /No workspace files were changed/);
  assert.deepEqual(await dataSnapshot(root), before);
});

test("apply writes valid draft risks that record the source file and import date", async (context) => {
  const { root, file } = await workspace(context);
  const result = JSON.parse((await execute(["import-risks", file, "--apply", "--root", root, "--json"])).stdout);
  assert.deepEqual(result.created, ["risk-laptop-theft", "risk-cloud-outage", "risk-phishing"]);
  assert.match(result.importedOn, /^\d{4}-\d{2}-\d{2}$/);
  const loaded = await loadWorkspace(root);
  for (const id of result.created) {
    const risk = loaded.resources.find((record) => record.id === id);
    assert.equal(risk.status, "draft");
    assert.equal(risk.extensions["filegrc.import"].sourceFile, "register.csv");
    assert.equal(risk.extensions["filegrc.import"].importedOn, result.importedOn);
  }
  assert.deepEqual(await riskErrors(root), []);
  const byId = Object.fromEntries(loaded.resources.filter(({ type }) => type === "risk").map((risk) => [risk.id, risk]));
  assert.deepEqual(byId["risk-cloud-outage"].inherentRating, { likelihood: "Likely", impact: "Major", rating: "high", score: 16 });
  assert.deepEqual(byId["risk-cloud-outage"].categories, ["availability", "security"]);
  assert.deepEqual(byId["risk-phishing"].inherentRating, { likelihood: "Unlikely", impact: "Moderate", rating: "medium", score: 6 });
  assert.equal(byId["risk-phishing"].extensions["filegrc.import"].factorRating, undefined);
});

test("a score of 12 alone gets the high band without invented likelihood or impact", async (context) => {
  const { root, file } = await workspace(context);
  const plan = JSON.parse((await execute(["import-risks", file, "--preview", "--root", root, "--json"])).stdout);
  const risk = plan.proposed.find(({ record }) => record.id === "risk-laptop-theft").record;
  assert.deepEqual(risk.inherentRating, { likelihood: "Not rated", impact: "Not rated", rating: "high", score: 12 });
  assert.equal(risk.extensions["filegrc.import"].factorRating, "needed");
  assert.equal(risk.extensions["filegrc.import"].sourceScore, 12);
  assert.equal(risk.description, "Unencrypted laptop lost, exposing customer data");
});

test("rerunning apply creates no records and changes no files", async (context) => {
  const { root, file } = await workspace(context);
  await execute(["import-risks", file, "--apply", "--root", root, "--json"]);
  const before = await dataSnapshot(root);
  const result = JSON.parse((await execute(["import-risks", file, "--apply", "--root", root, "--json"])).stdout);
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.existing.map(({ id }) => id), ["risk-laptop-theft", "risk-cloud-outage", "risk-phishing"]);
  assert.deepEqual(await dataSnapshot(root), before);
});

test("rows that cannot be imported are reported and apply writes nothing", async (context) => {
  const { root } = await workspace(context);
  const file = join(root, "bad.csv");
  await writeFile(file, [
    "title,description,owner,category,response,score,likelihood,impact",
    "Too high,Outside the bands,person-example,security,mitigate,30,,",
    "Mismatch,Score disagrees with factors,person-example,security,mitigate,20,Likely,Major",
    "Unknown owner,Owner is not a person,person-missing,security,mitigate,3,,",
    "Half rated,Only likelihood,person-example,security,mitigate,,Likely,"
  ].join("\n"));
  await writeFile(join(root, "bad-id.csv"), "id,title,score\n../escape,Path escape,3\n");
  const badId = JSON.parse((await execute(["import-risks", join(root, "bad-id.csv"), "--preview", "--root", root, "--json"])).stdout);
  assert.match(badId.errors[0].message, /lowercase kebab-case/);
  const before = await dataSnapshot(root);
  const plan = JSON.parse((await execute(["import-risks", file, "--preview", "--root", root, "--json"])).stdout);
  assert.deepEqual(plan.errors.map(({ row }) => row), [2, 3, 4, 5]);
  assert.match(plan.errors[0].message, /outside the Program's rating bands/);
  assert.match(plan.errors[1].message, /does not equal likelihood x impact \(16\)/);
  assert.match(plan.errors[2].message, /person-missing/);
  assert.match(plan.errors[3].message, /both likelihood and impact/);
  await assert.rejects(execute(["import-risks", file, "--apply", "--root", root]), /Fix 4 rows before applying/);
  assert.deepEqual(await dataSnapshot(root), before);
});

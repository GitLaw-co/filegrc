import { relative } from "node:path";
import { applyResourceBatch, resourcePath } from "../files.js";
import { currentCalendarDate } from "../time.js";
import { validateWorkspace } from "../validate.js";
import { loadWorkspace } from "../workspace.js";
import { githubCollector } from "./github.js";

// A collector reads one external source only when a person runs
// `filegrc collect <name>`. It reads its token from `tokenVariable` in the
// environment and returns one run per check:
//   { key, title, expectedCondition, sourceDescription, result, observed }
// `observed` is Markdown with the facts read. The collector never writes;
// this module turns runs into automated-check and evidence payloads.
export const COLLECTORS = { github: githubCollector };

export async function planCollection(input, name, options = {}, env = process.env) {
  const collector = COLLECTORS[name];
  if (!collector) throw new Error(`Unknown collector "${name}". Available collectors: ${Object.keys(COLLECTORS).join(", ")}.`);
  if (!env[collector.tokenVariable]) {
    throw new Error(`Set ${collector.tokenVariable} to a read-only token before running "filegrc collect ${name}". FileGRC reads it from the environment and never stores it.`);
  }
  for (const flag of ["component", "collector", "classification"]) {
    if (!options[flag]) throw new Error(`Pass --${flag} <id>. Run "filegrc collect --help" for details.`);
  }
  const loaded = await loadWorkspace(input);
  const byId = new Map(loaded.resources.map((record) => [record.id, record]));
  const runs = await collector.collect({ token: env[collector.tokenVariable], options, env });
  const runAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const stamp = runAt.replace(/[-:]/g, "").toLowerCase();
  const collectedOn = currentCalendarDate(loaded.workspace?.timezone || "UTC", new Date(runAt));
  const plan = { collector: name, runAt, checks: [], evidence: [], errors: [] };
  for (const run of runs) {
    const checkId = `automated-check-${run.key}`;
    let check = byId.get(checkId);
    if (check && check.type !== "automated-check") {
      plan.errors.push({ id: checkId, message: `ID "${checkId}" already belongs to a ${check.type} record.` });
      continue;
    }
    if (!check) {
      if (!options.controls?.length) {
        plan.errors.push({ id: checkId, message: `Pass --controls <control-id,...> to link new automated check "${checkId}".` });
        continue;
      }
      check = {
        id: checkId,
        type: "automated-check",
        title: run.title,
        status: "active",
        controlIds: options.controls,
        sourceComponentId: options.component,
        expectedCondition: run.expectedCondition,
        cadence: options.cadence || "daily"
      };
      plan.checks.push({ record: check, content: {} });
    }
    plan.evidence.push({
      record: {
        id: `evidence-${run.key}-${stamp}`,
        type: "evidence",
        title: `${run.title}: ${run.result} at ${runAt}`,
        status: "collected",
        artifactKind: "configuration-export",
        sourceKind: "component",
        sourceComponentId: options.component,
        sourceDescription: run.sourceDescription,
        sourceResourceIds: [checkId],
        controlIds: check.controlIds,
        collectedOn,
        collectedAt: runAt,
        sourceGeneratedAt: runAt,
        collectorIds: [options.collector],
        classificationId: options.classification,
        operatingResult: run.result
      },
      content: { content: `# ${run.title}\n\nRun by \`filegrc collect ${name}\` at ${runAt}.\n\nExpected: ${run.expectedCondition}\n\nResult: ${run.result}\n\n${run.observed}\n` }
    });
  }
  plan.errors.push(...await payloadErrors(loaded, [...plan.checks, ...plan.evidence]));
  return plan;
}

export async function applyCollection(input, name, options = {}, env = process.env) {
  const plan = await planCollection(input, name, options, env);
  if (plan.errors.length) throw new Error(`Nothing was written. ${plan.errors.map(({ id, message }) => `${id}: ${message}`).join(" ")}`);
  const payloads = [...plan.checks, ...plan.evidence];
  await applyResourceBatch(input, {
    create: payloads.map(({ record }) => record),
    contentUpdates: Object.fromEntries(payloads.filter(({ content }) => Object.keys(content).length).map(({ record, content }) => [record.id, content]))
  });
  return { ...plan, created: payloads.map(({ record }) => record.id) };
}

// Validate proposed records with the workspace validator so preview reports
// the errors apply would reject.
async function payloadErrors(loaded, payloads) {
  if (!payloads.length) return [];
  const entries = payloads.map(({ record }) => {
    const path = resourcePath(loaded.root, loaded.model, record);
    return { record, path, relativePath: relative(loaded.dataRoot, path).split("\\").join("/"), source: `${JSON.stringify(record, null, 2)}\n` };
  });
  const idByPath = new Map(entries.map(({ record, relativePath }) => [`data/${relativePath}`, record.id]));
  const result = await validateWorkspace({
    ...loaded,
    entries: [...loaded.entries, ...entries],
    sourceEntries: [...loaded.sourceEntries, ...entries],
    resources: [...loaded.resources, ...entries.map(({ record }) => record)]
  });
  return result.diagnostics
    .filter(({ severity, path }) => severity === "error" && idByPath.has(path))
    .map(({ path, message }) => ({ id: idByPath.get(path), message }));
}

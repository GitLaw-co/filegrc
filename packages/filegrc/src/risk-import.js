import { readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { createResourceId } from "./id.js";
import { createResources, resourcePath } from "./files.js";
import { resolveProgram } from "./program.js";
import { currentCalendarDate } from "./time.js";
import { validateWorkspace } from "./validate.js";
import { loadWorkspace } from "./workspace.js";

// Imported provenance lives under one extension namespace so the risk model stays unchanged.
export const RISK_IMPORT_EXTENSION = "filegrc.import";
// The risk-rating object requires both factors. A source that gives one score
// records this literal instead of guessing a likelihood or impact.
export const NOT_RATED = "Not rated";
const COLUMNS = ["id", "title", "description", "owner", "category", "response", "score", "likelihood", "impact"];

export async function planRiskImport(input, options = {}) {
  const loaded = await loadWorkspace(input);
  if (!options.file) throw new Error("A CSV file path is required.");
  const rows = parseCsv(await readFile(resolve(options.file), "utf8"));
  if (rows.length < 2) throw new Error("The CSV file needs a header row and at least one risk row.");
  const methodology = resolveProgram(loaded, options.programId).riskMethodology;
  if (!methodology?.ratingBands) throw new Error("Record the Program risk methodology, including its rating bands, before importing risks.");
  const header = rows[0].map((name) => name.trim());
  const columns = new Map(header.map((name, index) => [name.toLowerCase(), index]));
  const sourceFile = basename(options.file);
  const importedOn = currentCalendarDate(loaded.workspace?.timezone || "UTC");
  const existingTypes = new Map(loaded.resources.map(({ id, type }) => [id, type]));
  const plan = {
    sourceFile,
    importedOn,
    ignoredColumns: header.filter((name) => name && !COLUMNS.includes(name.toLowerCase())),
    proposed: [],
    existing: [],
    errors: []
  };
  const seen = new Set();
  rows.slice(1).forEach((cells, index) => {
    if (cells.every((cell) => !cell.trim())) return;
    const row = index + 2;
    const value = (name) => columns.has(name) ? String(cells[columns.get(name)] ?? "").trim() : "";
    try {
      const title = value("title");
      if (!title) throw new Error("title is required.");
      const id = value("id") || createResourceId("risk", title);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`ID "${id}" must use lowercase kebab-case.`);
      if (seen.has(id)) throw new Error(`Risk "${id}" appears more than once in the file.`);
      seen.add(id);
      if (existingTypes.has(id)) {
        if (existingTypes.get(id) !== "risk") throw new Error(`ID "${id}" already belongs to a ${existingTypes.get(id)} record.`);
        plan.existing.push({ row, id });
        return;
      }
      const { rating, factorRating } = rateRisk(methodology, loaded.model, value("score"), value("likelihood"), value("impact"));
      const record = {
        id,
        type: "risk",
        title,
        status: "draft",
        description: value("description"),
        ownerIds: list(value("owner")),
        categories: list(value("category")),
        response: value("response"),
        inherentRating: rating,
        extensions: {
          [RISK_IMPORT_EXTENSION]: {
            sourceFile,
            sourceRow: row,
            importedOn,
            ...(value("score") ? { sourceScore: rating.score } : {}),
            ...(factorRating ? { factorRating } : {})
          }
        }
      };
      for (const name of Object.keys(record)) if (record[name] === "" || (Array.isArray(record[name]) && !record[name].length)) delete record[name];
      plan.proposed.push({ row, record, content: {} });
    } catch (error) {
      plan.errors.push({ row, message: error.message });
    }
  });
  plan.errors.push(...await recordErrors(loaded, plan.proposed));
  plan.errors.sort((left, right) => left.row - right.row);
  return plan;
}

export async function applyRiskImport(input, options = {}) {
  const plan = await planRiskImport(input, options);
  if (plan.errors.length) {
    const rows = new Set(plan.errors.map(({ row }) => row)).size;
    throw new Error(`Fix ${rows} row${rows === 1 ? "" : "s"} before applying: ${plan.errors.map(({ row, message }) => `row ${row}: ${message}`).join(" ")}`);
  }
  if (plan.proposed.length) await createResources(input, plan.proposed.map(({ record }) => record));
  return { ...plan, created: plan.proposed.map(({ record }) => record.id) };
}

// Validate proposed records with the workspace validator before any write, so
// preview reports the same errors that apply would reject.
async function recordErrors(loaded, proposed) {
  if (!proposed.length) return [];
  const entries = proposed.map(({ row, record }) => {
    const path = resourcePath(loaded.root, loaded.model, record);
    return { row, record, path, relativePath: relative(loaded.dataRoot, path).split("\\").join("/"), source: `${JSON.stringify(record, null, 2)}\n` };
  });
  const rowByPath = new Map(entries.map(({ row, relativePath }) => [`data/${relativePath}`, row]));
  const result = await validateWorkspace({
    ...loaded,
    entries: [...loaded.entries, ...entries],
    sourceEntries: [...loaded.sourceEntries, ...entries],
    resources: [...loaded.resources, ...entries.map(({ record }) => record)]
  });
  return result.diagnostics
    .filter(({ severity, path }) => severity === "error" && rowByPath.has(path))
    .map(({ path, message }) => ({ row: rowByPath.get(path), message }));
}

function rateRisk(methodology, model, scoreValue, likelihoodValue, impactValue) {
  if (Boolean(likelihoodValue) !== Boolean(impactValue)) throw new Error("Give both likelihood and impact, or neither.");
  let score = scoreValue ? Number(scoreValue) : null;
  if (scoreValue && !Number.isFinite(score)) throw new Error(`Score "${scoreValue}" is not a number.`);
  let likelihood = NOT_RATED;
  let impact = NOT_RATED;
  if (likelihoodValue) {
    const factorLikelihood = scalePosition(methodology.likelihoodScale, likelihoodValue, "Likelihood");
    const factorImpact = scalePosition(methodology.impactScale, impactValue, "Impact");
    const product = factorLikelihood.position * factorImpact.position;
    if (score !== null && score !== product) throw new Error(`Score ${score} does not equal likelihood x impact (${product}).`);
    score = product;
    likelihood = factorLikelihood.label;
    impact = factorImpact.label;
  }
  if (score === null) throw new Error("Give a score, or likelihood and impact.");
  const ratings = model.primitives?.rating || [];
  const band = Object.entries(methodology.ratingBands).find(([name, range]) => {
    const [low, high] = String(range).split("-").map(Number);
    return ratings.includes(name) && score >= low && score <= high;
  });
  if (!band) throw new Error(`Score ${score} is outside the Program's rating bands (${Object.entries(methodology.ratingBands).map(([name, range]) => `${name} ${range}`).join(", ")}).`);
  return {
    rating: { likelihood, impact, rating: band[0], score },
    factorRating: likelihoodValue ? null : "needed"
  };
}

// Accept a scale label (any case) or its 1-based position on the Program scale.
function scalePosition(scale = [], value, label) {
  const number = /^\d+$/.test(value) ? Number(value) : null;
  const index = number !== null ? number - 1 : scale.findIndex((item) => item.toLowerCase() === value.toLowerCase());
  if (index < 0 || index >= scale.length) throw new Error(`${label} "${value}" is not on the Program's ${label.toLowerCase()} scale (${scale.join(", ")}).`);
  return { label: scale[index], position: index + 1 };
}

function list(value) {
  return value.split(";").map((item) => item.trim()).filter(Boolean);
}

// RFC 4180 CSV: quoted fields may hold commas, newlines and doubled quotes.
export function parseCsv(source) {
  const text = source.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === "\"" && text[index + 1] === "\"") {
        field += "\"";
        index += 1;
      } else if (character === "\"") quoted = false;
      else field += character;
    } else if (character === "\"" && field === "") quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new Error("The CSV file has an unterminated quoted field.");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

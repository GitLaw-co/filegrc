// One status vocabulary for every list: five words, each with one colour. A record's
// lifecycle word (draft, approved, active) stays beside the pill as secondary text.
//
// These functions are also embedded in the browser app, so each one may only use its
// arguments, STATUS_WORDS and the other functions in this file. Dates are ISO
// calendar dates (YYYY-MM-DD) compared as strings.
export const STATUS_WORDS = {
  passing: { label: "Passing", tone: "green" },
  failing: { label: "Failing", tone: "red" },
  critical: { label: "Critical", tone: "amber" },
  "due-soon": { label: "Due soon", tone: "blue" },
  "not-monitored": { label: "Not monitored", tone: "grey" }
};

export function isoDatePlusDays(date, days) {
  const [year, month, day] = String(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// Implemented is Passing; implemented with gaps is Failing; planned has nothing that
// proves it operates yet, so it is Not monitored. Out-of-scope Controls get no pill.
export function controlStatusWord(record) {
  if (record?.status === "implemented") return "passing";
  if (record?.status === "partially-implemented") return "failing";
  if (record?.status === "planned") return "not-monitored";
  return null;
}

// Policies, Documents and Training: approved or active is Passing, waiting for review
// or approval is Due soon.
export function governedStatusWord(record) {
  if (["approved", "active"].includes(record?.status)) return "passing";
  if (["draft", "in-review"].includes(record?.status)) return "due-soon";
  return null;
}

// Action register entries: done or accepted is Passing; a waiting action past its due
// date is Failing; one due within 7 days, or with an answer proposed, is Due soon.
export function actionStatusWord(action, today) {
  if (["accepted", "done"].includes(action?.status)) return "passing";
  if (!["open", "proposed"].includes(action?.status)) return null;
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(action.due ?? "")) ? action.due : null;
  if (due && due < today) return "failing";
  if (due && due <= isoDatePlusDays(today, 7)) return "due-soon";
  if (action.status === "proposed") return "due-soon";
  return null;
}

// No per-person checks (training, device, acknowledgements) are recorded yet, so an
// active person is Not monitored rather than Passing.
export function personStatusWord(record) {
  return record?.status === "active" ? "not-monitored" : null;
}

// Each run of an automated check is an Evidence Artifact that lists the check in
// sourceResourceIds and records operatingResult. The latest run per check, by
// collectedAt (or collectedOn), is the check's current result.
export function latestCheckResults(evidence) {
  const latest = {};
  for (const record of evidence || []) {
    if (record?.type !== "evidence" || !["passed", "failed"].includes(record.operatingResult)) continue;
    const at = String(record.collectedAt || record.collectedOn || "");
    for (const checkId of record.sourceResourceIds || []) {
      if (!String(checkId).startsWith("automated-check-")) continue;
      if (!latest[checkId] || at > latest[checkId].at) latest[checkId] = { result: record.operatingResult, at, evidenceId: record.id };
    }
  }
  return latest;
}

// An active check reads from its latest run: passed is Passing, failed is Failing, no
// run yet is Not monitored.
export function automatedCheckStatusWord(record, latest = {}) {
  if (record?.status !== "active") return null;
  const run = latest[record.id];
  return run ? (run.result === "passed" ? "passing" : "failing") : "not-monitored";
}

// A vendor reads from its reviews: completed within a year is Passing, a planned review
// past its date is Failing, a planned one is Due soon, none at all is Not monitored.
export function vendorStatusWord(vendor, reviews, today) {
  if (!["active", "evaluating"].includes(vendor?.status)) return null;
  const own = (reviews || []).filter((review) => review?.vendorId === vendor.id && review.status !== "canceled");
  const lastYear = isoDatePlusDays(today, -365);
  if (own.some((review) => review.status === "complete" && String(review.completedOn || "") >= lastYear)) return "passing";
  const open = own.filter((review) => ["planned", "in-progress"].includes(review.status));
  if (open.some((review) => review.scheduledFor && review.scheduledFor < today)) return "failing";
  if (open.length) return "due-soon";
  return "not-monitored";
}

export function statusWordForRecord(type, record, { today, resources = [] } = {}) {
  if (type === "control") return controlStatusWord(record);
  if (["policy", "document", "training"].includes(type)) return governedStatusWord(record);
  if (type === "person") return personStatusWord(record);
  if (type === "automated-check") return automatedCheckStatusWord(record, latestCheckResults(resources));
  if (type === "vendor") return vendorStatusWord(record, resources.filter((item) => item?.type === "vendor-review"), today);
  return null;
}

// A risk rating is stored as { likelihood, impact, rating, score }. The pill shows the
// rating word and, when present, the score; a missing rating reads "Not rated".
export function riskRatingDisplay(value) {
  const rating = value && typeof value === "object" ? value.rating : value;
  const word = typeof rating === "string" && rating.trim() ? rating.trim().toLowerCase() : "";
  if (!word) return { label: "Not rated", tone: "grey", score: null };
  const tone = word === "low" ? "green" : word === "medium" ? "amber" : ["high", "critical", "very-high"].includes(word) ? "red" : "grey";
  const score = value && typeof value === "object" && Number.isFinite(value.score) ? value.score : null;
  const label = word.replace(/[-_]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
  return { label, tone, score };
}

export const STATUS_WORD_FUNCTIONS = [isoDatePlusDays, controlStatusWord, governedStatusWord, actionStatusWord, personStatusWord, latestCheckResults, automatedCheckStatusWord, vendorStatusWord, statusWordForRecord, riskRatingDisplay];

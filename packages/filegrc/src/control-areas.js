// Plain-English areas for the overview's "Readiness by area" table and the Controls
// list. A Control may name its area in `extensions.filegrc.area` (an id or label from
// CONTROL_AREAS). Without one, the first rule in CONTROL_AREA_RULES with a keyword in the
// Control's title decides, so a workspace needs no data change to get a useful split. A Control
// that matches nothing, or names an unknown area, is shown under "Other".
//
// These functions are also embedded in the browser app, so each one may only use its
// arguments, CONTROL_AREAS, CONTROL_AREA_RULES and the other functions in this file.
export const CONTROL_AREAS = [
  { id: "people", label: "People" },
  { id: "policies", label: "Policies" },
  { id: "access", label: "Access" },
  { id: "devices", label: "Devices" },
  { id: "infrastructure-and-data", label: "Infrastructure and data" },
  { id: "change-and-vulnerabilities", label: "Change and vulnerabilities" },
  { id: "vendors", label: "Vendors" },
  { id: "risk", label: "Risk" },
  { id: "incidents-and-continuity", label: "Incidents and continuity" },
  { id: "governance", label: "Governance" }
];

// Title keywords, tried in this order; the first rule with a matching keyword wins.
// Management reviews are oversight whatever they review, and a policy document sits
// under Policies unless it is about incidents, vendors, risk or change.
export const CONTROL_AREA_RULES = [
  { area: "governance", keywords: ["management review"] },
  { area: "incidents-and-continuity", keywords: ["incident", "backup", "disaster", "continuity", "recovery", "situational awareness", "anomalous", "capacity", "reliability"] },
  { area: "vendors", keywords: ["third-party", "third party", "tprm", "vendor", "supplier", "subservice"] },
  { area: "risk", keywords: ["risk", "fraud", "impact analysis"] },
  { area: "change-and-vulnerabilities", keywords: ["change", "modification", "vulnerab", "flaw", "penetration", "patch", "testing", "installations"] },
  { area: "policies", keywords: ["policy", "policies", "procedure", "documentation", "guideline"] },
  { area: "devices", keywords: ["endpoint", "device", "malware", "malicious code", "session lock", "media disposal", "laptop"] },
  { area: "access", keywords: ["access", "password", "identity", "privilege", "multi-factor", "authentication", "termination", "unauthorized", "user review"] },
  { area: "infrastructure-and-data", keywords: ["encrypt", "network", "connection", "transmission", "database", "log", "data classification", "retention", "infrastructure", "asset", "physical", "attributes", "automated reporting", "privacy notice"] },
  { area: "people", keywords: ["hire", "training", "awareness", "screening", "competency", "personnel", "performance review", "roles", "responsibilit", "organizational", "org chart", "people", "acknowledg", "conduct", "rules of behavior", "program manager", "segregat"] },
  { area: "governance", keywords: ["governance", "review & update", "internal audit", "monitoring", "program"] }
];

export const OTHER_CONTROL_AREA = { id: "other", label: "Other" };

export function controlAreaId(record) {
  const named = record?.extensions?.filegrc?.area;
  if (typeof named === "string" && named.trim()) {
    const wanted = named.trim().toLowerCase();
    const area = CONTROL_AREAS.find(({ id, label }) => id === wanted || label.toLowerCase() === wanted);
    return area ? area.id : "other";
  }
  const title = String(record?.title || "").toLowerCase();
  return CONTROL_AREA_RULES.find(({ keywords }) => keywords.some((keyword) => title.includes(keyword)))?.area || "other";
}

export function controlAreaLabel(id) {
  return CONTROL_AREAS.find((area) => area.id === id)?.label || "Other";
}

// Not applicable and retired Controls are out of scope; every other status counts.
export function controlInScope(record) {
  return !["not-applicable", "retired"].includes(record?.status);
}

export function controlReadiness(records) {
  const inScope = records.filter(controlInScope);
  const ready = inScope.filter((record) => record.status === "implemented").length;
  return {
    ready,
    inScope: inScope.length,
    planned: inScope.filter((record) => record.status === "planned").length,
    partial: inScope.filter((record) => record.status === "partially-implemented").length,
    excluded: records.length - inScope.length,
    percent: inScope.length ? Math.round((ready / inScope.length) * 100) : 0
  };
}

// One row per area that has in-scope Controls, largest first, "Other" last.
export function areaReadiness(records) {
  const rows = [...CONTROL_AREAS, { id: "other", label: "Other" }].map(({ id, label }) => {
    const members = records.filter((record) => controlInScope(record) && controlAreaId(record) === id);
    const ready = members.filter((record) => record.status === "implemented").length;
    return { id, label, ready, total: members.length, percent: members.length ? Math.round((ready / members.length) * 100) : 0 };
  });
  return rows.filter(({ total }) => total > 0)
    .sort((a, b) => (a.id === "other") - (b.id === "other") || b.total - a.total || a.label.localeCompare(b.label));
}

// The colour of a "38% ready" pill: green from 90%, amber
// from half, red below half, grey when the area has no Controls.
export function readinessTone(percent, total) {
  if (!total) return "grey";
  if (percent >= 90) return "green";
  if (percent >= 50) return "amber";
  return "red";
}

export const CONTROL_AREA_FUNCTIONS = [controlAreaId, controlAreaLabel, controlInScope, controlReadiness, areaReadiness, readinessTone];

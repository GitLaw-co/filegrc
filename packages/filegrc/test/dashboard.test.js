import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { APP_SCRIPT, renderActionsPage } from "../src/web.js";
import { THEMED_APP_STYLES } from "../src/theme.js";
import { areaReadiness, CONTROL_AREAS, controlAreaId, controlReadiness, readinessTone } from "../src/control-areas.js";
import { NAV_GROUPS, navigationRouteKeys } from "../src/navigation.js";
import { PROGRAM_PATH } from "../src/program-path.js";
import {
  actionStatusWord,
  automatedCheckStatusWord,
  controlStatusWord,
  governedStatusWord,
  latestCheckResults,
  riskRatingDisplay,
  statusWordForRecord,
  STATUS_WORDS,
  vendorStatusWord
} from "../src/status-words.js";

const control = (title, status = "planned", extra = {}) => ({ id: `control-${title}`, type: "control", title, status, ...extra });

test("assigns each control an area from its extension, else from its title", () => {
  assert.equal(controlAreaId(control("Multi-factor Authentication")), "access");
  assert.equal(controlAreaId(control("Endpoints Encryption")), "devices");
  assert.equal(controlAreaId(control("Incident Management Policy & Procedure")), "incidents-and-continuity");
  assert.equal(controlAreaId(control("Management Review of Third-Party Risks")), "governance");
  assert.equal(controlAreaId(control("Data Classification Policy")), "policies");
  assert.equal(controlAreaId(control("New Hire Security & Privacy Training Records")), "people");
  assert.equal(controlAreaId(control("Something unrelated")), "other");
  assert.equal(controlAreaId(control("Multi-factor Authentication", "planned", { extensions: { filegrc: { area: "Governance" } } })), "governance");
  assert.equal(controlAreaId(control("Multi-factor Authentication", "planned", { extensions: { filegrc: { area: "vendors" } } })), "vendors");
  assert.equal(controlAreaId(control("Multi-factor Authentication", "planned", { extensions: { filegrc: { area: "Typo" } } })), "other");
  assert.equal(CONTROL_AREAS.length, 10);
});

test("readiness is implemented controls over in-scope controls, overall and per area", () => {
  const records = [
    control("Multi-factor Authentication", "implemented"),
    control("User Access Reviews"),
    control("Password Guidelines", "not-applicable"),
    control("Endpoints Encryption", "implemented"),
    control("Session Lock", "partially-implemented"),
    control("Old control", "retired")
  ];
  assert.deepEqual(controlReadiness(records), { ready: 2, inScope: 4, planned: 1, partial: 1, excluded: 2, percent: 50 });
  assert.deepEqual(areaReadiness(records), [
    { id: "access", label: "Access", ready: 1, total: 2, percent: 50 },
    { id: "devices", label: "Devices", ready: 1, total: 2, percent: 50 }
  ]);
  assert.deepEqual(controlReadiness([]), { ready: 0, inScope: 0, planned: 0, partial: 0, excluded: 0, percent: 0 });
  assert.deepEqual([readinessTone(100, 3), readinessTone(90, 10), readinessTone(62, 8), readinessTone(20, 5), readinessTone(0, 0)], ["green", "green", "amber", "red", "grey"]);
});

test("maps records onto the five status words", () => {
  assert.deepEqual(Object.values(STATUS_WORDS).map(({ label }) => label), ["Passing", "Failing", "Critical", "Due soon", "Not monitored"]);
  assert.deepEqual(["implemented", "partially-implemented", "planned", "not-applicable"].map((status) => controlStatusWord({ status })), ["passing", "failing", "not-monitored", null]);
  assert.deepEqual(["approved", "active", "draft", "in-review", "retired"].map((status) => governedStatusWord({ status })), ["passing", "passing", "due-soon", "due-soon", null]);
  const today = "2026-11-26";
  assert.equal(actionStatusWord({ status: "open", due: "2026-11-05" }, today), "failing");
  assert.equal(actionStatusWord({ status: "open", due: "2026-12-03" }, today), "due-soon");
  assert.equal(actionStatusWord({ status: "open", due: "2026-12-04" }, today), null);
  assert.equal(actionStatusWord({ status: "proposed", due: "2027-01-10" }, today), "due-soon");
  assert.equal(actionStatusWord({ status: "done" }, today), "passing");
  assert.equal(actionStatusWord({ status: "rejected", due: "2026-11-01" }, today), null);
  const vendor = { id: "vendor-a", status: "active" };
  assert.equal(vendorStatusWord(vendor, [], today), "not-monitored");
  assert.equal(vendorStatusWord(vendor, [{ vendorId: "vendor-a", status: "planned", scheduledFor: "2026-12-05" }], today), "due-soon");
  assert.equal(vendorStatusWord(vendor, [{ vendorId: "vendor-a", status: "planned", scheduledFor: "2026-11-01" }], today), "failing");
  assert.equal(vendorStatusWord(vendor, [{ vendorId: "vendor-a", status: "complete", completedOn: "2026-03-01" }], today), "passing");
  assert.equal(vendorStatusWord({ ...vendor, status: "terminated" }, [], today), null);
  assert.equal(statusWordForRecord("person", { status: "active" }), "not-monitored");
});

test("an automated check reads its latest run from evidence", () => {
  const run = (id, checkId, at, result) => ({ id, type: "evidence", sourceResourceIds: [checkId], collectedAt: at, operatingResult: result });
  const evidence = [
    run("e1", "automated-check-a", "2026-11-25T02:00:00Z", "failed"),
    run("e2", "automated-check-a", "2026-11-26T02:00:00Z", "passed"),
    run("e3", "automated-check-b", "2026-11-26T02:00:00Z", "failed"),
    { id: "e4", type: "evidence", sourceResourceIds: ["automated-check-c"], collectedAt: "2026-11-26T02:00:00Z" }
  ];
  const latest = latestCheckResults(evidence);
  assert.deepEqual(latest["automated-check-a"], { result: "passed", at: "2026-11-26T02:00:00Z", evidenceId: "e2" });
  assert.equal(latest["automated-check-c"], undefined);
  assert.equal(automatedCheckStatusWord({ id: "automated-check-a", status: "active" }, latest), "passing");
  assert.equal(automatedCheckStatusWord({ id: "automated-check-b", status: "active" }, latest), "failing");
  assert.equal(automatedCheckStatusWord({ id: "automated-check-c", status: "active" }, latest), "not-monitored");
  assert.equal(automatedCheckStatusWord({ id: "automated-check-a", status: "retired" }, latest), null);
  assert.equal(statusWordForRecord("automated-check", { id: "automated-check-b", status: "active" }, { resources: evidence }), "failing");
});

test("renders a risk rating object as a pill instead of [object Object]", () => {
  assert.deepEqual(riskRatingDisplay({ likelihood: "Not rated", impact: "Not rated", rating: "medium", score: 4.8 }), { label: "Medium", tone: "amber", score: 4.8 });
  assert.deepEqual(riskRatingDisplay({ rating: "low" }), { label: "Low", tone: "green", score: null });
  assert.deepEqual(riskRatingDisplay({ rating: "high", score: 9 }), { label: "High", tone: "red", score: 9 });
  assert.deepEqual(riskRatingDisplay(undefined), { label: "Not rated", tone: "grey", score: null });
  const source = APP_SCRIPT.slice(APP_SCRIPT.indexOf("function tonePill"), APP_SCRIPT.indexOf("function viewerPerson"))
    + APP_SCRIPT.slice(APP_SCRIPT.indexOf("function riskRatingPill"), APP_SCRIPT.indexOf("function formatObjectArray"));
  const html = vm.runInNewContext(source + "\nriskRatingPill(value) + '|' + riskRatingPill(undefined)", {
    esc: String, riskRatingDisplay, value: { likelihood: "Not rated", impact: "Not rated", rating: "medium", score: 4.8 }
  });
  assert.equal(html, '<span class="status-pill tone-amber">Medium · 4.8</span>|<span class="status-pill tone-grey">Not rated</span>');
  assert.match(APP_SCRIPT, /if \(field\.endsWith\("Rating"\) && typeof value === "object"\) return riskRatingPill\(value\)/);
});

test("the sidebar still reaches every page the setup path linked", () => {
  const keys = new Set(navigationRouteKeys());
  const types = PROGRAM_PATH.flatMap((stage) => [...stage.sections.flatMap((section) => section.types), ...(stage.supportingResourceTypes || [])]);
  for (const type of types.filter((type) => !["policy", "document", "retention-schedule-item"].includes(type))) assert.ok(keys.has(`type:${type}`), type);
  for (const route of ["route:policies", "route:retention-schedule", "route:evidence-sources", "route:audit-packet", "route:audit-documents", "route:stage:run"]) assert.ok(keys.has(route), route);
  assert.deepEqual(NAV_GROUPS.map(({ title }) => title), ["My work", "Monitoring", "Compliance", "Data library", "Audits"]);
  assert.ok(keys.has("server:acknowledgementsHref"));
});

test("embeds the shared status and area functions in the browser app", () => {
  assert.doesNotThrow(() => new vm.Script(APP_SCRIPT));
  for (const name of ["controlAreaId", "areaReadiness", "controlReadiness", "actionStatusWord", "latestCheckResults", "riskRatingDisplay", "statusWordForRecord"]) {
    assert.match(APP_SCRIPT, new RegExp(`function ${name}\\(`), name);
  }
  assert.match(APP_SCRIPT, /const CONTROL_AREA_RULES = \[/);
  assert.match(APP_SCRIPT, /if \(type === "control"\) entries\.sort\(\(a, b\) => String\(a\.record\.code/);
  assert.match(THEMED_APP_STYLES, /\.status-pill\.tone-green\{/);
  assert.match(THEMED_APP_STYLES, /--fg-accent-orange:#ea580b/);
});

test("action cards carry the shared status pill", () => {
  const html = renderActionsPage({
    fragment: true,
    people: [{ id: "person-a", title: "A" }],
    allActions: [],
    actions: [{ id: "ACT-1", title: "Late", ownerId: "person-a", status: "open", due: "2000-01-01", kind: "fix" }]
  });
  assert.match(html, /<span class="status-pill tone-red" data-status-word="failing">Failing<\/span>/);
});


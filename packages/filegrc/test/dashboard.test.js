import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { APP_SCRIPT, renderActionsPage } from "../src/web.js";
import { THEMED_APP_STYLES } from "../src/theme.js";
import { areaReadiness, CONTROL_AREAS, controlAreaId, controlReadiness, readinessTone } from "../src/control-areas.js";
import { NAV_GROUPS, navigationRouteKeys } from "../src/navigation.js";
import { actionTaskStatus, blocksStartLabel, compareActions, observationPeriodStart } from "../src/action-status.js";
import { filterActions, summarizeActions } from "../src/action-register.js";
import { PROGRAM_PATH } from "../src/program-path.js";
import {
  automatedCheckStatusWord,
  checkRunHistory,
  isCheckRun,
  nightlyRuns,
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
  for (const name of ["controlAreaId", "areaReadiness", "controlReadiness", "actionTaskStatus", "compareActions", "latestCheckResults", "riskRatingDisplay", "statusWordForRecord"]) {
    assert.match(APP_SCRIPT, new RegExp(`function ${name}\\(`), name);
  }
  assert.match(APP_SCRIPT, /const CONTROL_AREA_RULES = \[/);
  assert.match(APP_SCRIPT, /if \(type === "control"\) entries\.sort\(\(a, b\) => String\(a\.record\.code/);
  assert.match(THEMED_APP_STYLES, /\.status-pill\.tone-green\{/);
  assert.match(THEMED_APP_STYLES, /--fg-accent-orange:#ea580b/);
});

test("action cards carry the task status pill, never a compliance word", () => {
  const html = renderActionsPage({
    fragment: true,
    people: [{ id: "person-a", title: "A" }],
    allActions: [],
    actions: [{ id: "ACT-1", title: "Late", ownerId: "person-a", status: "open", due: "2000-01-01", kind: "fix" }]
  });
  assert.match(html, /<span class="status-pill tone-amber-outline" data-task-status="overdue">Overdue · \d+d<\/span>/);
  assert.doesNotMatch(html, /Failing|tone-red/);
});


test("check history lists one check's runs and lays them out night by night", () => {
  const run = (id, checkId, at, result) => ({ id, type: "evidence", sourceResourceIds: [checkId], collectedAt: at, operatingResult: result });
  const evidence = [
    run("e2", "automated-check-a", "2026-11-26T02:00:00Z", "failed"),
    run("e1", "automated-check-a", "2026-11-24T02:00:00Z", "passed"),
    run("e3", "automated-check-b", "2026-11-26T02:00:00Z", "passed"),
    { id: "manual", type: "evidence", sourceResourceIds: ["component-x"], collectedOn: "2026-11-20" }
  ];
  assert.deepEqual(evidence.map(isCheckRun), [true, true, true, false]);
  const history = checkRunHistory(evidence, "automated-check-a");
  assert.deepEqual(history.map(({ id }) => id), ["e1", "e2"]);
  const nights = nightlyRuns(history, "2026-11-26", 3);
  assert.deepEqual(nights.map(({ day, run }) => [day, run?.result ?? null]), [["2026-11-24", "passed"], ["2026-11-25", null], ["2026-11-26", "failed"]]);
  assert.equal(nightlyRuns([], "2026-03-01", 30)[0].day, "2026-01-31");
});

test("record pages and lists use the gap-aware control status", () => {
  assert.match(APP_SCRIPT, /record\.status === "implemented" && controlLaunchState\(record\.id\) === "implemented-with-gaps"\) return "critical"/);
  assert.match(APP_SCRIPT, /const word = recordStatusWord\(type, record\);/);
  for (const name of ["checkSummary", "controlSummary", "riskSummary", "vendorSummary", "renderCheckRunEvidence", "collectionEmptyBlock", "openCommandPalette"]) {
    assert.match(APP_SCRIPT, new RegExp(`function ${name}\\(`), name);
  }
  assert.doesNotMatch(APP_SCRIPT, /titleCase\(entry\.record\.title\)/);
});

test("search groups matching records by type, ranks title matches first and leaves out check runs", () => {
  const source = APP_SCRIPT.slice(APP_SCRIPT.indexOf("function paletteDestinations"), APP_SCRIPT.indexOf("let paletteDialog"));
  const entry = (type, id, title, extra = {}) => ({ record: { type, id, title, ...extra }, content: {} });
  const context = {
    NAV_GROUPS,
    isCheckRun,
    document: { body: { dataset: {} } },
    entrySearchText: ({ record }) => JSON.stringify(record).toLowerCase(),
    state: {
      model: { resources: { control: { pluralTitle: "Controls" }, evidence: { pluralTitle: "Evidence artifacts" }, risk: { pluralTitle: "Risks" } } },
      resources: [
        entry("control", "control-2", "Data Backups", { code: "SDC 59" }),
        entry("control", "control-1", "Testing", { code: "SDC 97", statement: "restores a backup" }),
        entry("evidence", "run", "Backups: passed", { sourceResourceIds: ["automated-check-a"], operatingResult: "passed" }),
        entry("risk", "risk-1", "Lost backup")
      ]
    }
  };
  const result = vm.runInNewContext(source + "\nJSON.stringify(paletteResults('backup'))", context);
  const { pages, records } = JSON.parse(result);
  assert.deepEqual(records.map(({ type, total }) => [type, total]), [["control", 2], ["risk", 1]]);
  assert.deepEqual(records[0].items.map(({ record }) => record.id), ["control-2", "control-1"]);
  assert.deepEqual(pages, []);
  const risks = JSON.parse(vm.runInNewContext(source + "\nJSON.stringify(paletteResults('risks'))", context));
  assert.deepEqual(risks.pages.map(({ label }) => label), ["Risks"]);
});

test("actions read as tasks: to review, overdue by days, due soon, open, closed", () => {
  const today = "2026-11-26";
  const status = (action) => { const result = actionTaskStatus(action, today); return result && [result.id, result.label, result.tone]; };
  assert.deepEqual(status({ status: "proposed", due: "2026-11-01" }), ["to-review", "To review", "blue"]);
  assert.deepEqual(status({ status: "open", due: "2026-11-05" }), ["overdue", "Overdue · 21d", "amber-outline"]);
  assert.deepEqual(status({ status: "open", due: "2026-12-03" }), ["due-soon", "Due soon", "amber"]);
  assert.deepEqual(status({ status: "open", due: "2026-12-04" }), ["open", "Open", "grey"]);
  assert.deepEqual(status({ status: "open" }), ["open", "Open", "grey"]);
  assert.deepEqual(status({ status: "accepted" }), ["accepted", "Accepted", "green-muted"]);
  assert.deepEqual(status({ status: "done" }), ["done", "Done", "green-muted"]);
  assert.equal(status({ status: "rejected" }), null);
  for (const action of [{ status: "open", due: "2020-01-01" }, { status: "proposed" }, { status: "done" }]) {
    assert.ok(!["red", "green"].includes(actionTaskStatus(action, today).tone));
  }
});

test("actions sort to review first, then blocking, priority, oldest due date and id; closed last", () => {
  const actions = [
    { id: "ACT-9", status: "done", priority: "p1", blocksPeriodStart: true, due: "2026-01-01" },
    { id: "ACT-5", status: "open", priority: "p3", due: "2026-10-01" },
    { id: "ACT-4", status: "open", priority: "p2", blocksPeriodStart: true, due: "2026-11-20" },
    { id: "ACT-3", status: "open", priority: "p1", blocksPeriodStart: true, due: "2026-11-20" },
    { id: "ACT-2", status: "open", priority: "p1", blocksPeriodStart: true, due: "2026-11-05" },
    { id: "ACT-1", status: "proposed", priority: "p3", due: "2026-12-30" },
    { id: "ACT-6", status: "open", priority: "p1", due: "2026-09-01" }
  ];
  assert.deepEqual([...actions].sort(compareActions).map(({ id }) => id), ["ACT-1", "ACT-2", "ACT-3", "ACT-4", "ACT-6", "ACT-5", "ACT-9"]);
  assert.deepEqual(filterActions(actions, { status: "waiting" }).map(({ id }) => id), ["ACT-1", "ACT-2", "ACT-3", "ACT-4", "ACT-6", "ACT-5"]);
  const summary = summarizeActions(actions, { today: "2026-11-26" });
  assert.equal(summary.counts.toReviewEveryone, 1);
  assert.equal(summary.items[0].id, "ACT-1");
});

test("the blocks tag names the period start when the program or audit records one", () => {
  assert.equal(blocksStartLabel("2026-12-01"), "Blocks 1 Dec");
  assert.equal(blocksStartLabel(null), "Blocks period start");
  const program = { type: "program", status: "active", candidateCoverage: { kind: "range", startsOn: "2026-12-01", endsOn: "2027-02-28" } };
  assert.equal(observationPeriodStart([program]), "2026-12-01");
  assert.equal(observationPeriodStart([program, { type: "audit", status: "fieldwork", coverage: { kind: "range", startsOn: "2027-01-01", endsOn: "2027-03-31" } }]), "2027-01-01");
  assert.equal(observationPeriodStart([{ type: "program", status: "active" }]), null);
  const html = renderActionsPage({ fragment: true, periodStart: "2026-12-01", people: [], allActions: [], actions: [{ id: "ACT-1", title: "Gate", ownerId: "p", status: "open", blocksPeriodStart: true, priority: "p1", kind: "fix" }] });
  assert.match(html, /<span class="impact-tag">Blocks 1 Dec<\/span><span class="priority-chip">P1<\/span><span class="status-pill tone-grey" data-task-status="open">Open<\/span>/);
});

// Where an action in the register stands. Actions are tasks for people, not
// compliance results, so they never use the check and control words (Passing,
// Failing, Critical, Not monitored): an overdue task is late work, not a failed control.
//
// These functions are also embedded in the browser app, so each one may only use its
// arguments, ACTION_PRIORITY_ORDER, SHORT_MONTHS and the other functions in this file.
// Dates are ISO calendar dates (YYYY-MM-DD) compared as strings.
export const ACTION_PRIORITY_ORDER = ["p1", "p2", "p3"];
export const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isoDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? String(value) : null;
}

function daysBetween(from, to) {
  const day = (value) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  return Math.round((day(to) - day(from)) / 86_400_000);
}

// To review: an answer is proposed and waits for the owner. Overdue · Nd: open and
// past its due date. Due soon: open and due within 7 days. Open: due later or never.
// Accepted and Done are closed. Anything else (rejected, dropped) has no pill.
export function actionTaskStatus(action, today) {
  const status = action?.status;
  if (status === "accepted") return { id: "accepted", label: "Accepted", tone: "green-muted" };
  if (status === "done") return { id: "done", label: "Done", tone: "green-muted" };
  if (status === "proposed") return { id: "to-review", label: "To review", tone: "blue" };
  if (status !== "open") return null;
  const due = isoDay(action.due);
  if (due && due < today) {
    const days = daysBetween(due, today);
    return { id: "overdue", label: "Overdue · " + days + "d", tone: "amber-outline", days };
  }
  if (due && daysBetween(today, due) <= 7) return { id: "due-soon", label: "Due soon", tone: "amber" };
  return { id: "open", label: "Open", tone: "grey" };
}

// Register order: answers to review first, then open work that blocks the period
// start, then priority, then the oldest due date, then id. Closed actions come last.
export function compareActions(left, right) {
  const closed = (action) => (["open", "proposed"].includes(action.status) ? 0 : 1);
  const review = (action) => (action.status === "proposed" ? 0 : 1);
  const blocks = (action) => (action.blocksPeriodStart === true ? 0 : 1);
  const priority = (action) => {
    const index = ACTION_PRIORITY_ORDER.indexOf(action.priority);
    return index === -1 ? ACTION_PRIORITY_ORDER.length : index;
  };
  return closed(left) - closed(right)
    || review(left) - review(right)
    || blocks(left) - blocks(right)
    || priority(left) - priority(right)
    || String(isoDay(left.due) ?? "9999").localeCompare(String(isoDay(right.due) ?? "9999"))
    || String(left.id).localeCompare(String(right.id));
}

// "Blocks 1 Dec" when the period start is known, else "Blocks period start".
export function blocksStartLabel(periodStart) {
  const day = isoDay(periodStart);
  return day ? "Blocks " + Number(day.slice(8, 10)) + " " + SHORT_MONTHS[Number(day.slice(5, 7)) - 1] : "Blocks period start";
}

// The start of the observation period: an open audit's coverage, else the active
// Program's candidate period.
export function observationPeriodStart(records) {
  const range = (value) => (value?.kind === "range" && isoDay(value.startsOn) ? value.startsOn : null);
  const audit = (records || []).find((record) => record?.type === "audit" && !["issued", "delivered", "complete"].includes(record.status) && range(record.coverage));
  if (audit) return range(audit.coverage);
  const program = (records || []).find((record) => record?.type === "program" && record.status !== "retired" && range(record.candidateCoverage));
  return program ? range(program.candidateCoverage) : null;
}

export const ACTION_STATUS_FUNCTIONS = [isoDay, daysBetween, actionTaskStatus, compareActions, blocksStartLabel, observationPeriodStart];

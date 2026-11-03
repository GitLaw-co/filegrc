import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAuthorEnvironment, runGitCommand } from "./git.js";
import { resolveWorkspaceRoot } from "./paths.js";
import { loadWorkspace } from "./workspace.js";

// An action register is an optional folder of questions waiting on a person:
// `actions/<ID>.json`, one file per action, outside `data/`. Hosted mode shows it
// at /actions and lets the owner (or an admin) approve, send feedback or reject.
//
// Decisions are never written to the authoritative branch. Each one is a new file
// `actions/decisions/<ID>/<decision id>.json` committed to a separate branch
// (default `action-decisions`) and pushed there, so a protected main branch stays
// protected. Whoever maintains the register folds those files into the action
// records through a normal review and copies each one into the action's
// `history`, so the page stops showing it as pending.
export const ACTION_DIRECTORY = "actions";
export const ACTION_DECISIONS_DIRECTORY = "actions/decisions";
export const ACTION_SUGGESTIONS_DIRECTORY = "actions/suggestions";
export const ACTION_DECISIONS_BRANCH_ENV = "FILEGRC_ACTION_DECISIONS_BRANCH";
export const DEFAULT_ACTION_DECISIONS_BRANCH = "action-decisions";
export const ACTION_STATUSES = ["open", "proposed", "accepted", "rejected", "done", "dropped"];
export const ACTION_PRIORITIES = ["p1", "p2", "p3"];
export const DECISION_OUTCOMES = ["approved", "feedback", "rejected"];
const DECIDABLE = new Set(["open", "proposed"]);
const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DECISION_ID = /^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{6}$/;
const MAX_NOTE_LENGTH = 4000;
const REFRESH_MS = 30_000;
const PUSH_ATTEMPTS = 3;

export function actionDecisionsBranchFromEnv(env = process.env) {
  return String(env[ACTION_DECISIONS_BRANCH_ENV] ?? "").trim() || undefined;
}

// Every `actions/<ID>.json` whose `id` matches its file name. `schema.json` and
// anything that does not parse are listed as problems instead of being dropped silently.
export async function loadActionRegister(input) {
  const directory = join(resolveWorkspaceRoot(input), ACTION_DIRECTORY);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return { exists: false, actions: [], problems: [] };
    throw error;
  }
  const actions = [];
  const problems = [];
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "schema.json")
    .map(({ name }) => name).sort();
  for (const name of names) {
    const stem = name.slice(0, -".json".length);
    try {
      const record = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("it is not a JSON object");
      if (record.id !== stem || !ACTION_ID.test(stem)) throw new Error("its id does not match the file name");
      actions.push(record);
    } catch (error) {
      problems.push(`${ACTION_DIRECTORY}/${name} was skipped: ${error instanceof SyntaxError ? "it is not valid JSON" : error.message}.`);
    }
  }
  return { exists: true, actions, problems };
}

// A pending decision stops counting once the register has caught up with it: the
// action's history holds it (same on, by and outcome, or its decisionId), the
// action's own decision is at least as recent, or the action has left the
// open/proposed states.
export function isDecisionFolded(action, decision) {
  if (!DECIDABLE.has(action.status)) return true;
  // A register may copy the decision into `history` as it is, or name its id.
  if (Array.isArray(action.history) && action.history.some((entry) => entry?.decisionId === decision.id
    || (entry?.on === decision.on && entry?.by === decision.by && entry?.outcome === decision.outcome))) return true;
  const decidedOn = typeof action.decision?.on === "string" ? action.decision.on : "";
  return Boolean(decidedOn) && decidedOn >= decision.on;
}

// The register as people should see it now: each action with its pending
// decisions applied in time order. Approve and reject settle it; feedback leaves
// the status alone. The file on the authoritative branch is not changed.
export function applyPendingDecisions(actions, decisions) {
  const byAction = new Map();
  for (const decision of [...decisions].sort((a, b) => a.on.localeCompare(b.on) || a.id.localeCompare(b.id))) {
    if (!byAction.has(decision.actionId)) byAction.set(decision.actionId, []);
    byAction.get(decision.actionId).push(decision);
  }
  return actions.map((action) => {
    const pending = (byAction.get(action.id) ?? []).filter((decision) => !isDecisionFolded(action, decision));
    let view = { ...action, pendingDecisions: [] };
    for (const decision of pending) {
      if (!DECIDABLE.has(view.status)) break;
      view.pendingDecisions.push(decision);
      if (decision.outcome === "approved") view = { ...view, status: "accepted", decision: summary(decision) };
      if (decision.outcome === "rejected") view = { ...view, status: "rejected", decision: summary(decision) };
    }
    return view;
  });
}

function summary({ outcome, by, on, note }) {
  return { outcome, by, on, note };
}

// Filters from the query string. With none of them present, a signed-in person
// sees their own actions that wait for a decision.
export function actionFilters(searchParams, viewerPersonId = null) {
  const keys = ["q", "owner", "status", "priority", "blocks"];
  const given = keys.some((key) => searchParams.has(key));
  const value = (key) => String(searchParams.get(key) ?? "").trim();
  if (!given) return { q: "", owner: viewerPersonId || "", status: "waiting", priority: "", blocks: "" };
  const status = value("status");
  const priority = value("priority");
  return {
    q: value("q").slice(0, 200),
    owner: value("owner"),
    status: status === "all" || status === "waiting" || ACTION_STATUSES.includes(status) ? status : "waiting",
    priority: ACTION_PRIORITIES.includes(priority) ? priority : "",
    blocks: value("blocks") === "yes" ? "yes" : ""
  };
}

export function filterActions(actions, filters) {
  const query = String(filters.q ?? "").toLowerCase();
  return actions.filter((action) => (
    (!query || [action.id, action.title, action.question, action.suggestedAnswer].some((text) => String(text ?? "").toLowerCase().includes(query)))
    && (!filters.owner || action.ownerId === filters.owner)
    && (filters.status === "all" || !filters.status
      || (filters.status === "waiting" ? DECIDABLE.has(action.status) : action.status === filters.status))
    && (!filters.priority || action.priority === filters.priority)
    && (!filters.blocks || action.blocksPeriodStart === true)
  )).sort((a, b) => (
    rank(a.priority, ACTION_PRIORITIES) - rank(b.priority, ACTION_PRIORITIES)
    || String(a.due ?? "9999").localeCompare(String(b.due ?? "9999"))
    || a.id.localeCompare(b.id)
  ));
}

function rank(value, order) {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

export function canDecideAction(action, viewer) {
  return Boolean(viewer?.personId) && DECIDABLE.has(action.status)
    && (viewer.isAdmin === true || action.ownerId === viewer.personId);
}

export function createActionRegister(input, options = {}) {
  const root = resolveWorkspaceRoot(input);
  const branch = String(options.decisionsBranch ?? DEFAULT_ACTION_DECISIONS_BRANCH).trim();
  if (!isSafeBranchName(branch)) throw new Error(`The action decisions branch "${branch}" is not a safe Git branch name.`);
  const now = options.now ?? (() => new Date());
  const refreshMs = options.refreshMs ?? REFRESH_MS;
  const blobCache = new Map();
  let lastFetchAt = 0;
  let writes = Promise.resolve();

  async function repository() {
    const loaded = await loadWorkspace(root);
    const renderer = loaded.resources.find(({ type, id }) => type === "renderer-settings" && id === "renderer-settings");
    const remote = String(renderer?.repositoryRemote || "origin").trim();
    if (!isSafeBranchName(remote)) throw new Error("The configured repository remote is not a safe Git name.");
    if (renderer?.authoritativeBranch && renderer.authoritativeBranch === branch) {
      throw new Error("Action decisions must go to a branch other than the authoritative branch.");
    }
    return { loaded, remote, trackingRef: `refs/remotes/${remote}/${branch}` };
  }

  async function fetchBranch(remote, trackingRef) {
    try {
      await runGitCommand(root, ["fetch", "--no-tags", "--recurse-submodules=no", "--", remote, `+refs/heads/${branch}:${trackingRef}`], {
        operation: "fetch saved action decisions", timeoutMs: 30_000
      });
    } catch (error) {
      // No decision has been saved yet, so the branch does not exist.
      if (!/couldn't find remote ref|could not find remote ref/i.test(error.message)) throw error;
    }
    lastFetchAt = Date.now();
  }

  async function prefix() {
    return runGitCommand(root, ["rev-parse", "--show-prefix"], { operation: "locate the workspace in its repository" });
  }

  async function readDecisions(trackingRef) {
    const tip = await runGitCommand(root, ["rev-parse", "--verify", "--quiet", `${trackingRef}^{commit}`], {
      operation: "find saved action decisions"
    }).catch(() => "");
    if (!tip) return [];
    const base = `${await prefix()}${ACTION_DECISIONS_DIRECTORY}/`;
    const listing = await runGitCommand(root, ["ls-tree", "-r", "-z", "--full-tree", tip, "--", base], {
      operation: "list saved action decisions"
    });
    const decisions = [];
    for (const line of listing.split("\0").filter(Boolean)) {
      const match = /^100644 blob ([0-9a-f]{40,64})\t(.+)$/.exec(line);
      if (!match) continue;
      const [, oid, path] = match;
      const parts = path.slice(base.length).split("/");
      if (parts.length !== 2 || !ACTION_ID.test(parts[0]) || !DECISION_ID.test(parts[1].replace(/\.json$/, ""))) continue;
      if (!blobCache.has(oid)) {
        const source = await runGitCommand(root, ["cat-file", "blob", oid], { operation: "read a saved action decision" });
        blobCache.set(oid, parseDecision(source, parts[0], parts[1].replace(/\.json$/, "")));
      }
      const decision = blobCache.get(oid);
      if (decision) decisions.push(decision);
    }
    return decisions;
  }

  // The register with pending decisions applied. Saved decisions are fetched at
  // most every `refreshMs`; a failed fetch keeps the last known decisions.
  async function view() {
    const register = await loadActionRegister(root);
    if (!register.exists) return { ...register, decisions: [] };
    const { loaded, remote, trackingRef } = await repository();
    const problems = [...register.problems];
    if (Date.now() - lastFetchAt >= refreshMs) {
      await fetchBranch(remote, trackingRef).catch(() => {
        lastFetchAt = Date.now();
        problems.push("Recent decisions could not be loaded, so some may be missing from this page.");
      });
    }
    const decisions = await readDecisions(trackingRef);
    const people = loaded.resources.filter(({ type }) => type === "person");
    return { exists: true, actions: applyPendingDecisions(register.actions, decisions), problems, decisions, people };
  }

  async function decide({ actionId, outcome, note, viewer }) {
    const run = writes.then(() => decideNow({ actionId, outcome, note, viewer }));
    writes = run.catch(() => undefined);
    return run;
  }

  async function decideNow({ actionId, outcome, note, viewer }) {
    if (!DECISION_OUTCOMES.includes(outcome)) throw requestError(400, "The decision must be approve, feedback or reject.");
    const text = String(note ?? "").replace(/\r\n?/g, "\n").trim();
    if (outcome !== "approved" && !text) {
      throw requestError(400, outcome === "feedback" ? "Feedback is required." : "A reason is required to reject an action.");
    }
    if (text.length > MAX_NOTE_LENGTH) throw requestError(400, `The note must be at most ${MAX_NOTE_LENGTH} characters.`);
    if (!viewer?.personId || !viewer.email) throw requestError(403, "Sign in to decide on an action.");
    const { remote, trackingRef } = await repository();
    await fetchBranch(remote, trackingRef);
    const register = await loadActionRegister(root);
    const current = applyPendingDecisions(register.actions, await readDecisions(trackingRef))
      .find(({ id }) => id === String(actionId ?? ""));
    if (!current) throw requestError(404, "That action was not found in the register.");
    if (!DECIDABLE.has(current.status)) throw requestError(409, `${current.id} is already ${current.status}; it no longer needs a decision.`);
    if (!canDecideAction(current, viewer)) throw requestError(403, "Only the action's owner or an admin can decide on it.");
    const decidedAt = now();
    const on = decidedAt.toISOString();
    const id = `${on.replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`;
    const decision = {
      id,
      actionId: current.id,
      outcome,
      by: viewer.personId,
      email: viewer.email,
      on,
      note: text,
      ...(outcome === "approved" ? { approvedAnswer: current.suggestedAnswer ?? null } : {}),
      actionStatusBefore: current.status
    };
    const path = `${await prefix()}${ACTION_DECISIONS_DIRECTORY}/${current.id}/${id}.json`;
    const verb = { approved: "Approve", feedback: "Feedback on", rejected: "Reject" }[outcome];
    const commit = await appendFile({
      remote,
      trackingRef,
      path,
      content: `${JSON.stringify(decision, null, 2)}\n`,
      message: `${verb} ${current.id}: ${current.title || current.id}`,
      author: { name: viewer.name || viewer.email, email: viewer.email }
    });
    return { decision, path, commit, branch };
  }

  // Anyone signed in may suggest a change to a record or a collection. The
  // suggestion is saved next to decisions as `actions/suggestions/<id>.json`; the
  // register's maintainer turns it into an action with a proposed change.
  async function suggest({ recordType, recordId, text, viewer }) {
    const run = writes.then(() => suggestNow({ recordType, recordId, text, viewer }));
    writes = run.catch(() => undefined);
    return run;
  }

  async function suggestNow({ recordType, recordId, text, viewer }) {
    const body = String(text ?? "").replace(/\r\n?/g, "\n").trim();
    if (!body) throw requestError(400, "Describe what is wrong or what should change.");
    if (body.length > MAX_NOTE_LENGTH) throw requestError(400, `A suggestion must be at most ${MAX_NOTE_LENGTH} characters.`);
    if (!viewer?.personId || !viewer.email) throw requestError(403, "Sign in to suggest a change.");
    const { loaded, remote, trackingRef } = await repository();
    const type = String(recordType ?? "");
    const definition = Object.hasOwn(loaded.model.resources, type) ? loaded.model.resources[type] : null;
    if (!definition) throw requestError(400, "Choose a record type to suggest a change to.");
    const entry = recordId ? loaded.entries.find(({ record }) => record?.type === type && record.id === String(recordId)) : null;
    if (recordId && !entry) throw requestError(404, "That record was not found.");
    await fetchBranch(remote, trackingRef);
    const on = now().toISOString();
    const subject = entry?.record.id || type;
    const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "record";
    const id = `${on.replace(/[-:.]/g, "")}-${slug}-${randomBytes(3).toString("hex")}`;
    const suggestion = {
      id,
      kind: "suggestion",
      recordType: type,
      recordId: entry?.record.id ?? null,
      recordTitle: entry?.record.title ?? definition.pluralTitle ?? type,
      recordPath: entry ? `data/${entry.relativePath}` : null,
      text: body,
      by: viewer.personId,
      email: viewer.email,
      on
    };
    const path = `${await prefix()}${ACTION_SUGGESTIONS_DIRECTORY}/${id}.json`;
    const commit = await appendFile({
      remote,
      trackingRef,
      path,
      content: `${JSON.stringify(suggestion, null, 2)}\n`,
      message: `Suggest a change to ${suggestion.recordTitle}`,
      author: { name: viewer.name || viewer.email, email: viewer.email }
    });
    return { suggestion, path, commit, branch };
  }

  // Adds one new file on top of the decisions branch and pushes it, without
  // touching the checked-out branch, its index or its working tree. A rejected
  // push means someone else saved a decision first: fetch and try again.
  async function appendFile({ remote, trackingRef, path, content, message, author }) {
    const gitDirectory = await runGitCommand(root, ["rev-parse", "--absolute-git-dir"], { operation: "locate the repository" });
    for (let attempt = 1; ; attempt += 1) {
      const token = randomUUID();
      const blobFile = join(gitDirectory, `filegrc-decision-${token}`);
      const indexFile = join(gitDirectory, `filegrc-decision-index-${token}`);
      try {
        const parent = await runGitCommand(root, ["rev-parse", "--verify", "--quiet", `${trackingRef}^{commit}`], {
          operation: "find saved action decisions"
        }).catch(() => "");
        await writeFile(blobFile, content);
        const blob = await runGitCommand(root, ["hash-object", "-w", "--", blobFile], { operation: "store the decision" });
        await runGitCommand(root, parent ? ["read-tree", parent] : ["read-tree", "--empty"], {
          operation: "prepare the decision commit", gitIndexFile: indexFile
        });
        await runGitCommand(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], {
          operation: "add the decision file", gitIndexFile: indexFile
        });
        const tree = await runGitCommand(root, ["write-tree"], { operation: "prepare the decision commit", gitIndexFile: indexFile });
        const commit = await runGitCommand(root, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], {
          operation: "create the decision commit", gitEnv: commitAuthorEnvironment(author)
        });
        try {
          await runGitCommand(root, ["push", "--no-verify", "--", remote, `${commit}:refs/heads/${branch}`], {
            operation: "save the decision", timeoutMs: 30_000
          });
        } catch (error) {
          if (attempt >= PUSH_ATTEMPTS || !/rejected|fetch first|non-fast-forward/i.test(error.message)) throw error;
          await fetchBranch(remote, trackingRef);
          continue;
        }
        await runGitCommand(root, ["update-ref", trackingRef, commit], { operation: "remember the saved decision" });
        return commit;
      } finally {
        await Promise.all([blobFile, indexFile, `${indexFile}.lock`].map((file) => rm(file, { force: true }).catch(() => undefined)));
      }
    }
  }

  return { branch, view, decide, suggest };
}

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseDecision(source, actionId, id) {
  try {
    const value = JSON.parse(source);
    if (value?.id !== id || value.actionId !== actionId || !DECISION_OUTCOMES.includes(value.outcome)) return null;
    if (typeof value.on !== "string" || typeof value.by !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

function isSafeBranchName(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(value) && !value.includes("..") && !value.includes("//")
    && !value.endsWith("/") && !value.endsWith(".lock") && !value.endsWith(".");
}

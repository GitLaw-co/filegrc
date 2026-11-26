import { compareActions } from "./action-status.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAuthorEnvironment, runGitCommand } from "./git.js";
import { resolveWorkspaceRoot } from "./paths.js";
import { loadWorkspace } from "./workspace.js";

// An action register is an optional folder of questions waiting on a person:
// `actions/<ID>.json`, one file per action, outside `data/`. Hosted mode shows it
// at /actions and lets the owner (or an admin) respond: approve the suggested
// answer, mark a task done, record progress, message the agent, or reject.
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
// The label each kind of action shows on the Actions page. An action without a
// known kind reads as a decision.
export const ACTION_KIND_LABELS = {
  fix: "Task",
  external: "Task outside GitLaw",
  decision: "Decision",
  approval: "Sign-off",
  information: "Information needed"
};
export const ACTION_FILTER_KEYS = ["q", "owner", "status", "priority", "type", "blocks"];
export function actionKind(action) {
  return Object.hasOwn(ACTION_KIND_LABELS, action?.kind) ? action.kind : "decision";
}
// approved: the suggested answer is accepted. done: the owner did the work.
// progress: part of the work is done; the action stays open. feedback: a message
// to the agent, not a statement for the record. rejected: it will not be done.
export const DECISION_OUTCOMES = ["approved", "done", "progress", "feedback", "rejected"];
const DECIDABLE = new Set(["open", "proposed"]);
const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DECISION_ID = /^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{6}$/;
const MAX_NOTE_LENGTH = 4000;
const REFRESH_MS = 30_000;
const PUSH_ATTEMPTS = 3;
const MAX_QUEUED_WRITES = 20;
const PROTECTED_BRANCH_NAMES = new Set(["main", "master", "trunk", "develop"]);
const PULL_REQUEST_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]{0,8})(?:\/[^?#]*)?(?:[?#].*)?$/;
const COMMIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// Ties an Approve to the exact suggested answer the owner read.
export function answerRevision(answer) {
  return createHash("sha256").update(String(answer ?? "")).digest("hex").slice(0, 16);
}

// `owner/repo` of a GitHub remote URL (https, ssh or scp form), lowercased; null otherwise.
export function githubRepositoryFromRemote(url) {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url ?? "").trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

// The pull requests of the program repository that an action links to, by
// number, in link order. Links to other repositories are not bound.
export function actionPullRequests(action, repository) {
  if (!repository) return [];
  const raw = action?.links;
  const entries = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  const found = new Map();
  for (const entry of entries) {
    const url = typeof entry === "string" ? entry : entry && typeof entry === "object" ? String(entry.url ?? entry.href ?? "") : "";
    const match = PULL_REQUEST_URL.exec(url.trim());
    if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== String(repository).toLowerCase()) continue;
    const number = Number(match[3]);
    if (!found.has(number)) found.set(number, { url: `https://github.com/${match[1]}/${match[2]}/pull/${number}`, number });
  }
  return [...found.values()];
}

// The form value an Approve carries for the pull request versions the owner saw:
// `<number>:<sha>` pairs joined by commas.
export function pullRequestVersions(pullRequests) {
  return (pullRequests ?? []).map(({ number, headSha }) => `${number}:${headSha ?? ""}`).join(",");
}

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
// decisions applied in time order. Approve, done and reject settle it; progress
// and feedback leave the status alone. The file on the authoritative branch is not changed.
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
      if (decision.outcome === "done") view = { ...view, status: "done", decision: summary(decision) };
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
  const given = ACTION_FILTER_KEYS.some((key) => searchParams.has(key));
  const value = (key) => String(searchParams.get(key) ?? "").trim();
  if (!given) return { q: "", owner: viewerPersonId || "", status: "waiting", priority: "", type: "", blocks: "" };
  const status = value("status");
  const priority = value("priority");
  const type = value("type");
  return {
    q: value("q").slice(0, 200),
    owner: value("owner"),
    status: status === "all" || status === "waiting" || ACTION_STATUSES.includes(status) ? status : "waiting",
    priority: ACTION_PRIORITIES.includes(priority) ? priority : "",
    type: Object.hasOwn(ACTION_KIND_LABELS, type) ? type : "",
    blocks: value("blocks") === "yes" ? "yes" : ""
  };
}

export function filterActions(actions, filters) {
  const query = String(filters.q ?? "").toLowerCase();
  return actions.filter((action) => (
    (!query || [action.id, action.title, action.question, action.suggestedAnswer, ACTION_KIND_LABELS[actionKind(action)]].some((text) => String(text ?? "").toLowerCase().includes(query)))
    && (!filters.owner || action.ownerId === filters.owner)
    && (filters.status === "all" || !filters.status
      || (filters.status === "waiting" ? DECIDABLE.has(action.status) : action.status === filters.status))
    && (!filters.priority || action.priority === filters.priority)
    && (!filters.type || actionKind(action) === filters.type)
    && (!filters.blocks || action.blocksPeriodStart === true)
  )).sort(compareActions);
}

// What the dashboard shows: the viewer's actions waiting for a decision (everyone's
// when nobody is signed in), the counts behind them, and the first few to do.
export function summarizeActions(actions, { viewerPersonId = null, today = new Date().toISOString().slice(0, 10), limit = 5 } = {}) {
  const waiting = filterActions(actions, { status: "waiting" });
  const mine = viewerPersonId ? waiting.filter((action) => action.ownerId === viewerPersonId) : waiting;
  const overdue = (list) => list.filter((action) => /^\d{4}-\d{2}-\d{2}$/.test(String(action.due ?? "")) && action.due < today).length;
  const blocking = (list) => list.filter((action) => action.blocksPeriodStart === true).length;
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
  const dueSoon = (list) => list.filter((action) => /^\d{4}-\d{2}-\d{2}$/.test(String(action.due ?? "")) && action.due >= today && action.due <= horizon).length;
  return {
    scope: viewerPersonId ? "viewer" : "everyone",
    counts: {
      waiting: mine.length,
      blocking: blocking(mine),
      overdue: overdue(mine),
      waitingEveryone: waiting.length,
      blockingEveryone: blocking(waiting),
      overdueEveryone: overdue(waiting),
      toReview: mine.filter((action) => action.status === "proposed").length,
      toReviewEveryone: waiting.filter((action) => action.status === "proposed").length,
      dueSoonEveryone: dueSoon(waiting)
    },
    items: mine.slice(0, limit).map(({ id, title, ownerId, status, priority, due, blocksPeriodStart, kind }) => ({
      id, title, ownerId, status, priority, due, kind, blocksPeriodStart: blocksPeriodStart === true,
      overdue: /^\d{4}-\d{2}-\d{2}$/.test(String(due ?? "")) && due < today
    }))
  };
}

export function canDecideAction(action, viewer) {
  return Boolean(viewer?.personId) && DECIDABLE.has(action.status)
    && (viewer.isAdmin === true || action.ownerId === viewer.personId);
}

export function createActionRegister(input, options = {}) {
  const root = resolveWorkspaceRoot(input);
  const branch = String(options.decisionsBranch ?? DEFAULT_ACTION_DECISIONS_BRANCH).trim();
  if (!isSafeBranchName(branch)) throw new Error(`The action decisions branch "${branch}" is not a safe Git branch name.`);
  if (PROTECTED_BRANCH_NAMES.has(branch.toLowerCase())) {
    throw new Error(`Action decisions cannot go to "${branch}". Choose a separate branch such as ${DEFAULT_ACTION_DECISIONS_BRANCH}.`);
  }
  const now = options.now ?? (() => new Date());
  const refreshMs = options.refreshMs ?? REFRESH_MS;
  const configuredRepository = options.pullRequestRepository ? String(options.pullRequestRepository).toLowerCase() : null;
  let remoteRepository;
  const blobCache = new Map();
  let lastFetchAt = 0;
  let writes = Promise.resolve();
  let queued = 0;
  let refreshing = null;

  // Writes and fetches of the decisions branch run one at a time, so a fetch can
  // never rewind the tracking ref past a decision that was just pushed.
  function exclusive(task, { limit = false } = {}) {
    if (limit && queued >= MAX_QUEUED_WRITES) {
      return Promise.reject(requestError(429, "Too many changes are being saved right now. Try again in a minute."));
    }
    queued += 1;
    const run = writes.then(task).finally(() => { queued -= 1; });
    writes = run.catch(() => undefined);
    return run;
  }

  async function repository() {
    const loaded = await loadWorkspace(root);
    const renderer = loaded.resources.find(({ type, id }) => type === "renderer-settings" && id === "renderer-settings");
    const remote = String(renderer?.repositoryRemote || "origin").trim();
    if (!isSafeBranchName(remote)) throw new Error("The configured repository remote is not a safe Git name.");
    const checkedOut = await runGitCommand(root, ["symbolic-ref", "--short", "-q", "HEAD"], { operation: "find the checked-out branch" }).catch(() => "");
    if ([renderer?.authoritativeBranch, checkedOut].some((name) => name && String(name).toLowerCase() === branch.toLowerCase())) {
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

  // `owner/repo` whose pull request links an Approve is bound to: the option when
  // given, else the GitHub repository the remote points at.
  async function pullRequestRepository(remote) {
    if (configuredRepository) return configuredRepository;
    if (remoteRepository === undefined) {
      const url = await runGitCommand(root, ["remote", "get-url", "--", remote], { operation: "read the repository remote" }).catch(() => "");
      remoteRepository = githubRepositoryFromRemote(url);
    }
    return remoteRepository;
  }

  // The current head commit of each pull request, read from the remote's
  // refs/pull/<n>/head. A number missing from the result has no such ref.
  async function pullRequestHeads(remote, numbers) {
    const heads = new Map();
    const wanted = [...new Set(numbers)];
    if (!wanted.length) return heads;
    const listing = await runGitCommand(root, ["ls-remote", "--", remote, ...wanted.map((number) => `refs/pull/${number}/head`)], {
      operation: "read the pull request versions", timeoutMs: 30_000
    });
    for (const line of listing.split("\n")) {
      const match = /^([0-9a-f]{40,64})\trefs\/pull\/([0-9]+)\/head$/.exec(line.trim());
      if (match && wanted.includes(Number(match[2]))) heads.set(Number(match[2]), match[1]);
    }
    return heads;
  }

  // Each waiting action's linked pull requests with their current head, so the
  // page can say which version an Approve covers. A failed lookup leaves headSha null.
  async function withPullRequests(actions, remote, problems) {
    const repository = await pullRequestRepository(remote);
    const linked = actions.map((action) => (DECIDABLE.has(action.status) ? actionPullRequests(action, repository) : []));
    const numbers = linked.flat().map(({ number }) => number);
    let heads = new Map();
    if (numbers.length) {
      try {
        heads = await pullRequestHeads(remote, numbers);
      } catch {
        problems.push("The current versions of linked pull requests could not be read. Reload before approving.");
      }
    }
    return actions.map((action, index) => (linked[index].length
      ? { ...action, pullRequests: linked[index].map((pr) => ({ ...pr, headSha: heads.get(pr.number) ?? null })) }
      : action));
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

  // Fetches the branch at most every `refreshMs`, one fetch at a time. Returns
  // false when the fetch failed and the last known state is all there is.
  async function refresh(remote, trackingRef) {
    if (!refreshing && Date.now() - lastFetchAt < refreshMs) return true;
    if (!refreshing) {
      lastFetchAt = Date.now();
      refreshing = exclusive(() => fetchBranch(remote, trackingRef)).finally(() => { refreshing = null; });
    }
    return refreshing.then(() => true, () => false);
  }

  // The register with pending decisions applied; a failed fetch keeps the last known decisions.
  async function view() {
    const register = await loadActionRegister(root);
    if (!register.exists) return { ...register, decisions: [] };
    const { loaded, remote, trackingRef } = await repository();
    const problems = [...register.problems];
    if (!await refresh(remote, trackingRef)) {
      problems.push("Recent decisions could not be loaded, so some may be missing from this page.");
    }
    const decisions = await readDecisions(trackingRef);
    const people = loaded.resources.filter(({ type }) => type === "person");
    const actions = await withPullRequests(applyPendingDecisions(register.actions, decisions), remote, problems);
    return { exists: true, actions, problems, decisions, people };
  }

  async function decide(request) {
    return exclusive(() => decideNow(request), { limit: true });
  }

  async function decideNow({ actionId, outcome, note, viewer, answerRevision: seenAnswer, pullRequestVersions: seenVersions }) {
    if (!DECISION_OUTCOMES.includes(outcome)) throw requestError(400, "Choose a response: approve, done, progress, message or reject.");
    const text = String(note ?? "").replace(/\r\n?/g, "\n").trim();
    if (outcome !== "approved" && !text) {
      throw requestError(400, {
        done: "Say what you did, so the record shows it.",
        progress: "Say what you have done so far.",
        feedback: "Write your message to the agent.",
        rejected: "A reason is required to reject an action."
      }[outcome]);
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
    if (outcome === "approved" && !String(current.suggestedAnswer ?? "").trim()) {
      throw requestError(400, `${current.id} has no suggested answer to approve. Message the agent instead.`);
    }
    if (outcome === "approved" && seenAnswer !== answerRevision(current.suggestedAnswer)) {
      throw requestError(409, `The suggested answer for ${current.id} changed after you opened the page. Read it again before approving.`);
    }
    // An Approve of an action that links pull requests of this repository covers
    // the versions the page showed; if any head moved since, the owner reviews again.
    let pullRequests = [];
    if (outcome === "approved") {
      pullRequests = actionPullRequests(current, await pullRequestRepository(remote));
      if (pullRequests.length) {
        const seen = parseVersions(seenVersions);
        let heads;
        try {
          heads = await pullRequestHeads(remote, pullRequests.map(({ number }) => number));
        } catch {
          throw requestError(503, "The pull request version could not be checked. Try again in a minute.");
        }
        for (const pr of pullRequests) {
          const head = heads.get(pr.number);
          if (!head) throw requestError(409, `Pull request #${pr.number} was not found, so its version cannot be approved.`);
          if (seen.get(pr.number) !== head) {
            throw requestError(409, "The pull request changed since you opened this page — reload and review again.");
          }
          pr.headSha = head;
        }
      }
    }
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
      ...(pullRequests.length === 1 ? { pullRequest: pullRequests[0] } : {}),
      ...(pullRequests.length > 1 ? { pullRequests } : {}),
      actionStatusBefore: current.status
    };
    const path = `${await prefix()}${ACTION_DECISIONS_DIRECTORY}/${current.id}/${id}.json`;
    const verb = { approved: "Approve", done: "Done", progress: "Progress on", feedback: "Message on", rejected: "Reject" }[outcome];
    const commit = await appendFile({
      remote,
      trackingRef,
      path,
      content: `${JSON.stringify(decision, null, 2)}\n`,
      message: `${verb} ${current.id}: ${current.title || current.id}`,
      author: commitAuthor(viewer)
    });
    return { decision, path, commit, branch };
  }

  // Anyone signed in may suggest a change to a record or a collection. The
  // suggestion is saved next to decisions as `actions/suggestions/<id>.json`; the
  // register's maintainer turns it into an action with a proposed change.
  async function suggest(request) {
    return exclusive(() => suggestNow(request), { limit: true });
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
      author: commitAuthor(viewer)
    });
    return { suggestion, path, commit, branch };
  }

  // Saves a prepared record file (such as an Attestation) on the branch instead
  // of the authoritative branch, for a reviewed change to add to the program.
  async function saveRecord({ path, record, message, viewer }) {
    return exclusive(async () => {
      const { remote, trackingRef } = await repository();
      await fetchBranch(remote, trackingRef);
      const commit = await appendFile({
        remote,
        trackingRef,
        path: `${await prefix()}${path}`,
        content: `${JSON.stringify(record, null, 2)}\n`,
        message,
        author: commitAuthor(viewer)
      });
      return { commit, branch, path };
    }, { limit: true });
  }

  // Records saved on the branch under a workspace directory such as data/attestations.
  async function savedRecords(directory) {
    const { remote, trackingRef } = await repository();
    await refresh(remote, trackingRef);
    const tip = await runGitCommand(root, ["rev-parse", "--verify", "--quiet", `${trackingRef}^{commit}`], {
      operation: "find saved records"
    }).catch(() => "");
    if (!tip) return [];
    const base = `${await prefix()}${directory}/`;
    const listing = await runGitCommand(root, ["ls-tree", "-r", "-z", "--full-tree", tip, "--", base], { operation: "list saved records" });
    const records = [];
    for (const line of listing.split("\0").filter(Boolean)) {
      const match = /^100644 blob ([0-9a-f]{40,64})\t(.+\.json)$/.exec(line);
      if (!match) continue;
      if (!blobCache.has(match[1])) {
        const source = await runGitCommand(root, ["cat-file", "blob", match[1]], { operation: "read a saved record" });
        let value = null;
        try { value = JSON.parse(source); } catch { /* skip a file that is not JSON */ }
        blobCache.set(match[1], value);
      }
      if (blobCache.get(match[1])) records.push(blobCache.get(match[1]));
    }
    return records;
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
          if (attempt >= PUSH_ATTEMPTS || !/non-fast-forward|fetch first|stale info/i.test(error.message)) throw error;
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

  return { branch, view, decide, suggest, saveRecord, savedRecords };
}

// The Person's name when Git accepts it as an author name, else their email.
function commitAuthor(viewer) {
  const name = String(viewer.name ?? "").trim();
  return { name: name && !/[<>\u0000-\u001f\u007f]/.test(name) ? name : viewer.email, email: viewer.email };
}

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// `<number>:<sha>` pairs from the Approve form; anything malformed is ignored.
function parseVersions(value) {
  const versions = new Map();
  for (const pair of String(value ?? "").split(",")) {
    const match = /^([1-9][0-9]{0,8}):(.*)$/.exec(pair.trim());
    if (match && COMMIT_SHA.test(match[2])) versions.set(Number(match[1]), match[2]);
  }
  return versions;
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

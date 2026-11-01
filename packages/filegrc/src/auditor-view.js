import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { prepareEvidencePacket } from "./evidence-packet.js";
import { getFileBufferAtRevision, runGitCommand } from "./git.js";
import { escapeHtml } from "./markdown.js";
import { resolveWorkspaceRoot } from "./paths.js";

// An auditor reads one tagged revision through signed links. The link names
// the commit the tag resolved to when it was issued, so later commits and a
// moved tag never change what the auditor sees. Locally the server answers these
// links on a separate listener; in hosted mode it answers them under /auditor/
// on the main server. Either way only GET is served and no cookie is set.
export const AUDITOR_LINK_MAX_HOURS = 168;
const AUDITOR_LINK_DEFAULT_HOURS = 24;
const EVIDENCE_LINK_HOURS = 1;
const HOUR_MS = 3_600_000;
// Optional. A fixed signing key keeps issued links valid across restarts.
export const AUDITOR_LINK_SECRET_ENV = "FILEGRC_AUDITOR_LINK_SECRET";
const MIN_AUDITOR_LINK_SECRET_LENGTH = 32;

export function auditorLinkSecretFromEnv(env = process.env) {
  const secret = String(env[AUDITOR_LINK_SECRET_ENV] ?? "").trim();
  if (!secret) return undefined;
  if (secret.length < MIN_AUDITOR_LINK_SECRET_LENGTH) {
    throw new Error(`${AUDITOR_LINK_SECRET_ENV} must be at least ${MIN_AUDITOR_LINK_SECRET_LENGTH} characters.`);
  }
  return secret;
}

export function createAuditorView(input, options = {}) {
  const root = resolveWorkspaceRoot(input);
  const secret = options.secret || randomBytes(32);
  const now = options.now || Date.now;
  const checkouts = new Map();
  const packets = new Map();

  const sign = (pathname, commit, expires) => createHmac("sha256", secret)
    .update(`${pathname}\n${commit}\n${expires}`).digest("hex");
  const link = (pathname, commit, expires) => (
    `${pathname}?${new URLSearchParams({ commit, expires: String(expires), signature: sign(pathname, commit, expires) })}`
  );
  const verified = (url) => {
    const commit = url.searchParams.get("commit") || "";
    const expires = Number(url.searchParams.get("expires"));
    const signature = Buffer.from(url.searchParams.get("signature") || "", "hex");
    const expected = Buffer.from(sign(url.pathname, commit, expires), "hex");
    if (!/^[a-f0-9]{40}$/.test(commit) || !Number.isSafeInteger(expires) || now() >= expires) return null;
    return signature.length === expected.length && timingSafeEqual(signature, expected) ? { commit, expires } : null;
  };

  // Materialize the tagged commit in a private clone so the existing packet
  // indexes run against that revision and its history, never the working tree.
  const checkout = (commit) => {
    if (!checkouts.has(commit)) {
      checkouts.set(commit, (async () => {
        const [topLevel, prefix] = await Promise.all([
          runGitCommand(root, ["rev-parse", "--show-toplevel"]),
          runGitCommand(root, ["rev-parse", "--show-prefix"])
        ]);
        const directory = await mkdtemp(join(tmpdir(), "filegrc-auditor-"));
        await runGitCommand(directory, ["clone", "--quiet", "--shared", "--no-checkout", topLevel, "."]);
        await runGitCommand(directory, ["checkout", "--quiet", "--detach", commit]);
        return { directory, workspaceRoot: join(directory, prefix) };
      })());
    }
    return checkouts.get(commit);
  };
  const packetFor = (commit, auditId) => {
    const key = `${commit}\n${auditId}`;
    if (!packets.has(key)) {
      packets.set(key, checkout(commit).then(({ workspaceRoot }) => prepareEvidencePacket(workspaceRoot, { auditId })));
      packets.get(key).catch(() => packets.delete(key));
    }
    return packets.get(key);
  };

  return {
    async createLink(payload = {}) {
      const tag = String(payload.tag || "");
      const auditId = String(payload.auditId || "");
      const hours = payload.hours ?? AUDITOR_LINK_DEFAULT_HOURS;
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(tag) || tag.includes("..")) throw new Error("A valid Git tag name is required.");
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(auditId)) throw new Error("A valid Audit ID is required.");
      if (!Number.isInteger(hours) || hours < 1 || hours > AUDITOR_LINK_MAX_HOURS) {
        throw new Error(`Link hours must be a whole number from 1 through ${AUDITOR_LINK_MAX_HOURS}.`);
      }
      let commit;
      try {
        commit = await runGitCommand(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
      } catch {
        throw new Error(`Tag "${tag}" was not found.`);
      }
      await packetFor(commit, auditId);
      const expires = now() + hours * HOUR_MS;
      return {
        tag, commit, auditId, expiresAt: new Date(expires).toISOString(),
        url: link(`/auditor/${encodeURIComponent(tag)}/${encodeURIComponent(auditId)}`, commit, expires)
      };
    },

    async respond(url) {
      const access = verified(url);
      if (!access) return { status: 403, error: "This auditor link is invalid or has expired." };
      const segments = url.pathname.slice("/auditor/".length).split("/").map(decodeURIComponent);
      const [tag, auditId] = segments;
      const packet = await packetFor(access.commit, auditId);
      if (segments.length === 2) {
        const evidenceExpires = Math.min(access.expires, now() + EVIDENCE_LINK_HOURS * HOUR_MS);
        const evidenceLink = (evidenceId, path) => link(
          `/auditor/${[tag, auditId, "evidence", evidenceId, path].map(encodeURIComponent).join("/")}`, access.commit, evidenceExpires
        );
        return {
          status: 200,
          html: renderAuditorView(packet, { tag, commit: access.commit, evidenceLink, evidenceExpires })
        };
      }
      const [, , kind, evidenceId, path] = segments;
      const evidence = packet.evidence.find(({ id }) => id === evidenceId);
      if (segments.length !== 5 || kind !== "evidence" || !evidence?.filePaths.includes(path)) {
        return { status: 404, error: "Evidence not found." };
      }
      const file = getFileBufferAtRevision(root, access.commit, `data/${path}`);
      return file ? { status: 200, file, path } : { status: 404, error: "Evidence not found." };
    },

    async close() {
      const pending = [...checkouts.values()];
      checkouts.clear();
      packets.clear();
      await Promise.all(pending.map((promise) => promise.then(
        ({ directory }) => rm(directory, { recursive: true, force: true }),
        () => {}
      )));
    }
  };
}

function renderAuditorView(packet, { tag, commit, evidenceLink, evidenceExpires }) {
  const evidenceById = new Map(packet.evidence.map((item) => [item.id, item]));
  const populationById = new Map(packet.populations.map((item) => [item.id, item]));
  const period = (coverage) => coverage?.startsOn ? `${coverage.startsOn} through ${coverage.endsOn || "open"}` : coverage?.on || "Not recorded";
  const evidenceList = (ids) => ids.map((id) => {
    const item = evidenceById.get(id);
    if (!item) return `<li>${escapeHtml(id)}</li>`;
    const files = item.filePaths.map((path) => `<a href="${escapeHtml(evidenceLink(item.id, path))}">${escapeHtml(basename(path))}</a>`);
    if (!files.length) files.push(item.externalReference ? "External reference: request it through the engagement's agreed channel" : "No fixed attachment");
    return `<li>${escapeHtml(item.title)} <small>${escapeHtml(item.id)} · ${escapeHtml(item.status)} · collected ${escapeHtml(item.collectedOn || "not recorded")}</small><br>${files.join(" · ")}</li>`;
  }).join("") || "<li>No linked evidence</li>";
  const tested = packet.controlCoverage.filter(({ tests }) => tests.length);
  const untested = packet.controlCoverage.filter(({ tests }) => !tests.length);
  const controls = tested.map((control) => `<section><h2>${escapeHtml([control.code, control.title].filter(Boolean).join(" "))}</h2>
<p>${escapeHtml(control.statement)}</p>
<table><thead><tr><th>Control test</th><th>Status and outcome</th><th>Period</th><th>Sample</th><th>Population</th></tr></thead><tbody>${control.tests.map((test) => {
    const population = populationById.get(test.populationId);
    return `<tr><td>${escapeHtml(test.id)}</td><td>${escapeHtml(test.status)}${test.outcome ? ` · ${escapeHtml(test.outcome)}` : ""}</td><td>${escapeHtml(period(test.coverage))}</td><td>${test.sampleSize ?? "Not recorded"} sampled · ${test.exceptionCount ?? "not recorded"} exceptions</td><td>${population ? `${escapeHtml(population.title)} <small>${escapeHtml(population.status)} · ${population.populationCount ?? "count not recorded"} items</small>` : "None linked"}</td></tr>`;
  }).join("")}</tbody></table>
<h3>Linked evidence</h3><ul>${evidenceList(control.evidenceIds)}</ul></section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Auditor view · ${escapeHtml(tag)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:24px;color:#1f2933}table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}th,td{border-bottom:1px solid #d9dee3;padding:6px 8px;text-align:left;vertical-align:top}small{color:#52606d}section{margin-top:32px}</style></head>
<body><header><p>FileGRC auditor view · read-only</p><h1>${escapeHtml(packet.audit?.title || "Audit")}</h1>
<p>${escapeHtml(packet.workspace.organizationName)} · tag <code>${escapeHtml(tag)}</code> · commit <code>${escapeHtml(commit)}</code> · period ${escapeHtml(packet.period.start)} through ${escapeHtml(packet.period.end)}</p>
<p>This view shows the records management committed at this tag, organised by control test. It lists the evidence management linked; it does not decide whether that evidence is sufficient or appropriate. The engagement team makes that judgment.</p>
<p>Evidence links on this page expire at ${escapeHtml(new Date(evidenceExpires).toISOString())}. Reload the page for new links while your auditor link is valid.</p></header>
${controls || "<p>No control tests are recorded for this audit at this tag.</p>"}
${untested.length ? `<section><h2>Controls without a control test</h2><ul>${untested.map((control) => `<li>${escapeHtml([control.code, control.title].filter(Boolean).join(" "))}</li>`).join("")}</ul></section>` : ""}
</body></html>`;
}

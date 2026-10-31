import { readFile } from "node:fs/promises";
import { contentRevision, createResource } from "./files.js";
import { createResourceId } from "./id.js";
import { resolveDataPath } from "./paths.js";
import { assessProgramReadiness } from "./program-readiness.js";
import { markdownEntries } from "./resource-markdown.js";
import { currentCalendarDate } from "./time.js";
import { loadWorkspace } from "./workspace.js";

// Program readiness already names every person-by-subject gap in its workforce
// training and acknowledgement baselines; the attestation kinds match the
// Obligation activities that assign the same work.
const OWED_ATTESTATION_CHECKS = {
  "baseline-workforce-training": "training",
  "baseline-workforce-acknowledgements": "workforce-acknowledgement"
};

// Read only the target's editable source. Exporting an edit does not require
// rendering, workflow assessment, validation or unrelated record histories.
export async function readResourceMutation(input, type, id) {
  const loaded = input?.entries && input?.root ? input : await loadWorkspace(input);
  const entry = loaded.entries.find(({ record }) => record.id === id && (!type || record.type === type));
  if (!entry) throw new Error(`Resource "${type ? `${type}/` : ""}${id}" was not found.`);
  const content = await readResourceContent(loaded, entry.record);
  const contentEntries = Object.entries(content);
  return {
    record: structuredClone(entry.record),
    ...(contentEntries.length ? {
      content: Object.fromEntries(contentEntries.map(([name, item]) => [name, item.source])),
      contentRevisions: Object.fromEntries(contentEntries.map(([, item]) => [item.path, item.revision]))
    } : {}),
    revision: contentRevision(entry.source)
  };
}

export async function listOwedAttestations(input, personId, options = {}) {
  const loaded = input?.entries && input?.root ? input : await loadWorkspace(input);
  const byId = new Map(loaded.resources.map((record) => [record.id, record]));
  const owed = new Map();
  for (const program of loaded.resources.filter(({ type, status }) => type === "program" && status !== "retired")) {
    const readiness = await assessProgramReadiness(loaded, { programId: program.id, asOf: options.asOf });
    const checks = readiness.stages.flatMap(({ items }) => items).flatMap(({ preparationChecks = [] }) => preparationChecks);
    for (const check of checks.filter(({ id }) => OWED_ATTESTATION_CHECKS[id])) {
      for (const member of check.missingMembers || []) {
        const subject = byId.get(member.subjectId);
        if (member.personId !== personId || !subject || owed.has(subject.id)) continue;
        owed.set(subject.id, { subjectId: subject.id, subjectType: subject.type, title: subject.title,
          programId: program.id, attestationKind: OWED_ATTESTATION_CHECKS[check.id] });
      }
    }
  }
  return [...owed.values()];
}

// The attesting person is the caller's identity, never a payload value. The
// payload chooses one owed subject; creation binds its current content.
export async function completeOwnAttestation(input, personId, payload = {}) {
  const loaded = await loadWorkspace(input);
  const subjectIds = payload.record?.subjectResourceIds;
  const owed = Array.isArray(subjectIds) && subjectIds.length === 1
    ? (await listOwedAttestations(loaded, personId)).find(({ subjectId }) => subjectId === subjectIds[0])
    : null;
  if (!owed) throw new Error("The subject must be one Policy, Document, or Training you owe an acknowledgement for now.");
  const completedOn = currentCalendarDate(loaded.workspace?.timezone || "UTC");
  const record = {
    id: createResourceId("attestation", `${personId} ${owed.subjectId} ${completedOn}`, loaded.resources.map(({ id }) => id)),
    type: "attestation",
    title: `${owed.title} ${owed.attestationKind === "training" ? "completion" : "acknowledgement"}`,
    status: "completed",
    programId: owed.programId,
    subjectResourceIds: [owed.subjectId],
    personId,
    attestationKind: owed.attestationKind,
    assignedOn: completedOn,
    completedOn,
    attestationMethod: "git-approval"
  };
  return createResource(loaded.root, record, { content: payload.content });
}

export async function readResourceContent(loaded, record) {
  const content = {};
  if (!loaded.model.resources[record.type]) return content;
  for (const item of markdownEntries(loaded.model, record)) {
    try {
      const source = await readFile(resolveDataPath(loaded.root, item.path), "utf8");
      content[item.name] = { source, path: item.path, revision: contentRevision(source) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // An absent optional companion is not an editable source file.
    }
  }
  return content;
}

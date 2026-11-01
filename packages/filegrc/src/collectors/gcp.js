import { fetchAccessToken, googleRequest } from "./google-auth.js";

const DEFAULT_API_URL = "https://cloudresourcemanager.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only";
const HINT = "Check the project ID and that the service account can read the project's IAM policy.";
const PUBLIC_MEMBERS = new Set(["allUsers", "allAuthenticatedUsers"]);

// Reads one Google Cloud project's IAM policy with a read-only service account.
// FILEGRC_GCP_CREDENTIALS holds the service account key as inline JSON or a
// file path. The key signs one token request and is never printed or stored.
// FILEGRC_GCP_TOKEN_URL and FILEGRC_GCP_API_URL override the Google endpoints;
// plain HTTP is accepted only on loopback.
export const gcpCollector = {
  tokenVariable: "FILEGRC_GCP_CREDENTIALS",
  async collect({ token, options, env }) {
    if (!options.project) throw new Error("Pass --project <project-id> to name the Google Cloud project to check.");
    const accessToken = await fetchAccessToken({ prefix: "FILEGRC_GCP", token, env, scope: SCOPE, hint: HINT });
    const policyPath = `/v1/projects/${encodeURIComponent(options.project)}:getIamPolicy`;
    const policy = await googleRequest("POST", env.FILEGRC_GCP_API_URL || DEFAULT_API_URL, policyPath, "FILEGRC_GCP_API_URL", {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    }, JSON.stringify({ options: { requestedPolicyVersion: 3 } }), HINT);
    const project = slug(options.project);
    const source = `Google Cloud Resource Manager v1 POST ${policyPath}`;

    const publicBindings = (policy.bindings || []).flatMap(({ role, members = [] }) =>
      members.filter((member) => PUBLIC_MEMBERS.has(member)).map((member) => `${role} ${member}`));
    const allServices = (policy.auditConfigs || []).find(({ service }) => service === "allServices");
    const logTypes = (allServices?.auditLogConfigs || []).map(({ logType }) => logType);
    const missingLogTypes = ["DATA_READ", "DATA_WRITE"].filter((logType) => !logTypes.includes(logType));
    return [{
      key: `gcp-public-iam-${project}`,
      title: `Google Cloud project ${options.project} grants no IAM role to allUsers or allAuthenticatedUsers`,
      expectedCondition: `No IAM binding on Google Cloud project ${options.project} grants a role to allUsers or allAuthenticatedUsers.`,
      sourceDescription: `${source}, field bindings.`,
      result: publicBindings.length ? "failed" : "passed",
      observed: `${source}\n\nPublic role/member pairs:\n\n${publicBindings.length ? publicBindings.map((pair) => `- ${pair}`).join("\n") : "- none"}`
    }, {
      key: `gcp-data-access-audit-${project}`,
      title: `Google Cloud project ${options.project} logs Data Access reads and writes for all services`,
      expectedCondition: `The IAM policy of Google Cloud project ${options.project} has an allServices audit config that logs DATA_READ and DATA_WRITE.`,
      sourceDescription: `${source}, field auditConfigs.`,
      result: missingLogTypes.length ? "failed" : "passed",
      observed: `${source}\n\n- allServices audit config: ${allServices ? "present" : "absent"}\n- log types: ${logTypes.join(", ") || "none"}\n- missing: ${missingLogTypes.join(", ") || "none"}`
    }];
  }
};

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

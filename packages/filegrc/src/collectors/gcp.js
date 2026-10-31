import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_API_URL = "https://cloudresourcemanager.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
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
    const key = await readKey(token);
    const tokenUrl = env.FILEGRC_GCP_TOKEN_URL || DEFAULT_TOKEN_URL;
    const { access_token: accessToken } = await post(tokenUrl, "", "FILEGRC_GCP_TOKEN_URL", {
      "content-type": "application/x-www-form-urlencoded"
    }, new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signJwt(key, tokenUrl) }).toString());
    if (!accessToken) throw new Error("The Google token endpoint did not return an access token.");
    const policyPath = `/v1/projects/${encodeURIComponent(options.project)}:getIamPolicy`;
    const policy = await post(env.FILEGRC_GCP_API_URL || DEFAULT_API_URL, policyPath, "FILEGRC_GCP_API_URL", {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    }, JSON.stringify({ options: { requestedPolicyVersion: 3 } }));
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

// Error messages name the problem only; they never echo the key's content.
async function readKey(value) {
  let source = value.trim();
  if (!source.startsWith("{")) {
    try {
      source = await readFile(source, "utf8");
    } catch {
      throw new Error("FILEGRC_GCP_CREDENTIALS must hold a service account key as inline JSON or the path of a readable key file.");
    }
  }
  let key = null;
  try {
    key = JSON.parse(source);
  } catch {
    // Reported below without the content.
  }
  if (!key?.client_email || !key?.private_key) {
    throw new Error("FILEGRC_GCP_CREDENTIALS must be a service account key in JSON with client_email and private_key.");
  }
  return key;
}

function signJwt(key, audience) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) })}.${encode({
    iss: key.client_email,
    scope: SCOPE,
    aud: audience,
    iat: issuedAt,
    exp: issuedAt + 3600
  })}`;
  let signature;
  try {
    signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  } catch {
    throw new Error("FILEGRC_GCP_CREDENTIALS has a private_key that cannot sign. Download a new JSON key for the service account.");
  }
  return `${unsigned}.${signature}`;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function post(baseUrl, path, variable, headers, body) {
  const url = new URL(baseUrl.replace(/\/$/, "") + path);
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) ? http : null;
  if (!transport) return Promise.reject(new Error(`${variable} must use https (plain http is allowed only on localhost): ${baseUrl}`));
  const label = `Google POST ${url.pathname}`;
  return new Promise((resolve, reject) => {
    const call = transport.request(url, {
      method: "POST",
      headers: { ...headers, "content-length": Buffer.byteLength(body), "user-agent": "filegrc-collector" },
      timeout: 30000
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Reported below with the HTTP status.
        }
        if (response.statusCode !== 200 || !parsed) {
          const detail = parsed?.error?.message || parsed?.error_description || "";
          reject(new Error(`${label} returned HTTP ${response.statusCode}${detail ? `: ${detail}` : ""}. Check the project ID and that the service account can read the project's IAM policy.`));
        } else resolve(parsed);
      });
    });
    call.on("timeout", () => call.destroy(new Error(`${label} timed out.`)));
    call.on("error", reject);
    call.end(body);
  });
}

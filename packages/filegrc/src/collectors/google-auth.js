import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_IAM_CREDENTIALS_URL = "https://iamcredentials.googleapis.com";
// Credential files that hold no private key but can mint an access token: Workload
// Identity Federation (external_account) and gcloud user credentials (authorized_user).
const AMBIENT_TYPES = new Set(["external_account", "authorized_user"]);

// Shared by the Google collectors. `${prefix}_CREDENTIALS` is inline JSON or a file
// path holding one of:
// - a service account key: it signs one RS256 token request at `${prefix}_TOKEN_URL`;
// - keyless credentials: an external_account or authorized_user file, or
//   `{"client_email": "<service account>"}` with GOOGLE_APPLICATION_CREDENTIALS naming
//   such a file. The access token comes from those ambient credentials. Domain-wide
//   delegation needs a JWT signed as the service account, so it is signed by the IAM
//   Credentials API (signJwt) instead of a local key.
// `subject` makes the token act for that user through domain-wide delegation. Keys and
// tokens are never printed or stored; error messages name the problem only.
export async function fetchAccessToken({ prefix, token, env, scope, subject, hint }) {
  const variable = `${prefix}_CREDENTIALS`;
  const credentials = await readCredentials(token, variable);
  const audience = env[`${prefix}_TOKEN_URL`] || DEFAULT_TOKEN_URL;
  const claims = (issuer) => {
    const issuedAt = Math.floor(Date.now() / 1000);
    return { iss: issuer, ...(subject ? { sub: subject } : {}), scope, aud: audience, iat: issuedAt, exp: issuedAt + 3600 };
  };
  let assertion;
  if (credentials.private_key) {
    assertion = signWithKey(credentials, claims(credentials.client_email), variable);
  } else {
    const ambient = AMBIENT_TYPES.has(credentials.type) ? credentials : await readAmbientCredentials(env, variable);
    const serviceAccount = env[`${prefix}_SERVICE_ACCOUNT`]
      || (AMBIENT_TYPES.has(credentials.type) ? impersonatedAccount(credentials) : credentials.client_email);
    const iam = env[`${prefix}_IAM_CREDENTIALS_URL`] || DEFAULT_IAM_CREDENTIALS_URL;
    const iamPath = (method) => `/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:${method}`;
    const iamHint = `Check that the ambient credentials may act as ${serviceAccount} (roles/iam.serviceAccountTokenCreator on it).`;
    if (!subject) {
      // The ambient token is used as it is, unless a different service account was named.
      if (!serviceAccount || serviceAccount === impersonatedAccount(ambient)) return ambientAccessToken(ambient, scope, hint);
      const { accessToken } = await googleRequest("POST", iam, iamPath("generateAccessToken"), `${prefix}_IAM_CREDENTIALS_URL`, {
        authorization: `Bearer ${await ambientAccessToken(ambient, CLOUD_PLATFORM, hint)}`,
        "content-type": "application/json"
      }, JSON.stringify({ scope: scope.split(" "), lifetime: "3600s" }), iamHint);
      if (!accessToken) throw new Error("The IAM Credentials API did not return an access token.");
      return accessToken;
    }
    if (!serviceAccount) {
      throw new Error(`${variable} has no private_key, so domain-wide delegation must sign through the IAM Credentials API. Set ${prefix}_SERVICE_ACCOUNT to the service account email to sign as.`);
    }
    const { signedJwt } = await googleRequest("POST", iam, iamPath("signJwt"), `${prefix}_IAM_CREDENTIALS_URL`, {
      authorization: `Bearer ${await ambientAccessToken(ambient, CLOUD_PLATFORM, hint)}`,
      "content-type": "application/json"
    }, JSON.stringify({ payload: JSON.stringify(claims(serviceAccount)) }), iamHint);
    if (!signedJwt) throw new Error("The IAM Credentials API did not return a signed JWT.");
    assertion = signedJwt;
  }
  const { access_token: accessToken } = await googleRequest("POST", audience, "", `${prefix}_TOKEN_URL`, {
    "content-type": "application/x-www-form-urlencoded"
  }, new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(), hint);
  if (!accessToken) throw new Error("The Google token endpoint did not return an access token.");
  return accessToken;
}

function signWithKey(key, claims, variable) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) })}.${encode(claims)}`;
  try {
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url")}`;
  } catch {
    throw new Error(`${variable} has a private_key that cannot sign. Download a new JSON key for the service account.`);
  }
}

async function readCredentials(value, variable) {
  let source = value.trim();
  if (!source.startsWith("{")) {
    try {
      source = await readFile(source, "utf8");
    } catch {
      throw new Error(`${variable} must hold a service account key or keyless credentials as inline JSON or the path of a readable file.`);
    }
  }
  let key = null;
  try {
    key = JSON.parse(source);
  } catch {
    // Reported below without the content.
  }
  const keyed = key?.client_email && key?.private_key;
  const keyless = AMBIENT_TYPES.has(key?.type) || (key?.client_email && !key?.private_key && key?.type !== "service_account");
  if (!keyed && !keyless) {
    throw new Error(`${variable} must be a service account key in JSON with client_email and private_key, an external_account or authorized_user credentials file, or {"client_email": "<service account>"} to sign through GOOGLE_APPLICATION_CREDENTIALS.`);
  }
  return key;
}

async function readAmbientCredentials(env, variable) {
  const path = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) throw new Error(`${variable} has no private_key. Set GOOGLE_APPLICATION_CREDENTIALS to an external_account or authorized_user credentials file.`);
  const ambient = await readCredentials(path, "GOOGLE_APPLICATION_CREDENTIALS");
  if (!AMBIENT_TYPES.has(ambient.type)) throw new Error("GOOGLE_APPLICATION_CREDENTIALS must name an external_account or authorized_user credentials file.");
  return ambient;
}

function impersonatedAccount(credentials) {
  const match = /\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(credentials.service_account_impersonation_url || "");
  return match ? decodeURIComponent(match[1]) : null;
}

// An access token from keyless credentials, for `scope` when the credentials
// impersonate a service account and for cloud-platform otherwise.
async function ambientAccessToken(credentials, scope, hint) {
  if (credentials.type === "authorized_user") {
    const { access_token: accessToken } = await googleRequest("POST", credentials.token_uri || DEFAULT_TOKEN_URL, "", "authorized_user token_uri", {
      "content-type": "application/x-www-form-urlencoded"
    }, new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credentials.client_id || "",
      client_secret: credentials.client_secret || "",
      refresh_token: credentials.refresh_token || ""
    }).toString(), hint);
    if (!accessToken) throw new Error("The Google token endpoint did not return an access token for the authorized_user credentials.");
    return accessToken;
  }
  const { access_token: federated } = await googleRequest("POST", credentials.token_url || "https://sts.googleapis.com/v1/token", "", "external_account token_url", {
    "content-type": "application/x-www-form-urlencoded"
  }, new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience: credentials.audience || "",
    scope: CLOUD_PLATFORM,
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token: await subjectToken(credentials.credential_source),
    subject_token_type: credentials.subject_token_type || ""
  }).toString(), `${hint} Check the Workload Identity provider and its attribute condition.`);
  if (!federated) throw new Error("The Security Token Service did not return an access token.");
  if (!credentials.service_account_impersonation_url) return federated;
  const lifetime = credentials.service_account_impersonation?.token_lifetime_seconds || 3600;
  const { accessToken } = await googleRequest("POST", credentials.service_account_impersonation_url, "", "external_account service_account_impersonation_url", {
    authorization: `Bearer ${federated}`,
    "content-type": "application/json"
  }, JSON.stringify({ scope: scope.split(" "), lifetime: `${lifetime}s` }), `${hint} Check that the federated identity has roles/iam.workloadIdentityUser on the service account.`);
  if (!accessToken) throw new Error("The IAM Credentials API did not return an access token.");
  return accessToken;
}

// The external identity's token, from a file or a URL (the forms Workload Identity
// Federation uses for OIDC providers such as GitHub Actions).
async function subjectToken(source = {}) {
  let text;
  if (source.file) {
    try {
      text = await readFile(source.file, "utf8");
    } catch {
      throw new Error("external_account credential_source.file is not readable.");
    }
  } else if (source.url) {
    const response = await request("GET", new URL(source.url), "external_account credential_source.url", source.headers || {});
    if (response.status !== 200) throw new Error(`external_account credential_source.url returned HTTP ${response.status}.`);
    text = response.text;
  } else {
    throw new Error("external_account credentials must take their subject token from credential_source.file or credential_source.url.");
  }
  const format = source.format || { type: "text" };
  let token = text.trim();
  if (format.type === "json") {
    try {
      token = JSON.parse(text)[format.subject_token_field_name];
    } catch {
      token = null;
    }
  }
  if (!token || typeof token !== "string") throw new Error("external_account credential_source returned no subject token.");
  return token;
}

// Plain HTTP is accepted only on loopback so tests can stub Google locally.
export async function googleRequest(method, baseUrl, path, variable, headers, body, hint) {
  const url = new URL(baseUrl.replace(/\/$/, "") + path);
  const label = `Google ${method} ${url.pathname}`;
  const response = await request(method, url, variable, headers, body, label);
  let parsed = null;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    // Reported below with the HTTP status.
  }
  if (response.status !== 200 || !parsed) {
    const detail = parsed?.error?.message || parsed?.error_description || "";
    throw new Error(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}. ${hint}`);
  }
  return parsed;
}

function request(method, url, variable, headers, body, label = `${method} ${url.pathname}`) {
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) ? http : null;
  if (!transport) return Promise.reject(new Error(`${variable} must use https (plain http is allowed only on localhost): ${url.origin}`));
  return new Promise((resolve, reject) => {
    const call = transport.request(url, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }), "user-agent": "filegrc-collector" },
      timeout: 30000
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
    });
    call.on("timeout", () => call.destroy(new Error(`${label} timed out.`)));
    call.on("error", reject);
    call.end(body);
  });
}

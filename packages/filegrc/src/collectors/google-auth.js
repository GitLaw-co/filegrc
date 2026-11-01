import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Shared by the Google collectors. `${prefix}_CREDENTIALS` holds a service
// account key as inline JSON or a file path; it signs one RS256 token request at
// `${prefix}_TOKEN_URL` and is never printed or stored. `subject` makes the token
// act for that user through domain-wide delegation. Error messages name the
// problem only, never the key.
export async function fetchAccessToken({ prefix, token, env, scope, subject, hint }) {
  const variable = `${prefix}_CREDENTIALS`;
  const key = await readServiceAccountKey(token, variable);
  const audience = env[`${prefix}_TOKEN_URL`] || "https://oauth2.googleapis.com/token";
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) })}.${encode({
    iss: key.client_email,
    ...(subject ? { sub: subject } : {}),
    scope,
    aud: audience,
    iat: issuedAt,
    exp: issuedAt + 3600
  })}`;
  let signature;
  try {
    signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  } catch {
    throw new Error(`${variable} has a private_key that cannot sign. Download a new JSON key for the service account.`);
  }
  const { access_token: accessToken } = await googleRequest("POST", audience, "", `${prefix}_TOKEN_URL`, {
    "content-type": "application/x-www-form-urlencoded"
  }, new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(), hint);
  if (!accessToken) throw new Error("The Google token endpoint did not return an access token.");
  return accessToken;
}

async function readServiceAccountKey(value, variable) {
  let source = value.trim();
  if (!source.startsWith("{")) {
    try {
      source = await readFile(source, "utf8");
    } catch {
      throw new Error(`${variable} must hold a service account key as inline JSON or the path of a readable key file.`);
    }
  }
  let key = null;
  try {
    key = JSON.parse(source);
  } catch {
    // Reported below without the content.
  }
  if (!key?.client_email || !key?.private_key) {
    throw new Error(`${variable} must be a service account key in JSON with client_email and private_key.`);
  }
  return key;
}

// Plain HTTP is accepted only on loopback so tests can stub Google locally.
export function googleRequest(method, baseUrl, path, variable, headers, body, hint) {
  const url = new URL(baseUrl.replace(/\/$/, "") + path);
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) ? http : null;
  if (!transport) return Promise.reject(new Error(`${variable} must use https (plain http is allowed only on localhost): ${baseUrl}`));
  const label = `Google ${method} ${url.pathname}`;
  return new Promise((resolve, reject) => {
    const call = transport.request(url, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }), "user-agent": "filegrc-collector" },
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
          reject(new Error(`${label} returned HTTP ${response.statusCode}${detail ? `: ${detail}` : ""}. ${hint}`));
        } else resolve(parsed);
      });
    });
    call.on("timeout", () => call.destroy(new Error(`${label} timed out.`)));
    call.on("error", reject);
    call.end(body);
  });
}

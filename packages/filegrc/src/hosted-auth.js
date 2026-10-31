import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { loadWorkspace } from "./workspace.js";

// Hosted mode puts Google sign-in in front of every route. It is off unless
// every variable below is set, so local `filegrc serve` behaviour is unchanged.
// Sessions live only in a signed cookie: nothing is written under `data/`.
export const HOSTED_AUTH_ENV = {
  clientId: "FILEGRC_GOOGLE_CLIENT_ID",
  clientSecret: "FILEGRC_GOOGLE_CLIENT_SECRET",
  allowedDomain: "FILEGRC_ALLOWED_EMAIL_DOMAIN",
  sessionSecret: "FILEGRC_SESSION_SECRET",
  publicUrl: "FILEGRC_PUBLIC_URL"
};
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const SESSION_COOKIE = "filegrc_session";
const STATE_COOKIE = "filegrc_oauth_state";
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const STATE_MAX_AGE_SECONDS = 10 * 60;
const MIN_SESSION_SECRET_LENGTH = 32;

export function hostedAuthFromEnv(env = process.env) {
  const values = Object.fromEntries(Object.entries(HOSTED_AUTH_ENV).map(([key, name]) => [key, String(env[name] ?? "").trim()]));
  const missing = Object.entries(HOSTED_AUTH_ENV).filter(([key]) => !values[key]).map(([, name]) => name);
  if (missing.length === Object.keys(HOSTED_AUTH_ENV).length) return null;
  if (missing.length) throw new Error(`Hosted mode needs every sign-in variable. Set ${missing.join(", ")} or unset the others.`);
  return values;
}

export function createHostedAuth(input, config) {
  const allowedDomain = String(config.allowedDomain).trim().toLowerCase().replace(/^@/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(allowedDomain)) throw new Error("The allowed email domain must be a domain such as example.com.");
  if (String(config.sessionSecret).length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(`The session secret must be at least ${MIN_SESSION_SECRET_LENGTH} characters.`);
  }
  const redirectUri = new URL("/auth/callback", config.publicUrl).href;
  const tokenEndpoint = config.tokenEndpoint || GOOGLE_TOKEN_URL;
  const secret = config.sessionSecret;

  async function signIn(email) {
    const domain = email.split("@").at(-1);
    if (domain !== allowedDomain) return { error: `Only ${allowedDomain} accounts can sign in.` };
    const loaded = await loadWorkspace(input);
    const person = loaded.resources.find((record) => (
      record.type === "person" && record.status === "active"
      && String(record.email ?? "").trim().toLowerCase() === email
    ));
    if (!person) return { error: "No active person in this program uses that email address." };
    return { personId: person.id };
  }

  async function callback(url, request, response) {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const expectedState = readCookie(request, STATE_COOKIE);
    if (!state || !code || !expectedState || !safeEqual(state, expectedState)) {
      return deny(response, 400, "The sign-in request expired or did not start here.");
    }
    const tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      })
    });
    if (!tokenResponse.ok) return deny(response, 403, "Google did not accept the sign-in.");
    const claims = idTokenClaims((await tokenResponse.json()).id_token);
    // The ID token comes straight from Google's token endpoint over TLS, so the
    // claims are checked without verifying its signature (OpenID Connect 3.1.3.7).
    if (!claims || !GOOGLE_ISSUERS.has(claims.iss) || claims.aud !== config.clientId
      || !(Number(claims.exp) * 1000 > Date.now()) || claims.email_verified !== true
      || typeof claims.email !== "string") {
      return deny(response, 403, "Google did not return a verified email address.");
    }
    const result = await signIn(claims.email.trim().toLowerCase());
    if (result.error) return deny(response, 403, result.error);
    const session = signSession({ personId: result.personId, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS }, secret);
    return redirect(response, "/", [cookie(SESSION_COOKIE, session, SESSION_MAX_AGE_SECONDS), cookie(STATE_COOKIE, "", 0)]);
  }

  // Returns true when this layer has answered the request.
  async function handle(request, response, url) {
    if (request.method === "GET" && url.pathname === "/auth/login") {
      const state = randomBytes(24).toString("base64url");
      const target = new URL(GOOGLE_AUTHORIZE_URL);
      target.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email",
        state,
        hd: allowedDomain,
        prompt: "select_account"
      }).toString();
      return redirect(response, target.href, [cookie(STATE_COOKIE, state, STATE_MAX_AGE_SECONDS)]);
    }
    if (request.method === "GET" && url.pathname === "/auth/callback") return callback(url, request, response);
    if (url.pathname === "/auth/logout" && ["GET", "POST"].includes(request.method)) {
      response.writeHead(200, { ...pageHeaders(), "set-cookie": cookie(SESSION_COOKIE, "", 0) });
      response.end(page("Signed out", "You are signed out of FileGRC."));
      return true;
    }
    const session = verifySession(readCookie(request, SESSION_COOKIE), secret);
    if (!session) {
      if (url.pathname.startsWith("/api/")) return deny(response, 401, "Sign in to use FileGRC.", true);
      return redirect(response, "/auth/login");
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      return deny(response, 403, "Hosted FileGRC is read-only. Change records in the program repository.", url.pathname.startsWith("/api/"));
    }
    return false;
  }

  return { handle };
}

export function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function verifySession(value, secret, now = Date.now()) {
  const [body, signature, extra] = String(value ?? "").split(".");
  if (!body || !signature || extra !== undefined) return null;
  if (!safeEqual(signature, createHmac("sha256", secret).update(body).digest("base64url"))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return typeof payload?.personId === "string" && Number(payload.exp) * 1000 > now ? payload : null;
  } catch {
    return null;
  }
}

function idTokenClaims(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(request, name) {
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function redirect(response, location, cookies = []) {
  response.writeHead(302, { location, "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) });
  response.end();
  return true;
}

function deny(response, status, message, asJson = false) {
  response.writeHead(status, asJson ? { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } : pageHeaders());
  response.end(asJson ? `${JSON.stringify({ error: message }, null, 2)}\n` : page("Access denied", message));
  return true;
}

function pageHeaders() {
  return { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
    "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" };
}

// Messages are fixed strings or the configured domain, never request input.
function page(title, message) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title} · FileGRC</title><h1>${title}</h1><p>${message}</p><p><a href="/auth/login">Sign in with Google</a></p></html>\n`;
}

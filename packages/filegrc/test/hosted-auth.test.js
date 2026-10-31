import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostedAuthFromEnv, signSession, verifySession } from "../src/hosted-auth.js";
import { serveWorkspace } from "../src/server.js";
import { initializeGitWorkspace, makeWorkspace } from "./helpers.js";

const CLIENT_ID = "test-client.apps.example.com";
const SESSION_SECRET = "test-session-secret-with-enough-length";

function idToken(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

// The stub token endpoint treats each authorization code as the email to return.
async function stubTokenEndpoint(context) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const form = new URLSearchParams(body);
    requests.push(form);
    const email = form.get("code");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id_token: idToken({
        iss: "https://accounts.google.com",
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 300,
        email,
        email_verified: true
      })
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/token`, requests };
}

async function fixture(context, hosted = true) {
  const root = await mkdtemp(join(tmpdir(), "filegrc-hosted-auth-"));
  await makeWorkspace(root);
  await initializeGitWorkspace(root);
  const tokenEndpoint = hosted ? await stubTokenEndpoint(context) : null;
  const running = await serveWorkspace(root, {
    port: 0,
    env: {},
    hostedAuth: hosted ? {
      clientId: CLIENT_ID,
      clientSecret: "test-client-secret",
      allowedDomain: "example.com",
      sessionSecret: SESSION_SECRET,
      publicUrl: "https://filegrc.example.com",
      tokenEndpoint: tokenEndpoint.url
    } : undefined
  });
  context.after(async () => {
    await new Promise((resolve) => running.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { url: running.url, tokenEndpoint };
}

function cookies(response) {
  return Object.fromEntries(response.headers.getSetCookie().map((value) => {
    const [pair] = value.split(";");
    const index = pair.indexOf("=");
    return [pair.slice(0, index), { value: pair.slice(index + 1), raw: value }];
  }));
}

async function signInAs(url, email) {
  const login = await fetch(`${url}/auth/login`, { redirect: "manual" });
  const state = new URL(login.headers.get("location")).searchParams.get("state");
  const stateCookie = cookies(login).filegrc_oauth_state.value;
  return fetch(`${url}/auth/callback?code=${encodeURIComponent(email)}&state=${state}`, {
    redirect: "manual",
    headers: { cookie: `filegrc_oauth_state=${stateCookie}` }
  });
}

test("hosted mode stays off without variables and refuses a partial configuration", () => {
  assert.equal(hostedAuthFromEnv({}), null);
  assert.throws(() => hostedAuthFromEnv({ FILEGRC_GOOGLE_CLIENT_ID: "id" }), /FILEGRC_GOOGLE_CLIENT_SECRET/);
  assert.deepEqual(hostedAuthFromEnv({
    FILEGRC_GOOGLE_CLIENT_ID: "id",
    FILEGRC_GOOGLE_CLIENT_SECRET: "secret",
    FILEGRC_ALLOWED_EMAIL_DOMAIN: "example.com",
    FILEGRC_SESSION_SECRET: SESSION_SECRET,
    FILEGRC_PUBLIC_URL: "https://filegrc.example.com"
  }), {
    clientId: "id",
    clientSecret: "secret",
    allowedDomain: "example.com",
    sessionSecret: SESSION_SECRET,
    publicUrl: "https://filegrc.example.com"
  });
});

test("local mode serves pages without sign-in", async (context) => {
  const { url } = await fixture(context, false);
  const response = await fetch(url, { redirect: "manual" });
  assert.equal(response.status, 200);
});

test("hosted mode redirects unauthenticated pages to sign-in and rejects API reads", async (context) => {
  const { url } = await fixture(context);
  for (const path of ["/", "/app.js", "/people/person-owner"]) {
    const response = await fetch(`${url}${path}`, { redirect: "manual" });
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("location"), "/auth/login", path);
  }
  const api = await fetch(`${url}/api/state`);
  assert.equal(api.status, 401);

  const login = await fetch(`${url}/auth/login`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const target = new URL(login.headers.get("location"));
  assert.equal(target.origin, "https://accounts.google.com");
  assert.equal(target.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(target.searchParams.get("redirect_uri"), "https://filegrc.example.com/auth/callback");
  assert.equal(target.searchParams.get("hd"), "example.com");
  assert.equal(cookies(login).filegrc_oauth_state.value, target.searchParams.get("state"));
});

test("a callback outside the domain or without an active person returns 403 and no session", async (context) => {
  const { url } = await fixture(context);
  for (const email of ["security@example.org", "nobody@example.com"]) {
    const response = await signInAs(url, email);
    assert.equal(response.status, 403, email);
    assert.equal(cookies(response).filegrc_session, undefined, email);
  }
  const forged = await fetch(`${url}/auth/callback?code=security@example.com&state=forged`, {
    redirect: "manual",
    headers: { cookie: "filegrc_oauth_state=other" }
  });
  assert.equal(forged.status, 400);
  assert.equal(cookies(forged).filegrc_session, undefined);
});

test("a matching person gets a signed session cookie and read-only access; a tampered cookie is rejected", async (context) => {
  const { url, tokenEndpoint } = await fixture(context);
  const response = await signInAs(url, "Security@Example.com");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/");
  const session = cookies(response).filegrc_session;
  assert.match(session.raw, /HttpOnly/);
  assert.match(session.raw, /Secure/);
  assert.match(session.raw, /SameSite=Lax/);
  assert.equal(verifySession(session.value, SESSION_SECRET).personId, "person-owner");
  assert.equal(tokenEndpoint.requests.at(-1).get("client_secret"), "test-client-secret");
  assert.equal(tokenEndpoint.requests.at(-1).get("redirect_uri"), "https://filegrc.example.com/auth/callback");

  const page = await fetch(url, { redirect: "manual", headers: { cookie: `filegrc_session=${session.value}` } });
  assert.equal(page.status, 200);
  const signedIn = { cookie: `filegrc_session=${session.value}` };
  const state = await fetch(`${url}/api/state`, { headers: signedIn });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).readOnly, true);
  const bootstrap = await (await fetch(`${url}/api/state/bootstrap`, {
    headers: { ...signedIn, "sec-fetch-site": "same-origin" }
  })).json();
  const repository = await (await fetch(`${url}/api/state/repository?token=${bootstrap.stateToken}`, { headers: signedIn })).json();
  assert.equal(repository.state.readOnly, true);
  const syncStatus = await fetch(`${url}/api/git/sync-status`, { headers: signedIn });
  assert.equal((await syncStatus.json()).readOnly, true);
  const write = await fetch(`${url}/api/resources/person`, {
    method: "POST",
    headers: { cookie: `filegrc_session=${session.value}`, "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(write.status, 403);

  const [body] = session.value.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  const tampered = `${Buffer.from(JSON.stringify({ ...payload, personId: "person-approver" })).toString("base64url")}.${session.value.split(".")[1]}`;
  const otherSecret = signSession(payload, "a-different-session-secret-of-length");
  for (const value of [tampered, otherSecret, `${session.value}x`]) {
    const rejected = await fetch(url, { redirect: "manual", headers: { cookie: `filegrc_session=${value}` } });
    assert.equal(rejected.status, 302);
    assert.equal(rejected.headers.get("location"), "/auth/login");
  }
  assert.equal(verifySession(signSession({ personId: "person-owner", exp: 1 }, SESSION_SECRET), SESSION_SECRET), null);

  const logout = await fetch(`${url}/auth/logout`, { redirect: "manual" });
  assert.equal(logout.status, 200);
  assert.match(cookies(logout).filegrc_session.raw, /Max-Age=0/);
});

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchAccessToken } from "../src/collectors/google-auth.js";

const SA = "collector@demo-project.iam.gserviceaccount.com";
const OTHER_SA = "other@demo-project.iam.gserviceaccount.com";
const SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";
const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";
const SECRETS = ["oidc-subject-token", "federated-token", "impersonated-token", "refresh-secret", "user-token"];

// One loopback server stands in for the OIDC issuer, STS, IAM Credentials and the OAuth token endpoint.
async function stubGoogle(context) {
  const requests = [];
  const status = {};
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const path = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      requests.push({ method: request.method, path, authorization: request.headers.authorization, body });
      const signed = path.endsWith(":signJwt") ? JSON.parse(body).payload : null;
      const replies = {
        "/oidc": request.headers.authorization === "bearer request-token" ? { value: "oidc-subject-token" } : null,
        "/sts": { access_token: "federated-token", token_type: "Bearer", expires_in: 3600 },
        "/oauth/refresh": { access_token: "user-token", token_type: "Bearer" },
        "/token": { access_token: "delegated-token", token_type: "Bearer", expires_in: 3600 },
        [`/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`]: { accessToken: "impersonated-token" },
        [`/v1/projects/-/serviceAccounts/${OTHER_SA}:generateAccessToken`]: { accessToken: "other-token" },
        [`/v1/projects/-/serviceAccounts/${SA}:signJwt`]: { keyId: "k", signedJwt: `signed.${Buffer.from(signed || "").toString("base64url")}.sig` },
        [`/v1/projects/-/serviceAccounts/${OTHER_SA}:signJwt`]: { keyId: "k", signedJwt: `signed.${Buffer.from(signed || "").toString("base64url")}.sig` }
      };
      const code = status[path] || (replies[path] ? 200 : 404);
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(code === 200 ? replies[path] : { error: { message: code === 403 ? "Permission iam.serviceAccounts.signJwt denied" : "Not Found" } }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  context.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), "filegrc-google-auth-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const file = async (name, value) => {
    const path = join(dir, name);
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };
  const externalAccount = async ({ impersonate = SA, source } = {}) => ({
    type: "external_account",
    audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/pool/providers/provider",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: `${base}/sts`,
    credential_source: source || { file: await file("oidc.json", { value: "oidc-subject-token" }), format: { type: "json", subject_token_field_name: "value" } },
    ...(impersonate ? { service_account_impersonation_url: `${base}/v1/projects/-/serviceAccounts/${impersonate}:generateAccessToken` } : {})
  });
  const env = (extra = {}) => ({ FILEGRC_TEST_TOKEN_URL: `${base}/token`, FILEGRC_TEST_IAM_CREDENTIALS_URL: base, ...extra });
  return { base, requests, status, file, externalAccount, env };
}

const fetchToken = (credentials, env, subject) => fetchAccessToken({
  prefix: "FILEGRC_TEST", token: typeof credentials === "string" ? credentials : JSON.stringify(credentials), env, scope: SCOPE, subject, hint: "Check the stub."
});

test("an external_account without a subject uses the impersonated token for the collector's scope", async (context) => {
  const google = await stubGoogle(context);
  const token = await fetchToken(await google.externalAccount(), google.env());
  assert.equal(token, "impersonated-token");
  assert.deepEqual(google.requests.map(({ path }) => path), ["/sts", `/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`]);
  const sts = new URLSearchParams(google.requests[0].body);
  assert.equal(sts.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
  assert.equal(sts.get("subject_token"), "oidc-subject-token");
  assert.equal(sts.get("subject_token_type"), "urn:ietf:params:oauth:token-type:jwt");
  assert.match(sts.get("audience"), /workloadIdentityPools\/pool\/providers\/provider$/);
  assert.equal(google.requests[1].authorization, "Bearer federated-token");
  assert.deepEqual(JSON.parse(google.requests[1].body), { scope: [SCOPE], lifetime: "3600s" });
});

test("an external_account with a subject signs the delegation JWT through signJwt and exchanges it", async (context) => {
  const google = await stubGoogle(context);
  const source = { url: `${google.base}/oidc?audience=x`, headers: { Authorization: "bearer request-token" }, format: { type: "json", subject_token_field_name: "value" } };
  const token = await fetchToken(await google.externalAccount({ source }), google.env(), "admin@example.com");
  assert.equal(token, "delegated-token");
  assert.deepEqual(google.requests.map(({ path }) => path), [
    "/oidc", "/sts", `/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`, `/v1/projects/-/serviceAccounts/${SA}:signJwt`, "/token"
  ]);
  assert.deepEqual(JSON.parse(google.requests[2].body).scope, [CLOUD_PLATFORM]);
  assert.equal(google.requests[3].authorization, "Bearer impersonated-token");
  const claims = JSON.parse(JSON.parse(google.requests[3].body).payload);
  assert.equal(claims.iss, SA);
  assert.equal(claims.sub, "admin@example.com");
  assert.equal(claims.scope, SCOPE);
  assert.equal(claims.aud, `${google.base}/token`);
  assert.equal(claims.exp - claims.iat, 3600);
  const grant = new URLSearchParams(google.requests[4].body);
  assert.equal(grant.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.equal(JSON.parse(Buffer.from(grant.get("assertion").split(".")[1], "base64url")).sub, "admin@example.com");
});

test("a client_email-only file signs as that account with GOOGLE_APPLICATION_CREDENTIALS as the ambient identity", async (context) => {
  const google = await stubGoogle(context);
  const ambient = await google.file("adc.json", await google.externalAccount());
  const signer = await google.file("signer.json", { client_email: SA });
  assert.equal(await fetchToken(signer, google.env({ GOOGLE_APPLICATION_CREDENTIALS: ambient }), "admin@example.com"), "delegated-token");
  assert.equal(JSON.parse(JSON.parse(google.requests.find(({ path }) => path.endsWith(":signJwt")).body).payload).iss, SA);
  google.requests.length = 0;
  // Without a subject, the ambient token already acts as that account.
  assert.equal(await fetchToken(signer, google.env({ GOOGLE_APPLICATION_CREDENTIALS: ambient })), "impersonated-token");
  assert.equal(google.requests.length, 2);
});

test("naming a different service account without a subject mints its token through generateAccessToken", async (context) => {
  const google = await stubGoogle(context);
  const token = await fetchToken(await google.externalAccount(), google.env({ FILEGRC_TEST_SERVICE_ACCOUNT: OTHER_SA }));
  assert.equal(token, "other-token");
  const last = google.requests.at(-1);
  assert.equal(last.path, `/v1/projects/-/serviceAccounts/${OTHER_SA}:generateAccessToken`);
  assert.equal(last.authorization, "Bearer impersonated-token");
  assert.deepEqual(JSON.parse(last.body).scope, [SCOPE]);
});

test("authorized_user credentials refresh a user token and sign as the configured service account", async (context) => {
  const google = await stubGoogle(context);
  const user = { type: "authorized_user", client_id: "id", client_secret: "secret", refresh_token: "refresh-secret", token_uri: `${google.base}/oauth/refresh` };
  const token = await fetchToken(user, google.env({ FILEGRC_TEST_SERVICE_ACCOUNT: SA }), "admin@example.com");
  assert.equal(token, "delegated-token");
  assert.deepEqual(google.requests.map(({ path }) => path), ["/oauth/refresh", `/v1/projects/-/serviceAccounts/${SA}:signJwt`, "/token"]);
  assert.equal(new URLSearchParams(google.requests[0].body).get("grant_type"), "refresh_token");
  assert.equal(google.requests[1].authorization, "Bearer user-token");
});

for (const [name, arrange, message] of [
  ["keyless credentials without GOOGLE_APPLICATION_CREDENTIALS", async () => [{ client_email: SA }, {}], /Set GOOGLE_APPLICATION_CREDENTIALS/],
  ["delegation with no service account to sign as", async (google) => [await google.externalAccount({ impersonate: null }), {}, "admin@example.com"], /Set FILEGRC_TEST_SERVICE_ACCOUNT/],
  ["a service_account key without private_key", async () => [{ type: "service_account", client_email: SA }, {}], /must be a service account key in JSON/],
  ["an unsupported credential_source", async (google) => [await google.externalAccount({ source: { environment_id: "aws1" } }), {}], /credential_source\.file or credential_source\.url/],
  ["a denied signJwt", async (google) => [await google.externalAccount(), {}, "admin@example.com", { [`/v1/projects/-/serviceAccounts/${SA}:signJwt`]: 403 }],
    /signJwt returned HTTP 403: Permission iam\.serviceAccounts\.signJwt denied\. .*serviceAccountTokenCreator/]
]) {
  test(`fetchAccessToken refuses ${name} with a plain message that holds no token`, async (context) => {
    const google = await stubGoogle(context);
    const [credentials, extra, subject, status = {}] = await arrange(google);
    Object.assign(google.status, status);
    const failure = await fetchToken(credentials, google.env(extra), subject).then(() => null, (error) => error);
    assert.ok(failure, "fetchAccessToken must fail");
    assert.match(failure.message, message);
    for (const secret of SECRETS) assert.ok(!failure.message.includes(secret), secret);
  });
}

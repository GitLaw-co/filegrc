import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { runCli } from "../src/cli.js";
import { signSession } from "../src/hosted-auth.js";
import { createFilegrcServer } from "../src/server.js";
import { APP_SCRIPT } from "../src/web.js";
import { loadWorkspace } from "../src/workspace.js";
import { makeComprehensiveWorkspace } from "./fixtures.js";
import { captureCli } from "./helpers.js";

const SESSION_SECRET = "test-session-secret-with-enough-length";
const WORKER = "person-example";

async function fixture(context, { faq = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "filegrc-hosted-faq-"));
  await makeComprehensiveWorkspace(root, "13");
  // Approved, not yet activated content keeps the workspace valid without a schedule-set review.
  for (const entry of (await loadWorkspace(root)).entries.filter(({ record }) => ["policy", "document", "training"].includes(record.type))) {
    const record = { ...entry.record, status: "approved" };
    for (const field of ["effectiveOn", "activationBasis", "activatedOn", "activatedByIds", "activatedContentRevisions"]) delete record[field];
    await writeFile(entry.path, `${JSON.stringify(record, null, 2)}\n`);
  }
  if (faq) {
    await mkdir(join(root, "faq"));
    await writeFile(join(root, "faq", "b-second.md"), "# B second\n\nSecond page.\n");
    await writeFile(join(root, "faq", "a-first.md"), [
      "# A first",
      "",
      "1. Open **Settings**.",
      "2. Turn on encryption.",
      "",
      "See [the vendor guide](https://example.com/guide).",
      "",
      "<script>alert(1)</script>",
      ""
    ].join("\n"));
  }
  const server = createFilegrcServer(root, {
    hostedAuth: {
      clientId: "test-client.apps.example.com",
      clientSecret: "test-client-secret",
      allowedDomain: "example.test",
      sessionSecret: SESSION_SECRET,
      publicUrl: "https://filegrc.example.com"
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const cookie = `filegrc_session=${signSession({ personId: WORKER, exp: Math.floor(Date.now() / 1000) + 600 }, SESSION_SECRET)}`;
  // A raw request keeps the path as written: fetch would resolve `..` first.
  const get = (path, headers = { cookie }) => new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: server.address().port, path, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, location: response.headers.location, body }));
    }).on("error", reject).end();
  });
  return { root, get };
}

test("the help index lists faq pages by file name with their headings", async (context) => {
  const { get } = await fixture(context);
  const index = await get("/faq");
  assert.equal(index.status, 200);
  assert.match(index.body, /<a href="\/faq\/a-first">A first<\/a>.*<a href="\/faq\/b-second">B second<\/a>/s);
});

test("a help page renders its Markdown and escapes raw HTML", async (context) => {
  const { get } = await fixture(context);
  const page = await get("/faq/a-first");
  assert.equal(page.status, 200);
  assert.match(page.body, /<h1>A first<\/h1>/);
  assert.match(page.body, /<ol><li>Open <strong>Settings<\/strong>\.<\/li><li>Turn on encryption\.<\/li><\/ol>/);
  assert.match(page.body, /<a href="https:\/\/example\.com\/guide" rel="noreferrer">the vendor guide<\/a>/);
  assert.match(page.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(page.body, /<script>/);
});

test("help slugs outside faq/ or the slug pattern are not found", async (context) => {
  const { get } = await fixture(context);
  for (const path of ["/faq/../package", "/faq/A-First", "/faq/missing", "/faq/%2e%2e/package"]) {
    assert.equal((await get(path)).status, 404, path);
  }
});

test("help pages need the same sign-in as acknowledgements", async (context) => {
  const { get } = await fixture(context);
  const expected = await get("/acknowledgements", {});
  assert.equal(expected.status, 302);
  for (const path of ["/faq", "/faq/a-first"]) {
    const response = await get(path, {});
    assert.deepEqual([response.status, response.location, response.body], [expected.status, expected.location, expected.body], path);
  }
});

test("the nav shows Help only when faq/ holds a Markdown page", async (context) => {
  const source = APP_SCRIPT.slice(APP_SCRIPT.indexOf("function helpNavigation"), APP_SCRIPT.indexOf("function hostedNavigation"));
  const helpNavigation = (dataset) => vm.runInNewContext(source + "\nhelpNavigation()", { document: { body: { dataset } }, esc: String });
  const withFaq = await fixture(context);
  const withoutFaq = await fixture(context, { faq: false });
  const shown = /data-help-href="([^"]+)"/.exec((await withFaq.get("/")).body)?.[1];
  assert.equal(shown, "/faq");
  assert.equal(helpNavigation({ helpHref: shown }), '<a class="help-nav" href="/faq">Help</a>');
  assert.doesNotMatch((await withoutFaq.get("/")).body, /data-help-href/);
  assert.equal(helpNavigation({}), "");
  assert.ok(APP_SCRIPT.includes("<div class=\"sidebar-footer\">' + helpNavigation() + '"));
});

test("a faq/ folder does not affect workspace validation", async (context) => {
  const { root } = await fixture(context);
  for (const args of [["init", "--initial-branch=main"], ["add", "."], ["-c", "user.name=FileGRC Test", "-c", "user.email=test@example.test", "-c", "commit.gpgSign=false", "commit", "-m", "Create test workspace"]]) {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  }
  const validation = await captureCli(runCli, ["validate", "--root", root]);
  assert.equal(validation.exitCode, 0, validation.stdout + validation.stderr);
});

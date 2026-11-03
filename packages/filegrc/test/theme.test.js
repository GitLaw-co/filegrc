import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { APP_SCRIPT, APP_STYLES } from "../src/web.js";
import {
  BASECOAT_CLASSES,
  BASECOAT_CSS,
  BASECOAT_GLOBAL_RULE_SCOPES,
  BASECOAT_SHA256,
  BASECOAT_VERSION,
  LEGACY_COLOR_ROLES,
  LEGACY_TOKENS,
  THEME_CLASS_MAP,
  THEMED_APP_SCRIPT,
  THEMED_APP_STYLES,
  prefixBasecoatClasses,
  themeLegacyStyles
} from "../src/theme.js";

const vendorFile = new URL("../src/vendor/basecoat/basecoat.cdn.min.css", import.meta.url);

test("vendors Basecoat's prebuilt CSS unmodified with its MIT licence", () => {
  assert.equal(BASECOAT_VERSION, "1.1.0");
  assert.equal(createHash("sha256").update(readFileSync(vendorFile)).digest("hex"), BASECOAT_SHA256);
  assert.match(readFileSync(new URL("../src/vendor/basecoat/LICENSE.md", import.meta.url), "utf8"), /^MIT License[\s\S]*Ronan Berder/);
  assert.doesNotMatch(BASECOAT_CSS, /@import|@apply|@tailwind/);
});

test("prefixes every Basecoat class so none collides with a FileGRC class", () => {
  const classes = new Set(BASECOAT_CSS.match(/\.[a-z][a-z0-9-]*/g).map((name) => name.slice(1)));
  for (const ignored of ["dark", "com", "org", "w3"]) classes.delete(ignored);
  assert.deepEqual([...classes].sort(), [...BASECOAT_CLASSES].sort());
  const prefixed = prefixBasecoatClasses(BASECOAT_CSS);
  const unprefixed = (prefixed.match(/\.[a-z][a-z0-9-]*/g) || [])
    .map((name) => name.slice(1))
    .filter((name) => BASECOAT_CLASSES.includes(name));
  assert.deepEqual(unprefixed, []);
  assert.match(prefixed, /\.bc-badge/);
  assert.match(prefixed, /html\.dark/);
});

test("orders the cascade so FileGRC layout sits between preflight and Basecoat components", () => {
  const order = THEMED_APP_STYLES.match(/@layer [a-z-]+(,[a-z-]+)+;/)[0];
  assert.equal(order, "@layer theme,base,filegrc-reset,filegrc,components,utilities,filegrc-theme;");
  assert.ok(THEMED_APP_STYLES.indexOf(order) < THEMED_APP_STYLES.indexOf("@layer theme{"));
  assert.match(THEMED_APP_STYLES, /@layer filegrc\{\n/);
  assert.match(THEMED_APP_STYLES, /@media \(prefers-color-scheme:dark\)\{:root\{--background:/);
  for (const [selector, scoped] of Object.entries(BASECOAT_GLOBAL_RULE_SCOPES)) {
    assert.equal(THEMED_APP_STYLES.includes(`}${selector}{`) || THEMED_APP_STYLES.includes(`{${selector}{`), false, selector);
    assert.ok(THEMED_APP_STYLES.includes(`${scoped}{`), scoped);
  }
  assert.doesNotMatch(THEMED_APP_STYLES, /select\.bc-select\{[^}]*width:fit-content/);
});

test("maps the FileGRC stylesheet onto Basecoat tokens without editing it", () => {
  const themed = themeLegacyStyles(APP_STYLES);
  for (const token of LEGACY_TOKENS) {
    assert.doesNotMatch(themed, new RegExp(`var\\(--${token}\\)`), token);
    assert.match(THEMED_APP_STYLES, new RegExp(`--fg-${token}:`), token);
  }
  for (const color of Object.values(LEGACY_COLOR_ROLES).flat()) {
    assert.equal(themed.toLowerCase().includes(color), false, color);
  }
  for (const role of Object.keys(LEGACY_COLOR_ROLES)) {
    if (themed.includes(`--fg-c-${role})`)) assert.match(THEMED_APP_STYLES, new RegExp(`--fg-c-${role}:`), role);
  }
  assert.match(themeLegacyStyles(".a{color:#000070;background:#000070}"), /color:var\(--fg-c-inverse-text\);background:var\(--fg-c-inverse\)/);
  assert.match(themeLegacyStyles(".a{background:#fff;color:#fff}"), /background:var\(--card\);color:#fff/);
  assert.doesNotMatch(themed, /Georgia/);
  assert.match(APP_STYLES, /--muted:#5d6475/);
});

test("serves the theme script after the app script and keeps it parseable", () => {
  assert.ok(THEMED_APP_SCRIPT.startsWith(APP_SCRIPT));
  assert.doesNotThrow(() => new Script(THEMED_APP_SCRIPT));
  assert.match(THEMED_APP_SCRIPT, /new MutationObserver/);
  assert.match(THEMED_APP_SCRIPT, /classList\.toggle\("dark"/);
});

test("maps each FileGRC button style to one Basecoat variant", () => {
  const buttons = THEME_CLASS_MAP.filter((rule) => rule.className === "bc-btn");
  assert.deepEqual(buttons.map((rule) => [rule.selector, rule.variant]), [
    [".button.hosted-automation-primary", "outline"],
    [".button.hosted-automation-secondary", "ghost"],
    [".button.primary", "primary"],
    [".button.danger-action", "destructive"],
    [".button.danger", "destructive"],
    [".button.text-button", "ghost"],
    [".button", "outline"]
  ]);
  for (const rule of THEME_CLASS_MAP) assert.match(rule.className, /^bc-/);
  assert.ok(THEME_CLASS_MAP.some((rule) => rule.className === "bc-badge"));
  assert.ok(THEME_CLASS_MAP.some((rule) => rule.className === "bc-table"));
});

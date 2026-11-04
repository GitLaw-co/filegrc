// Basecoat theme layer for the FileGRC web UI.
//
// The renderer in web.js keeps its own markup and stylesheet (APP_STYLES). This module
// wraps that stylesheet at serve/build time so it can merge cleanly with upstream:
//
//   1. Basecoat's prebuilt CSS, vendored verbatim, with its class names prefixed `bc-` so
//      they never collide with FileGRC's own class names (`.badge`, `.sidebar`, `.dialog`, ...).
//   2. A reset layer that gives document flow elements back their browser defaults after
//      Basecoat's Tailwind preflight, because APP_STYLES was written against them.
//   3. APP_STYLES itself in a cascade layer, with its colour tokens and brand colours
//      renamed onto Basecoat's design tokens (--background, --card, --primary, ...).
//   4. THEME_STYLES: the visual mapping for components whose markup Basecoat cannot style
//      directly (sidebar, panels, dialogs, alerts, page headings).
//
// THEME_CLASS_MAP adds Basecoat component classes to FileGRC elements in the browser
// (buttons, inputs, selects, textareas, badges, tables, kbd), so those use Basecoat's own
// component CSS. Nothing here changes markup structure, routes or behaviour.
//
// Vendored file: basecoat-css@1.1.0 dist/basecoat.cdn.min.css (Vega style, compiled with
// Tailwind CSS 4.3.1), from https://registry.npmjs.org/basecoat-css/-/basecoat-css-1.1.0.tgz.
// MIT licence: vendor/basecoat/LICENSE.md. To upgrade, replace the file with the same path
// from a newer release, update BASECOAT_VERSION and BASECOAT_SHA256, and check
// BASECOAT_CLASSES against the new file (theme.test.js fails on an unknown class).
import { readFileSync } from "node:fs";
import { APP_SCRIPT, APP_STYLES } from "./web.js";

export const BASECOAT_VERSION = "1.1.0";
export const BASECOAT_SHA256 = "e6354ef1e99adc94257e579507f18cb00307a08cc2b976deb320368eb7c28e70";
export const BASECOAT_CSS = readFileSync(new URL("./vendor/basecoat/basecoat.cdn.min.css", import.meta.url), "utf8");

// Every class selector in the vendored file except `.dark`, which Basecoat's dark variants
// match on <html>, and `.com`/`.org`/`.w3`, which are hostnames inside SVG data URLs.
export const BASECOAT_CLASSES = [
  "accordion", "active", "alert", "alert-dialog", "avatar", "avatar-badge", "avatar-group", "badge",
  "border-b", "border-t", "breadcrumb", "btn", "button-group", "card", "card-action", "card-description",
  "card-title", "chart", "chart-legend", "chart-legend-indicator", "chart-legend-item", "chart-tooltip",
  "chart-tooltip-indicator", "chart-tooltip-item", "chart-tooltip-items", "chart-tooltip-label",
  "chart-tooltip-title", "chart-tooltip-value", "combobox", "combobox-chip", "combobox-chip-remove",
  "combobox-chips", "combobox-trigger-icon", "command", "command-dialog", "dialog", "drawer",
  "dropdown-menu", "empty", "field", "field-separator", "fieldset", "input", "input-group", "item",
  "item-group", "kbd", "label", "peer", "popover", "progress", "scrollbar", "scrollbar-sm", "select",
  "sidebar", "skeleton", "sr-only", "table", "table-container", "tabs", "textarea", "toast",
  "toast-content", "toaster"
];
export const BASECOAT_CLASS_PREFIX = "bc-";

export function prefixBasecoatClasses(css) {
  const names = [...BASECOAT_CLASSES].sort((a, b) => b.length - a.length).join("|");
  return css.replace(new RegExp(`\\.(${names})(?![\\w-])`, "g"), `.${BASECOAT_CLASS_PREFIX}$1`);
}

// Basecoat styles a few bare elements globally (every <details>, every radiogroup). FileGRC
// has its own disclosure and choice styles, so those rules only apply inside Basecoat markup.
export const BASECOAT_GLOBAL_RULE_SCOPES = {
  "details::details-content": ".bc-collapsible details::details-content",
  "details[open]::details-content": ".bc-collapsible details[open]::details-content",
  "details summary": ".bc-collapsible details summary",
  "details>summary::-webkit-details-marker": ".bc-collapsible details>summary::-webkit-details-marker",
  "[role=radiogroup]": ":is(.bc-field,.bc-fieldset) [role=radiogroup]"
};

export function scopeGlobalRules(css) {
  let output = css;
  for (const [selector, scoped] of Object.entries(BASECOAT_GLOBAL_RULE_SCOPES)) {
    const escaped = selector.replace(/[[\]().*+?^$|\\]/g, "\\$&");
    output = output.replace(new RegExp(`(^|[{}])${escaped}\\{`, "g"), `$1${scoped}{`);
  }
  return output;
}

// Basecoat stretches text fields to their container (and shrinks selects to their text).
// FileGRC's own layout decides how wide a field is, so those two declarations are dropped.
export function releaseFieldWidths(css) {
  return css.replace(/([^{}]*)\{([^{}]*)\}/g, (rule, selector, body) =>
    /\.bc-input\[type=text\]|select\.bc-select|\.bc-textarea(?![\w-])/.test(selector) && !/::/.test(selector)
      ? `${selector}{${body.replace(/(^|;)width:(100%|fit-content)(?=;|$)/g, "$1").replace(/^;/, "")}}`
      : rule);
}

// APP_STYLES colour tokens. Several share a name with a Basecoat token but not its meaning
// (FileGRC's --muted is a text colour, Basecoat's is a surface), so all of them move to --fg-*.
export const LEGACY_TOKENS = [
  "ink", "muted", "line", "paper", "panel", "accent", "accent-soft", "accent-light", "accent-wash", "focus",
  "amber", "red", "sidebar", "primary-gradient", "surface", "surface-soft", "surface-muted", "field",
  "field-readonly", "code-bg", "code-ink", "shadow"
];

// Literal colours in APP_STYLES, grouped by the role they play there. Each group points at a
// --fg-* token that THEME_STYLES defines from Basecoat tokens, so light and dark mode follow
// the Basecoat palette without editing APP_STYLES.
export const LEGACY_COLOR_ROLES = {
  inverse: ["#0000a5", "#000070", "#000035", "#000024", "#0000e0", "#202066", "#11174a", "#3838be", "#5966a4"],
  "accent-tint": ["#eef1ff", "#e7ebff", "#f8f9ff", "#e6e8f7", "#dde1f4", "#252e52"],
  "accent-border": ["#cbd3ff", "#ccd4ff", "#c2caff", "#8aa1ff", "#9aabff", "#aab7ff", "#bdc7ff"],
  border: ["#dfe3ef", "#e8ebf3", "#cbd0e5", "#d0d5e3", "#d9dee3", "#343d5c"],
  surface: ["#f2f4fa", "#eceff7", "#eef0f6", "#e8ebed", "#e5e8f2", "#f6f7fb", "#1b2238", "#252d48", "#1c2338"],
  "ink-muted": ["#5d6475", "#75817b", "#6a7181", "#555e73", "#4b5960", "#52606d", "#697184", "#737a8b", "#3e4557"],
  ink: ["#151827", "#272c3b", "#1f2933", "#f4f5ff"],
  "inverse-ink": ["#d5d9ed", "#e8ebff", "#dce2ff"],
  "inverse-ink-muted": ["#c5cae2", "#aeb6d8", "#b8bed7", "#b4bbdc", "#919bc4", "#bfc9ff", "#c8cff0"],
  "success-bg": ["#dcefe4", "#ddefe5", "#173b2b", "#e7f4ec", "#eef8f2"],
  "success-ink": ["#125733", "#176143", "#315f48", "#a8edc4", "#6abf8c", "#b7d8c3", "#315d44"],
  "success-border": ["#b9dac6"],
  "warning-bg": ["#f6e8c9", "#f7e9cf", "#fff8e8", "#fff7df", "#483714", "#382f19"],
  "warning-ink": ["#79500f", "#855717", "#6d4917", "#765410", "#77612f", "#8a5200", "#ffd991", "#ffdc92", "#ffd08a", "#e9a445", "#ffe2a3", "#795b23", "#6d4707"],
  "warning-border": ["#d8bd78", "#e9c888"],
  "danger-bg": ["#f7dfdc", "#f5ded9", "#4a252a"],
  "danger-ink": ["#873027", "#8d352c", "#a13a31", "#ffb5ad", "#ffaaa0", "#dc6c5d"],
  "code-bg": ["#10162b"]
};

// A light tint used as a text colour sits on a dark surface (sidebar, hero banner), and a
// brand navy used as a text colour sits on a light one, so `color:` declarations take these
// roles instead of the role their literal has as a fill.
export const LEGACY_TEXT_ROLES = {
  inverse: "inverse-text",
  "accent-tint": "inverse-ink",
  "accent-border": "inverse-ink-muted",
  border: "inverse-ink-muted",
  surface: "inverse-ink-muted"
};

const TOKEN_PATTERN = new RegExp(`--(${[...LEGACY_TOKENS].sort((a, b) => b.length - a.length).join("|")})(?![\\w-])`, "g");
const COLOR_ROLE = new Map(Object.entries(LEGACY_COLOR_ROLES).flatMap(([role, colors]) => colors.map((color) => [color, role])));
const HEX_PATTERN = /#[0-9a-f]{6}(?![0-9a-f])/gi;

export function themeLegacyStyles(css) {
  let output = css.replace(TOKEN_PATTERN, "--fg-$1");
  output = output.replace(/(^|[;{\s])color:\s*(#[0-9a-f]{6})(?![0-9a-f])/gi, (match, before, hex) => {
    const role = COLOR_ROLE.get(hex.toLowerCase());
    return role ? `${before}color:var(--fg-c-${LEGACY_TEXT_ROLES[role] || role})` : match;
  });
  output = output.replace(HEX_PATTERN, (hex) => {
    const role = COLOR_ROLE.get(hex.toLowerCase());
    return role ? `var(--fg-c-${role})` : hex;
  });
  return output
    // White panels become cards; white text on inverse surfaces stays white.
    .replace(/background(-color)?:\s*#fff(fff)?(?![0-9a-f])/gi, "background$1:var(--card)")
    .replace(/rgba\(21,40,33,\.0\d+\)/g, "rgb(0 0 0/.04)")
    .replace(/rgba\(0,0,24,\.(\d+)\)/g, "rgb(0 0 0/.$1)")
    .replace(/rgba\(0,0,53,\.(\d+)\)/g, "rgb(0 0 0/.$1)")
    .replace(/rgba\(96,113,255,\.\d+\)/g, "transparent")
    .replace(/Georgia,\s*serif/g, "var(--fg-display-font)");
}

// Basecoat's dark palette is keyed on html.dark. The app script sets that class; this copy
// covers the moment before it runs and pages that load no script (help pages).
function darkTokensForMediaQuery(css) {
  const block = css.match(/(?:^|[}\s])\.dark\{([^}]*)\}/);
  return block ? `@media (prefers-color-scheme:dark){:root{${block[1]}}}` : "";
}

// Restores browser defaults that APP_STYLES relies on but Tailwind's preflight removes.
// `revert` here returns to the user-agent stylesheet, skipping the preflight layer.
const FLOW_RESET = String.raw`
:where(p,h1,h2,h3,h4,h5,h6,blockquote,figure,dl,dd,pre,hr,fieldset,legend,dialog){margin:revert}
:where(summary){display:revert;list-style:revert}
:where(ul,ol,menu){margin:revert;padding:revert;list-style:revert}
:where(h1,h2,h3,h4,h5,h6){font-size:revert;font-weight:revert}
:where(fieldset,legend){padding:revert}
:where(a){text-decoration:revert}
:where(img,svg,video,canvas,audio,iframe,embed,object){display:revert;vertical-align:revert}
`;

export const THEME_STYLES = String.raw`
:root{
  --fg-display-font:var(--font-sans);
  --fg-ink:var(--foreground);--fg-muted:var(--muted-foreground);--fg-line:var(--border);--fg-paper:var(--background);
  --fg-panel:var(--card);--fg-accent:var(--primary);--fg-accent-soft:var(--muted);--fg-accent-light:var(--ring);
  --fg-accent-wash:var(--muted);--fg-focus:var(--muted-foreground);--fg-amber:var(--fg-c-warning-ink);--fg-red:var(--destructive);
  --fg-sidebar:var(--sidebar);--fg-primary-gradient:var(--fg-c-inverse);--fg-surface:var(--muted);--fg-surface-soft:var(--muted);
  --fg-surface-muted:var(--muted);--fg-field:transparent;--fg-field-readonly:var(--muted);
  --fg-code-bg:var(--muted);--fg-code-ink:var(--foreground);--fg-shadow:0 1px 2px 0 rgb(0 0 0/.05);
  --fg-c-inverse:var(--primary);--fg-c-inverse-ink:var(--primary-foreground);--fg-c-inverse-text:var(--primary);--fg-c-ink:var(--foreground);
  --fg-c-inverse-ink-muted:color-mix(in oklab,var(--primary-foreground) 72%,transparent);
  --fg-c-accent-tint:var(--muted);--fg-c-accent-border:var(--border);--fg-c-border:var(--border);
  --fg-c-surface:var(--muted);--fg-c-ink-muted:var(--muted-foreground);--fg-c-code-bg:var(--fg-code-bg);
  --fg-c-success-bg:oklch(.962 .044 156.743);--fg-c-success-ink:oklch(.448 .119 151.328);--fg-c-success-border:oklch(.871 .15 154.449);
  --fg-c-warning-bg:oklch(.962 .059 95.617);--fg-c-warning-ink:oklch(.473 .137 46.201);--fg-c-warning-border:oklch(.879 .169 91.605);
  --fg-c-danger-bg:color-mix(in oklab,var(--destructive) 10%,var(--background));--fg-c-danger-ink:var(--destructive);
}
@media (prefers-color-scheme:dark){:root{
  --fg-c-inverse:var(--secondary);--fg-c-inverse-ink:var(--secondary-foreground);--fg-c-inverse-text:var(--foreground);
  --fg-c-inverse-ink-muted:var(--muted-foreground);
  --fg-c-success-bg:oklch(.266 .065 152.934);--fg-c-success-ink:oklch(.871 .15 154.449);--fg-c-success-border:oklch(.393 .095 152.535);
  --fg-c-warning-bg:oklch(.286 .066 53.813);--fg-c-warning-ink:oklch(.905 .182 98.111);--fg-c-warning-border:oklch(.476 .114 61.907);
  --fg-c-danger-bg:color-mix(in oklab,var(--destructive) 20%,var(--background));
}}
body{background:var(--background);color:var(--foreground);font-family:var(--font-sans);-webkit-font-smoothing:antialiased}

/* Headings: Basecoat's sans display type instead of the serif. */
:is(h1,h2,h3,h4){letter-spacing:-.015em}
:is(.page-intro,.detail-head,.dialog-head,.section-head,.stage-overview-hero,.group-overview-head,.finish-step,.policy-content-table>.section-head) h2{font-weight:600}
.kicker,.eyebrow{color:var(--muted-foreground)}

/* Sidebar: Basecoat's sidebar palette, light in light mode and dark in dark mode, so the
   navigation matches the page instead of sitting on a fixed dark panel. */
.sidebar{background:var(--sidebar);color:var(--sidebar-foreground);border-right:1px solid var(--sidebar-border)}
.nav-scrim{background:rgb(0 0 0/.5)}
.brand strong{color:var(--sidebar-foreground)}
.brand small,.nav-stage-copy small,.organization-nav small,.organization-arrow,.nav-items small{color:var(--muted-foreground)}
.brand .mark{background:var(--sidebar-primary);padding:7px;box-sizing:border-box}
.nav-stage-copy strong{font-size:13px}
.nav-stage-copy small{font-size:11px}
.organization-nav strong,.help-nav{font-size:13px}
.organization-nav small{font-size:11px}
:is(.nav-home,.nav-items a,.nav-stage>.nav-heading,.nav-heading-row>.nav-heading,.help-nav,.organization-nav){color:var(--sidebar-foreground)}
:is(.nav-heading,.nav-subgroup>.nav-subheading,.nav-subheading-row,.nav-toggle){color:var(--muted-foreground)}
:is(.nav-home,.nav-items a,.nav-stage>.nav-heading,.nav-heading-row>.nav-heading,.nav-toggle,.nav-subheading-row,.help-nav,.organization-nav):hover,
:is(.nav-home,.nav-items a,.nav-heading-row>.nav-heading,.organization-nav).current,.brand[aria-current=page]{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground)}
.nav-items a.current,.nav-heading-row>.nav-heading.current{font-weight:600}
.nav-stage-number,.organization-mark{border-color:var(--sidebar-border);background:var(--background);color:var(--sidebar-foreground)}
.nav-heading-row>.nav-heading.current .nav-stage-number{background:var(--sidebar-primary);border-color:var(--sidebar-primary);color:var(--sidebar-primary-foreground)}
.nav-stage>.nav-items{border-left-color:var(--sidebar-border)}
.sidebar-footer,.side-foot{background:var(--sidebar);border-top:1px solid var(--sidebar-border);color:var(--sidebar-foreground)}
.sidebar .mobile-sidebar-search{background:var(--background);border-color:var(--input);color:var(--muted-foreground)}
.mobile-sidebar-search input{color:var(--foreground)}
.nav-close{border-color:var(--border);background:var(--background);color:var(--foreground)}
.sidebar-primary-nav{display:grid;gap:2px;margin:0 0 12px}
.sidebar-primary-nav a{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:var(--radius-md);color:var(--sidebar-foreground);font-size:14px;font-weight:600;text-decoration:none}
.sidebar-primary-nav a:hover,.sidebar-primary-nav a.current{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground)}
.sidebar-action-count{min-width:22px;padding:1px 7px;border-radius:999px;background:var(--sidebar-primary);color:var(--sidebar-primary-foreground);font-size:11px;font-weight:600;text-align:center}

/* Guide card in the sidebar: replaces the hosted Autopilot promotion when the workspace
   names its own guide, and takes the light card look either way. */
.automation-nav-panel{border:1px solid var(--sidebar-border);background:var(--background);box-shadow:0 1px 2px 0 rgb(0 0 0/.05)}
.automation-nav-panel p{color:var(--muted-foreground)}
.automation-nav-panel strong{display:block;margin:0 0 4px;color:var(--foreground);font-size:13px}
.hosted-automation-nav{border:1px solid var(--primary);background:var(--primary);color:var(--primary-foreground);box-shadow:none;font-size:13px;font-weight:600}
.hosted-automation-nav:hover{border-color:var(--primary);background:color-mix(in oklab,var(--primary) 88%,transparent)}
.hosted-automation-nav:focus-visible{outline-color:var(--ring)}

/* Overview: Actions waiting on the viewer, and the workspace guide. */
.home-actions-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);align-items:start;gap:16px;margin:0 0 16px}
.home-actions-grid.single{grid-template-columns:1fr}
.home-actions-grid>.panel{margin:0}
.home-actions-panel .panel-head,.guide-panel .panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.home-action-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}
.home-action-stat{padding:12px 14px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--background)}
.home-action-stat strong{display:block;font-size:24px;line-height:1.1;font-weight:600}
.home-action-stat span{display:block;margin-top:4px;color:var(--muted-foreground);font-size:12px}
.home-action-stat.warn strong{color:var(--fg-c-warning-ink)}
.home-action-stat.bad strong{color:var(--fg-c-danger-ink)}
.home-action-list{margin:0;padding:0;list-style:none;border-top:1px solid var(--border)}
.home-action-list li{border-bottom:1px solid var(--border)}
.home-action-list a{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 4px;color:var(--foreground);text-decoration:none}
.home-action-list a:hover{background:var(--muted)}
.home-action-copy strong{display:block;font-size:14px;font-weight:500}
.home-action-copy small{display:block;margin-top:2px;color:var(--muted-foreground);font-size:12px}
.home-action-tags{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;flex:0 0 auto}
.home-actions-status,.home-actions-more{display:flex;align-items:center;gap:8px;margin:12px 0 0;color:var(--muted-foreground);font-size:13px}
.guide-panel-copy{margin:12px 0 16px;color:var(--muted-foreground);font-size:14px;line-height:1.55}
.server-page .page-intro{margin-bottom:16px}
.help-index{margin:0;padding:8px 16px;list-style:none}
.help-index li{padding:10px 0;border-bottom:1px solid var(--border)}
.help-index li:last-child{border-bottom:0}
.help-article{padding:24px 28px;max-width:860px}
@media(max-width:900px){.home-actions-grid{grid-template-columns:1fr}.home-action-stats{grid-template-columns:1fr 1fr 1fr}}
@media(max-width:520px){.home-action-stats{grid-template-columns:1fr}.home-action-list a{flex-direction:column;align-items:flex-start}}
/* Actions page: the response choices read as one row of buttons; their radios stay hidden. */
.bc-input.action-choice{position:absolute;width:1px;height:1px;min-height:0;margin:0;opacity:0;pointer-events:none}
.action-choice:checked+label{box-shadow:0 0 0 2px var(--background),0 0 0 4px var(--ring)}
.action-choice:focus-visible+label{outline:2px solid var(--fg-focus);outline-offset:2px}
.action-response .bc-textarea{min-height:140px;field-sizing:fixed;background:var(--background);font-size:.9rem;line-height:1.5}
.action-response{background:var(--muted);border-color:var(--border)}
.action-record li{border-left-color:var(--border)}

/* Hero banners: a plain card, not an inverse block, so every page has one surface colour. */
.hero,.overview-hero{background:var(--card);color:var(--card-foreground);border:1px solid var(--border);box-shadow:0 1px 2px 0 rgb(0 0 0/.05);min-height:0}
.hero:after{display:none}
.hero .kicker,.hero-meta span{color:var(--muted-foreground)}
.hero p:not(.kicker){color:var(--muted-foreground)}
.hero h2{color:var(--foreground)}
.hero-meta span{border-left-color:var(--border)}
.hosted-automation-hero{background:var(--card);color:var(--card-foreground);border:1px solid var(--border)}
.hosted-automation-hero :is(h2,.hosted-automation-lead,.hosted-automation-price){color:var(--foreground)}
.hosted-automation-hero :is(p,.kicker,.hosted-automation-note),.hosted-automation-details small{color:var(--muted-foreground)}
.hosted-automation-details{border-left-color:var(--border);border-top-color:var(--border)}
.hosted-automation-hero .hosted-automation-primary{border-color:var(--primary);background:var(--primary);color:var(--primary-foreground);box-shadow:none}
.hosted-automation-hero .hosted-automation-secondary{border-color:var(--border);background:var(--background);color:var(--foreground)}
.hosted-automation-hero :is(.hosted-automation-primary,.hosted-automation-secondary):hover{background:var(--muted);color:var(--foreground)}
.readiness-flow a>span,.preparation-progress span{background:var(--primary);color:var(--primary-foreground)}

/* Top bar */
.topbar{background:color-mix(in oklab,var(--background) 92%,transparent);border-bottom-color:var(--border);backdrop-filter:blur(8px)}
.search{background:transparent;border-color:var(--input);border-radius:var(--radius-md);box-shadow:0 1px 2px 0 rgb(0 0 0/.05);color:var(--muted-foreground)}
.search:focus-within{border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in oklab,var(--ring) 50%,transparent)}
html.dark .search{background:color-mix(in oklab,var(--input) 30%,transparent)}
.search input{color:var(--foreground)}
.sidebar .search{border-color:oklch(1 0 0/.2);background:oklch(1 0 0/.06);color:var(--fg-c-inverse-ink-muted)}
.sidebar .search input{color:var(--fg-c-inverse-ink)}
.repo-chip,.validation-chip{border-color:var(--border);border-radius:var(--radius-md);box-shadow:0 1px 2px 0 rgb(0 0 0/.05)}
.repo-chip:hover,.validation-chip:hover{background:var(--muted);border-color:var(--border)}

/* Panels and cards: Basecoat card surface. */
.panel,.metric,.record-table-wrap,.stage-instructions,.stage-overview-hero,.stage-progress-card,.setup-steps a,.external-evidence-list>a,.catalog a{border-color:var(--border);border-radius:var(--radius-xl);box-shadow:0 1px 2px 0 rgb(0 0 0/.05)}
.panel,.metric,.record-table-wrap{background:var(--card);color:var(--card-foreground)}

/* Inverse surfaces (hero banners, the hosted automation card). */
.hosted-automation-hero,.overview-hero{box-shadow:none;border-radius:var(--radius-xl)}

/* Dialogs: Basecoat dialog surface and overlay. */
dialog{background:var(--popover);color:var(--popover-foreground);border:1px solid var(--border);border-radius:var(--radius-xl);box-shadow:0 10px 15px -3px rgb(0 0 0/.1),0 4px 6px -4px rgb(0 0 0/.1)}
dialog::backdrop{background:rgb(0 0 0/.5)}
.icon-button{background:transparent;border-radius:var(--radius-md);color:var(--muted-foreground)}
.icon-button:hover{background:var(--accent);color:var(--accent-foreground)}

/* Alerts and inline notices: Basecoat alert surface, tone from the status palette. */
.repository-sync-alert,.setup-banner,.policy-activation-review-warning{border-radius:var(--radius-lg)}
.dialog-error{color:var(--destructive)}

/* Basecoat components mapped onto FileGRC elements (see THEME_CLASS_MAP). */
/* Server-rendered pages (help, actions) load no script, so their buttons keep FileGRC's
   classes; give them the same Basecoat shape. */
.button:not(.bc-btn){display:inline-flex;align-items:center;justify-content:center;min-height:calc(var(--spacing)*9);padding:calc(var(--spacing)*1.5) calc(var(--spacing)*3);border:1px solid var(--border);border-radius:var(--radius-md);background:var(--background);color:var(--foreground);font-size:.875rem;font-weight:500;box-shadow:0 1px 2px 0 rgb(0 0 0/.05)}
.button.primary:not(.bc-btn){border-color:var(--primary);background:var(--primary);color:var(--primary-foreground)}
.button:not(.bc-btn):hover{filter:none;background:var(--muted)}
.button.primary:not(.bc-btn):hover{background:color-mix(in oklab,var(--primary) 85%,transparent)}
.bc-btn{height:auto;min-height:calc(var(--spacing)*9);white-space:normal;text-align:center;line-height:1.25;cursor:pointer;text-decoration:none}
.bc-btn[data-variant='ghost'].text-button{min-height:0;padding:calc(var(--spacing)*1) calc(var(--spacing)*2)}
.bc-btn:disabled{opacity:.5;cursor:not-allowed}
.bc-btn.is-loading{display:inline-flex}
.bc-select{max-width:100%}
.text-button:not(.bc-btn){color:var(--primary);text-transform:none;letter-spacing:0;font-size:.8125rem;font-weight:500;text-decoration:underline;text-underline-offset:4px}
.bc-input[type=checkbox],.bc-input[type=radio]{flex:0 0 auto;width:1rem;min-height:1rem;height:1rem;margin:2px 0 0;padding:0}
.bc-badge{height:auto;min-height:calc(var(--spacing)*5);text-transform:none;letter-spacing:0;font-size:.75rem}
.bc-badge:is(.good,.status-active,.status-approved,.status-complete,.status-passed,.status-accepted){background:var(--fg-c-success-bg);color:var(--fg-c-success-ink)}
.bc-badge:is(.warn,.status-draft,.status-planned,.status-in-progress,.status-medium,.status-due){background:var(--fg-c-warning-bg);color:var(--fg-c-warning-ink)}
.bc-badge:is(.bad,.status-open,.status-high,.status-critical,.status-failed,.status-overdue,.status-blocked){background:var(--fg-c-danger-bg);color:var(--fg-c-danger-ink)}
.bc-table td{white-space:normal}
.bc-table th{color:var(--muted-foreground);text-transform:none;letter-spacing:0;font-size:.8125rem;background:transparent}
.bc-textarea:is(.markdown-source,.content-editor-field textarea,.advanced-editor>textarea,.editor>form>textarea){background:var(--fg-code-bg);color:var(--fg-code-ink);font-family:var(--font-mono)}

/* Tab lists, when present, follow Basecoat's tabs. */
[role=tablist]{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:var(--radius-lg);background:var(--muted)}
[role=tablist]>[role=tab]{border:1px solid transparent;border-radius:var(--radius-md);background:transparent;padding:4px 10px;color:var(--muted-foreground);font-weight:500}
[role=tablist]>[role=tab][aria-selected=true]{background:var(--background);color:var(--foreground);box-shadow:0 1px 2px 0 rgb(0 0 0/.05)}

/* Focus: a solid outline with at least 3:1 contrast, on top of Basecoat's soft ring. */
:is(.bc-btn,.bc-input,.bc-select,.bc-textarea,.bc-badge,a,button,summary,[tabindex]):focus-visible{outline:2px solid var(--fg-focus);outline-offset:2px}
`;

// Basecoat components applied to FileGRC elements. The first entry whose selector matches
// an element sets its Basecoat class and variant; later entries for the same class are skipped.
export const THEME_CLASS_MAP = [
  { selector: ".button.hosted-automation-primary", className: "bc-btn", variant: "primary" },
  { selector: ".button.hosted-automation-secondary", className: "bc-btn", variant: "outline" },
  { selector: ".button.primary", className: "bc-btn", variant: "primary" },
  { selector: ".button.danger-action", className: "bc-btn", variant: "destructive" },
  { selector: ".button.danger", className: "bc-btn", variant: "destructive" },
  { selector: ".button.text-button", className: "bc-btn", variant: "ghost" },
  { selector: ".button", className: "bc-btn", variant: "outline" },
  { selector: "input:not([type]), input[type=text], input[type=email], input[type=password], input[type=number], input[type=tel], input[type=url], input[type=date], input[type=datetime-local], input[type=month], input[type=week], input[type=time], input[type=search]:not(.search input)", className: "bc-input" },
  { selector: "input[type=checkbox], input[type=radio]", className: "bc-input" },
  { selector: "select:not([multiple]):not([size])", className: "bc-select" },
  { selector: "textarea", className: "bc-textarea" },
  { selector: ".badge", className: "bc-badge", variant: "secondary" },
  { selector: "table.record-table, .markdown table, .operating-preview table", className: "bc-table" },
  { selector: "kbd", className: "bc-kbd" }
];

export const THEME_SCRIPT = String.raw`
;(() => {
  const CLASS_MAP = ${JSON.stringify(THEME_CLASS_MAP)};
  const html = document.documentElement;
  const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const syncScheme = () => html.classList.toggle("dark", Boolean(darkQuery && darkQuery.matches));
  syncScheme();
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener("change", syncScheme);
  const selectorAll = CLASS_MAP.map((rule) => rule.selector).join(",");
  const classNames = [...new Set(CLASS_MAP.map((rule) => rule.className))];
  function themeElement(element) {
    const wanted = new Map();
    for (const rule of CLASS_MAP) {
      if (!wanted.has(rule.className) && element.matches(rule.selector)) wanted.set(rule.className, rule.variant || "");
    }
    for (const className of classNames) {
      if (!wanted.has(className) && element.classList.contains(className)) element.classList.remove(className);
    }
    let variant = "";
    for (const [className, value] of wanted) {
      if (!element.classList.contains(className)) element.classList.add(className);
      if (value) variant = value;
    }
    if (variant && element.getAttribute("data-variant") !== variant) element.setAttribute("data-variant", variant);
    if (!variant && wanted.size === 0 && element.hasAttribute("data-variant") && element.hasAttribute("data-fg-themed")) element.removeAttribute("data-variant");
    if (wanted.size && !element.hasAttribute("data-fg-themed")) element.setAttribute("data-fg-themed", "");
  }
  function themeTree(node) {
    if (node.nodeType !== 1) return;
    if (node.matches(selectorAll) || node.hasAttribute("data-fg-themed")) themeElement(node);
    for (const element of node.querySelectorAll(selectorAll)) themeElement(element);
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") themeElement(record.target);
      else for (const node of record.addedNodes) themeTree(node);
    }
  }).observe(html, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  themeTree(document.body || html);
})();
`;

export function themeStylesheet(appStyles) {
  return [
    `/* FileGRC theme: Basecoat ${BASECOAT_VERSION} (MIT, https://basecoatui.com). See src/theme.js. */`,
    "@layer properties;",
    "@layer theme,base,filegrc-reset,filegrc,components,utilities,filegrc-theme;",
    scopeGlobalRules(releaseFieldWidths(prefixBasecoatClasses(BASECOAT_CSS))),
    darkTokensForMediaQuery(BASECOAT_CSS),
    `@layer filegrc-reset{${FLOW_RESET}}`,
    `@layer filegrc{\n${themeLegacyStyles(appStyles)}\n}`,
    `@layer filegrc-theme{${THEME_STYLES}}`
  ].join("\n");
}

export function themeScript(appScript) {
  return `${appScript}\n${THEME_SCRIPT}`;
}

// What the server and `filegrc build` deliver as /filegrc.css and /filegrc-app.js.
export const THEMED_APP_STYLES = themeStylesheet(APP_STYLES);
export const THEMED_APP_SCRIPT = themeScript(APP_SCRIPT);

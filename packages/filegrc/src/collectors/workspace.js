import { fetchAccessToken, googleRequest } from "./google-auth.js";

const DEFAULT_API_URL = "https://admin.googleapis.com";
const DEFAULT_DEVICES_API_URL = "https://cloudidentity.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";
const DEVICES_SCOPE = "https://www.googleapis.com/auth/cloud-identity.devices.readonly";
const USERS_PATH = "/admin/directory/v1/users";
const DEVICES_PATH = "/v1/devices";
const HINT = "Check that --admin names a Workspace administrator and that the service account has domain-wide delegation for the directory read-only scope.";
const DEVICES_HINT = "Check that --admin names a Workspace administrator and that the service account has domain-wide delegation for the directory and Cloud Identity devices read-only scopes.";

// Lists Google Workspace users with a service account that acts for --admin
// through domain-wide delegation and holds only the directory read-only scope.
// --devices adds the Cloud Identity devices read-only scope and lists endpoint
// devices with their device users.
// FILEGRC_WORKSPACE_CREDENTIALS holds the service account key as inline JSON or
// a file path. The key signs one token request and is never printed or stored.
// FILEGRC_WORKSPACE_TOKEN_URL, FILEGRC_WORKSPACE_API_URL and
// FILEGRC_CLOUD_IDENTITY_API_URL override the Google endpoints; plain HTTP is
// accepted only on loopback.
export const workspaceCollector = {
  tokenVariable: "FILEGRC_WORKSPACE_CREDENTIALS",
  async collect({ token, options, env }) {
    if (!options.admin) throw new Error("Pass --admin <email> to name the Workspace administrator the service account acts for.");
    const maxAdmins = wholeNumber(options.maxAdmins, 3, 0, "--max-admins");
    const limits = options.devices ? {
      sinceDays: wholeNumber(options.sinceDays, 30, 1, "--since-days"),
      minMacos: wholeNumber(options.minMacos, 15, 1, "--min-macos"),
      minWindowsBuild: wholeNumber(options.minWindowsBuild, 22000, 0, "--min-windows-build")
    } : null;
    const hint = limits ? DEVICES_HINT : HINT;
    const scope = limits ? `${SCOPE} ${DEVICES_SCOPE}` : SCOPE;
    const accessToken = await fetchAccessToken({ prefix: "FILEGRC_WORKSPACE", token, env, scope, subject: options.admin, hint });
    const users = await listAll(env.FILEGRC_WORKSPACE_API_URL || DEFAULT_API_URL, "FILEGRC_WORKSPACE_API_URL", USERS_PATH,
      { customer: "my_customer", maxResults: "500" }, "users", accessToken, hint);
    const source = `Google Workspace Admin SDK Directory API GET ${USERS_PATH}?customer=my_customer`;

    const active = users.filter((user) => !user.suspended && !user.archived);
    const unenrolled = active.filter((user) => user.isEnrolledIn2Sv !== true).map((user) => user.primaryEmail).sort();
    const admins = users.filter((user) => user.isAdmin === true).length;
    const runs = [{
      key: "workspace-2sv-enrolment",
      title: "Every active Google Workspace user is enrolled in 2-step verification",
      expectedCondition: "Every active, non-suspended Google Workspace user is enrolled in 2-step verification.",
      sourceDescription: `${source}, fields isEnrolledIn2Sv, suspended and archived.`,
      result: unenrolled.length ? "failed" : "passed",
      observed: `${source}\n\n- active users: ${active.length}\n- not enrolled in 2-step verification: ${unenrolled.length}\n\n${unenrolled.map((email) => `- ${email}`).join("\n")}`.trimEnd()
    }, {
      key: "workspace-admin-count",
      title: `Google Workspace has at most ${maxAdmins} super administrators`,
      expectedCondition: `At most ${maxAdmins} Google Workspace users have isAdmin set.`,
      sourceDescription: `${source}, field isAdmin.`,
      result: admins > maxAdmins ? "failed" : "passed",
      observed: `${source}\n\n- users with isAdmin: ${admins}\n- allowed: ${maxAdmins}`
    }];
    if (limits) runs.push(...await deviceRuns(env.FILEGRC_CLOUD_IDENTITY_API_URL || DEFAULT_DEVICES_API_URL, accessToken, limits));
    return runs;
  }
};

function wholeNumber(value, fallback, minimum, flag) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < minimum) throw new Error(`${flag} must be a whole number of ${minimum} or more.`);
  return Number(value);
}

async function listAll(baseUrl, variable, path, params, field, accessToken, hint) {
  const items = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ ...params, ...(pageToken ? { pageToken } : {}) });
    const page = await googleRequest("GET", baseUrl, `${path}?${query}`, variable, { authorization: `Bearer ${accessToken}` }, undefined, hint);
    items.push(...(page[field] || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return items;
}

// Keeps devices synced within --since-days and, per serial number, the latest
// sync, then reads each kept device's users. Failing devices are named by
// owner email, device type and model only.
async function deviceRuns(baseUrl, accessToken, { sinceDays, minMacos, minWindowsBuild }) {
  const customer = { customer: "customers/my_customer" };
  const variable = "FILEGRC_CLOUD_IDENTITY_API_URL";
  const listed = await listAll(baseUrl, variable, DEVICES_PATH, { ...customer, pageSize: "100" }, "devices", accessToken, DEVICES_HINT);
  const cutoff = Date.now() - sinceDays * 86400000;
  const recent = listed.filter((device) => Date.parse(device.lastSyncTime) >= cutoff);
  const latest = new Map();
  for (const device of recent) {
    const key = device.serialNumber || device.name;
    const kept = latest.get(key);
    if (!kept || Date.parse(device.lastSyncTime) > Date.parse(kept.lastSyncTime)) latest.set(key, device);
  }
  const devices = [];
  for (const device of latest.values()) {
    const users = await listAll(baseUrl, variable, `/v1/${device.name}/deviceUsers`, customer, "deviceUsers", accessToken, DEVICES_HINT);
    const owner = users.map((user) => user.userEmail).filter(Boolean).join(", ");
    devices.push({ ...device, users, owner, label: `${owner || "no owner email"} (${device.deviceType || "unknown type"}, ${device.model || "unknown model"})` });
  }
  devices.sort((a, b) => a.label.localeCompare(b.label));

  const source = `Google Cloud Identity Devices API GET ${DEVICES_PATH}?customer=customers/my_customer and GET /v1/{device}/deviceUsers`;
  const counts = `${source}\n\n- devices listed: ${listed.length}\n- dropped as stale (no sync in the last ${sinceDays} days): ${listed.length - recent.length}\n- dropped as duplicate serial number: ${recent.length - devices.length}\n- kept: ${devices.length}`;
  const block = (items) => items.length ? `\n\n${items.join("\n")}` : "";
  const userStates = (device, field) => device.users.map((user) => user[field]).filter(Boolean).join(", ");
  const cell = (value) => String(value || "not reported").replaceAll("|", "\\|");
  const table = devices.length ? [
    "| Owner email | Device type | OS version | encryptionState | passwordState | managementState | lastSyncTime | firstSyncTime |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...devices.map((device) => `| ${[device.owner, device.deviceType, device.osVersion, device.encryptionState, userStates(device, "passwordState"),
      userStates(device, "managementState"), device.lastSyncTime, userStates(device, "firstSyncTime")].map(cell).join(" | ")} |`)
  ] : [];

  const unencrypted = devices.filter((device) => device.encryptionState !== "ENCRYPTED").map((device) => device.encryptionState === "NOT_ENCRYPTED"
    ? `- ${device.label}: not encrypted` : `- ${device.label}: not reported (${device.encryptionState || "no encryptionState"})`);
  const unlocked = devices.filter((device) => !device.users.some((user) => user.passwordState === "PASSWORD_SET"))
    .map((device) => `- ${device.label}: no device user with passwordState PASSWORD_SET`);
  const ownerless = devices.filter((device) => !device.owner).map((device) => `- ${device.label}: no device user with an email`);
  const outdated = [];
  const unchecked = [];
  for (const device of devices) {
    const version = device.osVersion || "OS version not reported";
    if (device.deviceType === "MAC_OS") {
      if (!(Number(/\d+/.exec(device.osVersion || "")?.[0]) >= minMacos)) outdated.push(`- ${device.label}: ${version}, below macOS ${minMacos}`);
    } else if (device.deviceType === "WINDOWS") {
      if (!(Number(/\d+\.\d+\.(\d+)/.exec(device.osVersion || "")?.[1]) >= minWindowsBuild)) outdated.push(`- ${device.label}: ${version}, below Windows build ${minWindowsBuild}`);
    } else unchecked.push(`- ${device.label}: not checked`);
  }

  // With no kept device every check fails: no laptop evidence is the gap.
  const check = (key, title, expectedCondition, fields, failures, extra = "") => ({
    key,
    title,
    expectedCondition,
    sourceDescription: `${source}, fields ${fields}; devices synced in the last ${sinceDays} days, one per serial number.`,
    result: devices.length && !failures.length ? "passed" : "failed",
    observed: `${counts}\n- failing: ${failures.length}${block(failures)}${extra}`
  });
  return [{
    key: "workspace-device-inventory",
    title: "Google Workspace reports recently synced endpoint devices",
    expectedCondition: `Google endpoint management reports at least one device synced in the last ${sinceDays} days.`,
    sourceDescription: `${source}, fields deviceType, osVersion, encryptionState, lastSyncTime and serialNumber, and device user fields userEmail, passwordState, managementState and firstSyncTime.`,
    result: devices.length ? "passed" : "failed",
    observed: `${counts}${block(table)}`
  },
  check("workspace-device-encryption", "Every Google Workspace endpoint device reports disk encryption",
    "Every recently synced endpoint device has encryptionState ENCRYPTED.", "encryptionState", unencrypted),
  check("workspace-device-screen-lock", "Every Google Workspace endpoint device has a screen lock password",
    "Every recently synced endpoint device has a device user with passwordState PASSWORD_SET.", "passwordState", unlocked),
  check("workspace-device-os-supported", "Every Google Workspace endpoint device runs a supported OS version",
    `Every recently synced macOS device runs macOS ${minMacos} or later and every Windows device runs build ${minWindowsBuild} or later.`,
    "deviceType and osVersion", outdated, `\n\n- not checked (not macOS or Windows): ${unchecked.length}${block(unchecked)}`),
  check("workspace-device-owner", "Every Google Workspace endpoint device names its owner",
    "Every recently synced endpoint device has a device user with an email address.", "device user userEmail", ownerless)];
}

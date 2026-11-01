import { fetchAccessToken, googleRequest } from "./google-auth.js";

const DEFAULT_API_URL = "https://admin.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";
const USERS_PATH = "/admin/directory/v1/users";
const HINT = "Check that --admin names a Workspace administrator and that the service account has domain-wide delegation for the directory read-only scope.";

// Lists Google Workspace users with a service account that acts for --admin
// through domain-wide delegation and holds only the directory read-only scope.
// FILEGRC_WORKSPACE_CREDENTIALS holds the service account key as inline JSON or
// a file path. The key signs one token request and is never printed or stored.
// FILEGRC_WORKSPACE_TOKEN_URL and FILEGRC_WORKSPACE_API_URL override the Google
// endpoints; plain HTTP is accepted only on loopback.
export const workspaceCollector = {
  tokenVariable: "FILEGRC_WORKSPACE_CREDENTIALS",
  async collect({ token, options, env }) {
    if (!options.admin) throw new Error("Pass --admin <email> to name the Workspace administrator the service account acts for.");
    const maxAdmins = options.maxAdmins === undefined ? 3 : /^\d+$/.test(options.maxAdmins) ? Number(options.maxAdmins) : -1;
    if (maxAdmins < 0) throw new Error("--max-admins must be a whole number of 0 or more.");
    const accessToken = await fetchAccessToken({ prefix: "FILEGRC_WORKSPACE", token, env, scope: SCOPE, subject: options.admin, hint: HINT });
    const users = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({ customer: "my_customer", maxResults: "500", ...(pageToken ? { pageToken } : {}) });
      const page = await googleRequest("GET", env.FILEGRC_WORKSPACE_API_URL || DEFAULT_API_URL, `${USERS_PATH}?${query}`, "FILEGRC_WORKSPACE_API_URL", {
        authorization: `Bearer ${accessToken}`
      }, undefined, HINT);
      users.push(...(page.users || []));
      pageToken = page.nextPageToken || "";
    } while (pageToken);
    const source = `Google Workspace Admin SDK Directory API GET ${USERS_PATH}?customer=my_customer`;

    const active = users.filter((user) => !user.suspended && !user.archived);
    const unenrolled = active.filter((user) => user.isEnrolledIn2Sv !== true).map((user) => user.primaryEmail).sort();
    const admins = users.filter((user) => user.isAdmin === true).length;
    return [{
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
  }
};

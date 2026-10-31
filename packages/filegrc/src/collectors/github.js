import http from "node:http";
import https from "node:https";

const DEFAULT_API_URL = "https://api.github.com";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Reads GitHub organization and repository settings with GET requests only.
// GITHUB_API_URL may name a GitHub Enterprise Server API; plain HTTP is
// accepted only on loopback so the token never crosses a network unencrypted.
export const githubCollector = {
  tokenVariable: "GITHUB_TOKEN",
  async collect({ token, options, env }) {
    if (!options.org) throw new Error("Pass --org <organization> to name the GitHub organization to check.");
    const get = (path) => request(env.GITHUB_API_URL || DEFAULT_API_URL, path, token);
    const orgPath = `/orgs/${encodeURIComponent(options.org)}`;
    const org = await get(orgPath);
    if (typeof org.two_factor_requirement_enabled !== "boolean") {
      throw new Error(`GitHub did not return the two-factor requirement for "${options.org}". Use a token from an organization owner with read access to organization administration.`);
    }
    const runs = [{
      key: `github-org-2fa-${slug(options.org)}`,
      title: `GitHub organization ${options.org} requires two-factor authentication`,
      expectedCondition: `GitHub organization ${options.org} requires two-factor authentication for every member.`,
      sourceDescription: `GitHub REST API GET ${orgPath}, field two_factor_requirement_enabled.`,
      result: org.two_factor_requirement_enabled ? "passed" : "failed",
      observed: `GET ${orgPath}\n\n- two_factor_requirement_enabled: ${org.two_factor_requirement_enabled}`
    }];
    for (const fullName of options.repos || []) {
      const [owner, repo, extra] = fullName.split("/");
      if (!owner || !repo || extra !== undefined) throw new Error(`Repository "${fullName}" must be written as owner/name.`);
      const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const { default_branch: branch } = await get(repoPath);
      const branchPath = `${repoPath}/branches/${encodeURIComponent(branch)}`;
      const { protected: isProtected } = await get(branchPath);
      runs.push({
        key: `github-branch-protection-${slug(owner)}-${slug(repo)}`,
        title: `GitHub repository ${owner}/${repo} protects its default branch`,
        expectedCondition: `The default branch of GitHub repository ${owner}/${repo} has branch protection enabled.`,
        sourceDescription: `GitHub REST API GET ${repoPath} and GET ${repoPath}/branches/{default_branch}, field protected.`,
        result: isProtected === true ? "passed" : "failed",
        observed: `GET ${repoPath}\n\n- default_branch: ${branch}\n\nGET ${branchPath}\n\n- protected: ${isProtected}`
      });
    }
    return runs;
  }
};

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function request(apiUrl, path, token) {
  const url = new URL(apiUrl.replace(/\/$/, "") + path);
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) ? http : null;
  if (!transport) return Promise.reject(new Error(`GITHUB_API_URL must use https (plain http is allowed only on localhost): ${apiUrl}`));
  return new Promise((resolve, reject) => {
    const call = transport.get(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "filegrc-collector",
        "x-github-api-version": "2022-11-28"
      },
      timeout: 30000
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          // Reported below with the HTTP status.
        }
        if (response.statusCode !== 200 || !parsed) {
          reject(new Error(`GitHub GET ${path} returned HTTP ${response.statusCode}${parsed?.message ? `: ${parsed.message}` : ""}. Check the organization and repository names and the token's read access.`));
        } else resolve(parsed);
      });
    });
    call.on("timeout", () => call.destroy(new Error(`GitHub GET ${path} timed out.`)));
    call.on("error", reject);
  });
}

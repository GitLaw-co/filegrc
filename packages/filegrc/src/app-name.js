// The name shown in window titles and the sidebar. Hosted deployments set
// FILEGRC_APP_NAME to their own name (for example "GitLaw Compliance").
export function appName() {
  const name = process.env.FILEGRC_APP_NAME?.trim();
  return name ? name.slice(0, 80) : "FileGRC";
}

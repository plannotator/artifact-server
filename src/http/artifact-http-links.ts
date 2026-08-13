/** Build the stable browser URL for an artifact's current version. */
export function artifactBrowserUrl(
  applicationUrl: URL,
  artifactId: string,
): string {
  return new URL(`/artifacts/${artifactId}`, applicationUrl).toString();
}

/** Build the browser origin for one exact immutable version. */
export function versionBrowserUrl(
  applicationUrl: URL,
  contentDomain: string,
  contentToken: string,
): string {
  const versionUrl = new URL(applicationUrl);
  versionUrl.hostname = `${contentToken}.${contentDomain}`;
  versionUrl.pathname = "/";
  versionUrl.search = "";
  versionUrl.hash = "";
  return versionUrl.toString();
}

/** Build the browser URL for one file within an immutable version. */
export function versionFileBrowserUrl(
  applicationUrl: URL,
  contentDomain: string,
  contentToken: string,
  manifestPath: string,
): string {
  const fileUrl = new URL(
    versionBrowserUrl(applicationUrl, contentDomain, contentToken),
  );
  fileUrl.pathname = `/${manifestPath.split("/").map(encodeURIComponent).join("/")}`;
  return fileUrl.toString();
}

/** Build the one-time URL that establishes a private version browser session. */
export function contentBootstrapBrowserUrl(
  applicationUrl: URL,
  contentDomain: string,
  contentToken: string,
  bootstrapToken: string,
): string {
  const bootstrapUrl = new URL(applicationUrl);
  bootstrapUrl.hostname = `${contentToken}.${contentDomain}`;
  bootstrapUrl.pathname = "/";
  bootstrapUrl.search = new URLSearchParams({
    __artifact_bootstrap: bootstrapToken,
  }).toString();
  bootstrapUrl.hash = "";
  return bootstrapUrl.toString();
}

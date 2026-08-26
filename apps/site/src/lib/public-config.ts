/**
 * Optional trusted Artifact Server application linked from the site.
 *
 * The public site at artifactserver.com has no application behind it — the
 * product is self-hosted — so this is null unless a deployment sets
 * `PUBLIC_ARTIFACT_SERVER_APP_URL` (a team hosting these docs beside its own
 * installation). When set, the header shows an "Open app" link next to the
 * GitHub call to action.
 */
export const artifactServerAppUrl: string | null =
  import.meta.env.PUBLIC_ARTIFACT_SERVER_APP_URL ?? null;

export const repositoryUrl = "https://github.com/plannotator/artifact-server";

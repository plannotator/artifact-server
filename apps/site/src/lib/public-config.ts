const localAppUrl = "http://127.0.0.1:5173/review";
const productionAppUrl = "https://app.artifactserver.com/review";

/** Trusted Artifact Server application target linked from the public site. */
export const artifactServerAppUrl =
  import.meta.env.PUBLIC_ARTIFACT_SERVER_APP_URL ??
  (import.meta.env.DEV ? localAppUrl : productionAppUrl);

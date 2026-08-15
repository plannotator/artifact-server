import {Redacted} from "effect";

/** One named string that is safe to inspect but must never expose credentials. */
export interface CloudDeploymentSecretCandidate {
  readonly field: string;
  readonly value: string;
}

const signedUrlKeys = new Set([
  "access_token",
  "apikey",
  "api_key",
  "key",
  "sig",
  "signature",
  "token",
  "x-amz-credential",
  "x-amz-signature",
  "x-goog-credential",
  "x-goog-signature",
]);

/**
 * Return the field containing credential material without ever returning the
 * credential itself.
 */
export function findUnsafeCloudDeploymentValue(
  candidates: readonly CloudDeploymentSecretCandidate[],
  knownSecrets: readonly Redacted.Redacted[],
): string | null {
  return candidates.find(({value}) =>
    containsCredentialMaterial(value, knownSecrets)
  )?.field ?? null;
}

function containsCredentialMaterial(
  value: string,
  knownSecrets: readonly Redacted.Redacted[],
): boolean {
  if (knownSecrets.some((secret) => {
    const revealed = Redacted.value(secret);
    return revealed.length > 0 && value.includes(revealed);
  })) {
    return true;
  }
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /\bAKIA[A-Z0-9]{16}\b/u.test(value) ||
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u.test(value) ||
    /(?:AccountKey|SharedAccessSignature|password)\s*=/iu.test(value)
  ) {
    return true;
  }
  try {
    const url = new URL(value);
    if (url.username.length > 0 || url.password.length > 0) {
      return true;
    }
    return [...url.searchParams.keys()].some((key) =>
      signedUrlKeys.has(key.toLowerCase())
    );
  } catch {
    return false;
  }
}

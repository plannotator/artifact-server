import {createHash} from "node:crypto";

import {Redacted} from "effect";

import type {BootstrapManagedApiKeyRepository} from
  "../core/identity-ports.js";
import {
  managedApiKeyCredentialPattern,
  type StoredManagedApiKey,
} from "../core/installation-identity.js";
import {
  principalCapabilities,
  principalKinds,
} from "../core/identity.js";
import {identitySecretsEqual} from "./installation-access.js";

const bootstrapKeyExpiration = "9999-12-31T23:59:59.999Z";
const bootstrapCapabilities = Object.values(principalCapabilities).toSorted();

/**
 * Persist the first private-team machine credential as a normal managed key.
 *
 * A repeated startup reuses the exact row. Once an installation has identity
 * state, changing the bootstrap key id cannot manufacture new authority; an
 * administrator must use the ordinary managed-key lifecycle instead.
 */
export async function ensureBootstrapManagedApiKey(input: {
  readonly credential: Redacted.Redacted;
  readonly installationId: string;
  readonly now: Date;
  readonly repository: BootstrapManagedApiKeyRepository;
}): Promise<void> {
  const credential = Redacted.value(input.credential);
  const parsed = managedApiKeyCredentialPattern.exec(credential);
  if (parsed?.[1] === undefined) {
    throw new Error(
      "A private-team API bootstrap credential must use the managed as_key_ format.",
    );
  }
  const keyId = parsed[1];
  const secretDigest = createHash("sha256").update(credential).digest("hex");
  const stored: StoredManagedApiKey = {
    authorizedByPrincipalId: "installation-bootstrap",
    capabilities: bootstrapCapabilities,
    createdAt: input.now.toISOString(),
    expiresAt: bootstrapKeyExpiration,
    id: keyId,
    installationId: input.installationId,
    name: "Installation bootstrap key",
    prefix: credential.slice(0, Math.min(credential.length, 32)),
    principalId: `service:${keyId}`,
    principalKind: principalKinds.service,
    revokedAt: null,
    rotatedFromId: null,
    secretDigest,
  };
  const persisted = await input.repository.initializeBootstrapApiKey(stored);
  assertMatchingBootstrapKey(persisted, secretDigest);
}

function assertMatchingBootstrapKey(
  key: StoredManagedApiKey,
  secretDigest: string,
): void {
  if (
    key.principalKind !== principalKinds.service
    || !identitySecretsEqual(key.secretDigest, secretDigest)
  ) {
    throw new Error(
      "The configured private-team bootstrap key conflicts with persisted identity state.",
    );
  }
}

import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect, ManagedRuntime, Redacted, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import {InstallationAccessService} from "../../src/application/installation-access.js";
import type {ExternalIdentity} from "../../src/core/installation-identity.js";
import {SystemClock, SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";

const installationId = "oidc-admission-boundary";
const oidcProvider = "oidc:https://issuer.example.test";
const memberIdentity: ExternalIdentity = {
  displayName: "New member",
  email: "member@example.test",
  emailVerified: true,
  provider: oidcProvider,
  subject: "new-member",
};

describe("OIDC admission provider and credential boundaries", () => {
  let dataDirectory: string;
  let repository: SqliteArtifactRepository;
  let identityRepository: SqliteIdentityRepository;
  let runtime: ApplicationRuntime;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-oidc-boundary-"));
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    repository = new SqliteArtifactRepository(databasePath);
    identityRepository = new SqliteIdentityRepository(databasePath);
    runtime = ManagedRuntime.make(createLocalApplicationLayer({
      apiToken: Redacted.make("test-api-token"),
      blobs: new LocalBlobStore(path.join(dataDirectory, "blobs")),
      bootstrapAdministratorEmail: "administrator@example.test",
      clock: new SystemClock(),
      dispatches: repository,
      externalApiBearerVerifier: null,
      externalIdentityAdmissionPolicy: {
        allowedEmailDomains: [],
        provider: oidcProvider,
      },
      externalMcpBearerVerifier: null,
      externalMcpOAuthVerifier: null,
      ids: new SystemIdGenerator(),
      identityRepository,
      installationId,
      interactiveIdentityProvider: null,
      localBootstrapCredential: null,
      protectBootstrapAdministrator: false,
      repository,
      staging: new LocalStagingStore(path.join(dataDirectory, "staging")),
    }));
    await runtime.runPromise(InstallationAccessService.use((access) =>
      access.completeExternalIdentity({
        ...memberIdentity,
        email: "administrator@example.test",
        subject: "administrator",
      })
    ));
  });

  afterEach(async () => {
    await runtime.dispose();
    identityRepository.close();
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("AUTH-029: an enabled browser policy cannot admit an unknown bearer identity", async () => {
    const denied = await runtime.runPromise(Effect.result(
      InstallationAccessService.use((access) =>
        access.authenticateExternalIdentity(memberIdentity)
      ),
    ));
    expect(Result.match(denied, {
      onFailure: (failure) => failure._tag,
      onSuccess: () => "UnexpectedSuccess",
    })).toBe("IdentityAdmissionDenied");
    expect(await identityRepository.listMembers(installationId)).toHaveLength(1);
    expect(await identityRepository.findMemberByExternalIdentity(
      installationId, oidcProvider, "new-member",
    )).toBeNull();

    const admitted = await runtime.runPromise(InstallationAccessService.use((access) =>
      access.completeExternalIdentity(memberIdentity)
    ));
    const principal = await runtime.runPromise(InstallationAccessService.use((access) =>
      access.authenticateExternalIdentity(memberIdentity)
    ));
    expect(principal).toMatchObject({
      id: admitted.session.member.id,
      membershipRole: "member",
    });
    expect(await identityRepository.listMembers(installationId)).toHaveLength(2);
  });

  test("AUTH-029: an enabled OIDC policy cannot admit an unknown WorkOS browser identity", async () => {
    const denied = await runtime.runPromise(Effect.result(
      InstallationAccessService.use((access) =>
        access.completeExternalIdentity({...memberIdentity, provider: "workos"})
      ),
    ));
    expect(Result.match(denied, {
      onFailure: (failure) => failure._tag,
      onSuccess: () => "UnexpectedSuccess",
    })).toBe("IdentityAdmissionDenied");
    expect(await identityRepository.listMembers(installationId)).toHaveLength(1);
    expect(await identityRepository.findMemberByExternalIdentity(
      installationId, "workos", "new-member",
    )).toBeNull();
  });
});

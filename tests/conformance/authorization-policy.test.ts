import {Effect, Layer, ManagedRuntime, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {AuthorizationService} from "../../src/application/authorization.js";
import type {AuthorizationDenied} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import type {ArtifactRecord} from "../../src/core/model.js";

describe("authorization policy", () => {
  let runtime: ManagedRuntime.ManagedRuntime<AuthorizationService, never>;

  beforeEach(async () => {
    runtime = ManagedRuntime.make(Layer.mergeAll(
      AuthorizationService.layer({installationId: "installation-a"}),
    ));
    await runtime.context();
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  test("foundation: standalone reads and mutations use membership, ownership, and explicit capabilities", async () => {
    expect.hasAssertions();
    const artifact = artifactOwnedBy("owner");
    const owner = humanPrincipal("owner", membershipRoles.member);
    const otherMember = humanPrincipal("other", membershipRoles.member);
    const administrator = humanPrincipal(
      "administrator",
      membershipRoles.administrator,
    );
    const scopedService = servicePrincipal(
      "publisher",
      [principalCapabilities.publishAnyArtifact],
    );
    const readerService = servicePrincipal(
      "reader",
      [principalCapabilities.readArtifacts],
    );
    const managerService = servicePrincipal(
      "manager",
      [principalCapabilities.manageAnyArtifact],
    );
    const ownerManagerService = servicePrincipal(
      "owner",
      [principalCapabilities.manageOwnedArtifact],
    );
    const foreignOwnerManagerService = servicePrincipal(
      "not-owner",
      [principalCapabilities.manageOwnedArtifact],
    );
    const unscopedService = servicePrincipal("reader", []);

    await expectAllowed((authorization) =>
      authorization.requireArtifactRead(otherMember, artifact)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactRead(readerService, artifact)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactManagement(owner, artifact)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactManagement(administrator, artifact)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactManagement(managerService, artifact)
    );
    await expectAllowed((authorization) =>
      authorization.requireArtifactRead(ownerManagerService, artifact)
    );
    await expectAllowed((authorization) =>
      authorization.requireContentSession(otherMember, artifact)
    );
    await expectAllowed((authorization) =>
      authorization.requireVersionPublication(owner, artifact)
    );
    await expectAllowed((authorization) =>
      authorization.requireVersionPublication(administrator, artifact)
    );
    await expectAllowed((authorization) =>
      authorization.requireVersionPublication(scopedService, artifact)
    );
    await expectDenied((authorization) =>
      authorization.requireVersionPublication(otherMember, artifact)
    );
    await expectDenied((authorization) =>
      authorization.requireArtifactManagement(otherMember, artifact)
    );
    await expectDenied((authorization) =>
      authorization.requireVersionPublication(unscopedService, artifact)
    );
    await expectDenied((authorization) =>
      authorization.requireArtifactRead(unscopedService, artifact)
    );
    await expectDenied((authorization) =>
      authorization.requireArtifactRead(foreignOwnerManagerService, artifact)
    );
  });

  test("foundation: another installation or an unscoped service cannot acquire authority", async () => {
    expect.hasAssertions();
    const artifact = artifactOwnedBy("owner");
    const foreignAdministrator: Principal = {
      ...humanPrincipal("foreign-admin", membershipRoles.administrator),
      installationId: "installation-b",
    };
    await expectDenied((authorization) =>
      authorization.requireContentSession(foreignAdministrator, artifact)
    );
    await expectDenied((authorization) =>
      authorization.requireArtifactCreation(servicePrincipal("unscoped", []))
    );
  });

  async function expectAllowed(
    operation: (
      authorization: AuthorizationService["Service"],
    ) => Effect.Effect<void, AuthorizationDenied>,
  ): Promise<void> {
    const result = await runtime.runPromise(
      Effect.result(AuthorizationService.use(operation)),
    );
    expect(Result.isSuccess(result)).toBe(true);
  }

  async function expectDenied(
    operation: (
      authorization: AuthorizationService["Service"],
    ) => Effect.Effect<void, AuthorizationDenied>,
  ): Promise<void> {
    const result = await runtime.runPromise(
      Effect.result(AuthorizationService.use(operation)),
    );
    expect(Result.match(result, {
      onFailure: (failure) => failure._tag,
      onSuccess: () => "UnexpectedSuccess",
    })).toBe("AuthorizationDenied");
  }
});

function artifactOwnedBy(ownerPrincipalId: string): ArtifactRecord {
  return {
    accessSetting: "account_required",
    createdAt: "2026-08-13T00:00:00.000Z",
    currentVersionId: "version-1",
    deletedAt: null,
    id: "artifact-1",
    name: "Authorization fixture",
    ownerPrincipalId,
  };
}

function humanPrincipal(
  id: string,
  membershipRole: Principal["membershipRole"],
): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities: [],
    id,
    installationId: "installation-a",
    kind: principalKinds.human,
    membershipRole,
  };
}

function servicePrincipal(
  id: string,
  capabilities: Principal["capabilities"],
): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities,
    id,
    installationId: "installation-a",
    kind: principalKinds.service,
    membershipRole: membershipRoles.member,
  };
}

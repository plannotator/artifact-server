import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {membershipRoles} from "../../src/core/identity.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";

describe("status-inclusive admission lookups", () => {
  let directory: string;
  let repository: SqliteIdentityRepository;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "artifact-admission-identity-"));
    repository = new SqliteIdentityRepository(path.join(directory, "identity.db"));
    await repository.admitMember({
      createdAt: "2026-10-09T00:00:00.000Z",
      displayName: "Admitted member",
      email: "member@example.test",
      id: "member-one",
      installationId: "installation-one",
      role: membershipRoles.member,
    });
    await repository.bindExternalIdentity({
      boundAt: "2026-10-09T00:00:00.000Z",
      email: "member@example.test",
      memberId: "member-one",
      provider: "oidc:https://issuer-one.example.test",
      subject: "subject-one",
    });
  });

  afterEach(async () => {
    repository.close();
    await rm(directory, {force: true, recursive: true});
  });

  test("AUTH-029: email admission lookup returns active and inactive members", async () => {
    const active = await repository.findMemberByEmail(
      "installation-one", "member@example.test",
    );
    expect(active).toMatchObject({id: "member-one", status: "active"});

    await repository.deactivateMember(
      "installation-one", "member-one", "2026-10-09T01:00:00.000Z",
    );
    const inactive = await repository.findMemberByEmail(
      "installation-one", "member@example.test",
    );
    expect(inactive).toMatchObject({
      id: "member-one",
      status: "inactive",
      updatedAt: "2026-10-09T01:00:00.000Z",
    });
    await expect(repository.findActiveMemberByEmail(
      "installation-one", "member@example.test",
    )).resolves.toBeNull();
  });

  test("AUTH-029: bound-subject lookup retains an inactive member after email changes", async () => {
    const active = await repository.findMemberByExternalIdentity(
      "installation-one", "oidc:https://issuer-one.example.test", "subject-one",
    );
    expect(active).toMatchObject({id: "member-one", status: "active"});

    await repository.deactivateMember(
      "installation-one", "member-one", "2026-10-09T01:00:00.000Z",
    );
    await repository.bindExternalIdentity({
      boundAt: "2026-10-09T02:00:00.000Z",
      email: "changed@example.test",
      memberId: "member-one",
      provider: "oidc:https://issuer-one.example.test",
      subject: "subject-one",
    });
    const inactive = await repository.findMemberByExternalIdentity(
      "installation-one", "oidc:https://issuer-one.example.test", "subject-one",
    );
    expect(inactive).toMatchObject({
      email: "member@example.test", id: "member-one", status: "inactive",
    });
    await expect(repository.findActiveMemberByExternalIdentity(
      "installation-one", "oidc:https://issuer-one.example.test", "subject-one",
    )).resolves.toBeNull();
  });

  test("AUTH-029: email and bound-subject lookups preserve installation and issuer scopes", async () => {
    await repository.admitMember({
      createdAt: "2026-10-09T00:00:00.000Z",
      displayName: "Other installation member",
      email: "member@example.test",
      id: "member-two",
      installationId: "installation-two",
      role: membershipRoles.member,
    });
    await repository.bindExternalIdentity({
      boundAt: "2026-10-09T00:00:00.000Z",
      email: "member@example.test",
      memberId: "member-two",
      provider: "oidc:https://issuer-two.example.test",
      subject: "subject-one",
    });

    await expect(repository.findMemberByEmail(
      "installation-two", "member@example.test",
    )).resolves.toMatchObject({id: "member-two", installationId: "installation-two"});
    await expect(repository.findMemberByEmail(
      "installation-three", "member@example.test",
    )).resolves.toBeNull();
    await expect(repository.findMemberByExternalIdentity(
      "installation-two", "oidc:https://issuer-two.example.test", "subject-one",
    )).resolves.toMatchObject({id: "member-two", installationId: "installation-two"});
    await expect(repository.findMemberByExternalIdentity(
      "installation-one", "oidc:https://issuer-two.example.test", "subject-one",
    )).resolves.toBeNull();
    await expect(repository.findMemberByExternalIdentity(
      "installation-two", "oidc:https://issuer-one.example.test", "subject-one",
    )).resolves.toBeNull();
    await expect(repository.findMemberByExternalIdentity(
      "installation-one", "oidc:https://issuer-one.example.test", "missing-subject",
    )).resolves.toBeNull();
  });
});

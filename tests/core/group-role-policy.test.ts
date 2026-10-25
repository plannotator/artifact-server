import {describe, expect, test} from "vitest";

import {
  type GroupRolePolicy,
  groupMembershipRole,
} from "../../src/core/group-role-policy.js";

const policy: GroupRolePolicy = {
  administratorGroups: ["artifact-admins"],
  memberGroups: ["artifact-users", "engineering"],
};

describe("issuer group roles", () => {
  test("an administrator group outranks a member group", () => {
    expect(groupMembershipRole(policy, ["artifact-admins"]))
      .toBe("administrator");
    expect(groupMembershipRole(policy, ["engineering", "artifact-admins"]))
      .toBe("administrator");
  });

  test("any member group admits a member", () => {
    expect(groupMembershipRole(policy, ["artifact-users"])).toBe("member");
    expect(groupMembershipRole(policy, ["sales", "engineering"])).toBe("member");
  });

  test("no admitted group, no reported groups, or a near miss admits no one", () => {
    expect(groupMembershipRole(policy, [])).toBeNull();
    expect(groupMembershipRole(policy, null)).toBeNull();
    expect(groupMembershipRole(policy, ["sales"])).toBeNull();
    // Names compare exactly: case, paths, and padding are different groups.
    expect(groupMembershipRole(policy, [
      "Artifact-Admins",
      "/artifact-admins",
      " artifact-users",
    ])).toBeNull();
  });

  test("a policy with one empty list grants only the other role", () => {
    expect(groupMembershipRole(
      {administratorGroups: [], memberGroups: ["artifact-users"]},
      ["artifact-users"],
    )).toBe("member");
    expect(groupMembershipRole(
      {administratorGroups: ["artifact-admins"], memberGroups: []},
      ["artifact-users"],
    )).toBeNull();
  });
});

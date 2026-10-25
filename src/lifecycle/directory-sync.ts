import {Effect} from "effect";

import type {ApplicationRuntime} from
  "../application/application-runtime.js";
import {
  type DirectorySyncReport,
  type MemberDirectory,
  syncDirectoryMembers,
} from "../application/directory-sync.js";
import type {GroupRolePolicy} from "../core/group-role-policy.js";

/** Run one complete directory sync pass and reject with a stable message. */
export function runDirectorySyncPass(
  runtime: ApplicationRuntime,
  directory: MemberDirectory,
  policy: GroupRolePolicy,
): Promise<DirectorySyncReport> {
  return runtime.runPromise(syncDirectoryMembers(directory, policy).pipe(
    Effect.mapError((error) => new Error(`${error._tag}: ${error.message}`)),
  ));
}

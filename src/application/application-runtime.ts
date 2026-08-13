import { Effect, type ManagedRuntime, Result } from "effect";

import type { PublishArtifactService } from "./publish-artifact.js";
import type { StagedUploadService } from "./staged-upload.js";
import type { AuthenticationService } from "./authentication.js";
import type { AuthorizationService } from "./authorization.js";
import type { ContentAccessService } from "./content-access.js";

/** Application services shared by every Artifact Server entry point. */
export type ApplicationServices =
  | AuthenticationService
  | AuthorizationService
  | ContentAccessService
  | PublishArtifactService
  | StagedUploadService;

/** One reusable runtime for an Artifact Server installation. */
export type ApplicationRuntime = ManagedRuntime.ManagedRuntime<
  ApplicationServices,
  never
>;

/** Run an application effect and rethrow only at the protocol adapter boundary. */
export async function runApplicationEffect<A, E>(
  runtime: ApplicationRuntime,
  effect: Effect.Effect<A, E, ApplicationServices>,
): Promise<A> {
  const result = await runtime.runPromise(Effect.result(effect));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

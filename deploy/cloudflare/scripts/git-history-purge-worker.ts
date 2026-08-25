import {Effect} from "effect";
import type {D1Database} from "@cloudflare/workers-types";
import {z} from "zod";

import {createD1ArtifactRepository} from
  "../src/d1-artifact-repository.js";
import {D1GitHistoryProviderIdentityStore} from
  "../src/d1-git-history-provider-identity-store.js";
import {
  ArtifactsBindingGitHistoryProvider,
  type ArtifactsBinding,
} from "../src/artifacts-binding-git-history-provider.js";
import {
  applyGitHistoryPurge,
  planGitHistoryPurge,
} from "../../../src/git-history/git-history-purge.js";

interface PurgeEnvironment {
  readonly ARTIFACTS: ArtifactsBinding;
  readonly ARTIFACT_SERVER_ACCOUNT_ID: string;
  readonly ARTIFACT_SERVER_D1_DATABASE: D1Database;
  readonly ARTIFACT_SERVER_INSTALLATION_ID: string;
  readonly ARTIFACT_SERVER_NAMESPACE: string;
  readonly PURGE_KEY: string;
}

const purgeRequestSchema = z.object({
  confirmInstallationId: z.string().optional(),
  mode: z.enum(["apply", "plan"]),
}).strict();

/** Transient operator Worker; it is not part of the deployed application. */
export default {
  async fetch(request: Request, environment: PurgeEnvironment): Promise<Response> {
    if (
      request.method !== "POST" ||
      request.headers.get("Authorization") !== `Bearer ${environment.PURGE_KEY}`
    ) {
      return new Response(null, {status: 404});
    }
    const body = purgeRequestSchema.parse(await request.json());
    const store = createD1ArtifactRepository(
      environment.ARTIFACT_SERVER_D1_DATABASE,
      environment.ARTIFACT_SERVER_INSTALLATION_ID,
    );
    const identityStore = new D1GitHistoryProviderIdentityStore(
      environment.ARTIFACT_SERVER_D1_DATABASE,
      environment.ARTIFACT_SERVER_INSTALLATION_ID,
    );
    const persistedIdentity = await Effect.runPromise(identityStore.read());
    if (persistedIdentity === null) {
      return Response.json(
        {error: "This installation has no persisted Git provider identity."},
        {status: 409},
      );
    }
    if (body.mode === "plan") {
      return Response.json(await planGitHistoryPurge({
        installationId: environment.ARTIFACT_SERVER_INSTALLATION_ID,
        persistedIdentity,
        store,
      }));
    }
    const configuredIdentity = {
      accountId: environment.ARTIFACT_SERVER_ACCOUNT_ID,
      namespace: environment.ARTIFACT_SERVER_NAMESPACE,
      provider: "cloudflare-artifacts" as const,
    };
    const provider = new ArtifactsBindingGitHistoryProvider(environment.ARTIFACTS);
    return Response.json(await applyGitHistoryPurge({
      configuredIdentity,
      confirmInstallationId: body.confirmInstallationId ?? "",
      installationId: environment.ARTIFACT_SERVER_INSTALLATION_ID,
      persistedIdentity,
      provider,
      store,
    }));
  },
};

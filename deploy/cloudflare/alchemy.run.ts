import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

import {
  cloudflareDeploymentDocumentConfig,
  parseCloudflareDeploymentInput,
} from "./src/deployment-input.ts";
import { defineCloudflareFoundation } from "./src/stack.ts";

export default Alchemy.Stack(
  "artifact-server-cloudflare",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const document = yield* cloudflareDeploymentDocumentConfig;
    const input = yield* parseCloudflareDeploymentInput(document);
    const apiToken = yield* Config.redacted("ARTIFACT_SERVER_API_TOKEN");
    let workOsApiKey: Redacted.Redacted | undefined;
    if (input.workosApiKeySecretRef !== undefined) {
      workOsApiKey = yield* Config.redacted("ARTIFACT_SERVER_WORKOS_API_KEY");
    }
    return yield* defineCloudflareFoundation(
      input,
      apiToken,
      undefined,
      workOsApiKey,
    );
  }),
);

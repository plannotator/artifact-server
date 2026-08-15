import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

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
    return yield* defineCloudflareFoundation(input, apiToken);
  }),
);

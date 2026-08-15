import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import {
  cloudflareDeploymentDocumentConfig,
  parseCloudflareDeploymentInput,
} from "./src/deployment-input.js";
import { defineCloudflareFoundation } from "./src/stack.js";

export default Alchemy.Stack(
  "artifact-server-cloudflare",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const document = yield* cloudflareDeploymentDocumentConfig;
    const input = yield* parseCloudflareDeploymentInput(document);
    return yield* defineCloudflareFoundation(input);
  }),
);

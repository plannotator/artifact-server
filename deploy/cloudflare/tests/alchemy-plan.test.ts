import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Provider from "alchemy/Provider";
import * as Test from "alchemy/Test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";

import {
  type CloudflareZoneResolver,
  defineCloudflareFoundation,
} from "../src/stack.js";
import {
  validDeploymentInput,
  validDeploymentOutput,
} from "./fixtures.js";

const providerWriteAttempt = new Error(
  "A provider write was attempted during an Alchemy plan",
);
const writeForbidden = () => Effect.die(providerWriteAttempt);
const mismatchedZoneResolver: CloudflareZoneResolver = () =>
  Effect.succeed("f".repeat(32));
const unexpectedZoneResolver: CloudflareZoneResolver = () =>
  Effect.die(new Error("private ingress attempted a DNS zone lookup"));
type PlanWorker = Alchemy.Resource<
  "Cloudflare.Worker",
  object,
  object
>;
const PlanWorker = Alchemy.Resource<PlanWorker>("Cloudflare.Worker");

const databaseProvider = Provider.succeed(
  Cloudflare.D1.Database,
  {
    reconcile: writeForbidden,
    delete: writeForbidden,
  },
);
const bucketProvider = Provider.succeed(
  Cloudflare.R2.Bucket,
  {
    reconcile: writeForbidden,
    delete: writeForbidden,
  },
);
const workerProvider = Provider.succeed(
  PlanWorker,
  {
    reconcile: writeForbidden,
    delete: writeForbidden,
  },
);
const individualProviders = Layer.mergeAll(
  databaseProvider,
  bucketProvider,
  workerProvider,
);
const providerCollection = Layer.succeed(
  Cloudflare.Providers,
  Cloudflare.Providers.of({
    kind: "ProviderCollection",
    providers: {},
    get: () => undefined,
  }),
);
const cloudflareEnvironment = Layer.succeed(
  Cloudflare.CloudflareEnvironment,
  Effect.succeed({
    type: "apiToken",
    apiToken: Redacted.make("test-only-placeholder"),
    accountId: validDeploymentInput.cloudflareAccountId,
    source: {
      type: "env",
    },
  }),
);
const cloudflareCredentials = Layer.succeed(
  Cloudflare.Credentials,
  Effect.succeed({
    type: "apiToken",
    apiToken: Redacted.make("test-only-placeholder"),
    apiBaseUrl: "https://api.cloudflare.invalid/client/v4",
  }),
);
const providers = Layer.mergeAll(
  individualProviders,
  providerCollection,
  cloudflareEnvironment,
  cloudflareCredentials,
);
const options = {
  providers,
  state: Alchemy.inMemoryState(),
  stage: validDeploymentInput.stage,
  sidecar: false,
} satisfies Test.MakeOptions;

describe("Alchemy foundation plan", () => {
  it("plans named Worker, D1, and R2 without provider writes", async () => {
    const resolvedHostnames: string[] = [];
    const resolveZoneId: CloudflareZoneResolver = ({ hostname }) => {
      resolvedHostnames.push(hostname);
      return Effect.succeed(validDeploymentInput.dnsZoneId ?? "");
    };
    const scratch = Test.scratchStack(options, "foundation-plan");
    const plan = await Test.run(
      scratch.plan(
        defineCloudflareFoundation(
          validDeploymentInput,
          resolveZoneId,
        ),
      ),
      options,
    );
    const resources = Object.values(plan.resources);

    expect(resources).toHaveLength(3);
    expect(
      resources
        .map(({ resource }) => resource.Type)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual([
      "Cloudflare.D1Database",
      "Cloudflare.R2.Bucket",
      "Cloudflare.Worker",
    ]);
    expect(resources.every(({ action }) => action === "create")).toBe(
      true,
    );
    expect(resolvedHostnames).toEqual([
      validDeploymentInput.applicationDomain,
      validDeploymentInput.contentDomain,
    ]);
    expect(
      Object.keys(plan.output).toSorted((left, right) =>
        left.localeCompare(right)
      ),
    ).toEqual(
      Object.keys(validDeploymentOutput).toSorted((left, right) =>
        left.localeCompare(right)
      ),
    );
    expect(plan.output).toMatchObject({
      applicationUrl: "https://artifacts.example.com",
      contentDomain: "artifact-content.example.net",
      healthUrl: "https://artifacts.example.com/health",
      installationId: "review:development",
      mcpUrl: "https://artifacts.example.com/mcp",
      readinessUrl: "https://artifacts.example.com/ready",
      stateBackend: "cloudflare:alchemy-state-store",
    });

    const retained = resources
      .filter(({ resource }) =>
        resource.Type !== "Cloudflare.Worker"
      )
      .map(({ resource }) => resource.RemovalPolicy);
    expect(retained).toEqual(["retain", "retain"]);

    const worker = resources.find(
      ({ resource }) => resource.Type === "Cloudflare.Worker",
    );
    expect(worker?.resource.Props).toMatchObject({
      compatibility: {
        date: validDeploymentInput.compatibilityDate,
      },
      domain: {
        name: validDeploymentInput.applicationDomain,
        aliases: [validDeploymentInput.contentDomain],
      },
      workersDev: false,
    });
  });

  it("rejects a configured zone that does not own both domains", async () => {
    const scratch = Test.scratchStack(options, "zone-mismatch");

    await expect(
      Test.run(
        scratch.plan(
          defineCloudflareFoundation(
            validDeploymentInput,
            mismatchedZoneResolver,
          ),
        ),
        options,
      ),
    ).rejects.toThrow(
      "dnsZoneId does not match a domain zone inferred by Cloudflare",
    );
  });

  it("keeps private ingress off domains and workers.dev", async () => {
    const {
      dnsZoneId: _dnsZoneId,
      ...deploymentInputWithoutZone
    } = validDeploymentInput;
    const privateDeploymentInput = {
      ...deploymentInputWithoutZone,
      ingress: "private" as const,
    };
    const scratch = Test.scratchStack(options, "private-ingress");
    const plan = await Test.run(
      scratch.plan(
        defineCloudflareFoundation(
          privateDeploymentInput,
          unexpectedZoneResolver,
        ),
      ),
      options,
    );
    const worker = Object.values(plan.resources).find(
      ({ resource }) => resource.Type === "Cloudflare.Worker",
    );

    expect(worker?.resource.Props).not.toHaveProperty("domain");
    expect(worker?.resource.Props).toMatchObject({
      workersDev: false,
    });
  });
});

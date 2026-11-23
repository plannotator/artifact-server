import {Effect, Exit} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  ArtifactInsightsService,
  disabledArtifactInsightsLayer,
} from "../../src/application/artifact-insights.js";
import {principalKinds, membershipRoles} from "../../src/core/identity.js";
import {
  ApiClient,
  failureSchema,
  issueApiKey,
  MutableClock,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {publishNew, publishVersion, type PublishResponse} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const insightsSchema = z.object({
  insights: z.object({
    generatedAt: z.string(),
    overview: z.object({
      artifactCount: z.number(),
      projects: z.array(z.object({
        archived: z.boolean(),
        artifactCount: z.number(),
        latestVersionAt: z.string().nullable(),
        name: z.string(),
        projectId: z.string(),
        versionCount: z.number(),
      })),
      publicLinkCount: z.number(),
      recentArtifacts: z.array(z.object({
        artifactId: z.string(),
        latestVersionNumber: z.number(),
      }).loose()),
      tags: z.array(z.object({artifactCount: z.number(), tag: z.string()})),
      untaggedArtifactCount: z.number(),
      versionCount: z.number(),
      versionsInWindow: z.number(),
    }),
    projectId: z.string().nullable(),
    review: z.object({
      dispatches: z.record(z.string(), z.number()),
      dispatchesInWindow: z.number(),
      oldestOpenThreadAt: z.string().nullable(),
      openDispatchedThreads: z.number(),
      openThreads: z.number(),
      openThreadsByArtifact: z.array(z.object({
        artifactId: z.string(),
        openThreads: z.number(),
      }).loose()),
      repliesInWindow: z.number(),
      resolvedThreads: z.number(),
      threadsOpenedInWindow: z.number(),
      threadsResolvedInWindow: z.number(),
    }),
    since: z.string().nullable(),
    storage: z.object({
      distinctBlobCount: z.number(),
      fileCount: z.number(),
      gitHistory: z.object({
        committedBytes: z.number(),
        failingJobs: z.number(),
        pendingJobs: z.number(),
        projects: z.array(z.object({enabled: z.boolean(), projectId: z.string()}).loose()),
        reservedBytes: z.number(),
      }),
      growth: z.array(z.object({
        addedBytes: z.number(),
        cumulativeBytes: z.number(),
        day: z.string(),
        versions: z.number(),
      })),
      growthBucket: z.enum(["day", "week"]),
      largestArtifacts: z.array(z.object({
        artifactId: z.string(),
        logicalBytes: z.number(),
      }).loose()),
      logicalBytes: z.number(),
      storedBytes: z.number(),
    }),
    window: z.string(),
  }),
});
const activitySchema = z.object({
  items: z.array(z.object({
    actor: z.object({
      displayName: z.string().nullable(),
      kind: z.enum(["human", "service"]).nullable(),
      principalId: z.string(),
    }).nullable(),
    artifactId: z.string().nullable(),
    id: z.string(),
    kind: z.string(),
    occurredAt: z.string(),
    projectId: z.string(),
    versionNumber: z.number().nullable(),
  })),
  nextCursor: z.string().nullable(),
});

type Insights = z.infer<typeof insightsSchema>["insights"];
type ActivityEvent = z.infer<typeof activitySchema>["items"][number];

/** Same bytes in two artifacts: storage must count them once. */
const sharedContent = "<!doctype html><title>Shared</title><p>same bytes</p>";
const secondVersionContent = "<!doctype html><title>Alpha</title><p>second version</p>";
const deletedContent = "<!doctype html><title>Removed</title>";
const betaContent = "<!doctype html><title>Beta</title>";
const size = (content: string) => new TextEncoder().encode(content).byteLength;

/** Fail fixture setup with the server's own answer when a step is refused. */
async function requireStatus(
  response: Response,
  status: number,
  operation: string,
): Promise<void> {
  if (response.status !== status) {
    throw new Error(`${operation} answered ${response.status}: ${await response.text()}`);
  }
}

describe("dashboard insights", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableClock;
  let client: ApiClient;
  let alphaId: string;
  let betaId: string;
  let alphaFirst: PublishResponse;
  let alphaSecond: PublishResponse;
  let alphaShared: PublishResponse;
  let alphaDeleted: PublishResponse;
  let beta: PublishResponse;
  let openThreadId: string;
  let resolvedThreadId: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock("2026-01-01T10:00:00.000Z");
    server = await startTestServer(installation, {clock});
    client = new ApiClient(server, installation.apiToken);
    alphaId = await client.createProject("Alpha", "dashboard-insights-project-alpha");
    betaId = await client.createProject("Beta", "dashboard-insights-project-beta");

    // Forty days before "now": outside the default thirty-day window.
    alphaFirst = (await publishNew(server, installation, {
      accessSetting: "public_link",
      content: sharedContent,
      idempotencyKey: "dashboard-insights-alpha-first",
      name: "Alpha report",
      projectId: alphaId,
      tags: ["design", "review"],
    })).body;

    clock.advance(40 * 86_400_000);
    alphaShared = await step(async () => (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: sharedContent,
      idempotencyKey: "dashboard-insights-alpha-shared",
      name: "Alpha copy",
      projectId: alphaId,
      tags: ["design"],
    })).body);
    alphaSecond = await step(async () => (await publishVersion(server, installation, {
      artifactId: alphaFirst.artifact.id,
      content: secondVersionContent,
      expectedCurrentVersionId: alphaFirst.version.id,
      idempotencyKey: "dashboard-insights-alpha-second",
      projectId: alphaId,
    })).body);
    alphaDeleted = await step(async () => (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: deletedContent,
      idempotencyKey: "dashboard-insights-alpha-deleted",
      name: "Removed report",
      projectId: alphaId,
      tags: ["removed"],
    })).body);
    await step(async () => {
      const deleted = await fetch(
        `${server.baseUrl}/api/v1/artifacts/${alphaDeleted.artifact.id}?projectId=${alphaId}`,
        {
          body: JSON.stringify({expectedCurrentVersionId: alphaDeleted.version.id}),
          headers: apiHeaders(installation, "dashboard-insights-alpha-delete"),
          method: "DELETE",
        },
      );
      await requireStatus(deleted, 200, "Deleting the removed artifact");
    });
    beta = await step(async () => (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: betaContent,
      idempotencyKey: "dashboard-insights-beta",
      name: "Beta report",
      projectId: betaId,
    })).body);

    openThreadId = await step(async () =>
      (await client.openThread(alphaShared, "Still open.", "dashboard-insights-thread-open")).id
    );
    resolvedThreadId = await step(async () =>
      (await client.openThread(alphaShared, "Fixed.", "dashboard-insights-thread-resolved")).id
    );
    await step(async () => requireStatus(
      await client.setThreadState(alphaShared, resolvedThreadId, "resolved"),
      200,
      "Resolving a thread",
    ));
    await step(async () => {
      const reply = await client.fetch(
        `/api/v1/artifacts/${alphaShared.artifact.id}/comments/${openThreadId}/replies` +
          `?projectId=${alphaId}`,
        {
          body: JSON.stringify({body: "Looking at it."}),
          idempotencyKey: "dashboard-insights-thread-reply",
          method: "POST",
        },
      );
      await requireStatus(reply, 201, "Replying to a thread");
    });
    await step(() => client.openThread(beta, "Beta thread.", "dashboard-insights-thread-beta"));
    const agent = await step(() => client.registerAgent({
      connectionKey: "dashboard-insights-agent-connection",
      displayName: "site",
      workingDirectory: "/work/site",
    }));
    await step(async () => requireStatus(
      await client.sendDispatch({
        agentId: agent.id,
        idempotencyKey: "dashboard-insights-dispatch-send",
        projectId: alphaId,
        threadIds: [openThreadId],
      }),
      201,
      "Dispatching a thread",
    ));
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  /** Run one fixture step one second after the previous, so order is exact. */
  async function step<T>(operation: () => Promise<T>): Promise<T> {
    clock.advance(1_000);
    return operation();
  }

  async function readInsights(query: string): Promise<Insights> {
    const response = await client.fetch(`/api/v1/insights${query}`);
    expect(response.status).toBe(200);
    return insightsSchema.parse(await response.json()).insights;
  }

  async function readAllActivity(query: string, limit: number): Promise<ActivityEvent[]> {
    const events: ActivityEvent[] = [];
    let cursor: string | null = null;
    do {
      const suffix: string = cursor === null ? "" : `&cursor=${cursor}`;
      // Keyset paging is sequential: each request needs the previous cursor.
      // eslint-disable-next-line no-await-in-loop
      const response = await client.fetch(
        `/api/v1/insights/activity${query}&limit=${limit}${suffix}`,
      );
      expect(response.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const page = activitySchema.parse(await response.json());
      events.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return events;
  }

  test("DSH-001-B: the overview counts live artifacts, versions, recency, tags, and public links per project", async () => {
    expect.hasAssertions();
    const insights = await readInsights(`?projectId=${alphaId}`);
    expect(insights.window).toBe("30d");
    expect(insights.since).toBe("2026-01-12T00:00:00.000Z");
    expect(insights.overview).toEqual({
      artifactCount: 2,
      projects: [{
        archived: false,
        artifactCount: 2,
        latestVersionAt: alphaSecond.version.createdAt,
        name: "Alpha",
        projectId: alphaId,
        versionCount: 3,
      }],
      publicLinkCount: 1,
      recentArtifacts: [
        expect.objectContaining({artifactId: alphaFirst.artifact.id, latestVersionNumber: 2}),
        expect.objectContaining({artifactId: alphaShared.artifact.id, latestVersionNumber: 1}),
      ],
      tags: [{artifactCount: 2, tag: "design"}, {artifactCount: 1, tag: "review"}],
      untaggedArtifactCount: 0,
      versionCount: 3,
      versionsInWindow: 2,
    });

    const everything = await readInsights("?window=all");
    expect(everything.projectId).toBeNull();
    expect(everything.since).toBeNull();
    // The installation also holds its default project, which stays empty here.
    expect(everything.overview.projects.map((project) => project.projectId).toSorted())
      .toEqual(["prj_default", alphaId, betaId].toSorted());
    expect(everything.overview.artifactCount).toBe(3);
    expect(everything.overview.versionsInWindow).toBe(4);
    expect(everything.overview.untaggedArtifactCount).toBe(1);
  });

  test("DSH-001-F: deleted artifacts and other projects never reach a project's overview, and an unknown project is refused", async () => {
    expect.hasAssertions();
    const alpha = await readInsights(`?projectId=${alphaId}&window=all`);
    const listed = alpha.overview.recentArtifacts.map((artifact) => artifact.artifactId);
    expect(listed).not.toContain(alphaDeleted.artifact.id);
    expect(listed).not.toContain(beta.artifact.id);
    expect(alpha.overview.tags.map((tag) => tag.tag)).not.toContain("removed");
    expect(alpha.overview.versionCount).toBe(3);

    const betaOnly = await readInsights(`?projectId=${betaId}&window=all`);
    expect(betaOnly.overview.recentArtifacts.map((artifact) => artifact.artifactId))
      .toEqual([beta.artifact.id]);

    const unknown = await client.fetch(
      "/api/v1/insights?projectId=project_00000000-0000-4000-8000-00000000ffff",
    );
    expect(unknown.status).toBe(404);
    expect(failureSchema.parse(await unknown.json()).error.code).toBe("PROJECT_NOT_FOUND");
  });

  test("DSH-002-B: the review section reports unresolved, resolved, replied, and dispatched work inside the window", async () => {
    expect.hasAssertions();
    const insights = await readInsights(`?projectId=${alphaId}`);
    expect(insights.review).toEqual({
      dispatches: {addressed: 0, canceled: 0, claimed: 0, delivered: 0, failed: 0, queued: 1},
      dispatchesInWindow: 1,
      oldestOpenThreadAt: expect.any(String),
      openDispatchedThreads: 1,
      openThreads: 1,
      openThreadsByArtifact: [
        expect.objectContaining({artifactId: alphaShared.artifact.id, openThreads: 1}),
      ],
      repliesInWindow: 1,
      resolvedThreads: 1,
      threadsOpenedInWindow: 2,
      threadsResolvedInWindow: 1,
    });
  });

  test("DSH-002-F: review counts stay inside their project and fall out of a window that closed before them", async () => {
    expect.hasAssertions();
    const betaOnly = await readInsights(`?projectId=${betaId}`);
    expect(betaOnly.review.openThreads).toBe(1);
    expect(betaOnly.review.resolvedThreads).toBe(0);
    expect(betaOnly.review.dispatchesInWindow).toBe(0);
    expect(betaOnly.review.dispatches["queued"]).toBe(0);

    // Thirty-one days later the work is still open but no longer "in window".
    clock.advance(31 * 86_400_000);
    const later = await readInsights(`?projectId=${alphaId}`);
    expect(later.review.openThreads).toBe(1);
    expect(later.review.threadsOpenedInWindow).toBe(0);
    expect(later.review.threadsResolvedInWindow).toBe(0);
    expect(later.review.repliesInWindow).toBe(0);
    expect(later.review.dispatchesInWindow).toBe(0);
  });

  test("DSH-003-B: storage separates declared bytes from deduplicated bytes and draws daily growth from a baseline", async () => {
    expect.hasAssertions();
    const insights = await readInsights(`?projectId=${alphaId}`);
    const logical = size(sharedContent) * 2 + size(secondVersionContent) + size(deletedContent);
    expect(insights.storage.logicalBytes).toBe(logical);
    expect(insights.storage.storedBytes)
      .toBe(size(sharedContent) + size(secondVersionContent) + size(deletedContent));
    expect(insights.storage.fileCount).toBe(4);
    expect(insights.storage.distinctBlobCount).toBe(3);
    expect(insights.storage.growthBucket).toBe("day");
    expect(insights.storage.growth).toHaveLength(30);
    expect(insights.storage.growth[0]).toEqual({
      addedBytes: 0,
      cumulativeBytes: size(sharedContent),
      day: "2026-01-12",
      versions: 0,
    });
    expect(insights.storage.growth.at(-1)).toEqual({
      addedBytes: logical - size(sharedContent),
      cumulativeBytes: logical,
      day: "2026-02-10",
      versions: 3,
    });
    expect(insights.storage.largestArtifacts.map((artifact) => artifact.artifactId))
      .toEqual([alphaFirst.artifact.id, alphaShared.artifact.id]);
    expect(insights.storage.gitHistory).toEqual({
      committedBytes: 0,
      failingJobs: 0,
      pendingJobs: 0,
      projects: [expect.objectContaining({enabled: false, projectId: alphaId})],
      reservedBytes: 0,
    });
  });

  test("DSH-003-F: a long history folds into weekly buckets that still sum to every retained byte", async () => {
    expect.hasAssertions();
    clock.advance(120 * 86_400_000);
    const insights = await readInsights("?window=all");
    const total = size(sharedContent) * 2 + size(secondVersionContent) +
      size(deletedContent) + size(betaContent);
    expect(insights.storage.growthBucket).toBe("week");
    expect(insights.storage.growth[0]?.day).toBe("2026-01-01");
    expect(insights.storage.growth.reduce((sum, point) => sum + point.addedBytes, 0))
      .toBe(total);
    expect(insights.storage.growth.reduce((sum, point) => sum + point.versions, 0))
      .toBe(5);
    expect(insights.storage.growth.at(-1)?.cumulativeBytes).toBe(total);
    expect(insights.storage.logicalBytes).toBe(total);
  });

  test("DSH-004-B: activity merges artifact, comment, and dispatch changes newest first with stable cursor pages", async () => {
    expect.hasAssertions();
    const whole = await readAllActivity(`?projectId=${alphaId}&window=all`, 100);
    const paged = await readAllActivity(`?projectId=${alphaId}&window=all`, 3);
    expect(paged.map((event) => event.id)).toEqual(whole.map((event) => event.id));
    expect(new Set(whole.map((event) => event.id)).size).toBe(whole.length);
    const times = whole.map((event) => event.occurredAt);
    expect(times).toEqual([...times].toSorted().toReversed());

    expect(whole.map((event) => event.kind)).toEqual([
      "dispatch.sent",
      "comment.replied",
      "comment.resolved",
      "comment.opened",
      "comment.opened",
      "artifact.deleted",
      "artifact.published",
      "artifact.published",
      "artifact.published",
      "artifact.published",
    ]);
    const firstPublish = whole.at(-1);
    expect(firstPublish).toMatchObject({
      actor: {displayName: "Local", kind: "service", principalId: "local-api-token"},
      artifactId: alphaFirst.artifact.id,
      versionNumber: 1,
    });

    const inWindow = await readAllActivity(`?projectId=${alphaId}`, 100);
    expect(inWindow).toHaveLength(whole.length - 1);
  });

  test("DSH-004-F: activity never crosses projects and refuses malformed cursors and page sizes", async () => {
    expect.hasAssertions();
    const betaEvents = await readAllActivity(`?projectId=${betaId}&window=all`, 100);
    expect(betaEvents.every((event) => event.projectId === betaId)).toBe(true);
    expect(betaEvents.map((event) => event.kind)).toEqual([
      "comment.opened",
      "artifact.published",
    ]);

    const refusals = await Promise.all([
      "?cursor=not-a-cursor!",
      `?cursor=${Buffer.from("{\"x\":1}").toString("base64url")}`,
      "?limit=0",
      "?limit=101",
    ].map(async (query) => {
      const response = await client.fetch(`/api/v1/insights/activity${query}`);
      return {
        code: failureSchema.parse(await response.json()).error.code,
        status: response.status,
      };
    }));
    expect(refusals).toEqual(Array.from(
      {length: 4},
      () => ({code: "INVALID_INPUT", status: 422}),
    ));
  });

  test("DSH-005-B: an administrator session and a key that may read artifacts can both read the dashboard", async () => {
    expect.hasAssertions();
    const cookies = await signInAdministrator(server, installation);
    const browser = await fetch(`${server.baseUrl}/api/v1/insights?projectId=${alphaId}`, {
      headers: new Headers({
        Cookie: cookies.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      }),
    });
    expect(browser.status).toBe(200);
    expect(insightsSchema.parse(await browser.json()).insights.overview.artifactCount).toBe(2);

    const reader = new ApiClient(
      server,
      await issueApiKey(server, cookies, ["artifact:read"], "dashboard reader"),
    );
    expect((await reader.fetch(`/api/v1/insights?projectId=${alphaId}`)).status).toBe(200);
    expect((await reader.fetch(`/api/v1/insights/activity?projectId=${alphaId}`)).status)
      .toBe(200);
  });

  test("DSH-005-F: anonymous, under-privileged, malformed, and insights-less requests are refused", async () => {
    expect.hasAssertions();
    const dashboardRoutes = ["/api/v1/insights", "/api/v1/insights/activity"];
    const anonymous = await Promise.all(dashboardRoutes.map(async (pathname) =>
      (await fetch(`${server.baseUrl}${pathname}`)).status
    ));
    expect(anonymous).toEqual([401, 401]);

    const cookies = await signInAdministrator(server, installation);
    const agentOnly = new ApiClient(
      server,
      await issueApiKey(server, cookies, ["agent:connect"], "agent only"),
    );
    const denied = await Promise.all(dashboardRoutes.map(async (pathname) => {
      const response = await agentOnly.fetch(`${pathname}?projectId=${alphaId}`);
      return {
        code: failureSchema.parse(await response.json()).error.code,
        status: response.status,
      };
    }));
    expect(denied).toEqual(Array.from(
      {length: 2},
      () => ({code: "AUTHORIZATION_DENIED", status: 403}),
    ));

    const malformedWindow = await client.fetch("/api/v1/insights?window=1y");
    expect(malformedWindow.status).toBe(422);
    expect(failureSchema.parse(await malformedWindow.json()).error.code)
      .toBe("INVALID_INPUT");
    // A path-shaped project never selects storage; it is simply not a project.
    const traversal = await client.fetch("/api/v1/insights?projectId=../../etc");
    expect(traversal.status).toBe(404);
    expect(failureSchema.parse(await traversal.json()).error.code)
      .toBe("PROJECT_NOT_FOUND");

    // A deployment whose persistence lacks the insights queries answers the
    // stable capability-unavailable failure instead of guessing.
    const exit = await Effect.runPromiseExit(
      ArtifactInsightsService.use((service) =>
        service.readInsights({
          principal: {
            authorizedByPrincipalId: null,
            capabilities: [],
            displayName: "Reader",
            id: "member_reader",
            installationId: "local",
            kind: principalKinds.human,
            membershipRole: membershipRoles.member,
          },
          projectId: null,
          window: "30d",
        })
      ).pipe(Effect.provide(disabledArtifactInsightsLayer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("CapabilityUnavailable");
  });
});

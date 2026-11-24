import type {Context, Hono, MiddlewareHandler} from "hono";
import type {Effect} from "effect";
import {Redacted} from "effect";
import {z} from "zod";

import type {ApplicationServices} from "../application/application-runtime.js";
import {LinkedFolderService, type UpdateFolderLinkCommand} from "../application/linked-folders.js";
import {CapabilityUnavailable} from "../core/errors.js";
import type {HttpEnvironment} from "./create-http-app.js";
import {contentBootstrapBrowserUrl} from "./artifact-http-links.js";
import {
  acceptRelinkSchema, captureInventorySchema, folderLinkIdSchema, folderLinkProjection,
  folderLinkRevisionSchema, inventoryEntryIdSchema, inventoryEntryProjection, inventoryQuerySchema,
  linkFolderSchema, updateFolderLinkSchema,
} from "./folder-link-protocol.js";

/** Helpers owned by the HTTP application and lent to these routes. */
export interface FolderLinkRouteHelpers {
  readonly applicationUrl: (context: Context<HttpEnvironment>) => URL;
  readonly boundedJsonBody: MiddlewareHandler<HttpEnvironment>;
  readonly contentDomain: string;
  readonly enabled: boolean;
  readonly isLoopbackHostname: (hostname: string) => boolean;
  readonly run: <A, E>(context: Context<HttpEnvironment>, effect: Effect.Effect<A, E, ApplicationServices>) => Promise<A>;
}

const projectIdSchema = z.string().min(1).max(200);
const idempotencyKeySchema = z.string().min(16).max(200);

/**
 * Register the local-only linked-folder routes. Every route answers the stable
 * capability-unavailable shape unless the deployment enabled linked folders
 * and the request reached the loopback application origin (the LNK-006 rung).
 */
export function registerFolderLinkRoutes(
  app: Hono<HttpEnvironment>,
  helpers: FolderLinkRouteHelpers,
): void {
  const gate: MiddlewareHandler<HttpEnvironment> = async (context, next) => {
    const hostname = new URL(context.req.url).hostname;
    if (!helpers.enabled || !helpers.isLoopbackHostname(hostname)) {
      throw new CapabilityUnavailable({message: "Linked folders are not available on this deployment."});
    }
    await next();
  };
  const linkCommand = (context: Context<HttpEnvironment>) => ({
    folderLinkId: folderLinkIdSchema.parse(context.req.param("folderLinkId")),
    principal: context.get("principal"),
    projectId: optionalProject(context.req.query("projectId")),
  });

  app.get("/api/v1/projects/:projectId/folder-links", gate, async (context) => {
    const links = await helpers.run(context, LinkedFolderService.use((service) => service.listFolderLinks({
      principal: context.get("principal"),
      projectId: projectIdSchema.parse(context.req.param("projectId")),
    })));
    return context.json({folderLinks: links.map(folderLinkProjection)});
  });

  app.post("/api/v1/projects/:projectId/folder-links", gate, helpers.boundedJsonBody, async (context) => {
    const body = linkFolderSchema.strict().parse(await context.req.json());
    const link = await helpers.run(context, LinkedFolderService.use((service) => service.linkFolder({
      ...body,
      idempotencyKey: idempotencyKeySchema.parse(context.req.header("idempotency-key")),
      principal: context.get("principal"),
      projectId: projectIdSchema.parse(context.req.param("projectId")),
    })));
    return respond(context, link, 201);
  });

  app.get("/api/v1/folder-links/:folderLinkId", gate, async (context) => {
    const link = await helpers.run(context, LinkedFolderService.use((service) => service.getFolderLink(linkCommand(context))));
    return respond(context, link);
  });

  app.patch("/api/v1/folder-links/:folderLinkId", gate, helpers.boundedJsonBody, async (context) => {
    const body = updateFolderLinkSchema.strict().parse(await context.req.json());
    let command: UpdateFolderLinkCommand = {...linkCommand(context), expectedRevision: body.expectedRevision};
    if (body.ignore !== undefined) command = {...command, ignore: body.ignore};
    if (body.paused !== undefined) command = {...command, paused: body.paused};
    const update = command;
    const link = await helpers.run(context, LinkedFolderService.use((service) => service.updateFolderLink(update)));
    return respond(context, link);
  });

  app.delete("/api/v1/folder-links/:folderLinkId", gate, async (context) => {
    const expectedRevision = z.coerce.number().pipe(folderLinkRevisionSchema)
      .parse(context.req.query("expectedRevision"));
    const link = await helpers.run(context, LinkedFolderService.use((service) =>
      service.unlinkFolder({...linkCommand(context), expectedRevision})
    ));
    return respond(context, link);
  });

  app.post("/api/v1/folder-links/:folderLinkId/scan", gate, async (context) => {
    const link = await helpers.run(context, LinkedFolderService.use((service) => service.scanNow(linkCommand(context))));
    return respond(context, link);
  });

  app.get("/api/v1/folder-links/:folderLinkId/inventory", gate, async (context) => {
    const query = inventoryQuerySchema.parse(context.req.query());
    const page = await helpers.run(context, LinkedFolderService.use((service) => service.listInventory({
      ...linkCommand(context),
      cursor: query.cursor ?? null,
      limit: query.limit,
      pendingOnly: query.pending === "true",
      state: query.state ?? null,
    })));
    return context.json({entries: page.entries.map(inventoryEntryProjection), nextCursor: page.nextCursor});
  });

  app.post("/api/v1/folder-links/:folderLinkId/capture", gate, helpers.boundedJsonBody, async (context) => {
    const body = captureInventorySchema.parse(await context.req.json());
    const outcome = await helpers.run(context, LinkedFolderService.use((service) => service.captureInventory({
      ...linkCommand(context),
      entryIds: "all" in body ? "all-pending" : body.entryIds,
      idempotencyKey: idempotencyKeySchema.parse(context.req.header("idempotency-key")),
    })));
    return context.json({results: outcome.results});
  });

  app.get("/api/v1/folder-links/:folderLinkId/relink-suggestions", gate, async (context) => {
    const suggestions = await helpers.run(context, LinkedFolderService.use((service) =>
      service.suggestRelinks(linkCommand(context))
    ));
    return context.json({suggestions});
  });

  app.post("/api/v1/folder-links/:folderLinkId/relink", gate, helpers.boundedJsonBody, async (context) => {
    const body = acceptRelinkSchema.strict().parse(await context.req.json());
    const binding = await helpers.run(context, LinkedFolderService.use((service) => service.acceptRelink({
      ...linkCommand(context),
      ...body,
      idempotencyKey: idempotencyKeySchema.parse(context.req.header("idempotency-key")),
    })));
    return context.json({
      sourceBinding: {lastVerifiedAt: binding.lastVerifiedAt, path: binding.path, status: binding.freshness},
    });
  });

  app.post("/api/v1/folder-links/:folderLinkId/entries/:entryId/live-sessions", gate, async (context) => {
    const issued = await helpers.run(context, LinkedFolderService.use((service) => service.issueEntryLiveBootstrap({
      ...linkCommand(context),
      entryId: inventoryEntryIdSchema.parse(context.req.param("entryId")),
    })));
    return context.json({
      bootstrapUrl: contentBootstrapBrowserUrl(
        helpers.applicationUrl(context),
        helpers.contentDomain,
        issued.contentToken,
        Redacted.value(issued.token),
      ),
      expiresAt: issued.expiresAt,
    }, 201);
  });
}

function respond(
  context: Context<HttpEnvironment>,
  link: Parameters<typeof folderLinkProjection>[0],
  status: 200 | 201 = 200,
) {
  return context.json({folderLink: folderLinkProjection(link)}, status);
}

function optionalProject(value: string | undefined): string | null {
  return value === undefined ? null : projectIdSchema.parse(value);
}

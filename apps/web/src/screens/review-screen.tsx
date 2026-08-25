import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft01Icon,
  Cancel01Icon,
  Comment01Icon,
  File01Icon,
  FocusIcon,
  HistoryIcon,
  Link01Icon,
  Share01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { z } from "zod";

import {
  api,
  type AgentPresence,
  type Artifact,
  type ArtifactDetails,
  type ArtifactVersion,
  type CommentAnchor,
  type CommentThread,
  type CommentThreadQuery,
  type Manifest,
  type Project,
  type SourceBinding,
  type Version,
} from "@/api/client";
import { maximumCommentBodyCharacters } from "@/components/comments/comment-limits";
import {
  mergeThreads,
  threadWatermark,
  useCommentListOwnership,
  useCommentPoll,
} from "@/components/comments/comment-poll";
import { CommentThreadCard } from "@/components/comments/comment-thread-card";
import {
  bundleOfThreads,
  openVersionBundle,
} from "@/components/dispatch/dispatch-bundle";
import { DispatchSelectionBar } from "@/components/dispatch/dispatch-selection-bar";
import { useDispatchUndo } from "@/components/dispatch/dispatch-toast";
import { SendToAgentControl } from "@/components/dispatch/send-to-agent-dialog";
import {
  ErrorPanel,
  StatePanel,
  StatusBadge,
} from "@/components/product";
import { Button } from "@/components/ui/button";
import {
  errorMessage,
  sourceDriftDescription,
  sourceFreshnessLabel,
  sourceFreshnessTone,
} from "@/lib/presentation";
import { cn } from "@/lib/utils";
import {
  reviewAnchorSchema,
  reviewProtocolVersion,
  type HostMessage,
  type ReviewAnnotation,
} from "@/review-frame/protocol";

const threadPageSize = 100;

/**
 * The theme properties `@plannotator/ui` reads off the host root before it
 * builds the sandbox (`components/html-viewer/srcdoc.ts` THEME_TOKENS). They
 * are listed rather than imported so the management shell never pulls the
 * viewer package into its own bundle; the review frame owns that dependency.
 */
const reviewThemeTokens = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--success",
  "--success-foreground",
  "--warning",
  "--warning-foreground",
  "--border",
  "--input",
  "--ring",
  "--code-bg",
  "--focus-highlight",
  "--font-sans",
  "--font-mono",
  "--radius",
] as const;

const protocolVersionSchema = z.literal(reviewProtocolVersion);

/**
 * The anchor a submission carries, kept in the exact JSON the frame sent so the
 * thread stores the wire shape verbatim. The refinement holds it to the shape
 * the frame is allowed to produce, which also bounds every string in it.
 */
const submittedAnchorSchema = z.json().nullable().refine(
  (value) => value === null || reviewAnchorSchema.safeParse(value).success,
);

/**
 * Every message the review frame is allowed to send back. The frame is a
 * document this application serves, but it hosts artifact-authored markup, so
 * its reports are validated exactly like any other untrusted input.
 */
const frameMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("as-review-ready"),
    v: protocolVersionSchema,
  }),
  z.object({
    anchor: submittedAnchorSchema,
    body: z.string(),
    originalText: z.string(),
    type: z.literal("as-review-submit"),
    v: protocolVersionSchema,
  }),
  z.object({
    threadId: z.string().nullable(),
    type: z.literal("as-review-select"),
    v: protocolVersionSchema,
  }),
  z.object({
    threadIds: z.array(z.string()),
    type: z.literal("as-review-unanchored"),
    v: protocolVersionSchema,
  }),
]);

/** The one document this view renders and comments on. */
interface ReviewDocument {
  readonly baseHref: string | null;
  readonly entryPath: string;
  readonly html: string;
}

/**
 * What this version offers a reviewer: still being read, nothing that can be
 * annotated in place, or the one HTML entry the frame paints.
 */
type ReviewEntry =
  | { readonly kind: "absent" }
  | { readonly kind: "pending" }
  | { readonly document: ReviewDocument; readonly kind: "ready" };

/** One row in the artifact browser, projected from the project listing. */
interface ReviewArtifactListItem {
  readonly artifact: Artifact;
}

/** One saved version in the viewer's on-demand history. */
interface ReviewVersionListItem {
  readonly version: Version;
}

/** The one contextual surface the viewer may open beside the artifact. */
type ViewerPanel = "closed" | "comments" | "versions";

/** Every thread on this version; a poll narrows it to what changed since. */
function threadQuery(
  versionId: string,
  since: string | null,
): CommentThreadQuery {
  return {
    cursor: null,
    // Unset: the server hides the threads an active send carries, so a sent
    // annotation loses its pin here as soon as this listing comes back.
    dispatched: null,
    limit: threadPageSize,
    since,
    state: null,
    versionId,
  };
}

function isHtml(mediaType: string): boolean {
  return mediaType.split(";")[0]?.trim().toLowerCase() === "text/html";
}

/**
 * The HTML entry a reviewer sees: the version's own entry when it is HTML,
 * otherwise the first HTML file in the manifest. A version with none (an
 * image, a PDF, a data bundle) has nothing to annotate in place.
 */
function htmlEntryPath(manifest: Manifest): string | null {
  const declared = manifest.entries.find(
    (entry) => entry.path === manifest.entryPath,
  );
  if (declared !== undefined && isHtml(declared.mediaType)) return declared.path;
  return manifest.entries.find((entry) => isHtml(entry.mediaType))?.path ?? null;
}

/**
 * Where the sandbox resolves this version's relative sub-resources.
 *
 * Only a public link's current version answers unauthenticated requests on the
 * content domain, so only that version gets a base. Everything else keeps the
 * relative references it was published with, which the opaque-origin sandbox
 * cannot satisfy: the entry document still renders, its sub-resources do not.
 */
function contentBaseHref(
  details: ArtifactDetails,
  loaded: ArtifactVersion,
): string | null {
  const publicCurrent = details.artifact.accessSetting === "public_link"
    && details.artifact.currentVersionId === loaded.version.id;
  return publicCurrent ? loaded.links.version : null;
}

function readThemeTokens() {
  const style = getComputedStyle(document.documentElement);
  const entries = reviewThemeTokens
    .map<[string, string]>((token) => [
      token,
      style.getPropertyValue(token).trim().slice(0, 256),
    ])
    .filter((entry) => entry[1] !== "");
  return Object.fromEntries(entries);
}

/** One compact, labelled toolbar action. */
function ViewerIconButton({
  active = false,
  children,
  className,
  label,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children" | "size" | "variant"> & {
  readonly active?: boolean;
  readonly children: React.ReactNode;
  readonly label: string;
}) {
  return (
    <Button
      aria-label={label}
      className={cn("relative", className)}
      size="icon-lg"
      title={label}
      type="button"
      variant={active ? "secondary" : "ghost"}
      {...props}
    >
      {children}
    </Button>
  );
}

/**
 * The linked file's compact viewer status and the way into its live origin.
 *
 * Drift stays ambient (spec §4.1): the control reports it without placing a
 * blocking band between the reviewer and the immutable version.
 */
function LinkedSourceControl({
  binding,
  current,
  onOpenLive,
  opening,
}: {
  readonly binding: SourceBinding;
  readonly current: boolean;
  readonly onOpenLive: () => Promise<void>;
  readonly opening: boolean;
}) {
  const drifted = binding.status === "modified";
  const [open, setOpen] = useState(false);
  const panelId = "linked-source-state";
  return (
    <div className="relative">
      <Button
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={`Linked source: ${sourceFreshnessLabel(binding.status)}`}
        className="h-11 gap-2 px-2 tracking-normal normal-case"
        onClick={() => setOpen((value) => !value)}
        title="Linked source state"
        type="button"
        variant="ghost"
      >
        <HugeiconsIcon icon={Link01Icon} strokeWidth={1.8} />
        <span className="hidden lg:inline">
          {sourceFreshnessLabel(binding.status)}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            binding.status === "in-sync" ? "bg-primary" : "bg-destructive",
          )}
        />
      </Button>
      {open
        ? (
          <section
            aria-label="Linked file state"
            className="absolute top-full right-0 z-50 mt-2 w-[min(21rem,calc(100vw-1rem))] border bg-popover p-4 text-popover-foreground shadow-xl"
            id={panelId}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <StatusBadge tone={sourceFreshnessTone(binding.status)}>
                  {sourceFreshnessLabel(binding.status)}
                </StatusBadge>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  {sourceDriftDescription(binding.status, "captured")
                    ?? "This version was captured from a linked file on this machine."}
                </p>
              </div>
              <ViewerIconButton
                className="-mt-2 -mr-2"
                label="Close linked source state"
                onClick={() => setOpen(false)}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.8} />
              </ViewerIconButton>
            </div>
            <p className="mt-3 truncate font-mono text-xs text-muted-foreground" title={binding.path}>
              {binding.path}
            </p>
            {drifted
              ? (
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  {sourceDriftDescription(binding.status, "live")}
                </p>
              )
              : null}
            {current
              ? (
                <Button
                  className="mt-4"
                  disabled={opening}
                  onClick={() => void onOpenLive()}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  {opening ? "Opening…" : "Open live view"}
                </Button>
              )
              : null}
          </section>
        )
        : null}
    </div>
  );
}

/** Where one exact saved version is reviewed. */
function reviewHref(
  projectId: string,
  artifactId: string,
  versionId: string,
): string {
  return `/projects/${encodeURIComponent(projectId)}/artifacts/${
    encodeURIComponent(artifactId)
  }/versions/${encodeURIComponent(versionId)}/review`;
}

/** Project one stored thread into the record the review frame paints. */
function toAnnotation(thread: CommentThread): ReviewAnnotation {
  const parsed = reviewAnchorSchema.safeParse(thread.anchor);
  return {
    anchor: parsed.success ? parsed.data : null,
    body: thread.body,
    state: thread.state,
    threadId: thread.id,
  };
}

/**
 * Review one exact saved version of an HTML artifact.
 *
 * The version's bytes are read over the authenticated file route and handed to
 * the `/review-frame` document, which renders them inside an opaque-origin
 * sandbox and reports back where the reviewer clicked. This screen holds every
 * credential and makes every comment call; the frame holds none and makes none.
 */
export function ReviewScreen({
  artifactId,
  canComment,
  canManage,
  linkedArtifacts,
  principalId,
  project,
  versionId,
}: {
  readonly artifactId: string;
  readonly canComment: boolean;
  readonly canManage: boolean;
  /** Whether this deployment offers linked files at all (spec §4.3). */
  readonly linkedArtifacts: boolean;
  readonly principalId: string;
  readonly project: Project;
  readonly versionId: string;
}) {
  const [details, setDetails] = useState<ArtifactDetails | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<ArtifactVersion | null>(null);
  const [entry, setEntry] = useState<ReviewEntry>({ kind: "pending" });
  const [artifacts, setArtifacts] = useState<readonly ReviewArtifactListItem[]>([]);
  const [versions, setVersions] = useState<readonly ReviewVersionListItem[]>([]);
  const [threads, setThreads] = useState<readonly CommentThread[]>([]);
  const [agents, setAgents] = useState<readonly AgentPresence[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [unanchoredIds, setUnanchoredIds] = useState<readonly string[]>([]);
  const [frameReady, setFrameReady] = useState(false);
  const [openingLive, setOpeningLive] = useState(false);
  const [viewerPanel, setViewerPanel] = useState<ViewerPanel>("closed");
  const [focusMode, setFocusMode] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [navigationLoading, setNavigationLoading] = useState(true);
  const [navigationError, setNavigationError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const initialisedRef = useRef(false);
  const cardsRef = useRef(new Map<string, HTMLLIElement>());
  const watermarkRef = useRef<string | null>(null);
  const ownership = useCommentListOwnership();

  const readOnly = !canComment || project.archivedAt !== null;
  /**
   * Sending answers to the same authority as managing artifacts, and an
   * archived project takes no new work.
   */
  const canSend = canManage && project.archivedAt === null;

  /**
   * The linked file behind this artifact, when this deployment offers linked
   * files at all. Everywhere else there is no binding and no live affordance.
   */
  const binding: SourceBinding | null = linkedArtifacts
    ? (details?.sourceBinding ?? null)
    : null;
  const linked = binding !== null;

  const postToFrame = useCallback((message: HostMessage): void => {
    const frame = frameRef.current?.contentWindow;
    if (frame === null || frame === undefined) return;
    frame.postMessage(message, window.location.origin);
  }, []);

  const loadThreads = useCallback(
    (): Promise<void> =>
      ownership.own(async () => {
        const page = await api.comments(
          project.id,
          artifactId,
          threadQuery(versionId, null),
        );
        const listed = new Set(page.items.map((thread) => thread.id));
        setThreads(page.items);
        setSelectedIds((current) => current.filter((id) => listed.has(id)));
        setNow(Date.now());
      }),
    [artifactId, ownership, project.id, versionId],
  );

  /**
   * Ask only for what changed since the newest thread on screen and fold the
   * answer in, so a second reviewer's comment appears without a reload. A poll
   * that overlaps an owning write throws its answer away rather than undo it.
   */
  const pollThreads = useCallback(async (): Promise<void> => {
    // A linked file's freshness rides this same poll rather than a second one:
    // the artifact read refreshes the binding, so the drift indicator follows
    // the file on disk while the review stays open.
    if (linked) {
      try {
        setDetails(await api.artifact(project.id, artifactId));
      } catch {
        // A failed refresh changes nothing on screen; Reload reports for itself.
      }
    }
    const token = ownership.open();
    if (token < 0) return;
    try {
      const page = await api.comments(
        project.id,
        artifactId,
        threadQuery(versionId, watermarkRef.current),
      );
      if (page.items.length === 0 || !ownership.settled(token)) return;
      setThreads((current) => mergeThreads(current, page.items));
      setNow(Date.now());
    } catch {
      // A failed poll changes nothing on screen; Reload reports for itself.
    }
  }, [artifactId, linked, ownership, project.id, versionId]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      await ownership.own(async () => {
        // Threads need nothing but the ids the route already carries, so they
        // are asked for beside the artifact and the version rather than after.
        const threadsLoaded = loadThreads();
        const detailsLoaded = api.artifact(project.id, artifactId);
        const versionLoaded = api.version(project.id, artifactId, versionId);
        // The page's bytes need the manifest and nothing else, so they start
        // the moment the version lands instead of waiting on the rest.
        const documentLoaded = versionLoaded.then(async (version) => {
          const entryPath = htmlEntryPath(version.manifest);
          if (entryPath === null) return null;
          const html = await api.versionFile(
            project.id,
            artifactId,
            versionId,
            entryPath,
          );
          return { entryPath, html };
        });
        const [loadedDetails, version, loadedDocument] = await Promise.all([
          detailsLoaded,
          versionLoaded,
          documentLoaded,
          threadsLoaded,
        ]);
        setDetails(loadedDetails);
        setLoadedVersion(version);
        setEntry(
          loadedDocument === null ? { kind: "absent" } : {
            document: {
              baseHref: contentBaseHref(loadedDetails, version),
              entryPath: loadedDocument.entryPath,
              html: loadedDocument.html,
            },
            kind: "ready",
          },
        );
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Review loading failed."),
      );
      // A load that never reached a page leaves nothing to hand the frame, so
      // the panel that says so takes the place of the waiting frame.
      setEntry((current) => current.kind === "ready" ? current : { kind: "absent" });
    } finally {
      setLoading(false);
    }
  }, [artifactId, loadThreads, ownership, project.id, versionId]);

  const loadNavigation = useCallback(async (): Promise<void> => {
    setNavigationLoading(true);
    setNavigationError(null);
    try {
      const [artifactPage, loadedVersions] = await Promise.all([
        api.artifacts(project.id, null, ""),
        api.versions(project.id, artifactId),
      ]);
      setArtifacts(artifactPage.artifacts);
      setVersions(loadedVersions);
    } catch (caught) {
      setNavigationError(
        caught instanceof Error
          ? caught
          : new Error("Viewer navigation failed to load."),
      );
    } finally {
      setNavigationLoading(false);
    }
  }, [artifactId, project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadNavigation();
  }, [loadNavigation]);

  useEffect(() => {
    watermarkRef.current = threadWatermark(threads);
  }, [threads]);

  useCommentPoll(pollThreads, true);

  const undo = useDispatchUndo(project.id, loadThreads);

  /**
   * Presence rides the comment cadence, and only while the comments panel is
   * open: that is the one surface here that names an agent. Screens without
   * the panel keep the last known state.
   */
  const presenceLive = canSend && viewerPanel === "comments";
  const pollAgents = useCallback(async (): Promise<void> => {
    try {
      setAgents(await api.agentPresence());
      setNow(Date.now());
    } catch {
      // A failed presence read keeps the last known state on screen.
    }
  }, []);

  useCommentPoll(pollAgents, presenceLive);

  useEffect(() => {
    if (presenceLive) void pollAgents();
  }, [pollAgents, presenceLive]);

  // Resolving hides a thread's in-page marker; the side panel still lists it.
  const annotations = useMemo(
    () =>
      threads
        .filter((thread) => thread.state === "open")
        .map((thread) => toAnnotation(thread)),
    [threads],
  );

  const changeSelected = useCallback(
    (threadId: string, checked: boolean): void => {
      setSelectedIds((current) =>
        checked
          ? [...current, threadId]
          : current.filter((id) => id !== threadId)
      );
    },
    [],
  );

  const focusThread = useCallback((threadId: string | null): void => {
    setSelectedThreadId(threadId);
    postToFrame({
      threadId,
      type: "as-review-focus",
      v: reviewProtocolVersion,
    });
  }, [postToFrame]);

  const submitThread = useCallback(
    async (
      body: string,
      anchor: CommentAnchor,
      path: string,
    ): Promise<void> => {
      setError(null);
      try {
        await ownership.own(async () => {
          // One key for one completed compose action: a replayed delivery of
          // the same submission can never open a second thread.
          const created = await api.createComment(
            project.id,
            artifactId,
            versionId,
            { anchor, body, path },
            crypto.randomUUID(),
          );
          // A comment on a drifted linked file captures first (spec §4.5), so
          // the thread can land on a version this screen is not pinned to.
          // The response names it; the review follows it rather than showing a
          // version the new thread is not on.
          if (created.thread.versionId !== versionId) {
            window.location.assign(
              reviewHref(project.id, artifactId, created.thread.versionId),
            );
            return;
          }
          // The reloaded threads flow back into the frame through the
          // annotation sync below, which replaces the optimistic mark with the
          // stored one.
          await loadThreads();
        });
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught
            : new Error("Comment creation failed."),
        );
      }
    },
    [artifactId, loadThreads, ownership, project.id, versionId],
  );

  const entryPath = entry.kind === "ready" ? entry.document.entryPath : undefined;
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      const parsed = frameMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "as-review-ready") {
        setFrameReady(true);
        return;
      }
      if (message.type === "as-review-select") {
        setSelectedThreadId(message.threadId);
        if (message.threadId !== null) {
          setViewerPanel("comments");
        }
        return;
      }
      if (message.type === "as-review-unanchored") {
        setUnanchoredIds(message.threadIds);
        return;
      }
      if (entryPath === undefined) return;
      void submitThread(message.body, message.anchor, entryPath);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [entryPath, submitThread]);

  useEffect(() => {
    if (viewerPanel !== "comments" || selectedThreadId === null) return;
    cardsRef.current.get(selectedThreadId)?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedThreadId, threads, viewerPanel]);

  // The frame learns everything it renders from one init message, held until
  // both the frame has reported itself ready and this version's page has been
  // read: whichever lands last sends it. Later thread changes ride the
  // annotation sync.
  useEffect(() => {
    if (!frameReady || entry.kind !== "ready" || initialisedRef.current) return;
    initialisedRef.current = true;
    postToFrame({
      annotations,
      baseHref: entry.document.baseHref,
      entryPath: entry.document.entryPath,
      html: entry.document.html,
      isLight: !document.documentElement.classList.contains("dark"),
      readOnly,
      themeTokens: readThemeTokens(),
      type: "as-review-init",
      v: reviewProtocolVersion,
    });
  }, [annotations, entry, frameReady, postToFrame, readOnly]);

  useEffect(() => {
    if (!initialisedRef.current) return;
    postToFrame({
      annotations,
      type: "as-review-annotations",
      v: reviewProtocolVersion,
    });
  }, [annotations, postToFrame]);

  /**
   * Enter the artifact's own live origin. The exchange is the one a version's
   * content session already uses — a one-use bootstrap URL that trades itself
   * for the content cookie — and it opens in its own tab because the content
   * cookie is `SameSite=Strict`: an embedded frame on this origin would never
   * carry it.
   */
  const openLiveView = useCallback(async (): Promise<void> => {
    const popup = window.open("about:blank", "_blank");
    setOpeningLive(true);
    setError(null);
    try {
      const issued = await api.liveSession(project.id, artifactId);
      if (popup === null) {
        window.location.assign(issued.bootstrapUrl);
      } else {
        popup.opener = null;
        popup.location.replace(issued.bootstrapUrl);
      }
    } catch (caught) {
      popup?.close();
      setError(
        caught instanceof Error ? caught : new Error("Live view failed to open."),
      );
    } finally {
      setOpeningLive(false);
    }
  }, [artifactId, project.id]);

  const toggleViewerPanel = useCallback((panel: Exclude<ViewerPanel, "closed">) => {
    setViewerPanel((current) => current === panel ? "closed" : panel);
  }, []);

  const enterFocusMode = useCallback(() => {
    setViewerPanel("closed");
    setFocusMode(true);
  }, []);

  const copyReviewLink = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("Clipboard access is unavailable in this browser.");
      }
      await navigator.clipboard.writeText(window.location.href);
      setShareCopied(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught
          : new Error("Review link copying failed."),
      );
    }
  }, []);

  const artifactHref = `/projects/${encodeURIComponent(project.id)}/artifacts/${
    encodeURIComponent(artifactId)
  }`;

  const ready = details !== null && loadedVersion !== null;
  const versionLabel = loadedVersion === null
    ? "This version"
    : `Version ${loadedVersion.version.number}`;
  const frameTitle = details === null
    ? "Loading, annotated page"
    : `${details.artifact.name}, ${versionLabel}, annotated page`;
  const unanchored = new Set(unanchoredIds);
  const openThreads = threads.filter((thread) => thread.state === "open");
  /** Only an open annotation can join a bundle; the rest are already done. */
  const sendable = (thread: CommentThread) =>
    canSend && thread.state === "open";
  const selectedThreads = threads.filter((thread) =>
    selectedIds.includes(thread.id)
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {focusMode
        ? null
        : (
          <header className="relative z-30 flex h-11 shrink-0 items-center justify-between border-b bg-background">
            <div className="flex min-w-0 items-center">
              <Button
                aria-label="Back to artifact details"
                render={<a href={artifactHref} />}
                size="icon-lg"
                title="Back to artifact details"
                variant="ghost"
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={1.8} />
              </Button>
              <div className="min-w-0 px-2">
                <h1 className="truncate font-heading text-sm font-semibold tracking-tight">
                  {details?.artifact.name ?? "Loading artifact"}
                </h1>
                <p className="truncate text-[0.6875rem] text-muted-foreground">
                  {project.name} · {versionLabel}{details?.artifact.currentVersionId === versionId
                    ? " · Current"
                    : ""}
                </p>
              </div>
            </div>
            <div className="flex h-full shrink-0 items-center">
              {binding === null
                ? null
                : (
                  <LinkedSourceControl
                    binding={binding}
                    current={details?.artifact.currentVersionId === versionId}
                    onOpenLive={openLiveView}
                    opening={openingLive}
                  />
                )}
              <ViewerIconButton
                active={viewerPanel === "comments"}
                aria-controls="review-comments-panel"
                aria-expanded={viewerPanel === "comments"}
                label={`Comments — ${threads.length} ${threads.length === 1 ? "thread" : "threads"}`}
                onClick={() => toggleViewerPanel("comments")}
              >
                <HugeiconsIcon icon={Comment01Icon} strokeWidth={1.8} />
                {threads.length === 0
                  ? null
                  : (
                    <span
                      aria-hidden="true"
                      className="absolute top-1 right-0.5 grid min-w-3.5 place-items-center bg-primary px-0.5 font-mono text-[0.5rem] leading-3.5 text-primary-foreground"
                    >
                      {threads.length > 99 ? "99+" : threads.length}
                    </span>
                  )}
              </ViewerIconButton>
              <ViewerIconButton
                active={viewerPanel === "versions"}
                aria-controls="review-navigation-panel"
                aria-expanded={viewerPanel === "versions"}
                label="Browse artifacts and versions"
                onClick={() => toggleViewerPanel("versions")}
              >
                <HugeiconsIcon icon={HistoryIcon} strokeWidth={1.8} />
              </ViewerIconButton>
              <ViewerIconButton
                label={shareCopied ? "Review link copied" : "Copy review link"}
                onClick={() => void copyReviewLink()}
              >
                <HugeiconsIcon
                  icon={shareCopied ? Tick02Icon : Share01Icon}
                  strokeWidth={1.8}
                />
              </ViewerIconButton>
              <ViewerIconButton label="Enter focus mode" onClick={enterFocusMode}>
                <HugeiconsIcon icon={FocusIcon} strokeWidth={1.8} />
              </ViewerIconButton>
            </div>
          </header>
        )}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {focusMode
          ? (
            <Button
              className="absolute top-3 right-3 z-40 shadow-lg"
              onClick={() => setFocusMode(false)}
              size="sm"
              type="button"
              variant="default"
            >
              Exit focus mode
            </Button>
          )
          : null}

        {viewerPanel === "versions" && !focusMode
          ? (
            <aside
              aria-label="Browse artifacts and versions"
              className="absolute inset-y-0 left-0 z-20 flex w-[min(22rem,calc(100%-3rem))] flex-col border-r bg-background shadow-2xl lg:static lg:w-80 lg:shrink-0 lg:shadow-none"
              id="review-navigation-panel"
            >
              <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
                <h2 className="font-heading text-sm font-semibold">Browse</h2>
                <ViewerIconButton
                  label="Close artifact browser"
                  onClick={() => setViewerPanel("closed")}
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.8} />
                </ViewerIconButton>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <nav aria-label="Artifact shortcuts" className="border-b p-2">
                  <a
                    className="flex min-h-11 items-center gap-3 px-3 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    href={`/projects/${encodeURIComponent(project.id)}/artifacts`}
                  >
                    <HugeiconsIcon className="size-4" icon={File01Icon} strokeWidth={1.8} />
                    All artifacts
                  </a>
                  <a
                    className="flex min-h-11 items-center gap-3 px-3 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    href={artifactHref}
                  >
                    <HugeiconsIcon className="size-4" icon={Link01Icon} strokeWidth={1.8} />
                    Artifact details
                  </a>
                </nav>
                {navigationError === null
                  ? null
                  : (
                    <div className="p-3">
                      <ErrorPanel
                        error={navigationError}
                        onRetry={() => void loadNavigation()}
                      />
                    </div>
                  )}
                {navigationLoading
                  ? (
                    <p className="p-4 text-sm text-muted-foreground">
                      Loading artifacts and versions…
                    </p>
                  )
                  : (
                    <>
                      <p className="px-4 pt-5 pb-2 font-mono text-[0.625rem] font-semibold tracking-widest text-muted-foreground uppercase">
                        Project artifacts
                      </p>
                      <nav aria-label="Project artifacts">
                        {artifacts.map(({ artifact }) => (
                          <a
                            aria-current={artifact.id === artifactId ? "page" : undefined}
                            className={cn(
                              "grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                              artifact.id === artifactId && "bg-accent shadow-[inset_3px_0_0_var(--primary)]",
                            )}
                            href={reviewHref(project.id, artifact.id, artifact.currentVersionId)}
                            key={artifact.id}
                          >
                            <span className="truncate text-sm font-medium">{artifact.name}</span>
                            <span className="font-mono text-[0.625rem] text-muted-foreground">
                              {artifact.id === artifactId ? "Viewing" : "Open"}
                            </span>
                          </a>
                        ))}
                      </nav>
                      <p className="px-4 pt-5 pb-2 font-mono text-[0.625rem] font-semibold tracking-widest text-muted-foreground uppercase">
                        Version history
                      </p>
                      <nav aria-label="Version history">
                        {versions.map(({ version }) => (
                          <a
                            aria-current={version.id === versionId ? "page" : undefined}
                            className={cn(
                              "grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                              version.id === versionId && "bg-accent shadow-[inset_3px_0_0_var(--primary)]",
                            )}
                            href={reviewHref(project.id, artifactId, version.id)}
                            key={version.id}
                          >
                            <span>
                              <span className="block text-sm font-medium">
                                Version {version.number}
                              </span>
                              <time
                                className="block text-xs text-muted-foreground"
                                dateTime={version.createdAt}
                              >
                                {new Date(version.createdAt).toLocaleString()}
                              </time>
                            </span>
                            <span className="font-mono text-[0.625rem] text-muted-foreground">
                              {details?.artifact.currentVersionId === version.id
                                ? "Current"
                                : "Open"}
                            </span>
                          </a>
                        ))}
                      </nav>
                    </>
                  )}
              </div>
            </aside>
          )
          : null}

        <section className="relative min-w-0 flex-1 bg-background" id="artifact-viewer">
          {!ready
            ? (
              <div className="grid h-full place-items-center p-5">
                {error === null
                  ? (
                    <StatePanel
                      description="Reading this saved version and its comment threads."
                      title="Loading review"
                    />
                  )
                  : <ErrorPanel error={error} onRetry={() => void load()} />}
              </div>
            )
            : null}
          {entry.kind === "absent" && ready
            ? (
              <div className="grid h-full place-items-center p-5">
                <StatePanel
                  action={(
                    <Button render={<a href={artifactHref} />} variant="outline">
                      Open the Comments tab
                    </Button>
                  )}
                  description="This version holds no HTML file, so there is no page to annotate. Comment on the whole version from the artifact's Comments tab instead."
                  title="Nothing to review in place"
                />
              </div>
            )
            : null}
          {entry.kind === "absent"
            ? null
            : (
              // The frame is mounted from the first render, so its document and
              // bundle download beside the API reads rather than after them. It
              // stays hidden until this version's own page is ready to hand over.
              <div className={ready ? "h-full" : "hidden"}>
                <iframe
                  className="h-full w-full border-0"
                  ref={frameRef}
                  src="/review-frame"
                  title={frameTitle}
                />
              </div>
            )}
        </section>

        {viewerPanel === "comments" && !focusMode
          ? (
            <aside
              aria-label="Comment threads on this version"
              className="absolute inset-y-0 right-0 z-20 flex w-[min(24rem,calc(100%-3rem))] flex-col border-l bg-background shadow-2xl lg:static lg:w-96 lg:shrink-0 lg:shadow-none"
              id="review-comments-panel"
            >
              <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b py-1 pr-1 pl-4">
                <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                  {threads.length === 1 ? "1 thread" : `${threads.length} threads`}
                </h2>
                <div className="flex flex-wrap items-center gap-1">
                  {canSend && openThreads.length > 0
                    ? (
                      <SendToAgentControl
                        agents={agents}
                        feedback={undo.feedback}
                        label="Send all open"
                        onSent={loadThreads}
                        projectId={project.id}
                        resolveBundle={() =>
                          openVersionBundle(project.id, artifactId, versionId)}
                      />
                    )
                    : null}
                  <Button
                    disabled={loading}
                    onClick={() => void loadThreads()}
                    size="xs"
                    type="button"
                    variant="ghost"
                  >
                    Reload
                  </Button>
                  <ViewerIconButton
                    label="Close comments"
                    onClick={() => setViewerPanel("closed")}
                  >
                    <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.8} />
                  </ViewerIconButton>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {selectedThreads.length === 0
                  ? null
                  : (
                    <div className="border-b p-4">
                      <DispatchSelectionBar
                        agents={agents}
                        feedback={undo.feedback}
                        onClear={() => setSelectedIds([])}
                        onSent={loadThreads}
                        projectId={project.id}
                        threads={selectedThreads}
                      />
                    </div>
                  )}
                {threads.length === 0
                  ? (
                    <p className="p-5 text-sm leading-6 text-muted-foreground">
                      {readOnly
                        ? "Nobody has commented on this version yet."
                        : "Nobody has commented on this version yet. Click anything in the page to start a thread."}
                    </p>
                  )
                  : (
                    <ol>
                      {threads.map((thread) => (
                        <li
                          key={thread.id}
                          ref={(element) => {
                            if (element === null) {
                              cardsRef.current.delete(thread.id);
                              return;
                            }
                            cardsRef.current.set(thread.id, element);
                          }}
                        >
                          <CommentThreadCard
                            artifactId={artifactId}
                            canDeleteAny={canManage}
                            dispatch={null}
                            maximumBodyCharacters={maximumCommentBodyCharacters}
                            now={now}
                            onCancelDispatch={null}
                            onChanged={loadThreads}
                            onError={setError}
                            onShowInPage={() => focusThread(thread.id)}
                            principalId={principalId}
                            projectId={project.id}
                            selected={thread.id === selectedThreadId}
                            selection={sendable(thread)
                              ? {
                                checked: selectedIds.includes(thread.id),
                                onCheckedChange: (checked) =>
                                  changeSelected(thread.id, checked),
                              }
                              : null}
                            sendAction={sendable(thread)
                              ? (
                                <SendToAgentControl
                                  agents={agents}
                                  feedback={undo.feedback}
                                  label="Send to agent"
                                  onSent={loadThreads}
                                  oneAgentLabel={(name) => `Send to ${name}`}
                                  projectId={project.id}
                                  resolveBundle={() =>
                                    Promise.resolve(bundleOfThreads([thread]))}
                                />
                              )
                              : null}
                            thread={thread}
                            unanchored={unanchored.has(thread.id)}
                            versionLabel={versionLabel}
                          />
                        </li>
                      ))}
                    </ol>
                  )}
              </div>
            </aside>
          )
          : null}

        {error !== null && ready
          ? (
            <section
              className="absolute top-3 left-1/2 z-50 flex w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 items-center justify-between gap-4 border bg-popover p-3 text-sm text-popover-foreground shadow-xl"
              role="alert"
            >
              <p className="min-w-0 leading-5">{errorMessage(error)}</p>
              <Button className="shrink-0" onClick={() => void load()} size="xs" type="button" variant="outline">
                Reload
              </Button>
            </section>
          )
          : null}

        {undo.element}
      </div>
    </div>
  );
}

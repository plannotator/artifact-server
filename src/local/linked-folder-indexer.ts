import type {ApplicationRuntime} from "../application/application-runtime.js";
import {LinkedFolderService} from "../application/linked-folders.js";
import {
  reconciliationIntervalMilliseconds, watchHintDebounceMilliseconds,
} from "../core/folder-links.js";
import type {DirectoryWatch} from "./linked-directory-engine.js";

/**
 * The local linked-folder indexer (file-management-spec.md section 10.1).
 * It owns watchers, debounces hints, and schedules startup, hinted, and
 * periodic reconciliation scans. Hints are never facts: they only mark a link
 * dirty, and the scan through the application service is the single source
 * of truth. Scans write only inventory and binding freshness.
 */
export interface LinkedFolderIndexerOptions {
  readonly reconcileIntervalMilliseconds?: number;
  readonly watch: boolean;
  readonly watchDirectory: (path: string, onHint: () => void, onError: () => void) => DirectoryWatch;
}

interface LinkSchedule {
  dirty: boolean;
  hintAt: number;
  inFlight: boolean;
  lastScanAt: number;
  pathWatched: string | null;
  watch: DirectoryWatch | null;
  watchErrorAt: number;
}

const tickMilliseconds = 250;

function stopWatching(schedule: LinkSchedule): void {
  schedule.watch?.close();
  schedule.watch = null;
  schedule.pathWatched = null;
}

/** Start the indexer; resolves after every link is marked unverified for this process. */
export async function startLinkedFolderIndexer(
  runtime: ApplicationRuntime,
  options: LinkedFolderIndexerOptions,
): Promise<{close(): Promise<void>}> {
  await runtime.runPromise(LinkedFolderService.use((service) => service.startRuntime()));
  const startedAt = Date.now();
  const interval = options.reconcileIntervalMilliseconds ?? reconciliationIntervalMilliseconds;
  const schedules = new Map<string, LinkSchedule>();
  const running = new Set<Promise<void>>();
  let closed = false;
  let ticking = false;

  const scan = (folderLinkId: string, schedule: LinkSchedule) => {
    schedule.inFlight = true;
    schedule.dirty = false;
    const run = runtime.runPromise(LinkedFolderService.use((service) => service.reconcile(folderLinkId)))
      .then(() => undefined, () => undefined)
      .finally(() => {
        schedule.inFlight = false;
        schedule.lastScanAt = Date.now();
        running.delete(run);
      });
    running.add(run);
  };

  const tick = async () => {
    if (ticking || closed) return;
    ticking = true;
    try {
      const links = await runtime.runPromise(LinkedFolderService.use((service) => service.indexerLinks()));
      const present = new Set(links.map((link) => link.id));
      for (const [id, schedule] of schedules) {
        if (!present.has(id)) {
          stopWatching(schedule);
          schedules.delete(id);
        }
      }
      const now = Date.now();
      for (const link of links) {
        let schedule = schedules.get(link.id);
        if (schedule === undefined) {
          schedule = {
            dirty: true, hintAt: 0, inFlight: false, lastScanAt: 0, pathWatched: null, watch: null, watchErrorAt: 0,
          };
          schedules.set(link.id, schedule);
        }
        if (link.paused) {
          stopWatching(schedule);
          continue;
        }
        const completed = link.lastScanCompletedAt === null ? 0 : Date.parse(link.lastScanCompletedAt);
        // Watching starts only after this process verified the link, and a
        // failed watcher waits for one more successful scan before retrying.
        const verifiedHere = link.status !== "unavailable" && completed >= startedAt
          && completed > schedule.watchErrorAt;
        if (options.watch && verifiedHere && schedule.pathWatched !== link.path) {
          stopWatching(schedule);
          const tracked = schedule;
          tracked.pathWatched = link.path;
          tracked.watch = options.watchDirectory(link.path, () => {
            tracked.dirty = true;
            tracked.hintAt = Date.now();
          }, () => {
            stopWatching(tracked);
            tracked.watchErrorAt = Date.now();
            tracked.dirty = true;
            tracked.hintAt = Date.now();
          });
        } else if (!verifiedHere && schedule.watch !== null) {
          stopWatching(schedule);
        }
        if (schedule.inFlight) continue;
        const hinted = schedule.dirty && now - schedule.hintAt >= watchHintDebounceMilliseconds;
        const periodic = now - Math.max(schedule.lastScanAt, completed) >= interval;
        if (hinted || periodic) scan(link.id, schedule);
      }
    } catch {
      // A failed tick is retried on the next one; observation never blocks requests.
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => void tick(), tickMilliseconds);
  timer.unref();
  void tick();

  return {
    close: async () => {
      closed = true;
      clearInterval(timer);
      for (const schedule of schedules.values()) stopWatching(schedule);
      await Promise.all(running);
    },
  };
}

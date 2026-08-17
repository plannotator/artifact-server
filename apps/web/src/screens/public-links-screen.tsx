import {useEffect, useMemo, useState} from "react";

import {
  api,
  type MakePublicLinkPrivateItem,
  type PublicLinkItem,
  type PublicLinkMutationResult,
  type PublicLinkPage,
} from "@/api/client";
import {ErrorPanel, PageHeader, StatePanel, StatusBadge} from "@/components/product";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {Button} from "@/components/ui/button";
import {Checkbox} from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {formatTimestamp} from "@/lib/presentation";

const maximumBulkSize = 100;

type FailedMutationResult = Extract<
  PublicLinkMutationResult,
  {readonly status: "failed"}
>;

interface FailedMutation {
  readonly command: MakePublicLinkPrivateItem;
  readonly item: PublicLinkItem;
  readonly result: FailedMutationResult;
}

/** Administrator-only cross-project inventory and shutdown surface for public links. */
export function PublicLinksScreen() {
  const [pages, setPages] = useState<readonly PublicLinkPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [confirmation, setConfirmation] = useState<readonly PublicLinkItem[]>([]);
  const [failures, setFailures] = useState<readonly FailedMutation[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);

  const loadedItems = useMemo(
    () => pages.flatMap((page) => page.publicLinks),
    [pages],
  );
  const currentPage = pages[pageIndex] ?? null;
  const visibleItems = currentPage?.publicLinks ?? [];
  const selectedItems = loadedItems.filter((item) =>
    selectedKeys.has(selectionKey(item))
  );
  const fullyLoaded = pages.length > 0 && pages.at(-1)?.nextCursor === null;
  const allVisibleSelected = visibleItems.length > 0 && visibleItems.every((item) =>
    selectedKeys.has(selectionKey(item))
  );

  const loadFirstPage = async () => {
    setLoading(true);
    setError(null);
    try {
      const firstPage = await api.publicLinks(null);
      setPages([firstPage]);
      setPageIndex(0);
      setSelectedKeys(new Set());
      setFailures([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Public-link inventory failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadFirstPage();
  }, []);

  const showNextPage = async () => {
    const cached = pages[pageIndex + 1];
    if (cached !== undefined) {
      setPageIndex((current) => current + 1);
      return;
    }
    if (currentPage?.nextCursor === null || currentPage === null) return;
    setLoading(true);
    setError(null);
    try {
      const nextPage = await api.publicLinks(currentPage.nextCursor);
      setPages((current) => [...current, nextPage]);
      setPageIndex((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Public-link page failed."));
    } finally {
      setLoading(false);
    }
  };

  const selectItems = (items: readonly PublicLinkItem[], checked: boolean) => {
    setSelectionMessage(null);
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const item of items) {
        const key = selectionKey(item);
        if (!checked) {
          next.delete(key);
          continue;
        }
        if (next.size >= maximumBulkSize && !next.has(key)) {
          setSelectionMessage(
            `Bulk changes are limited to ${maximumBulkSize} public links. Clear part of the selection before adding more.`,
          );
          break;
        }
        next.add(key);
      }
      return next;
    });
  };

  const removeItems = (keys: ReadonlySet<string>) => {
    setPages((current) => current.map((page) => ({
      ...page,
      publicLinks: page.publicLinks.filter((item) => !keys.has(selectionKey(item))),
    })));
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  };

  const executeMutation = async (
    items: readonly PublicLinkItem[],
    commands: readonly MakePublicLinkPrivateItem[],
    retainedFailures: readonly FailedMutation[] = [],
  ) => {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.makePublicLinksPrivate(commands);
      const itemByKey = new Map(items.map((item) => [selectionKey(item), item]));
      const commandByKey = new Map(commands.map((command) => [commandKey(command), command]));
      const succeeded = new Set<string>();
      const nextFailures: FailedMutation[] = [...retainedFailures];
      for (const result of response.results) {
        const key = resultKey(result);
        if (result.status === "made_private") {
          succeeded.add(key);
          continue;
        }
        const item = itemByKey.get(key);
        const command = commandByKey.get(key);
        if (item === undefined || command === undefined) {
          throw new Error("A public-link mutation result did not match its bounded request.");
        }
        nextFailures.push({command, item, result});
      }
      removeItems(succeeded);
      setFailures(nextFailures);
      setSelectedKeys(new Set(nextFailures.map(({item}) => selectionKey(item))));
      if (response.summary.succeeded > 0) {
        setNotice(
          `${response.summary.succeeded} public ${response.summary.succeeded === 1 ? "link is" : "links are"} now private. ${response.warning}`,
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Making public links private failed."));
    } finally {
      setPending(false);
    }
  };

  const confirmMutation = async () => {
    const items = confirmation;
    setConfirmation([]);
    await executeMutation(items, items.map(makePrivateCommand));
  };

  const retryFailures = async () => {
    const retained = failures.filter(({result}) =>
      result.retry === "not_retryable"
    );
    const retryable = failures.filter(({result}) =>
      result.retry !== "not_retryable"
    );
    setPending(true);
    setError(null);
    try {
      const prepared = await Promise.all(retryable.map(async (failure) => {
        if (failure.result.retry === "same_command") return failure;
        const details = await api.artifact(
          failure.item.project.id,
          failure.item.artifact.id,
        );
        if (details.artifact.accessSetting === "account_required") {
          return {alreadyPrivate: failure.item} as const;
        }
        return {
          command: {
            ...failure.command,
            expectedCurrentVersionId: details.artifact.currentVersionId,
            idempotencyKey: crypto.randomUUID(),
          },
          item: {
            ...failure.item,
            artifact: details.artifact,
            currentVersion: details.current.version,
          },
        } as const;
      }));
      const alreadyPrivate = new Set(prepared.flatMap((entry) =>
        "alreadyPrivate" in entry ? [selectionKey(entry.alreadyPrivate)] : []
      ));
      removeItems(alreadyPrivate);
      const ready = prepared.flatMap((entry) =>
        "alreadyPrivate" in entry ? [] : [entry]
      );
      if (ready.length === 0) {
        setFailures(retained);
        if (alreadyPrivate.size > 0) {
          setNotice("The remaining public links were already private when their current state was refreshed.");
        }
        return;
      }
      await executeMutation(
        ready.map(({item}) => item),
        ready.map(({command}) => command),
        retained,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Retrying public links failed."));
    } finally {
      setPending(false);
    }
  };

  if (loading && pages.length === 0) {
    return (
      <StatePanel
        description="Loading active public links across every project."
        title="Loading public links"
      />
    );
  }
  if (error !== null && pages.length === 0) {
    return <ErrorPanel error={error} onRetry={() => void loadFirstPage()} />;
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        actions={(
          <Button onClick={() => void loadFirstPage()} type="button" variant="outline">
            Reload
          </Button>
        )}
        description="See every active artifact that currently allows public-link access, then make individual links or a bounded selection private."
        eyebrow="Administration"
        title="Public links"
      />

      {error === null ? null : <ErrorPanel error={error} onRetry={() => void loadFirstPage()} />}
      {notice === null ? null : (
        <Alert>
          <AlertTitle>Public access changed</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {failures.length === 0 ? null : (
        <Alert variant="destructive">
          <AlertTitle>
            {failures.length} {failures.length === 1 ? "link was" : "links were"} not changed
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-left text-sm">
              {failures.map(({item, result}) => (
                <li key={selectionKey(item)}>
                  {item.project.name} / {item.artifact.name}: {result.error.message}
                </li>
              ))}
            </ul>
            {failures.some(({result}) => result.retry !== "not_retryable")
              ? (
                <Button
                  className="mt-3"
                  disabled={pending}
                  onClick={() => void retryFailures()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {pending ? "Retrying…" : "Retry failed"}
                </Button>
              )
              : null}
          </AlertDescription>
        </Alert>
      )}

      {loadedItems.length === 0 && fullyLoaded
        ? (
          <StatePanel
            description="No active artifact in this installation currently allows public-link access."
            title="No public links"
          />
        )
        : (
          <>
            <section
              aria-label="Bulk selection"
              className="flex flex-col gap-3 border p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={visibleItems.length === 0}
                  onClick={() => selectItems(visibleItems, true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Select visible ({visibleItems.length})
                </Button>
                <Button
                  disabled={loadedItems.length === 0 || loadedItems.length > maximumBulkSize}
                  onClick={() => selectItems(loadedItems, true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {fullyLoaded ? "Select all" : "Select all loaded"} ({loadedItems.length})
                </Button>
                <Button
                  disabled={selectedKeys.size === 0}
                  onClick={() => setSelectedKeys(new Set())}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Clear selection
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-muted-foreground">
                  {selectedItems.length} selected · maximum {maximumBulkSize}
                </span>
                <Button
                  disabled={pending || selectedItems.length === 0}
                  onClick={() => setConfirmation(selectedItems)}
                  size="sm"
                  type="button"
                >
                  Make {selectedItems.length} private
                </Button>
              </div>
              <p className="basis-full text-xs leading-5 text-muted-foreground sm:order-3">
                {fullyLoaded
                  ? "All inventory pages are loaded, so Select all covers every listed public link."
                  : "More inventory pages exist. Select all loaded never includes pages you have not visited."}
                {loadedItems.length > maximumBulkSize
                  ? ` Select visible or choose up to ${maximumBulkSize} links for one bulk change.`
                  : ""}
              </p>
              {selectionMessage === null ? null : (
                <p className="basis-full text-sm text-destructive sm:order-4" role="alert">
                  {selectionMessage}
                </p>
              )}
            </section>

            <div className="overflow-x-auto border">
              <table className="w-full min-w-5xl border-collapse text-left text-sm">
                <thead className="border-b bg-muted/50 text-xs tracking-widest text-muted-foreground uppercase">
                  <tr>
                    <th className="w-12 px-4 py-3 font-semibold">
                      <Checkbox
                        aria-label="Select all visible public links"
                        checked={allVisibleSelected}
                        onCheckedChange={(checked) => selectItems(visibleItems, checked)}
                      />
                    </th>
                    <th className="px-4 py-3 font-semibold">Project</th>
                    <th className="px-4 py-3 font-semibold">Artifact</th>
                    <th className="px-4 py-3 font-semibold">Current version</th>
                    <th className="px-4 py-3 font-semibold">Public URL</th>
                    <th className="px-4 py-3 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.length === 0
                    ? (
                      <tr>
                        <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                          {currentPage?.nextCursor === null
                            ? "Every public link on this page is now private. Return to a previous page to inspect the remaining loaded links."
                            : "Every public link on this loaded page is now private. Continue to the next page to inspect older public links."}
                        </td>
                      </tr>
                    )
                    : visibleItems.map((item) => {
                    const selected = selectedKeys.has(selectionKey(item));
                    return (
                      <tr className="border-b last:border-b-0" key={selectionKey(item)}>
                        <td className="px-4 py-4 align-top">
                          <Checkbox
                            aria-label={`Select ${item.artifact.name}`}
                            checked={selected}
                            onCheckedChange={(checked) => selectItems([item], checked)}
                          />
                        </td>
                        <td className="px-4 py-4 align-top">
                          <p className="font-medium">{item.project.name}</p>
                          {item.project.archivedAt === null
                            ? null
                            : <StatusBadge>Archived</StatusBadge>}
                        </td>
                        <td className="max-w-xs px-4 py-4 align-top">
                          <a
                            className="font-heading font-semibold hover:underline"
                            href={`/projects/${encodeURIComponent(item.project.id)}/artifacts/${encodeURIComponent(item.artifact.id)}`}
                          >
                            {item.artifact.name}
                          </a>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Created {formatTimestamp(item.artifact.createdAt)}
                          </p>
                        </td>
                        <td className="px-4 py-4 align-top">
                          <p className="font-medium">Version {item.currentVersion.number}</p>
                          <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                            Saved {formatTimestamp(item.currentVersion.createdAt)}
                          </p>
                          <code className="mt-1 block max-w-48 truncate font-mono text-xs text-muted-foreground">
                            {item.currentVersion.id}
                          </code>
                        </td>
                        <td className="max-w-sm px-4 py-4 align-top">
                          <a
                            className="block truncate font-mono text-xs text-primary hover:underline"
                            href={item.links.public}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {item.links.public}
                          </a>
                        </td>
                        <td className="px-4 py-4 align-top">
                          <div className="flex justify-end gap-2">
                            <Button
                              render={<a href={item.links.public} rel="noreferrer" target="_blank" />}
                              size="xs"
                              variant="outline"
                            >
                              Open
                            </Button>
                            <Button
                              disabled={pending}
                              onClick={() => setConfirmation([item])}
                              size="xs"
                              type="button"
                              variant="ghost"
                            >
                              Make private
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                    })}
                </tbody>
              </table>
            </div>

            <nav aria-label="Public links pagination" className="flex items-center justify-between">
              <Button
                disabled={loading || pageIndex === 0}
                onClick={() => setPageIndex((current) => current - 1)}
                type="button"
                variant="outline"
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">Page {pageIndex + 1}</span>
              <Button
                disabled={loading || currentPage?.nextCursor === null}
                onClick={() => void showNextPage()}
                type="button"
                variant="outline"
              >
                {loading ? "Loading…" : "Next"}
              </Button>
            </nav>
          </>
        )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmation([]);
        }}
        open={confirmation.length > 0}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Make {confirmation.length} public {confirmation.length === 1 ? "link" : "links"} private?
            </DialogTitle>
            <DialogDescription>
              New requests to successful items will require an admitted account. Copies already
              downloaded or cached outside Artifact Server cannot be recalled.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm leading-6 text-muted-foreground">
            Each item is checked against the current version shown when you selected it. If an
            artifact changed, that item fails without changing its access and can be retried after
            refreshing its version.
          </p>
          <DialogFooter>
            <Button
              disabled={pending}
              onClick={() => setConfirmation([])}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() => void confirmMutation()}
              type="button"
            >
              {pending ? "Making private…" : "Make private"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function makePrivateCommand(item: PublicLinkItem): MakePublicLinkPrivateItem {
  return {
    artifactId: item.artifact.id,
    expectedCurrentVersionId: item.artifact.currentVersionId,
    idempotencyKey: crypto.randomUUID(),
    projectId: item.project.id,
  };
}

function selectionKey(item: PublicLinkItem): string {
  return `${item.project.id}\0${item.artifact.id}`;
}

function commandKey(command: MakePublicLinkPrivateItem): string {
  return `${command.projectId}\0${command.artifactId}`;
}

function resultKey(result: PublicLinkMutationResult): string {
  return `${result.projectId}\0${result.artifactId}`;
}

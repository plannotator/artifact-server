import {locale} from "@/i18n/locale";
import {serverErrorMessage} from "@/i18n/messages/common";
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
import {Button, ButtonLink} from "@/components/ui/button";
import {Checkbox} from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {settingsText} from "@/i18n/messages/settings";
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
      setError(caught instanceof Error ? caught : new Error(settingsText.publicLinks.inventoryFailed));
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
      setError(caught instanceof Error ? caught : new Error(settingsText.publicLinks.pageFailed));
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
          setSelectionMessage(settingsText.publicLinks.bulkLimit(maximumBulkSize));
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
          throw new Error(settingsText.publicLinks.resultMismatch);
        }
        nextFailures.push({command, item, result});
      }
      removeItems(succeeded);
      setFailures(nextFailures);
      setSelectedKeys(new Set(nextFailures.map(({item}) => selectionKey(item))));
      if (response.summary.succeeded > 0) {
        setNotice(settingsText.publicLinks.madePrivate(response.summary.succeeded, response.warning));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(settingsText.publicLinks.makePrivateFailed));
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
          setNotice(settingsText.publicLinks.alreadyPrivate);
        }
        return;
      }
      await executeMutation(
        ready.map(({item}) => item),
        ready.map(({command}) => command),
        retained,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(settingsText.publicLinks.retryFailedError));
    } finally {
      setPending(false);
    }
  };

  if (loading && pages.length === 0) {
    return (
      <StatePanel
        description={settingsText.publicLinks.loadingDescription}
        title={settingsText.publicLinks.loadingTitle}
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
            {settingsText.publicLinks.reload}
          </Button>
        )}
        description={settingsText.publicLinks.description}
        eyebrow={settingsText.publicLinks.eyebrow}
        title={settingsText.publicLinks.title}
      />

      {error === null ? null : <ErrorPanel error={error} onRetry={() => void loadFirstPage()} />}
      {notice === null ? null : (
        <Alert>
          <AlertTitle>{settingsText.publicLinks.noticeTitle}</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {failures.length === 0 ? null : (
        <Alert variant="destructive">
          <AlertTitle>
            {settingsText.publicLinks.notChanged(failures.length)}
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-left text-sm">
              {failures.map(({item, result}) => (
                <li key={selectionKey(item)}>
                  {item.project.name} / {item.artifact.name}: {locale === "en" ? result.error.message : serverErrorMessage(result.error.code) ?? result.error.message}
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
                  {pending ? settingsText.publicLinks.retrying : settingsText.publicLinks.retryFailed}
                </Button>
              )
              : null}
          </AlertDescription>
        </Alert>
      )}

      {loadedItems.length === 0 && fullyLoaded
        ? (
          <StatePanel
            description={settingsText.publicLinks.emptyDescription}
            title={settingsText.publicLinks.emptyTitle}
          />
        )
        : (
          <>
            <section
              aria-label={settingsText.publicLinks.bulkSelection}
              className="flex flex-col gap-3 rounded-[var(--radius-card)] border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={visibleItems.length === 0}
                  onClick={() => selectItems(visibleItems, true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {settingsText.publicLinks.selectVisible(visibleItems.length)}
                </Button>
                <Button
                  disabled={loadedItems.length === 0 || loadedItems.length > maximumBulkSize}
                  onClick={() => selectItems(loadedItems, true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {fullyLoaded
                    ? settingsText.publicLinks.selectAll(loadedItems.length)
                    : settingsText.publicLinks.selectAllLoaded(loadedItems.length)}
                </Button>
                <Button
                  disabled={selectedKeys.size === 0}
                  onClick={() => setSelectedKeys(new Set())}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {settingsText.publicLinks.clearSelection}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-muted-foreground">
                  {settingsText.publicLinks.selectedCount(selectedItems.length, maximumBulkSize)}
                </span>
                <Button
                  disabled={pending || selectedItems.length === 0}
                  onClick={() => setConfirmation(selectedItems)}
                  size="sm"
                  type="button"
                >
                  {settingsText.publicLinks.makeCountPrivate(selectedItems.length)}
                </Button>
              </div>
              <p className="basis-full text-xs leading-5 text-muted-foreground sm:order-3">
                {fullyLoaded
                  ? settingsText.publicLinks.fullyLoadedHint
                  : settingsText.publicLinks.partiallyLoadedHint}
                {loadedItems.length > maximumBulkSize
                  ? settingsText.publicLinks.overLimitHint(maximumBulkSize)
                  : ""}
              </p>
              {selectionMessage === null ? null : (
                <p className="basis-full text-sm text-destructive sm:order-4" role="alert">
                  {selectionMessage}
                </p>
              )}
            </section>

            <div className="as-public-links-inventory">
              <table aria-label={settingsText.publicLinks.tableLabel} className="as-public-links-table">
                <colgroup>
                  <col className="as-public-links-table__select-column" />
                  <col className="as-public-links-table__artifact-column" />
                  <col className="as-public-links-table__link-column" />
                  <col className="as-public-links-table__actions-column" />
                </colgroup>
                <thead className="border-b text-sm text-muted-foreground">
                  <tr>
                    <th className="as-public-links-table__select-cell font-medium">
                      <Checkbox
                        aria-label={settingsText.publicLinks.selectAllVisible}
                        checked={allVisibleSelected}
                        onCheckedChange={(checked) => selectItems(visibleItems, checked)}
                      />
                    </th>
                    <th className="font-medium">{settingsText.publicLinks.columnArtifact}</th>
                    <th className="font-medium">{settingsText.publicLinks.columnPublicLink}</th>
                    <th className="text-right font-medium">{settingsText.publicLinks.columnActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.length === 0
                    ? (
                      <tr className="as-public-links-table__empty-row">
                        <td className="text-center text-muted-foreground" colSpan={4}>
                          {currentPage?.nextCursor === null
                            ? settingsText.publicLinks.emptyLastPage
                            : settingsText.publicLinks.emptyLoadedPage}
                        </td>
                      </tr>
                    )
                    : visibleItems.map((item) => {
                    const selected = selectedKeys.has(selectionKey(item));
                    return (
                      <tr className="as-public-links-table__row" key={selectionKey(item)}>
                        <td className="as-public-links-table__select-cell">
                          <Checkbox
                            aria-label={settingsText.publicLinks.selectItem(item.artifact.name)}
                            checked={selected}
                            onCheckedChange={(checked) => selectItems([item], checked)}
                          />
                        </td>
                        <td className="as-public-links-table__artifact-cell">
                          <div className="as-public-links-table__artifact-heading">
                            <a
                              className="as-public-links-table__artifact-link"
                              href={`/review?${new URLSearchParams({
                                artifact: item.artifact.id,
                                project: item.project.id,
                              })}`}
                            >
                              {item.artifact.name}
                            </a>
                            {item.project.archivedAt === null
                              ? null
                              : <StatusBadge>{settingsText.publicLinks.archived}</StatusBadge>}
                          </div>
                          <p className="as-public-links-table__meta">{item.project.name}</p>
                        </td>
                        <td className="as-public-links-table__link-cell">
                          <a
                            className="as-public-links-table__url"
                            href={item.links.public}
                            rel="noreferrer"
                            target="_blank"
                            title={item.links.public}
                          >
                            {item.links.public}
                          </a>
                          <p className="as-public-links-table__meta">
                            <span>{settingsText.publicLinks.version(item.currentVersion.number)}</span>
                            <span aria-hidden="true"> · </span>
                            <span>{settingsText.publicLinks.saved(formatTimestamp(item.currentVersion.createdAt))}</span>
                          </p>
                        </td>
                        <td className="as-public-links-table__actions-cell">
                          <div className="as-public-links-table__actions">
                            <ButtonLink
                              href={item.links.public}
                              rel="noreferrer"
                              size="xs"
                              target="_blank"
                              variant="outline"
                            >
                              {settingsText.publicLinks.open}
                            </ButtonLink>
                            <Button
                              disabled={pending}
                              onClick={() => setConfirmation([item])}
                              size="xs"
                              type="button"
                              variant="ghost"
                            >
                              {settingsText.publicLinks.makePrivate}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                    })}
                </tbody>
              </table>
            </div>

            <nav aria-label={settingsText.publicLinks.pagination} className="flex items-center justify-between">
              <Button
                disabled={loading || pageIndex === 0}
                onClick={() => setPageIndex((current) => current - 1)}
                type="button"
                variant="outline"
              >
                {settingsText.publicLinks.previous}
              </Button>
              <span className="text-sm text-muted-foreground">{settingsText.publicLinks.page(pageIndex + 1)}</span>
              <Button
                disabled={loading || currentPage?.nextCursor === null}
                onClick={() => void showNextPage()}
                type="button"
                variant="outline"
              >
                {loading ? settingsText.publicLinks.loading : settingsText.publicLinks.next}
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
              {settingsText.publicLinks.confirmTitle(confirmation.length)}
            </DialogTitle>
            <DialogDescription>
              {settingsText.publicLinks.confirmDescription}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm leading-6 text-muted-foreground">
            {settingsText.publicLinks.confirmDetail}
          </p>
          <DialogFooter>
            <Button
              disabled={pending}
              onClick={() => setConfirmation([])}
              type="button"
              variant="outline"
            >
              {settingsText.publicLinks.cancel}
            </Button>
            <Button
              disabled={pending}
              onClick={() => void confirmMutation()}
              type="button"
            >
              {pending ? settingsText.publicLinks.makingPrivate : settingsText.publicLinks.makePrivate}
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

import type { ReactNode } from "react";

import { ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/presentation";
import { settingsText } from "@/i18n/messages/settings";

/** Primary heading and actions for a management screen. */
export function PageHeader({
  actions,
  description,
  eyebrow,
  title,
}: {
  readonly actions?: ReactNode;
  readonly description?: string;
  readonly eyebrow?: string;
  readonly title: string;
}) {
  return (
    <header className="flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="font-heading text-xl leading-tight font-semibold text-balance">
          {title}
        </h1>
        {/* The group a screen belongs to follows its title, never above it. */}
        {eyebrow === undefined ? null : (
          <p className="mt-1 text-sm text-muted-foreground">{eyebrow}</p>
        )}
        {description === undefined ? null : (
          <p className="mt-1.5 max-w-3xl text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
      )}
    </header>
  );
}

/** Intentional loading, empty, forbidden, and unavailable screen state. */
export function StatePanel({
  action,
  description,
  title,
}: {
  readonly action?: ReactNode;
  readonly description: string;
  readonly title: string;
}) {
  return (
    <section className="flex min-h-44 flex-col items-start justify-center rounded-[var(--radius-card)] border bg-card p-6">
      <h2 className="font-heading text-base font-semibold">{title}</h2>
      <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
        {description}
      </p>
      {action === undefined ? null : <div className="mt-5">{action}</div>}
    </section>
  );
}

/** Expected request failure with distinct authentication and permission treatment. */
export function ErrorPanel({
  error,
  onRetry,
}: {
  readonly error: Error;
  readonly onRetry?: () => void;
}) {
  const forbidden = error instanceof ApiError && error.status === 403;
  const conflict = error instanceof ApiError && (
    error.code === "ARTIFACT_MUTATION_CONFLICT"
    || error.code === "PUBLISH_CONFLICT"
  );
  const title = forbidden
    ? settingsText.product.permissionRequired
    : conflict
      ? settingsText.product.artifactChanged
      : settingsText.product.requestFailed;
  return (
    <StatePanel
      action={onRetry === undefined
        ? undefined
        : (
          <Button onClick={onRetry} type="button" variant="outline">
            {conflict ? settingsText.product.reloadArtifact : settingsText.product.tryAgain}
          </Button>
        )}
      description={errorMessage(error)}
      title={title}
    />
  );
}

/** Compact product status label. */
export function StatusBadge({
  children,
  tone = "neutral",
}: {
  readonly children: ReactNode;
  readonly tone?: "danger" | "neutral" | "primary";
}) {
  return (
    <Badge
      className={cn(
        "border px-1.5 py-0.5",
        tone === "neutral" && "border-border bg-[var(--color-paper-3)] text-[var(--color-ink-2)]",
        tone === "primary" && "border-[color-mix(in_oklab,var(--color-cool)_40%,transparent)] bg-[var(--color-cool-soft)] text-[var(--color-cool)]",
        tone === "danger" && "border-[color-mix(in_oklab,var(--color-bad)_40%,transparent)] bg-[var(--color-bad-soft)] text-[var(--color-bad)]",
      )}
      variant={tone === "danger" ? "destructive" : "secondary"}
    >
      {children}
    </Badge>
  );
}

/** Label-value metadata row that tolerates long identifiers. */
export function MetadataRow({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <div className="grid gap-1 border-b py-2.5 last:border-b-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

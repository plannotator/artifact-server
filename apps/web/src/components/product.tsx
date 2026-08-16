import type { ReactNode } from "react";

import { ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/presentation";

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
    <header className="flex flex-col gap-5 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow === undefined ? null : (
          <p className="mb-2 font-mono text-xs font-semibold tracking-widest text-primary uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="font-heading text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
          {title}
        </h1>
        {description === undefined ? null : (
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
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
    <section className="flex min-h-56 flex-col items-start justify-center border p-6 sm:p-8">
      <h2 className="font-heading text-lg font-semibold">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
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
    ? "Permission required"
    : conflict
      ? "Artifact changed"
      : "Request failed";
  return (
    <StatePanel
      action={onRetry === undefined
        ? undefined
        : (
          <Button onClick={onRetry} type="button" variant="outline">
            {conflict ? "Reload artifact" : "Try again"}
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
        tone === "primary" && "text-primary",
        tone === "danger" && "text-destructive",
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
    <div className="grid gap-1 border-b py-3 last:border-b-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

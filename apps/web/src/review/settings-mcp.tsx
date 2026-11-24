import {Copy01Icon, Tick02Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";
import {useEffect, useRef, useState} from "react";

import {PageHeader} from "@/components/product";
import {Button, ButtonLink} from "@/components/ui/button";
import {settingsText} from "@/i18n/messages/settings";

type CopyTarget = "doctor" | "local" | "remote" | "skill";

const copiedResetMilliseconds = 1_600;

/** Explain the supported local and team MCP connection paths for this installation. */
export function McpScreen({administrator}: {readonly administrator: boolean}) {
  const [copiedTarget, setCopiedTarget] = useState<CopyTarget | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mcpAddress = `${window.location.origin}/mcp`;

  useEffect(() => () => {
    if (copiedResetTimer.current !== null) clearTimeout(copiedResetTimer.current);
  }, []);

  const copy = async (value: string, target: CopyTarget): Promise<void> => {
    setFailure(null);
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("Clipboard access is unavailable in this browser.");
      }
      await navigator.clipboard.writeText(value);
      setCopiedTarget(target);
      if (copiedResetTimer.current !== null) clearTimeout(copiedResetTimer.current);
      copiedResetTimer.current = setTimeout(
        () => setCopiedTarget(null),
        copiedResetMilliseconds,
      );
    } catch {
      setCopiedTarget(null);
      setFailure(settingsText.mcp.copyFailed);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        description={settingsText.mcp.description}
        eyebrow={settingsText.mcp.eyebrow}
        title={settingsText.mcp.title}
      />

      {failure === null ? null : (
        <p className="rounded-[var(--radius-pill)] border border-destructive px-4 py-3 text-sm text-destructive" role="alert">
          {failure}
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <ConnectionCard
          description={settingsText.mcp.localDescription}
          eyebrow={settingsText.mcp.localEyebrow}
          title={settingsText.mcp.localTitle}
        >
          <CopyableValue
            copied={copiedTarget === "local"}
            label={settingsText.mcp.copyLocalCommand}
            onCopy={() => void copy("artifactserver connect", "local")}
            value="artifactserver connect"
          />
          <p className="text-xs leading-5 text-muted-foreground text-pretty">
            {settingsText.mcp.clientHintLead}<code>codex</code>{settingsText.mcp.clientHintSeparator}<code>claude</code>
            {settingsText.mcp.clientHintSeparator}<code>cursor</code>{settingsText.mcp.clientHintLastSeparator}<code>vscode</code>
            {settingsText.mcp.clientHintEnd}
          </p>
        </ConnectionCard>

        <ConnectionCard
          description={settingsText.mcp.remoteDescription}
          eyebrow={settingsText.mcp.remoteEyebrow}
          title={settingsText.mcp.remoteTitle}
        >
          <CopyableValue
            copied={copiedTarget === "remote"}
            label={settingsText.mcp.copyRemoteAddress}
            onCopy={() => void copy(mcpAddress, "remote")}
            value={mcpAddress}
          />
          <p className="text-xs leading-5 text-muted-foreground text-pretty">
            {settingsText.mcp.remoteHint}
          </p>
          {administrator ? (
            <ButtonLink className="justify-self-start" href="/review/settings/api-keys" size="xs" variant="outline">
              {settingsText.mcp.manageApiKeys}
            </ButtonLink>
          ) : null}
        </ConnectionCard>
      </div>

      <section className="grid gap-4 rounded-[var(--radius-card)] border bg-card p-5" aria-labelledby="mcp-after-connection">
        <header className="grid gap-1">
          <h2 className="font-heading text-base font-semibold text-balance" id="mcp-after-connection">
            {settingsText.mcp.checkHeading}
          </h2>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground text-pretty">
            {settingsText.mcp.checkDescription}
          </p>
        </header>
        <CopyableValue
          copied={copiedTarget === "doctor"}
          label={settingsText.mcp.copyCheckCommand}
          onCopy={() => void copy("artifactserver doctor", "doctor")}
          value="artifactserver doctor"
        />
        <p className="text-xs leading-5 text-muted-foreground text-pretty">
          {settingsText.mcp.disconnectLead}<code>artifactserver disconnect</code>{settingsText.mcp.disconnectEnd}
        </p>
      </section>

      <section className="grid gap-4 rounded-[var(--radius-card)] border bg-card p-5" aria-labelledby="mcp-agent-skill">
        <header className="grid gap-1">
          <h2 className="font-heading text-base font-semibold text-balance" id="mcp-agent-skill">
            {settingsText.mcp.skillHeading}
          </h2>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground text-pretty">
            {settingsText.mcp.skillDescription}
          </p>
        </header>
        <CopyableValue
          copied={copiedTarget === "skill"}
          label={settingsText.mcp.copySkillCommand}
          onCopy={() => void copy("npx skills add plannotator/artifact-server", "skill")}
          value="npx skills add plannotator/artifact-server"
        />
      </section>
    </div>
  );
}

function ConnectionCard({
  children,
  description,
  eyebrow,
  title,
}: {
  readonly children: React.ReactNode;
  readonly description: string;
  readonly eyebrow: string;
  readonly title: string;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border bg-card p-5">
      <header className="grid gap-1.5">
        <h2 className="font-heading text-base font-semibold text-balance">{title}</h2>
        <p className="text-sm text-muted-foreground">{eyebrow}</p>
        <p className="text-sm leading-6 text-muted-foreground text-pretty">{description}</p>
      </header>
      <div className="mt-auto grid gap-3">{children}</div>
    </section>
  );
}

function CopyableValue({
  copied,
  label,
  onCopy,
  value,
}: {
  readonly copied: boolean;
  readonly label: string;
  readonly onCopy: () => void;
  readonly value: string;
}) {
  return (
    <div className="flex min-w-0 items-stretch overflow-hidden rounded-[var(--radius-pill)] border bg-[var(--color-paper-3)]">
      <code className="min-w-0 flex-1 overflow-x-auto px-3 py-2.5 text-xs leading-5 whitespace-nowrap">
        {value}
      </code>
      <Button
        aria-label={copied ? settingsText.mcp.copied : label}
        className="h-auto shrink-0 rounded-none border-y-0 border-r-0"
        onClick={onCopy}
        size="sm"
        type="button"
        variant="outline"
      >
        <HugeiconsIcon
          aria-hidden="true"
          icon={copied ? Tick02Icon : Copy01Icon}
          strokeWidth={1.8}
        />
        {copied ? settingsText.mcp.copied : settingsText.mcp.copy}
      </Button>
    </div>
  );
}

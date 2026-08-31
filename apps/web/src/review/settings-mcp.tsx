import {Copy01Icon, Tick02Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";
import {useEffect, useRef, useState} from "react";

import {PageHeader} from "@/components/product";
import {Button, ButtonLink} from "@/components/ui/button";
import {WebmcpSettingsCard} from "./webmcp.tsx";

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
      setFailure("Unable to copy. Select the value and copy it manually.");
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        description="Give AI clients authenticated access to projects, artifacts, versions, and comments. Choose the setup that matches where Artifact Server runs."
        eyebrow="Connections"
        title="Connect agents with MCP"
      />

      {failure === null ? null : (
        <p className="border border-destructive px-4 py-3 text-sm text-destructive" role="alert">
          {failure}
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <ConnectionCard
          description="Run this on the computer where Artifact Server and your AI client are installed. It detects Codex, Claude Code, Cursor, or VS Code, updates the client configuration, and verifies the connection."
          eyebrow="Local installation"
          title="Connect automatically"
        >
          <CopyableValue
            copied={copiedTarget === "local"}
            label="Copy local connection command"
            onCopy={() => void copy("artifactserver connect", "local")}
            value="artifactserver connect"
          />
          <p className="text-xs leading-5 text-muted-foreground text-pretty">
            If more than one supported client is installed, add its name: <code>codex</code>,{" "}
            <code>claude</code>, <code>cursor</code>, or <code>vscode</code>.
          </p>
        </ConnectionCard>

        <ConnectionCard
          description="Add this exact address in your client’s MCP settings. The client should open browser sign-in when it connects."
          eyebrow="Team or remote server"
          title="Connect with the server address"
        >
          <CopyableValue
            copied={copiedTarget === "remote"}
            label="Copy MCP server address"
            onCopy={() => void copy(mcpAddress, "remote")}
            value={mcpAddress}
          />
          <p className="text-xs leading-5 text-muted-foreground text-pretty">
            If the client cannot use browser authentication, ask an administrator for a scoped
            API key. Never paste a key into chat.
          </p>
          {administrator ? (
            <ButtonLink className="justify-self-start" href="/review/settings/api-keys" size="xs" variant="outline">
              Manage API keys
            </ButtonLink>
          ) : null}
        </ConnectionCard>
      </div>

      <section className="grid gap-5 border p-5 sm:p-6" aria-labelledby="mcp-after-connection">
        <header className="grid gap-1">
          <h2 className="font-heading text-lg font-semibold text-balance" id="mcp-after-connection">
            Check the connection
          </h2>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground text-pretty">
            Inspect the managed service and client registration without changing either one.
          </p>
        </header>
        <CopyableValue
          copied={copiedTarget === "doctor"}
          label="Copy connection check command"
          onCopy={() => void copy("artifactserver doctor", "doctor")}
          value="artifactserver doctor"
        />
        <p className="text-xs leading-5 text-muted-foreground text-pretty">
          To remove a managed local connection, run <code>artifactserver disconnect</code>.
        </p>
      </section>

      <section className="grid gap-5 border p-5 sm:p-6" aria-labelledby="mcp-agent-skill">
        <header className="grid gap-1">
          <h2 className="font-heading text-lg font-semibold text-balance" id="mcp-agent-skill">
            Give agents the Artifact Server skill
          </h2>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground text-pretty">
            The optional skill teaches an agent to use MCP for server data and the CLI for files
            on its computer. Artifact bytes are never copied into MCP tool arguments.
          </p>
        </header>
        <CopyableValue
          copied={copiedTarget === "skill"}
          label="Copy skill installation command"
          onCopy={() => void copy("npx skills add plannotator/artifact-server", "skill")}
          value="npx skills add plannotator/artifact-server"
        />
      </section>

      <section className="grid gap-5 border p-5 sm:p-6" aria-labelledby="webmcp-tools">
        <header className="grid gap-1">
          <h2 className="font-heading text-lg font-semibold text-balance" id="webmcp-tools">
            Browser tools
          </h2>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground text-pretty">
            WebMCP is separate from the external coding-agent connection above. It exposes Review
            tools only to an AI agent running in this browser session.
          </p>
        </header>
        <WebmcpSettingsCard />
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
    <section className="flex flex-col gap-5 border p-5 sm:p-6">
      <header className="grid gap-2">
        <p className="font-mono text-xs font-semibold text-primary uppercase">{eyebrow}</p>
        <h2 className="font-heading text-xl font-semibold text-balance">{title}</h2>
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
    <div className="flex min-w-0 items-stretch border bg-muted/30">
      <code className="min-w-0 flex-1 overflow-x-auto px-3 py-2.5 text-xs leading-5 whitespace-nowrap">
        {value}
      </code>
      <Button
        aria-label={copied ? "Copied" : label}
        className="shrink-0 border-y-0 border-r-0"
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
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

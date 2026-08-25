import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Copy01Icon,
  File01Icon,
  Globe02Icon,
  SecurityLockIcon,
  Share01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Popover } from "@base-ui/react/popover";
import { useEffect, useRef, useState } from "react";

import {
  api,
  type AccessSetting,
  type ArtifactDetails,
} from "@/api/client";
import claudeLogoUrl from "./assets/agents/claude.svg";
import codexDarkLogoUrl from "./assets/agents/codex-dark.svg";
import codexLightLogoUrl from "./assets/agents/codex-light.svg";
import copilotDarkLogoUrl from "./assets/agents/copilot-dark.svg";
import copilotLightLogoUrl from "./assets/agents/copilot-light.svg";
import cursorDarkLogoUrl from "./assets/agents/cursor-dark.svg";
import cursorLightLogoUrl from "./assets/agents/cursor-light.svg";
import piLogoUrl from "./assets/agents/pi.svg";

type ShareScreen = "access" | "agents" | "overview";
type CopiedTarget = "agent-prompt" | "link" | "local-command" | "mcp-address";

const copiedResetMilliseconds = 1_600;

interface ReviewShareControlProps {
  readonly details: ArtifactDetails | null;
  readonly onArtifactChanged: (artifact: ArtifactDetails["artifact"]) => void;
  readonly triggerClassName: string;
}

/** Share one artifact from either the standard viewer header or focus controls. */
export function ReviewShareControl({
  details,
  onArtifactChanged,
  triggerClassName,
}: ReviewShareControlProps) {
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<ShareScreen>("overview");
  const [selectedAccess, setSelectedAccess] = useState<AccessSetting>(
    details?.artifact.accessSetting ?? "account_required",
  );
  const [pending, setPending] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState<CopiedTarget | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copiedResetTimer.current !== null) clearTimeout(copiedResetTimer.current);
  }, []);

  const updateOpen = (next: boolean): void => {
    if (pending && !next) return;
    setOpen(next);
    if (next) {
      setScreen("overview");
      setCopiedTarget(null);
      setFailure(null);
    }
  };

  const copyText = async (
    text: string,
    target: CopiedTarget,
    failureMessage: string,
  ): Promise<void> => {
    setFailure(null);
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("Clipboard access is unavailable in this browser.");
      }
      await navigator.clipboard.writeText(text);
      setCopiedTarget(target);
      if (copiedResetTimer.current !== null) clearTimeout(copiedResetTimer.current);
      copiedResetTimer.current = setTimeout(
        () => setCopiedTarget(null),
        copiedResetMilliseconds,
      );
    } catch (caught) {
      setCopiedTarget(null);
      setFailure(
        caught instanceof Error ? caught.message : failureMessage,
      );
    }
  };

  const copyLink = async (): Promise<void> => {
    if (details === null) return;
    await copyText(details.links.artifact, "link", "The artifact link could not be copied.");
  };

  const copyAgentPrompt = async (): Promise<void> => {
    if (details === null) return;
    await copyText(
      buildAgentReviewPrompt(details),
      "agent-prompt",
      "The agent review prompt could not be copied.",
    );
  };

  const openAccess = (): void => {
    if (details === null) return;
    setSelectedAccess(details.artifact.accessSetting);
    setFailure(null);
    setNotice(null);
    setScreen("access");
  };

  const saveAccess = async (): Promise<void> => {
    if (details === null) return;
    if (selectedAccess === details.artifact.accessSetting) {
      setScreen("overview");
      return;
    }
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      const changed = await api.changeAccess(
        details.artifact.projectId,
        details.artifact.id,
        details.artifact.currentVersionId,
        selectedAccess,
        crypto.randomUUID(),
      );
      onArtifactChanged(changed.artifact);
      setNotice(
        changed.warning ?? (
          selectedAccess === "public_link"
            ? "The current version can now be opened without signing in."
            : "This artifact now requires an admitted account."
        ),
      );
      setScreen("overview");
    } catch (caught) {
      setFailure(
        caught instanceof Error ? caught.message : "Artifact access could not be changed.",
      );
    } finally {
      setPending(false);
    }
  };

  const publicArtifact = details?.artifact.accessSetting === "public_link";
  const serverOrigin = details === null ? "" : new URL(details.links.artifact).origin;
  const mcpAddress = `${serverOrigin}/mcp`;

  return (
    <Popover.Root open={open} onOpenChange={updateOpen}>
      <Popover.Trigger
        render={(
          <button
            className={triggerClassName}
            disabled={details === null}
            type="button"
          />
        )}
      >
        <HugeiconsIcon aria-hidden="true" icon={Share01Icon} strokeWidth={1.8} />
        Share
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Backdrop className="as-share-backdrop" />
        <Popover.Positioner align="end" className="as-share-positioner" sideOffset={8}>
          <Popover.Popup aria-label="Share artifact" className="as-share-popover">
            {screen === "overview" ? (
              <header className="as-share-popover__header as-share-popover__header--artifact">
                <span aria-hidden="true" className="as-share-destination__icon">
                  <HugeiconsIcon icon={File01Icon} strokeWidth={1.8} />
                </span>
                <div>
                  <h2>{details?.artifact.name ?? "Artifact"}</h2>
                  <p>Current version · Version {details?.current.version.number ?? "—"}</p>
                </div>
                <button
                  aria-label="Close Share"
                  className="as-icon-button"
                  disabled={pending}
                  onClick={() => updateOpen(false)}
                  type="button"
                >
                  <HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} strokeWidth={1.8} />
                </button>
              </header>
            ) : (
              <header className="as-share-popover__header">
                <button
                  aria-label="Back to Share"
                  className="as-icon-button"
                  disabled={pending}
                  onClick={() => setScreen("overview")}
                  type="button"
                >
                  <HugeiconsIcon aria-hidden="true" icon={ArrowLeft01Icon} strokeWidth={1.8} />
                </button>
                <div>
                  <h2>{screen === "access" ? "Artifact access" : "Connect MCP"}</h2>
                  <p>{details?.artifact.name ?? "No artifact selected"}</p>
                </div>
                <button
                  aria-label="Close Share"
                  className="as-icon-button"
                  disabled={pending}
                  onClick={() => updateOpen(false)}
                  type="button"
                >
                  <HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} strokeWidth={1.8} />
                </button>
              </header>
            )}

            {screen === "overview" ? (
              <div className="as-share-overview">
                <section aria-labelledby="as-share-link-heading" className="as-share-link">
                  <h3 id="as-share-link-heading">Share this artifact</h3>
                  <div>
                    <code title={details?.links.artifact}>{details?.links.artifact ?? ""}</code>
                    <button
                      className="as-button as-button--primary"
                      disabled={details === null}
                      onClick={() => void copyLink()}
                      type="button"
                    >
                      <HugeiconsIcon
                        aria-hidden="true"
                        icon={copiedTarget === "link" ? Tick02Icon : Copy01Icon}
                        strokeWidth={1.8}
                      />
                      {copiedTarget === "link" ? "Copied" : "Copy link"}
                    </button>
                  </div>
                </section>

                <div className="as-share-access-summary">
                  <HugeiconsIcon
                    aria-hidden="true"
                    icon={publicArtifact ? Globe02Icon : SecurityLockIcon}
                    strokeWidth={1.8}
                  />
                  <p>
                    {publicArtifact
                      ? "Anyone with the link who can reach this server can open the current version."
                      : "Only people with access to this Artifact Server can open this link."}
                  </p>
                  <button
                    className="as-button"
                    disabled={details === null}
                    onClick={openAccess}
                    type="button"
                  >
                    Manage access
                  </button>
                </div>

                <section aria-labelledby="as-share-agent-heading" className="as-share-agent">
                  <h3 id="as-share-agent-heading">Review with an AI agent</h3>
                  <p>Copy one complete prompt into Claude, Codex, Cursor, GitHub Copilot, or Pi.</p>
                  <div className="as-share-agent__actions">
                    <button
                      className="as-share-agent__prompt"
                      disabled={details === null}
                      onClick={() => void copyAgentPrompt()}
                      type="button"
                    >
                      <AgentLogos />
                      <span>
                        {copiedTarget === "agent-prompt" ? "Prompt copied" : "Copy review prompt"}
                      </span>
                      <HugeiconsIcon
                        aria-hidden="true"
                        icon={copiedTarget === "agent-prompt" ? Tick02Icon : Copy01Icon}
                        strokeWidth={1.8}
                      />
                    </button>
                    <button
                      className="as-share-agent__setup"
                      disabled={details === null}
                      onClick={() => {
                        setFailure(null);
                        setScreen("agents");
                      }}
                      type="button"
                    >
                      Connect MCP
                      <HugeiconsIcon aria-hidden="true" icon={ArrowRight01Icon} strokeWidth={1.8} />
                    </button>
                  </div>
                </section>

                {failure === null ? null : (
                  <p className="as-share-message" data-tone="error" role="alert">{failure}</p>
                )}
                {notice === null ? null : (
                  <p className="as-share-message" data-tone="notice" role="status">{notice}</p>
                )}
              </div>
            ) : screen === "agents" ? (
              <div className="as-share-agent-setup">
                <p>Choose the connection that matches where Artifact Server is running.</p>

                <section>
                  <header>
                    <strong>On this computer</strong>
                    <span>Recommended for local use</span>
                  </header>
                  <p>Detect a supported client, install its private MCP connection, and verify it without copying a token.</p>
                  <CopyableAgentValue
                    copied={copiedTarget === "local-command"}
                    label="Copy local connection command"
                    onCopy={() => void copyText(
                      "artifactserver connect",
                      "local-command",
                      "The local connection command could not be copied.",
                    )}
                    value="artifactserver connect"
                  />
                </section>

                <section>
                  <header>
                    <strong>Team or remote server</strong>
                    <span>MCP</span>
                  </header>
                  <p>Add this server address to the agent. Compatible deployments open browser sign-in; other self-hosted deployments use an administrator-issued scoped key.</p>
                  <CopyableAgentValue
                    copied={copiedTarget === "mcp-address"}
                    label="Copy MCP server address"
                    onCopy={() => void copyText(
                      mcpAddress,
                      "mcp-address",
                      "The MCP server address could not be copied.",
                    )}
                    value={mcpAddress}
                  />
                </section>

                <section>
                  <header>
                    <strong>Without MCP</strong>
                    <span>HTTP API</span>
                  </header>
                  <p>The review prompt includes an exact authenticated API request for this version. Use a scoped API key from an administrator and never paste it into chat.</p>
                </section>

                {failure === null ? null : (
                  <p className="as-share-message" data-tone="error" role="alert">{failure}</p>
                )}
              </div>
            ) : (
              <div className="as-share-access-editor">
                <p>Choose who can open the current version from the stable artifact link.</p>
                <fieldset>
                  <legend className="as-visually-hidden">Who can open this artifact</legend>
                  <ShareAccessOption
                    checked={selectedAccess === "account_required"}
                    description="An admitted installation account is required."
                    disabled={pending}
                    label="Private"
                    onChange={() => setSelectedAccess("account_required")}
                    value="account_required"
                  />
                  <ShareAccessOption
                    checked={selectedAccess === "public_link"}
                    description="No sign-in. Anyone who can reach this server and has the link can open the current version."
                    disabled={pending}
                    label="Public link"
                    onChange={() => setSelectedAccess("public_link")}
                    value="public_link"
                  />
                </fieldset>
                <p className="as-share-network-note">
                  Public access does not create a tunnel, open a firewall, or make an unreachable server reachable.
                </p>
                {selectedAccess !== details?.artifact.accessSetting ? (
                  <p className="as-share-access-warning">
                    {selectedAccess === "public_link"
                      ? "The link can be redistributed. Earlier versions and history stay account-required."
                      : "Downloaded or externally cached copies cannot be recalled."}
                  </p>
                ) : null}
                {failure === null ? null : (
                  <p className="as-share-message" data-tone="error" role="alert">{failure}</p>
                )}
                <div className="as-share-access-editor__actions">
                  <button
                    className="as-button"
                    disabled={pending}
                    onClick={() => setScreen("overview")}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className="as-button as-button--primary"
                    disabled={
                      details === null
                      || pending
                      || selectedAccess === details.artifact.accessSetting
                    }
                    onClick={() => void saveAccess()}
                    type="button"
                  >
                    {pending ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            )}

            {screen === "overview" ? (
              <footer className="as-share-popover__footer">
                The link always opens Version {details?.current.version.number ?? "—"} until a newer version is published.
              </footer>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function AgentLogos() {
  return (
    <span
      aria-label="Claude, Codex, Cursor, GitHub Copilot, and Pi"
      className="as-agent-logos"
      role="img"
    >
      <span aria-hidden="true" className="as-agent-logo">
        <img alt="" src={claudeLogoUrl} />
      </span>
      <ThemedAgentLogo
        darkUrl={codexDarkLogoUrl}
        lightUrl={codexLightLogoUrl}
      />
      <ThemedAgentLogo
        darkUrl={cursorDarkLogoUrl}
        lightUrl={cursorLightLogoUrl}
      />
      <ThemedAgentLogo
        darkUrl={copilotDarkLogoUrl}
        lightUrl={copilotLightLogoUrl}
      />
      <span aria-hidden="true" className="as-agent-logo">
        <img alt="" src={piLogoUrl} />
      </span>
    </span>
  );
}

function ThemedAgentLogo({
  darkUrl,
  lightUrl,
}: {
  readonly darkUrl: string;
  readonly lightUrl: string;
}) {
  return (
    <span aria-hidden="true" className="as-agent-logo">
      <img alt="" data-agent-theme="dark" src={darkUrl} />
      <img alt="" data-agent-theme="light" src={lightUrl} />
    </span>
  );
}

function CopyableAgentValue({
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
    <div className="as-share-agent-value">
      <code title={value}>{value}</code>
      <button aria-label={label} onClick={onCopy} type="button">
        <HugeiconsIcon
          aria-hidden="true"
          icon={copied ? Tick02Icon : Copy01Icon}
          strokeWidth={1.8}
        />
      </button>
    </div>
  );
}

function buildAgentReviewPrompt(details: ArtifactDetails): string {
  const serverOrigin = new URL(details.links.artifact).origin;
  const apiUrl = new URL(
    `/api/v1/artifacts/${encodeURIComponent(details.artifact.id)}/versions/${encodeURIComponent(details.current.version.id)}`,
    serverOrigin,
  );
  apiUrl.searchParams.set("projectId", details.artifact.projectId);
  const manifestResource = `artifact://projects/${details.artifact.projectId}/artifacts/${details.artifact.id}/versions/${details.current.version.id}/manifest`;

  return `Review this Artifact Server artifact. Inspect the exact saved version below and do not silently substitute a newer version.

Artifact: ${details.artifact.name}
Project ID: ${details.artifact.projectId}
Artifact ID: ${details.artifact.id}
Version: ${details.current.version.number}
Version ID: ${details.current.version.id}
Access: ${details.artifact.accessSetting === "public_link" ? "public link" : "private"}
Stable link: ${details.links.artifact}
Exact version link: ${details.current.links.version}

Preferred path — Artifact Server MCP:
1. Call artifact_get with projectId "${details.artifact.projectId}" and artifactId "${details.artifact.id}".
2. Keep versionId "${details.current.version.id}" pinned. If artifact_get reports a different current version, use artifact_version_list and review the pinned version instead.
3. Read the exact manifest resource when available: ${manifestResource}
4. Use artifact_open with this project, artifact, and exact version when you need the rendered artifact.
5. Review the artifact and report findings in priority order. When comment tools are available, use comment_create against this exact version for precise, actionable findings.

If Artifact Server MCP is not connected:
- Local setup: run artifactserver connect, then retry with MCP.
- Remote or team setup: add ${serverOrigin}/mcp to the agent and complete browser sign-in, or use an administrator-issued scoped key when OAuth is unavailable.
- Direct HTTP fallback: GET ${apiUrl.toString()} with an admitted session or scoped API key.
- curl example: curl --fail-with-body --header "Authorization: Bearer $ARTIFACT_SERVER_API_KEY" '${apiUrl.toString()}'

Never paste credentials into chat, source files, or the review. If access fails, state which connection or permission is missing.`;
}

function ShareAccessOption({
  checked,
  description,
  disabled,
  label,
  onChange,
  value,
}: {
  readonly checked: boolean;
  readonly description: string;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: () => void;
  readonly value: AccessSetting;
}) {
  return (
    <label className="as-share-access-option" data-checked={checked}>
      <input
        checked={checked}
        disabled={disabled}
        name="review-artifact-access"
        onChange={onChange}
        type="radio"
        value={value}
      />
      <span aria-hidden="true" className="as-share-access-option__indicator" />
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

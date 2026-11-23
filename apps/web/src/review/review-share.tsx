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
  type ArtifactVersion,
} from "@/api/client";
import {reviewPartsText} from "@/i18n/messages/review-parts";
import claudeLogoUrl from "./assets/agents/claude.svg";
import codexDarkLogoUrl from "./assets/agents/codex-dark.svg";
import codexLightLogoUrl from "./assets/agents/codex-light.svg";
import copilotDarkLogoUrl from "./assets/agents/copilot-dark.svg";
import copilotLightLogoUrl from "./assets/agents/copilot-light.svg";
import cursorDarkLogoUrl from "./assets/agents/cursor-dark.svg";
import cursorLightLogoUrl from "./assets/agents/cursor-light.svg";
import opencodeDarkLogoUrl from "./assets/agents/opencode-dark.svg";
import opencodeLightLogoUrl from "./assets/agents/opencode-light.svg";
import piLogoUrl from "./assets/agents/pi.svg";
import piLightLogoUrl from "./assets/agents/pi-light.svg";

type ShareScreen = "access" | "agents" | "overview";
type CopiedTarget =
  | "agent-prompt"
  | "latest-link"
  | "local-command"
  | "mcp-address"
  | "raw-link"
  | "review-link";

const copiedResetMilliseconds = 1_600;
const shareText = reviewPartsText.share;

interface ReviewShareControlProps {
  readonly details: ArtifactDetails | null;
  readonly onArtifactChanged: (artifact: ArtifactDetails["artifact"]) => void;
  readonly selectedPath: string | null;
  readonly selectedVersion: ArtifactVersion | null;
  readonly triggerClassName: string;
}

/** Share one artifact from either the standard viewer header or focus controls. */
export function ReviewShareControl({
  details,
  onArtifactChanged,
  selectedPath,
  selectedVersion,
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
        throw new Error(shareText.failure.clipboardUnavailable);
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

  const reviewLink = selectedVersion === null
    ? null
    : exactReviewLink(selectedVersion, selectedPath);

  const copyReviewLink = async (): Promise<void> => {
    if (reviewLink === null) return;
    await copyText(
      reviewLink,
      "review-link",
      shareText.failure.reviewLink,
    );
  };

  const copyAgentPrompt = async (): Promise<void> => {
    if (details === null || selectedVersion === null || reviewLink === null) return;
    await copyText(
      buildAgentReviewPrompt(details, selectedVersion, reviewLink),
      "agent-prompt",
      shareText.failure.agentPrompt,
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
            ? shareText.nowPublic
            : shareText.nowPrivate
        ),
      );
      setScreen("overview");
    } catch (caught) {
      setFailure(
        caught instanceof Error ? caught.message : shareText.failure.access,
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
            aria-label={shareText.trigger}
            className={triggerClassName}
            disabled={details === null || selectedVersion === null}
            type="button"
          />
        )}
      >
        <HugeiconsIcon aria-hidden="true" icon={Share01Icon} strokeWidth={1.8} />
        <span className="as-button__label">{shareText.trigger}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Backdrop className="as-share-backdrop" />
        <Popover.Positioner align="end" className="as-share-positioner" sideOffset={8}>
          <Popover.Popup aria-label={shareText.popupLabel} className="as-share-popover">
            {screen === "overview" ? (
              <header className="as-share-popover__header as-share-popover__header--artifact">
                <span aria-hidden="true" className="as-share-destination__icon">
                  <HugeiconsIcon icon={File01Icon} strokeWidth={1.8} />
                </span>
                <div>
                  <h2>{details?.artifact.name ?? "Artifact"}</h2>
                  <p>{shareText.exactVersion(selectedVersion?.version.number ?? null)}</p>
                </div>
                <button
                  aria-label={shareText.close}
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
                  aria-label={shareText.back}
                  className="as-icon-button"
                  disabled={pending}
                  onClick={() => setScreen("overview")}
                  type="button"
                >
                  <HugeiconsIcon aria-hidden="true" icon={ArrowLeft01Icon} strokeWidth={1.8} />
                </button>
                <div>
                  <h2>{screen === "access" ? shareText.accessHeading : shareText.connectHeading}</h2>
                  <p>{details?.artifact.name ?? shareText.noArtifact}</p>
                </div>
                <button
                  aria-label={shareText.close}
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
                  <h3 id="as-share-link-heading">{shareText.reviewHeading}</h3>
                  <div>
                    <code title={reviewLink ?? undefined}>{reviewLink ?? ""}</code>
                    <button
                      className="as-button as-button--primary"
                      disabled={reviewLink === null}
                      onClick={() => void copyReviewLink()}
                      type="button"
                    >
                      <HugeiconsIcon
                        aria-hidden="true"
                        icon={copiedTarget === "review-link" ? Tick02Icon : Copy01Icon}
                        strokeWidth={1.8}
                      />
                      {copiedTarget === "review-link" ? shareText.copied : shareText.copyReviewLink}
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
                    {shareText.accessSummary}
                    {publicArtifact ? shareText.accessSummaryPublic : ""}
                  </p>
                  <button
                    className="as-button"
                    disabled={details === null}
                    onClick={openAccess}
                    type="button"
                  >
                    {shareText.manageAccess}
                  </button>
                </div>

                <section aria-labelledby="as-share-secondary-heading" className="as-share-secondary">
                  <h3 id="as-share-secondary-heading">{shareText.otherLinks}</h3>
                  <ShareSecondaryLink
                    copied={copiedTarget === "latest-link"}
                    description={shareText.latestDescription}
                    label={shareText.latestLabel}
                    onCopy={() => {
                      if (details !== null) {
                        void copyText(
                          details.links.artifact,
                          "latest-link",
                          shareText.failure.latestLink,
                        );
                      }
                    }}
                    value={details?.links.artifact ?? ""}
                  />
                  <ShareSecondaryLink
                    copied={copiedTarget === "raw-link"}
                    description={shareText.rawDescription}
                    label={shareText.rawLabel}
                    onCopy={() => {
                      if (selectedVersion !== null) {
                        void copyText(
                          selectedVersion.links.version,
                          "raw-link",
                          shareText.failure.rawLink,
                        );
                      }
                    }}
                    value={selectedVersion?.links.version ?? ""}
                  />
                </section>

                <section aria-labelledby="as-share-agent-heading" className="as-share-agent">
                  <h3 id="as-share-agent-heading">{shareText.agentHeading}</h3>
                  <p>{shareText.agentDescription}</p>
                  <div className="as-share-agent__actions">
                    <button
                      className="as-share-agent__prompt"
                      disabled={details === null || selectedVersion === null}
                      onClick={() => void copyAgentPrompt()}
                      type="button"
                    >
                      <AgentLogos />
                      <span>
                        {copiedTarget === "agent-prompt" ? shareText.promptCopied : shareText.copyPrompt}
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
                      {shareText.connectMcp}
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
                <p>{shareText.setupIntro}</p>

                <section>
                  <header>
                    <strong>{shareText.localHeading}</strong>
                    <span>{shareText.localBadge}</span>
                  </header>
                  <p>{shareText.localDescription}</p>
                  <CopyableAgentValue
                    copied={copiedTarget === "local-command"}
                    label={shareText.copyLocalCommand}
                    onCopy={() => void copyText(
                      "artifactserver connect",
                      "local-command",
                      shareText.failure.localCommand,
                    )}
                    value="artifactserver connect"
                  />
                </section>

                <section>
                  <header>
                    <strong>{shareText.remoteHeading}</strong>
                    <span>MCP</span>
                  </header>
                  <p>{shareText.remoteDescription}</p>
                  <CopyableAgentValue
                    copied={copiedTarget === "mcp-address"}
                    label={shareText.copyMcpAddress}
                    onCopy={() => void copyText(
                      mcpAddress,
                      "mcp-address",
                      shareText.failure.mcpAddress,
                    )}
                    value={mcpAddress}
                  />
                </section>

                <section>
                  <header>
                    <strong>{shareText.withoutMcpHeading}</strong>
                    <span><abbr title={shareText.httpApiTitle}>HTTP API</abbr></span>
                  </header>
                  <p>{shareText.withoutMcpDescription}</p>
                </section>

                {failure === null ? null : (
                  <p className="as-share-message" data-tone="error" role="alert">{failure}</p>
                )}
              </div>
            ) : (
              <div className="as-share-access-editor">
                <p>{shareText.accessIntro}</p>
                <fieldset>
                  <legend className="as-visually-hidden">{shareText.accessLegend}</legend>
                  <ShareAccessOption
                    checked={selectedAccess === "account_required"}
                    description={shareText.privateDescription}
                    disabled={pending}
                    label={shareText.privateLabel}
                    onChange={() => setSelectedAccess("account_required")}
                    value="account_required"
                  />
                  <ShareAccessOption
                    checked={selectedAccess === "public_link"}
                    description={shareText.publicDescription}
                    disabled={pending}
                    label={shareText.publicLabel}
                    onChange={() => setSelectedAccess("public_link")}
                    value="public_link"
                  />
                </fieldset>
                <p className="as-share-network-note">
                  {shareText.networkNote}
                </p>
                {selectedAccess !== details?.artifact.accessSetting ? (
                  <p className="as-share-access-warning">
                    {selectedAccess === "public_link"
                      ? shareText.publicWarning
                      : shareText.privateWarning}
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
                    {shareText.cancel}
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
                    {pending ? shareText.saving : shareText.save}
                  </button>
                </div>
              </div>
            )}

            {screen === "overview" ? (
              <footer className="as-share-popover__footer">
                {shareText.pinnedFooter(selectedVersion?.version.number ?? null, selectedPath)}
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
      aria-label={shareText.agentLogos}
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
      <ThemedAgentLogo darkUrl={piLogoUrl} lightUrl={piLightLogoUrl} />
      <ThemedAgentLogo
        darkUrl={opencodeDarkLogoUrl}
        lightUrl={opencodeLightLogoUrl}
      />
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

function ShareSecondaryLink({
  copied,
  description,
  label,
  onCopy,
  value,
}: {
  readonly copied: boolean;
  readonly description: string;
  readonly label: string;
  readonly onCopy: () => void;
  readonly value: string;
}) {
  return (
    <div className="as-share-secondary__row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <code title={value}>{value}</code>
      <button
        aria-label={shareText.copySecondaryLink(label)}
        className="as-icon-button"
        disabled={value === ""}
        onClick={onCopy}
        type="button"
      >
        <HugeiconsIcon
          aria-hidden="true"
          icon={copied ? Tick02Icon : Copy01Icon}
          strokeWidth={1.8}
        />
      </button>
    </div>
  );
}

function exactReviewLink(
  selectedVersion: ArtifactVersion,
  selectedPath: string | null,
): string {
  const reviewUrl = new URL(selectedVersion.links.review);
  reviewUrl.searchParams.set("view", "focus");
  if (
    selectedPath !== null
    && selectedVersion.manifest.entries.some((entry) => entry.path === selectedPath)
  ) {
    reviewUrl.searchParams.set("path", selectedPath);
  } else {
    reviewUrl.searchParams.delete("path");
  }
  return reviewUrl.toString();
}

function buildAgentReviewPrompt(
  details: ArtifactDetails,
  selectedVersion: ArtifactVersion,
  reviewLink: string,
): string {
  const serverOrigin = new URL(details.links.artifact).origin;
  const apiUrl = new URL(
    `/api/v1/artifacts/${encodeURIComponent(details.artifact.id)}/versions/${encodeURIComponent(selectedVersion.version.id)}`,
    serverOrigin,
  );
  apiUrl.searchParams.set("projectId", details.artifact.projectId);
  const manifestResource = `artifact://projects/${details.artifact.projectId}/artifacts/${details.artifact.id}/versions/${selectedVersion.version.id}/manifest`;

  return `Review this Artifact Server artifact. Inspect the exact saved version below and do not silently substitute a newer version.

Artifact: ${details.artifact.name}
Project ID: ${details.artifact.projectId}
Artifact ID: ${details.artifact.id}
Version: ${selectedVersion.version.number}
Version ID: ${selectedVersion.version.id}
Access: ${details.artifact.accessSetting === "public_link" ? "public link" : "private"}
Review and comment: ${reviewLink}
Raw exact version: ${selectedVersion.links.version}
Moving latest link: ${details.links.artifact}

Preferred path — Artifact Server MCP:
1. Call artifact_get with projectId "${details.artifact.projectId}" and artifactId "${details.artifact.id}".
2. Keep versionId "${selectedVersion.version.id}" pinned. If artifact_get reports a different current version, use artifact_version_list and review the pinned version instead.
3. Read the exact manifest resource when available: ${manifestResource}
4. Use artifact_open.reviewUrl for the full-screen Review experience. Use artifact_open.browserUrl only when you need the raw rendered artifact.
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

/**
 * The server-side copy of the agent-bridge bundle render contract.
 *
 * `@plannotator/agent-bridge` owns the canonical template and sanitization
 * for bundle messages, but the server cannot import that client package:
 * the compiled server build is rooted at `src/`, and the package's own
 * conformance gate (BRP-001-F) forbids its module graph from reaching out
 * of the published `@plannotator/agent-bridge` package. So the mailbox tier carries this exact
 * mirror, and BRP-002-B pins the two renders byte-for-byte against the
 * same bundle — any drift between the copies fails that test.
 */

/**
 * Bidirectional controls (U+202A–202E, U+2066–2069) and zero-width or
 * otherwise invisible characters (U+200B–200F, U+2060, U+FEFF) that hostile
 * comment text could use to reorder or hide what the reading agent sees.
 */
const invisibleDirectivePattern =
  /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\uFEFF]/gu;

/**
 * Strip bidirectional-override and invisible Unicode from one piece of
 * untrusted text before it is composed into a bundle message. Pure and
 * idempotent; every visible character passes through unchanged.
 */
export function sanitizeBundleText(text: string): string {
  return text.replace(invisibleDirectivePattern, "");
}

// ---------------------------------------------------------------------------
// Bundle rendering
// ---------------------------------------------------------------------------

/** Longest quoted selection the rendered message reproduces. */
export const maximumQuotedSelectionCharacters = 300;

/** One rendered line item of a bundle. */
export interface BundleItem {
  readonly artifactName: string;
  readonly body: string;
  readonly path: string | null;
  readonly quotedSelection: string | null;
  readonly threadId: string;
  readonly versionNumber: number;
}

/** Everything the message template needs, already fetched and ordered. */
export interface RenderableBundle {
  readonly items: readonly BundleItem[];
  readonly note: string | null;
  readonly senderDisplayName: string;
}

/** The comment-tool surface named in one rendered bundle. */
export type BundleRenderProfile = "mailbox" | "native";

const completionInstructions = {
  mailbox: [
    "When each item is done: use comment_reply to reply to its thread with what you did,",
    "then use comment_resolve to resolve it. Do not wait for confirmation.",
  ],
  native: [
    "When each item is done: use the artifact_comments tool to reply to its thread",
    "with what you did, then resolve it. Do not wait for confirmation.",
  ],
} as const satisfies Record<
  BundleRenderProfile,
  readonly [string, string]
>;

function quotedSelectionFragment(selection: string): string {
  const collapsed = sanitizeBundleText(selection).replace(/\s+/gu, " ").trim();
  const bounded = collapsed.length <= maximumQuotedSelectionCharacters
    ? collapsed
    : `${collapsed.slice(0, maximumQuotedSelectionCharacters - 1)}…`;
  return `"${bounded}"`;
}

/**
 * Render one bundle as one message in the recorded template. The message
 * always starts with the constant `Artifact Server:` prefix, so no rendered
 * message can ever begin with a slash and be intercepted as a host command,
 * and every untrusted field is stripped of bidirectional and invisible
 * Unicode before composition.
 *
 * @param bundle - The fetched, ordered bundle to render.
 * @param profile - The comment-tool surface available to the receiving agent.
 * @returns One sanitized message for the receiving agent.
 */
export function renderBundleMessage(
  bundle: RenderableBundle,
  profile: BundleRenderProfile = "native",
): string {
  const lines: string[] = [];
  lines.push(
    `Artifact Server: ${bundle.senderDisplayName} sent ` +
      `${bundle.items.length} annotation(s) to address.`,
  );
  const note = sanitizeBundleText(bundle.note ?? "").trim();
  if (note !== "") lines.push(note);
  lines.push("");
  bundle.items.forEach((item, index) => {
    const place = item.path === null
      ? `[${item.artifactName} · version ${item.versionNumber}]`
      : `[${item.artifactName} · version ${item.versionNumber} · ${item.path}]`;
    const quoted = item.quotedSelection === null
      ? ""
      : ` ${quotedSelectionFragment(item.quotedSelection)}`;
    lines.push(`${index + 1}. ${place}${quoted}`);
    for (const bodyLine of sanitizeBundleText(item.body).split("\n")) {
      lines.push(`   ${bodyLine}`);
    }
    lines.push(`   (thread ${item.threadId})`);
  });
  lines.push("");
  lines.push(...completionInstructions[profile]);
  return lines.join("\n");
}

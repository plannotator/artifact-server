/**
 * Tool-result nudges: the steering channel for pull-based MCP agents.
 *
 * MCP has no push, so a mailbox-tier agent learns about queued work only by
 * calling `dispatch_inbox` — and nothing tells it to. This module composes
 * the one terse context block the MCP server appends to a tool result when
 * the calling principal's own mailbox agent has work to attend to. The
 * facts are derived per call from existing dispatch state; nothing here is
 * stored, timed, or scheduled (`project/spec/tool-result-nudges-spec.md`).
 */

import type {CallToolResult} from "@modelcontextprotocol/server";

import {sanitizeBundleText} from "./dispatch-bundle-message.js";

/** The one line every nudge block opens with. */
export const nudgeHeading = "— artifact server —";

/** Hard bound on one nudge block, heading included. */
export const maximumNudgeCharacters = 400;

/** Tools whose results already say everything a nudge would. */
export const nudgeFreeTools: ReadonlySet<string> = new Set(["dispatch_inbox"]);

/** A settled bundle as a nudge names it: its id and how many threads it held. */
export interface NudgeBundle {
  readonly dispatchId: string;
  readonly threadCount: number;
}

/**
 * Everything the composer needs, already scoped to the calling principal's
 * own mailbox agent. A null active or settled bundle means that kind does
 * not apply on this call.
 */
export interface ToolResultNudgeFacts {
  /** Dispatches queued for the agent and not yet claimed. */
  readonly queuedBundles: number;
  /**
   * The claimed or delivered dispatch whose threads are not all resolved —
   * the presence derivation's active dispatch, known by id alone so naming
   * it costs no extra read.
   */
  readonly activeBundle: {readonly dispatchId: string} | null;
  /** The bundle the call just finished: every thread resolved, dispatch addressed. */
  readonly settledBundle: NudgeBundle | null;
}

function pluralized(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The one exit every nudge takes: the shared bundle sanitization (so a nudge
 * can never carry a bidirectional or invisible character, whatever a future
 * kind quotes), then the size bound.
 */
function bounded(text: string): string {
  const sanitized = sanitizeBundleText(text);
  return sanitized.length <= maximumNudgeCharacters
    ? sanitized
    : sanitized.slice(0, maximumNudgeCharacters);
}

/**
 * Pick the one nudge that applies, in the spec's priority order: queued
 * work, then an unfinished claim, then the progress echo. Null when nothing
 * applies, so the caller appends nothing.
 */
export function composeToolResultNudge(
  facts: ToolResultNudgeFacts,
): string | null {
  if (facts.queuedBundles > 0) {
    return bounded([
      nudgeHeading,
      `${pluralized(facts.queuedBundles, "review bundle")} ` +
        `${facts.queuedBundles === 1 ? "is" : "are"} queued for your inbox. ` +
        'Call dispatch_inbox {"operation": "claim"} to pick up the oldest.',
    ].join("\n"));
  }
  if (facts.activeBundle !== null) {
    return bounded([
      nudgeHeading,
      `Your claimed bundle ${facts.activeBundle.dispatchId} is not fully resolved. ` +
        "Reply and resolve each thread with comment_reply and comment_resolve, " +
        'or report it through dispatch_inbox {"operation": "failed"}.',
    ].join("\n"));
  }
  if (facts.settledBundle !== null) {
    return bounded([
      nudgeHeading,
      `All ${pluralized(facts.settledBundle.threadCount, "thread")} in bundle ` +
        `${facts.settledBundle.dispatchId} are resolved; the dispatch is addressed. ` +
        "Nothing further is needed for it.",
    ].join("\n"));
  }
  return null;
}

/**
 * Append one nudge as a trailing text content item. `structuredContent` and
 * every existing content item pass through untouched, so typed consumers see
 * exactly what they saw before.
 */
export function appendToolResultNudge(
  result: CallToolResult,
  nudge: string,
): CallToolResult {
  return {
    ...result,
    content: [...result.content, {text: nudge, type: "text"}],
  };
}

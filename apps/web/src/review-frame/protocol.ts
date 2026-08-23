import { z } from "zod";

import type {
  HtmlAnnotationTarget,
  HtmlElementAnchor,
} from "@plannotator/ui/components/html-viewer";

/** Protocol version carried by every host <-> review-frame message. */
export const reviewProtocolVersion = 1;

const versionSchema = z.literal(reviewProtocolVersion);

const anchorPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

/**
 * Trust-boundary caps mirror @plannotator/ui's own parent-side validation
 * (useHtmlAnnotation.ts:120-140) so a stored anchor can never be larger than
 * one the viewer would have produced.
 */
const htmlElementAnchorSchema = z.object({
  point: anchorPointSchema.optional(),
  selector: z.string().min(1).max(1_024),
  tagName: z.string().min(1).max(64),
  text: z.string().max(400).optional(),
});

const htmlAnnotationTargetSchema = z.object({
  anchor: htmlElementAnchorSchema.optional(),
  label: z.string().max(64).optional(),
  text: z.string().max(10_000),
});

/**
 * The anchor shape this client stores on a comment thread. The server treats
 * it as opaque, so the frame is its only reader: anything it does not
 * recognise (a whole-file `{kind: "page"}` anchor, an anchor written by a
 * future client) becomes `null` and the thread simply gets no page marker,
 * which is the same fail-closed outcome the bridge's own anchor builder uses.
 */
export const reviewAnchorSchema = z.object({
  htmlAdditionalTargets: z.array(htmlAnnotationTargetSchema).max(16).optional(),
  htmlAnchor: htmlElementAnchorSchema.nullable(),
  originalText: z.string().max(10_000),
});

const optionalAnchorSchema = reviewAnchorSchema.nullable().catch(null);

/** One comment thread as the host projects it into the page. */
export const reviewAnnotationSchema = z.object({
  anchor: optionalAnchorSchema,
  body: z.string(),
  state: z.enum(["open", "resolved"]),
  threadId: z.string().min(1),
});

const themeTokensSchema = z.record(
  z.string().regex(/^--[a-z0-9-]+$/iu),
  z.string().max(256),
);

/** Every message the host is allowed to send into the review frame. */
export const hostMessageSchema = z.discriminatedUnion("type", [
  z.object({
    annotations: z.array(reviewAnnotationSchema),
    baseHref: z.string().nullable(),
    entryPath: z.string(),
    html: z.string(),
    isLight: z.boolean(),
    readOnly: z.boolean(),
    themeTokens: themeTokensSchema,
    type: z.literal("as-review-init"),
    v: versionSchema,
  }),
  z.object({
    annotations: z.array(reviewAnnotationSchema),
    type: z.literal("as-review-annotations"),
    v: versionSchema,
  }),
  z.object({
    threadId: z.string().nullable(),
    type: z.literal("as-review-focus"),
    v: versionSchema,
  }),
]);

export type HostMessage = z.infer<typeof hostMessageSchema>;
export type ReviewAnnotation = z.infer<typeof reviewAnnotationSchema>;
export type ReviewAnchor = z.infer<typeof reviewAnchorSchema>;
export type ReviewInit = Extract<HostMessage, {type: "as-review-init"}>;

/** Every message the review frame sends back to the host. */
export type FrameMessage =
  | {v: typeof reviewProtocolVersion; type: "as-review-ready"}
  | {
    v: typeof reviewProtocolVersion;
    type: "as-review-submit";
    body: string;
    originalText: string;
    anchor: ReviewAnchor | null;
  }
  | {
    v: typeof reviewProtocolVersion;
    type: "as-review-select";
    threadId: string | null;
  }
  | {
    v: typeof reviewProtocolVersion;
    type: "as-review-unanchored";
    threadIds: string[];
  };

/** Build the anchor stored on a thread from what the viewer emitted. */
export function reviewAnchorFrom(
  originalText: string,
  htmlAnchor: HtmlElementAnchor | undefined,
  htmlAdditionalTargets: HtmlAnnotationTarget[] | undefined,
): ReviewAnchor {
  const anchor: ReviewAnchor = {
    htmlAnchor: htmlAnchor ?? null,
    originalText,
  };
  if (htmlAdditionalTargets !== undefined && htmlAdditionalTargets.length > 0) {
    return {...anchor, htmlAdditionalTargets};
  }
  return anchor;
}

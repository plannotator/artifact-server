/**
 * Which presenter Review uses for one manifest entry.
 *
 * The decision reads only the declared manifest media type. It never sniffs
 * bytes and never trusts a filename extension, so a publisher cannot promote
 * a file into a richer presenter than the type it declared.
 */
export type PreviewPresenter =
  | {readonly kind: "audio"}
  | {readonly kind: "data"; readonly format: DataFormat}
  | {readonly kind: "html"}
  | {readonly kind: "image"}
  | {readonly kind: "markdown"}
  | {readonly kind: "pdf"}
  | {readonly kind: "text"}
  | {readonly kind: "unsupported"}
  | {readonly kind: "video"};

export type DataFormat = "csv" | "json" | "ndjson" | "tsv";

const markdownTypes = new Set(["text/markdown", "text/x-markdown"]);
const ndjsonTypes = new Set([
  "application/jsonl",
  "application/jsonlines",
  "application/ndjson",
  "application/x-jsonlines",
  "application/x-ndjson",
]);
const textApplicationTypes = new Set([
  "application/ecmascript",
  "application/graphql",
  "application/javascript",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
]);

/** The lowercase media-type essence with every parameter removed. */
export function mediaTypeEssence(mediaType: string): string {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function previewPresenter(mediaType: string): PreviewPresenter {
  const essence = mediaTypeEssence(mediaType);
  if (essence === "text/html") return {kind: "html"};
  if (essence.startsWith("image/")) return {kind: "image"};
  if (essence.startsWith("video/")) return {kind: "video"};
  if (essence.startsWith("audio/")) return {kind: "audio"};
  if (essence === "application/pdf") return {kind: "pdf"};
  if (markdownTypes.has(essence)) return {kind: "markdown"};
  if (essence === "text/csv") return {format: "csv", kind: "data"};
  if (essence === "text/tab-separated-values") return {format: "tsv", kind: "data"};
  if (ndjsonTypes.has(essence)) return {format: "ndjson", kind: "data"};
  if (essence === "application/json" || isStructuredSuffix(essence, "+json")) {
    return {format: "json", kind: "data"};
  }
  if (
    essence.startsWith("text/")
    || textApplicationTypes.has(essence)
    || isStructuredSuffix(essence, "+xml")
  ) {
    return {kind: "text"};
  }
  return {kind: "unsupported"};
}

function isStructuredSuffix(essence: string, suffix: string): boolean {
  return essence.startsWith("application/") && essence.endsWith(suffix);
}

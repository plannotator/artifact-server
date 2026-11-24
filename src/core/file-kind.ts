const exactKinds = new Map([
  ["text/markdown", "markdown"],
  ["text/x-markdown", "markdown"],
  ["application/pdf", "pdf"],
  ["text/csv", "data"],
  ["text/tab-separated-values", "data"],
  ["application/json", "data"],
  ["application/x-ndjson", "data"],
  ["application/xml", "data"],
  ["text/xml", "data"],
  ["application/yaml", "data"],
  ["application/vnd.apache.parquet", "data"],
  ["application/x-sqlite3", "data"],
  ["text/javascript", "code"],
  ["application/javascript", "code"],
  ["application/x-sh", "code"],
  ["application/zip", "archive"],
  ["application/gzip", "archive"],
  ["application/x-tar", "archive"],
  ["application/x-7z-compressed", "archive"],
  ["application/x-rar-compressed", "archive"],
]);
const extensionKinds = new Map([
  ["md", "markdown"], ["markdown", "markdown"],
  ["ts", "code"], ["tsx", "code"], ["js", "code"], ["jsx", "code"],
  ["py", "code"], ["sh", "code"], ["rs", "code"], ["go", "code"],
  ["csv", "data"], ["tsv", "data"], ["json", "data"], ["ndjson", "data"],
  ["html", "html"], ["svg", "image"], ["pdf", "pdf"],
]);

/** Classify current-version metadata for catalog display and filtering. */
export function classifyFileKind(mediaType: string, entryPath: string, entryCount: number): string {
  const type = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type === "text/html") return entryCount > 1 ? "site" : "html";
  const exact = exactKinds.get(type);
  if (exact !== undefined) return exact;
  const family = type.split("/", 1)[0];
  if (family === "image" || family === "video" || family === "audio") return family;
  if (type === "text/plain" || type === "application/octet-stream") {
    const extension = /\.([a-z0-9]+)$/u.exec(entryPath.toLowerCase())?.[1] ?? "";
    const refined = extensionKinds.get(extension);
    if (refined !== undefined) return refined;
  }
  if (type.startsWith("text/x-")) return "code";
  return type.startsWith("text/") ? "text" : "other";
}

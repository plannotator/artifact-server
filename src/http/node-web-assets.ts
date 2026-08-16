import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";

import type {WebAssetStore} from "./create-http-app.js";

const webRoot = path.resolve(import.meta.dirname, "../../dist/web");

/** Reads the compiled management application from the release's fixed web directory. */
export function createNodeWebAssetStore(): WebAssetStore {
  return {
    fetch: async (assetPath, method) => {
      if (!safeAssetPath(assetPath)) return null;
      const relativePath = assetPath.slice(1);
      const bytes = await readFile(path.join(webRoot, relativePath)).catch(() => null);
      if (bytes === null) return null;
      const headers = new Headers({
        "Content-Length": String(bytes.byteLength),
        "Content-Type": assetMediaType(relativePath),
        ETag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
      });
      return new Response(method === "HEAD" ? null : bytes, {headers});
    },
  };
}

function safeAssetPath(assetPath: string): boolean {
  if (!assetPath.startsWith("/") || !/^[./A-Za-z0-9_-]+$/u.test(assetPath)) {
    return false;
  }
  return assetPath.split("/").every((segment, index) =>
    index === 0 || (segment !== "" && segment !== "." && segment !== "..")
  );
}

function assetMediaType(relativePath: string): string {
  switch (path.extname(relativePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

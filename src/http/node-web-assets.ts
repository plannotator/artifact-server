import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";

import type {WebAssetStore} from "./create-http-app.js";

const defaultWebRoot = path.resolve(import.meta.dirname, "../../dist/web");

// The compiled web bundle is well under two megabytes; the bound only guards
// against a misconfigured web root pointing at unexpectedly large files.
const maximumCachedAssetBytes = 32 * 1024 * 1024;

interface CachedWebAsset {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly etag: string;
  readonly mediaType: string;
}

/** Reads the compiled management application from the release's fixed web directory. */
export function createNodeWebAssetStore(
  webRoot: string = defaultWebRoot,
): WebAssetStore {
  // Assets are content-hashed and the entry documents only change with a
  // release restart, so one disk read and digest serves the process lifetime.
  const cache = new Map<string, CachedWebAsset>();
  let cachedBytes = 0;
  return {
    fetch: async (assetPath, method) => {
      if (!safeAssetPath(assetPath)) return null;
      const cached = cache.get(assetPath);
      const asset = cached ?? await loadWebAsset(webRoot, assetPath.slice(1));
      if (asset === null) return null;
      if (
        cached === undefined
        && cachedBytes + asset.bytes.byteLength <= maximumCachedAssetBytes
      ) {
        cache.set(assetPath, asset);
        cachedBytes += asset.bytes.byteLength;
      }
      const headers = new Headers({
        "Content-Length": String(asset.bytes.byteLength),
        "Content-Type": asset.mediaType,
        ETag: asset.etag,
      });
      return new Response(method === "HEAD" ? null : asset.bytes, {headers});
    },
  };
}

async function loadWebAsset(
  webRoot: string,
  relativePath: string,
): Promise<CachedWebAsset | null> {
  const fileBytes = await readFile(path.join(webRoot, relativePath))
    .catch(() => null);
  if (fileBytes === null) return null;
  const bytes = new Uint8Array(fileBytes.byteLength);
  bytes.set(fileBytes);
  return {
    bytes,
    etag: `"${createHash("sha256").update(fileBytes).digest("hex")}"`,
    mediaType: assetMediaType(relativePath),
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

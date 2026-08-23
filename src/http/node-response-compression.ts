import {promisify} from "node:util";
import {brotliCompress, constants, gzip} from "node:zlib";

const compressWithGzip = promisify(gzip);
const compressWithBrotli = promisify(brotliCompress);

/**
 * Media types worth compressing at the Node origin. Routes that serve raw
 * blob bytes advertise `Accept-Ranges: bytes` and are excluded wholesale so
 * encoded lengths never disagree with range arithmetic; a fronting proxy may
 * compress those streams. The Cloudflare Workers deployment receives edge
 * compression instead of this wrapper, which is why it wraps the Node request
 * listener rather than living inside the shared HTTP app.
 */
const compressibleMediaTypes = new Set([
  "application/javascript",
  "application/json",
  "image/svg+xml",
  "text/css",
  "text/html",
  "text/javascript",
]);

const minimumCompressedBodyBytes = 1024;

/**
 * Wrap a fetch-shaped handler so compressible Node responses are served
 * gzip- or brotli-encoded when the client allows it.
 */
export function withNodeResponseCompression<
  Rest extends ReadonlyArray<unknown>,
>(
  handler: (request: Request, ...rest: Rest) => Response | Promise<Response>,
): (request: Request, ...rest: Rest) => Promise<Response> {
  return async (request, ...rest) => {
    const response = await handler(request, ...rest);
    return encodeServedResponse(request, response);
  };
}

async function encodeServedResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  if (response.status < 200 || servesRangeableBytes(response.headers)) {
    return response;
  }
  if (response.status === 304) {
    // A 304 must carry the stored variant's Vary so caches keep keying
    // compressible routes on Accept-Encoding.
    return response.headers.has("ETag") ? withAppendedVary(response) : response;
  }
  if (!hasCompressibleMediaType(response.headers)) return response;
  const varied = withAppendedVary(response);
  if (
    request.method === "HEAD"
    || varied.status !== 200
    || varied.body === null
    || varied.headers.has("Content-Encoding")
  ) {
    return varied;
  }
  const encoding = negotiateEncoding(request.headers.get("accept-encoding"));
  if (encoding === null) return varied;
  // Every compressible body here is an in-memory string or memoized asset;
  // blob streams all serve ranges and were excluded above, so buffering the
  // representation to compress it is bounded and cheap.
  const bytes = new Uint8Array(await varied.arrayBuffer());
  if (bytes.byteLength < minimumCompressedBodyBytes) {
    return new Response(bytes, {
      headers: varied.headers,
      status: varied.status,
      statusText: varied.statusText,
    });
  }
  const compressed = encoding === "br"
    ? await compressWithBrotli(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 5,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
      },
    })
    : await compressWithGzip(bytes);
  const headers = new Headers(varied.headers);
  headers.set("Content-Encoding", encoding);
  headers.set("Content-Length", String(compressed.byteLength));
  const etag = headers.get("ETag");
  if (etag !== null && !etag.startsWith("W/")) {
    // The encoded representation differs from the identity one byte for
    // byte, so its validator must be weak.
    headers.set("ETag", `W/${etag}`);
  }
  return new Response(compressed, {
    headers,
    status: varied.status,
    statusText: varied.statusText,
  });
}

function servesRangeableBytes(headers: Headers): boolean {
  return headers.get("Accept-Ranges") === "bytes"
    || headers.has("Content-Range");
}

function hasCompressibleMediaType(headers: Headers): boolean {
  const contentType = headers.get("Content-Type");
  if (contentType === null) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLocaleLowerCase("en-US");
  return mediaType !== undefined && compressibleMediaTypes.has(mediaType);
}

function withAppendedVary(response: Response): Response {
  const existing = response.headers.get("Vary");
  if (
    existing !== null
    && (existing.trim() === "*" || existing
      .toLocaleLowerCase("en-US")
      .split(",")
      .some((member) => member.trim() === "accept-encoding"))
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set(
    "Vary",
    existing === null ? "Accept-Encoding" : `${existing}, Accept-Encoding`,
  );
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function negotiateEncoding(header: string | null): "br" | "gzip" | null {
  if (header === null) return null;
  let brotliAllowed = false;
  let gzipAllowed = false;
  for (const candidate of header.split(",")) {
    const [name = "", ...parameters] = candidate.trim().split(";");
    const coding = name.trim().toLocaleLowerCase("en-US");
    if (coding !== "br" && coding !== "gzip") continue;
    if (acceptQuality(parameters) === 0) continue;
    if (coding === "br") brotliAllowed = true;
    else gzipAllowed = true;
  }
  if (brotliAllowed) return "br";
  return gzipAllowed ? "gzip" : null;
}

function acceptQuality(parameters: ReadonlyArray<string>): number {
  for (const parameter of parameters) {
    const [key = "", value = ""] = parameter.split("=");
    if (key.trim().toLocaleLowerCase("en-US") !== "q") continue;
    const quality = Number(value.trim());
    return Number.isFinite(quality) ? quality : 1;
  }
  return 1;
}

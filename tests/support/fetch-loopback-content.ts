import {request} from "node:http";

/** Fetch one local content-origin URL without relying on wildcard localhost DNS. */
export function fetchLoopbackContent(contentUrl: string | URL): Promise<Response> {
  const target = new URL(contentUrl);
  if (
    target.protocol !== "http:"
    || (!target.hostname.endsWith(".localhost") && target.hostname !== "localhost")
  ) {
    return Promise.reject(
      new Error("The test content URL must use a localhost HTTP origin."),
    );
  }

  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        headers: {Host: target.host},
        hostname: "127.0.0.1",
        method: "GET",
        path: `${target.pathname}${target.search}`,
        port: target.port,
      },
      (incoming) => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("end", () => {
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index];
            const value = incoming.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined) {
              headers.append(name, value);
            }
          }
          resolve(new Response(Buffer.concat(chunks), {
            headers,
            status: incoming.statusCode ?? 500,
          }));
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

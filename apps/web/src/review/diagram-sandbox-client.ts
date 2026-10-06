import sandboxScriptPath from "virtual:markdown-diagram-sandbox";

import {diagramReplySchema} from "./diagram-sandbox-protocol.ts";

const diagramTimeoutMilliseconds = 8_000;
let diagramQueue: Promise<void> = Promise.resolve();

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function renderInFrame(text: string, isLight: boolean, id: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Diagram rendering was cancelled."));
      return;
    }
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.title = "Diagram renderer";
    frame.style.cssText = "position:fixed;left:-100000px;top:0;width:1024px;height:768px;border:0;visibility:hidden;pointer-events:none";
    const scriptUrl = new URL(sandboxScriptPath, window.location.origin).href;
    // Only the trusted bundled script may load. Diagram images, imports,
    // connections, frames and forms are denied before Mermaid touches the DOM.
    const policy = `default-src 'none'; script-src ${scriptUrl}; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'`;
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"></head><body><script src="${escapeAttribute(scriptUrl)}"></script></body></html>`;

    const cleanup = (): void => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
      frame.remove();
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error("Diagram rendering was cancelled."));
    };
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== frame.contentWindow || event.origin !== "null") return;
      const parsed = diagramReplySchema.safeParse(event.data);
      if (!parsed.success) return;
      const reply = parsed.data;
      if (reply.type === "ready") {
        frame.contentWindow?.postMessage({id, isLight, text}, "*");
        return;
      }
      if (reply.id !== id) return;
      cleanup();
      if (reply.type === "result") resolve(reply.svg);
      else reject(new Error("This diagram could not be rendered."));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Diagram rendering exceeded the preview time limit."));
    }, diagramTimeoutMilliseconds);
    window.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort, {once: true});
    document.body.append(frame);
  });
}

/** Serialize bounded jobs; each executes in a fresh frame with no application access. */
export async function renderMermaidInSandbox(text: string, isLight: boolean, id: string, signal?: AbortSignal): Promise<string> {
  const rendered = diagramQueue.then(() => renderInFrame(text, isLight, id, signal));
  diagramQueue = rendered.then(() => undefined, () => undefined);
  return rendered;
}

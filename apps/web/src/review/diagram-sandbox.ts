import mermaid from "mermaid";

import {diagramRequestSchema} from "./diagram-sandbox-protocol.ts";

/** Trusted classic-script entry, executed only inside an opaque, network-denied frame. */
function startDiagramSandbox(): void {
  const script = document.currentScript;
  if (!(script instanceof HTMLScriptElement) || window.parent === window) return;
  const hostOrigin = new URL(script.src).origin;

  window.addEventListener("message", (event: MessageEvent<unknown>): void => {
    if (event.source !== window.parent || event.origin !== hostOrigin) return;
    const parsed = diagramRequestSchema.safeParse(event.data);
    if (!parsed.success) return;
    const request = parsed.data;
    // Image decoding and optional loaders can remain pending after CSP blocks
    // them. Tell the host to discard this frame immediately, without waiting
    // for a blocked resource or holding subsequent diagram jobs in the queue.
    window.addEventListener("securitypolicyviolation", (violation) => {
      if (["img-src", "connect-src", "font-src", "frame-src", "worker-src"].includes(violation.effectiveDirective)) {
        window.parent.postMessage({id: request.id, type: "error"}, hostOrigin);
      }
    });
    void (async () => {
      try {
        mermaid.initialize({
          deterministicIds: true,
          deterministicIDSeed: request.id,
          flowchart: {htmlLabels: false},
          htmlLabels: false,
          maxEdges: 200,
          maxTextSize: 20_000,
          securityLevel: "strict",
          startOnLoad: false,
          suppressErrorRendering: true,
          theme: request.isLight ? "default" : "dark",
        });
        const host = document.createElement("div");
        document.body.append(host);
        const result = await mermaid.render(request.id, request.text, host);
        window.parent.postMessage({id: request.id, svg: result.svg, type: "result"}, hostOrigin);
      } catch {
        window.parent.postMessage({id: request.id, type: "error"}, hostOrigin);
      }
    })();
  });
  window.parent.postMessage({type: "ready"}, hostOrigin);
}

startDiagramSandbox();

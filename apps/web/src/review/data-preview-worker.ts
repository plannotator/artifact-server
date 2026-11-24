import { parseDataPreview, type DataPreviewRequest } from "./data-parse.ts";

/**
 * Parses one structured data preview off the Review document's main thread.
 * The host bounds its time and terminates this worker when the bound passes.
 */
self.addEventListener("message", (event: MessageEvent<DataPreviewRequest>) => {
  self.postMessage(parseDataPreview(event.data), {transfer: []});
});

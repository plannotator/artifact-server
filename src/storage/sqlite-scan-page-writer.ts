import {Worker} from "node:worker_threads";
import {FolderLinkFailure} from "../core/errors.js";
import type {ApplyScanPage} from "../core/ports.js";

export interface ScanPageRequest {
  readonly id: number;
  readonly command: ApplyScanPage;
}

export type ScanPageReply =
  | {readonly id: number; readonly result: {readonly overLimit: boolean}}
  | {readonly id: number; readonly failure: {readonly reason: FolderLinkFailure["reason"]; readonly message: string}}
  | {readonly id: number; readonly error: Error};

interface PendingPage {
  readonly resolve: (value: {readonly overLimit: boolean}) => void;
  readonly reject: (error: Error) => void;
}

/** One serialized scan-page writer per local runtime, started on demand. */
export class SqliteScanPageWriter {
  readonly #databasePath: string;
  readonly #pending = new Map<number, PendingPage>();
  #worker: Worker | null = null;
  #closed = false;
  #nextId = 0;

  constructor(databasePath: string) {
    this.#databasePath = databasePath;
  }

  apply = async (command: ApplyScanPage): Promise<{readonly overLimit: boolean}> => {
    if (this.#closed) throw new Error("The SQLite scan writer is closed.");
    const worker = this.#worker ?? this.#startWorker();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const request: ScanPageRequest = {id, command};
      worker.postMessage(request, []);
      this.#pending.set(id, {resolve, reject});
    });
  };

  async close(): Promise<void> {
    this.#closed = true;
    await this.#worker?.terminate();
  }

  #startWorker(): Worker {
    const source = import.meta.url.endsWith(".ts");
    const worker = new Worker(new URL(source ? "./sqlite-scan-page-worker.ts" : "./sqlite-scan-page-worker.js", import.meta.url), {
      execArgv: source ? ["--import", import.meta.resolve("tsx")] : [],
      workerData: this.#databasePath,
    });
    this.#worker = worker;
    const rejectPending = (error: Error) => {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    };
    worker.on("message", (reply: ScanPageReply) => {
      const pending = this.#pending.get(reply.id);
      if (pending === undefined) return;
      this.#pending.delete(reply.id);
      if ("failure" in reply) {
        pending.reject(new FolderLinkFailure(reply.failure));
      } else if ("error" in reply) {
        pending.reject(reply.error);
      } else {
        pending.resolve(reply.result);
      }
    });
    worker.once("error", rejectPending);
    worker.once("exit", () => {
      this.#worker = null;
      rejectPending(new Error("The SQLite scan writer stopped before confirming the page."));
    });
    return worker;
  }
}

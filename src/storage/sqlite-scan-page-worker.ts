import {DatabaseSync} from "node:sqlite";
import {parentPort, workerData} from "node:worker_threads";
import {z} from "zod";
import {FolderLinkFailure} from "../core/errors.js";
import {SqliteFolderLinks} from "./sqlite-folder-links.js";
import type {ScanPageReply, ScanPageRequest} from "./sqlite-scan-page-writer.js";

const port = parentPort;
if (port === null) throw new Error("The SQLite scan writer requires a parent port.");

// The catalog opens the database in WAL mode before the first page arrives.
// BEGIN IMMEDIATE serializes each page against writes on the catalog connection.
const database = new DatabaseSync(z.string().parse(workerData), {
  allowExtension: false,
  enableForeignKeyConstraints: true,
  timeout: 5_000,
});
database.enableDefensive(true);
database.exec("PRAGMA synchronous = FULL;");

const folderLinks = new SqliteFolderLinks(database, (operation) => {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
});

const reply = (message: ScanPageReply): void => port.postMessage(message);

port.on("message", ({id, command}: ScanPageRequest) => {
  void folderLinks.applyScanPage(command).then(
    (result) => reply({id, result}),
    (error: Error) => {
      if (error instanceof FolderLinkFailure) {
        reply({id, failure: {reason: error.reason, message: error.message}});
      } else {
        reply({id, error});
      }
    },
  );
});

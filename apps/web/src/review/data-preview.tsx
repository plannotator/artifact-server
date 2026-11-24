import { useEffect, useMemo, useRef, useState } from "react";

import {reviewPartsText} from "@/i18n/messages/review-parts";
import {displayError, formatBytes} from "@/lib/presentation";

import {
  dataByteLimit,
  dataRowLimit,
  type DataPreviewResult,
  type JsonEntry,
  type JsonTree,
} from "./data-parse.ts";
import type { DataFormat } from "./preview-kind.ts";
import {
  PreviewState,
  TerminalPreviewState,
  type PreviewActions,
  type PreviewEntry,
} from "./preview-states.tsx";

const text = reviewPartsText.preview;

/** A parse that has not answered within this bound is abandoned. */
export const dataParseTimeLimit = 5_000;
/** Children a single tree node renders before summarizing the rest. */
const jsonChildLimit = 500;
/** Must match `.as-data-table tbody td` height in review-preview.css. */
const tableRowHeight = 30;
const tableOverscan = 12;

const formatNames = {
  csv: "CSV",
  json: "JSON",
  ndjson: "NDJSON",
  tsv: "TSV",
} satisfies Readonly<Record<DataFormat, string>>;

type DataLoad =
  | {readonly state: "loading"}
  | {readonly error: Error; readonly state: "failed"}
  | {readonly reason: "malformed" | "timed-out" | "too-large"; readonly state: "refused"}
  | {readonly result: Exclude<DataPreviewResult, {kind: "failed"}>; readonly state: "ready"};

/**
 * CSV and TSV as a virtualized table, JSON and NDJSON as a collapsible tree.
 * Parsing happens in a worker under byte and time bounds; every value is
 * rendered as a text node.
 */
export function DataPreview({
  actions,
  entry,
  format,
  readBytes,
}: {
  readonly actions: PreviewActions;
  readonly entry: PreviewEntry;
  readonly format: DataFormat;
  readonly readBytes: (byteLimit: number | null) => Promise<Uint8Array>;
}) {
  const [load, setLoad] = useState<DataLoad>({state: "loading"});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    let worker: Worker | null = null;
    let timer: number | undefined;
    const stop = (): void => {
      worker?.terminate();
      worker = null;
      window.clearTimeout(timer);
    };
    setLoad({state: "loading"});
    if (format === "json" && entry.size > dataByteLimit) {
      setLoad({reason: "too-large", state: "refused"});
      return undefined;
    }
    void (async () => {
      try {
        const complete = entry.size <= dataByteLimit;
        const bytes = await readBytes(complete ? null : dataByteLimit);
        if (!current) return;
        const parser = new Worker(
          new URL("./data-preview-worker.ts", import.meta.url),
          {type: "module"},
        );
        worker = parser;
        const result = await new Promise<DataPreviewResult | "timed-out">(
          (resolve, reject) => {
            timer = window.setTimeout(() => resolve("timed-out"), dataParseTimeLimit);
            parser.addEventListener(
              "message",
              (event: MessageEvent<DataPreviewResult>) => resolve(event.data),
            );
            parser.addEventListener("error", () => reject(new Error(text.failed)));
            const transferable = bytes.slice().buffer;
            parser.postMessage({bytes: transferable, complete, format}, [transferable]);
          },
        );
        if (!current) return;
        if (result === "timed-out") {
          setLoad({reason: "timed-out", state: "refused"});
        } else if (result.kind === "failed") {
          setLoad({reason: result.reason, state: "refused"});
        } else {
          setLoad({result, state: "ready"});
        }
      } catch (cause) {
        if (current) {
          setLoad({
            error: cause instanceof Error ? cause : new Error(text.failed),
            state: "failed",
          });
        }
      } finally {
        stop();
      }
    })();
    return () => {
      current = false;
      stop();
    };
  }, [attempt, entry.size, format, readBytes]);

  if (load.state === "loading") {
    return <PreviewState description={text.loadingPath(entry.path)} title={text.loadingTitle} />;
  }
  if (load.state === "failed" || load.state === "refused") {
    return (
      <TerminalPreviewState
        actions={actions}
        description={load.state === "failed"
          ? displayError(load.error)
          : refusalDescription(load.reason, format)}
        mediaType={entry.mediaType}
        onRetry={load.state === "failed" || load.reason === "timed-out"
          ? () => setAttempt((value) => value + 1)
          : undefined}
        path={entry.path}
        size={entry.size}
        title={text.dataUnavailableTitle}
      />
    );
  }
  const result = load.result;
  const notice = result.truncated
    ? result.kind === "table"
      ? text.dataRowsTruncated(dataRowLimit.toLocaleString())
      : text.dataRecordsTruncated(dataRowLimit.toLocaleString())
    : null;
  return (
    <div className="as-data-preview" data-kind={result.kind}>
      {notice === null ? null : (
        <p className="as-preview-notice" role="note">
          <span>{notice}</span>
          {actions.downloadUrl === null ? null : (
            <a className="as-button" download href={actions.downloadUrl}>{text.download}</a>
          )}
        </p>
      )}
      {result.kind === "table" ? (
        <VirtualTable
          columns={result.columns}
          label={text.dataTableLabel(entry.path)}
          rows={result.rows}
        />
      ) : (
        <div
          aria-label={text.dataTreeLabel(entry.path)}
          className="as-json-tree"
          role="region"
          tabIndex={0}
        >
          <ul>
            <JsonNode depth={0} name={null} node={result.root} />
          </ul>
        </div>
      )}
    </div>
  );
}

function refusalDescription(
  reason: "malformed" | "timed-out" | "too-large",
  format: DataFormat,
): string {
  if (reason === "malformed") return text.dataMalformed(formatNames[format]);
  if (reason === "too-large") return text.dataTooLarge(formatBytes(dataByteLimit));
  return text.dataTimedOut;
}

/**
 * Only the rows in view (plus a small overscan) exist in the DOM; spacer rows
 * keep the scroll height of the full table.
 */
function VirtualTable({
  columns,
  label,
  rows,
}: {
  readonly columns: readonly string[];
  readonly label: string;
  readonly rows: readonly (readonly string[])[];
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({height: 600, top: 0});

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return undefined;
    const measure = (): void => {
      setViewport({height: element.clientHeight, top: element.scrollTop});
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener("scroll", measure, {passive: true});
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, []);

  const first = Math.max(0, Math.floor(viewport.top / tableRowHeight) - tableOverscan);
  const last = Math.min(
    rows.length,
    Math.ceil((viewport.top + viewport.height) / tableRowHeight) + tableOverscan,
  );
  const visible = rows.slice(first, last);

  return (
    <div
      aria-label={label}
      className="as-data-table__scroll"
      ref={scrollRef}
      role="region"
      tabIndex={0}
    >
      <table aria-rowcount={rows.length + 1} className="as-data-table">
        <thead>
          <tr aria-rowindex={1}>
            <th className="as-data-table__index" scope="col">#</th>
            {columns.map((column, index) => (
              <th key={index} scope="col">{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {first > 0 ? (
            <tr aria-hidden="true" className="as-data-table__spacer">
              <td colSpan={columns.length + 1} style={{height: first * tableRowHeight}} />
            </tr>
          ) : null}
          {visible.map((row, offset) => {
            const rowNumber = first + offset + 1;
            return (
              <tr aria-rowindex={rowNumber + 1} key={rowNumber}>
                <th className="as-data-table__index" scope="row">{rowNumber}</th>
                {row.map((cell, index) => <td key={index} title={cell}>{cell}</td>)}
              </tr>
            );
          })}
          {last < rows.length ? (
            <tr aria-hidden="true" className="as-data-table__spacer">
              <td
                colSpan={columns.length + 1}
                style={{height: (rows.length - last) * tableRowHeight}}
              />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function JsonNode({
  depth,
  name,
  node,
}: {
  readonly depth: number;
  readonly name: string | null;
  readonly node: JsonTree;
}) {
  if (node.kind === "array" || node.kind === "object") {
    return <JsonBranch depth={depth} name={name} node={node} />;
  }
  return (
    <li className="as-json-tree__leaf">
      {name === null ? null : <span className="as-json-tree__key">{name}</span>}
      <span className="as-json-tree__value" data-kind={node.kind}>{scalarText(node)}</span>
    </li>
  );
}

function JsonBranch({
  depth,
  name,
  node,
}: {
  readonly depth: number;
  readonly name: string | null;
  readonly node: Extract<JsonTree, {kind: "array" | "object"}>;
}) {
  const [open, setOpen] = useState(depth < 2);
  const children = useMemo<readonly JsonEntry[]>(
    () => node.kind === "array"
      ? node.items.map((item, index): JsonEntry => [String(index), item])
      : node.entries,
    [node],
  );
  const shown = children.slice(0, jsonChildLimit);
  return (
    <li className="as-json-tree__branch">
      <details onToggle={(event) => setOpen(event.currentTarget.open)} open={open}>
        <summary>
          {name === null ? null : <span className="as-json-tree__key">{name}</span>}
          <span className="as-json-tree__meta">
            {node.kind === "array" ? "[ ]" : "{ }"} {text.jsonEntries(children.length, node.kind)}
          </span>
        </summary>
        {open ? (
          <ul>
            {shown.map(([key, child], index) => (
              <JsonNode depth={depth + 1} key={index} name={key} node={child} />
            ))}
            {children.length > shown.length ? (
              <li className="as-json-tree__more">{text.jsonMore(children.length - shown.length)}</li>
            ) : null}
          </ul>
        ) : null}
      </details>
    </li>
  );
}

function scalarText(node: Exclude<JsonTree, {kind: "array" | "object"}>): string {
  if (node.kind === "string") return JSON.stringify(node.value);
  if (node.kind === "null") return "null";
  return String(node.value);
}

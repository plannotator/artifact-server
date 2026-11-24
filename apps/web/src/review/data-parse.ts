import { z } from "zod";

import type { DataFormat } from "./preview-kind.ts";

/**
 * Bounded parsers for the structured data preview. They run in a dedicated
 * worker so a large or hostile file can never block the Review document, and
 * every one of them is linear in its input.
 */

/** The most rows (CSV/TSV) or records (NDJSON) a preview shows. */
export const dataRowLimit = 5_000;
/** The most bytes a structured preview reads. JSON over this bound is refused. */
export const dataByteLimit = 5 * 1024 * 1024;
/** Deeper nesting is refused rather than rendered as an unusable tree. */
export const jsonDepthLimit = 256;

export type JsonTree =
  | {readonly kind: "array"; readonly items: readonly JsonTree[]}
  | {readonly kind: "boolean"; readonly value: boolean}
  | {readonly kind: "null"}
  | {readonly kind: "number"; readonly value: number}
  | {readonly kind: "object"; readonly entries: readonly JsonEntry[]}
  | {readonly kind: "string"; readonly value: string};

export type JsonEntry = readonly [key: string, value: JsonTree];

export interface DataPreviewRequest {
  readonly bytes: ArrayBuffer;
  /** True when `bytes` is the whole file, false when it is a leading slice. */
  readonly complete: boolean;
  readonly format: DataFormat;
}

export type DataPreviewResult =
  | {
    readonly columns: readonly string[];
    readonly kind: "table";
    readonly rows: readonly (readonly string[])[];
    readonly truncated: boolean;
  }
  | {readonly kind: "tree"; readonly root: JsonTree; readonly truncated: boolean}
  | {readonly kind: "failed"; readonly reason: "malformed" | "too-large"};

class MalformedData extends Error {}

export function parseDataPreview(request: DataPreviewRequest): DataPreviewResult {
  if (request.format === "json" && !request.complete) {
    return {kind: "failed", reason: "too-large"};
  }
  const text = new TextDecoder("utf-8").decode(request.bytes, {
    stream: !request.complete,
  });
  try {
    if (request.format === "json") {
      return {kind: "tree", root: parseJsonTree(text), truncated: false};
    }
    if (request.format === "ndjson") return parseNdjson(text, request.complete);
    const table = request.format === "csv"
      ? parseCsv(text, request.complete)
      : parseTsv(text, request.complete);
    return tableResult(table.rows, table.truncated);
  } catch (cause) {
    if (cause instanceof MalformedData || cause instanceof RangeError) {
      return {kind: "failed", reason: "malformed"};
    }
    throw cause;
  }
}

function tableResult(
  records: readonly (readonly string[])[],
  truncated: boolean,
): DataPreviewResult {
  const [header, ...rows] = records;
  if (header === undefined) throw new MalformedData("The table has no header row.");
  const width = Math.max(header.length, ...rows.map((row) => row.length));
  const columns = Array.from({length: width}, (_, index) => header[index] ?? "");
  return {
    columns,
    kind: "table",
    rows: rows.map((row) =>
      row.length === width
        ? row
        : Array.from({length: width}, (_, index) => row[index] ?? "")
    ),
    truncated,
  };
}

interface ParsedRows {
  readonly rows: readonly (readonly string[])[];
  readonly truncated: boolean;
}

const quote = 0x22;
const comma = 0x2c;
const lineFeed = 0x0a;
const carriageReturn = 0x0d;

/**
 * RFC 4180 CSV, strictly: a quote may only open a field or close it, and a
 * closed quote must be followed by a delimiter or line end. A quote still
 * open at the end of the complete file is malformed. When `complete` is false
 * the trailing, possibly cut, record is dropped.
 */
export function parseCsv(text: string, complete: boolean): ParsedRows {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let index = 0;
  let quoted = false;
  let fieldStarted = false;
  const rowLimit = dataRowLimit + 1;
  const endRow = (): void => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
    fieldStarted = false;
  };
  while (index < text.length) {
    if (rows.length === rowLimit) return {rows, truncated: true};
    const code = text.charCodeAt(index);
    if (quoted) {
      const close = text.indexOf('"', index);
      if (close === -1) {
        if (complete) throw new MalformedData("A quoted CSV field never closes.");
        return {rows, truncated: true};
      }
      field += text.slice(index, close);
      if (text.charCodeAt(close + 1) === quote) {
        field += '"';
        index = close + 2;
        continue;
      }
      quoted = false;
      index = close + 1;
      const next = text.charCodeAt(index);
      if (
        index < text.length
        && next !== comma
        && next !== lineFeed
        && next !== carriageReturn
      ) {
        throw new MalformedData("A closed CSV quote is followed by more text.");
      }
      continue;
    }
    if (code === quote) {
      if (fieldStarted) throw new MalformedData("A CSV quote appears inside a bare field.");
      quoted = true;
      fieldStarted = true;
      index += 1;
      continue;
    }
    if (code === comma) {
      row.push(field);
      field = "";
      fieldStarted = false;
      index += 1;
      continue;
    }
    if (code === carriageReturn || code === lineFeed) {
      endRow();
      index += code === carriageReturn && text.charCodeAt(index + 1) === lineFeed ? 2 : 1;
      continue;
    }
    field += text[index] ?? "";
    fieldStarted = true;
    index += 1;
  }
  if (quoted) {
    if (complete) throw new MalformedData("A quoted CSV field never closes.");
    return {rows, truncated: true};
  }
  if (!complete) return {rows: rows.slice(0, rowLimit), truncated: true};
  if (fieldStarted || row.length > 0) endRow();
  return {rows: rows.slice(0, rowLimit), truncated: rows.length > rowLimit};
}

/** IANA TSV: one record per line, fields split on tabs, no quoting. */
export function parseTsv(text: string, complete: boolean): ParsedRows {
  const lines = recordLines(text, complete, dataRowLimit + 1);
  return {
    rows: lines.lines.map((line) => line.split("\t")),
    truncated: lines.truncated,
  };
}

function parseNdjson(text: string, complete: boolean): DataPreviewResult {
  const lines = recordLines(text, complete, dataRowLimit);
  const items = lines.lines.map((line) => parseJsonTree(line));
  if (items.length === 0) throw new MalformedData("The file holds no JSON records.");
  return {kind: "tree", root: {items, kind: "array"}, truncated: lines.truncated};
}

interface RecordLines {
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

/** Non-blank lines up to `limit`; a cut trailing line is dropped. */
function recordLines(text: string, complete: boolean, limit: number): RecordLines {
  const lines: string[] = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/gu;
  for (const match of text.matchAll(pattern)) {
    const [, line = "", terminator = ""] = match;
    if (terminator === "" && !complete) return {lines, truncated: true};
    if (line.trim() !== "") {
      if (lines.length === limit) return {lines, truncated: true};
      lines.push(line);
    }
    if (terminator === "") break;
  }
  return {lines, truncated: !complete};
}

type ContainerFrame =
  | {readonly items: JsonTree[]; readonly kind: "array"}
  | {readonly entries: JsonEntry[]; key: string; readonly kind: "object"};

const jsonNumber = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;
const jsonStringSchema = z.string();

/**
 * Strict RFC 8259 JSON into a tagged tree. Containers use an explicit stack,
 * so deep nesting is refused at {@link jsonDepthLimit} instead of exhausting
 * the call stack.
 */
export function parseJsonTree(text: string): JsonTree {
  const reader = new JsonReader(text);
  const stack: ContainerFrame[] = [];
  let pending = reader.openValue(stack);
  for (;;) {
    if (pending !== null) {
      const top = stack.at(-1);
      if (top === undefined) {
        reader.skipWhitespace();
        if (!reader.atEnd()) throw new MalformedData("JSON continues after its value.");
        return pending;
      }
      if (top.kind === "array") top.items.push(pending);
      else top.entries.push([top.key, pending]);
      pending = null;
    }
    const top = stack.at(-1);
    if (top === undefined) throw new MalformedData("JSON ended without a value.");
    reader.skipWhitespace();
    const next = reader.take();
    if (next === ",") {
      if (top.kind === "object") top.key = reader.readKey();
      pending = reader.openValue(stack);
      continue;
    }
    if (next === (top.kind === "array" ? "]" : "}")) {
      stack.pop();
      pending = top.kind === "array"
        ? {items: top.items, kind: "array"}
        : {entries: top.entries, kind: "object"};
      continue;
    }
    throw new MalformedData("JSON has an unexpected character.");
  }
}

function decodeJsonString(token: string): string {
  let decoded: ReturnType<typeof jsonStringSchema.safeParse>;
  try {
    decoded = jsonStringSchema.safeParse(JSON.parse(token));
  } catch {
    throw new MalformedData("A JSON string has an invalid escape.");
  }
  if (!decoded.success) throw new MalformedData("A JSON string is invalid.");
  return decoded.data;
}

class JsonReader {
  #index = 0;
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  atEnd(): boolean {
    return this.#index >= this.#text.length;
  }

  skipWhitespace(): void {
    while (this.#index < this.#text.length) {
      const character = this.#text[this.#index];
      if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") {
        return;
      }
      this.#index += 1;
    }
  }

  take(): string {
    const character = this.#text[this.#index] ?? "";
    this.#index += 1;
    return character;
  }

  /**
   * Read one value. A scalar or empty container is returned; a non-empty
   * container is pushed onto `stack` and `null` is returned.
   */
  openValue(stack: ContainerFrame[]): JsonTree | null {
    this.skipWhitespace();
    const character = this.#text[this.#index];
    if (character === "[" || character === "{") {
      if (stack.length >= jsonDepthLimit) {
        throw new MalformedData("JSON nests deeper than the preview allows.");
      }
      this.#index += 1;
      this.skipWhitespace();
      const close = character === "[" ? "]" : "}";
      if (this.#text[this.#index] === close) {
        this.#index += 1;
        return character === "[" ? {items: [], kind: "array"} : {entries: [], kind: "object"};
      }
      stack.push(character === "["
        ? {items: [], kind: "array"}
        : {entries: [], key: this.readKey(), kind: "object"});
      return this.openValue(stack);
    }
    return this.readScalar();
  }

  readKey(): string {
    this.skipWhitespace();
    if (this.#text[this.#index] !== '"') throw new MalformedData("A JSON key must be a string.");
    const key = this.readString();
    this.skipWhitespace();
    if (this.take() !== ":") throw new MalformedData("A JSON key must be followed by a colon.");
    return key;
  }

  private readScalar(): JsonTree {
    const character = this.#text[this.#index];
    if (character === '"') return {kind: "string", value: this.readString()};
    if (this.#text.startsWith("true", this.#index)) {
      this.#index += 4;
      return {kind: "boolean", value: true};
    }
    if (this.#text.startsWith("false", this.#index)) {
      this.#index += 5;
      return {kind: "boolean", value: false};
    }
    if (this.#text.startsWith("null", this.#index)) {
      this.#index += 4;
      return {kind: "null"};
    }
    jsonNumber.lastIndex = this.#index;
    const number = jsonNumber.exec(this.#text);
    if (number === null) throw new MalformedData("JSON expected a value.");
    this.#index += number[0].length;
    return {kind: "number", value: Number(number[0])};
  }

  private readString(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#text.length) {
      const code = this.#text.charCodeAt(this.#index);
      if (code === quote) {
        this.#index += 1;
        // The span is a complete JSON string token; the platform decoder
        // applies the escape rules and rejects any that are invalid.
        return decodeJsonString(this.#text.slice(start, this.#index));
      }
      if (code < 0x20) throw new MalformedData("A JSON string holds a control character.");
      this.#index += code === 0x5c ? 2 : 1;
    }
    throw new MalformedData("A JSON string never closes.");
  }
}

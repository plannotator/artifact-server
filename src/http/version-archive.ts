import type {ArtifactVersion, ManifestEntry} from "../core/model.js";
import type {BlobStore} from "../core/ports.js";
import {portableDownloadFilename} from "./content-disposition.js";

const zip32Maximum = 0xffff_ffffn;
const zip32MaximumEntries = 0xffff;
const utf8Flag = 0x0800;
const dataDescriptorFlag = 0x0008;
const zipFlags = utf8Flag | dataDescriptorFlag;
const storedCompression = 0;
const dosEpochDate = 0x0021;
const zip32Version = 20;
const zip64Version = 45;
const zip64ExtraField = 0x0001;
const localHeaderBytes = 30;
const centralHeaderBytes = 46;
const zip32DescriptorBytes = 16;
const zip64DescriptorBytes = 24;
const zip32EndBytes = 22;
const zip64EndBytes = 56;
const zip64LocatorBytes = 20;
const zip64LocalExtraBytes = 20;
const zip64CentralExtraBytes = 28;
const textEncoder = new TextEncoder();

interface ArchivePlan {
  readonly byteLength: bigint;
  readonly centralDirectoryOffset: bigint;
  readonly centralDirectorySize: bigint;
  readonly entries: readonly ArchiveEntryPlan[];
  readonly format: "zip32" | "zip64";
}

interface ArchiveEntryPlan {
  readonly entry: ManifestEntry;
  readonly localHeaderOffset: bigint;
  readonly name: Uint8Array;
}

/** A pull-driven ZIP response for one complete immutable artifact version. */
export interface VersionArchive {
  readonly body: ReadableStream<Uint8Array>;
  readonly byteLength: bigint;
}

/** Name one complete version download without exposing storage identifiers. */
export function versionArchiveFilename(
  artifactName: string,
  versionNumber: number,
): string {
  const stem = portableDownloadFilename(artifactName);
  return portableDownloadFilename(`${stem} - version ${versionNumber}.zip`);
}

/** Stream an exact immutable version as a path-preserving ZIP or ZIP64 archive. */
export function createVersionArchive(
  saved: ArtifactVersion,
  blobs: BlobStore,
): VersionArchive {
  const plan = planArchive(saved.manifest.entries);
  return {
    body: streamFromAsyncIterable(writeArchive(plan, blobs)),
    byteLength: plan.byteLength,
  };
}

function planArchive(entries: readonly ManifestEntry[]): ArchivePlan {
  const zip32 = planArchiveFormat(entries, "zip32");
  if (
    entries.length < zip32MaximumEntries
    && zip32.centralDirectoryOffset < zip32Maximum
    && zip32.centralDirectorySize < zip32Maximum
    && zip32.entries.every(({entry, localHeaderOffset}) =>
      BigInt(entry.size) < zip32Maximum && localHeaderOffset < zip32Maximum
    )
  ) {
    return zip32;
  }
  return planArchiveFormat(entries, "zip64");
}

function planArchiveFormat(
  entries: readonly ManifestEntry[],
  format: ArchivePlan["format"],
): ArchivePlan {
  const planned: ArchiveEntryPlan[] = [];
  let offset = 0n;
  for (const entry of entries) {
    const name = textEncoder.encode(entry.path);
    if (name.byteLength > 0xffff) {
      throw new Error("A manifest path cannot fit in a ZIP filename field.");
    }
    planned.push({entry, localHeaderOffset: offset, name});
    offset += BigInt(
      localHeaderBytes
      + name.byteLength
      + (format === "zip64" ? zip64LocalExtraBytes : 0)
      + (format === "zip64" ? zip64DescriptorBytes : zip32DescriptorBytes),
    ) + BigInt(entry.size);
  }
  const centralDirectoryOffset = offset;
  const centralDirectorySize = planned.reduce(
    (total, {name}) => total + BigInt(
      centralHeaderBytes
      + name.byteLength
      + (format === "zip64" ? zip64CentralExtraBytes : 0),
    ),
    0n,
  );
  const endBytes = format === "zip64"
    ? zip64EndBytes + zip64LocatorBytes + zip32EndBytes
    : zip32EndBytes;
  return {
    byteLength: centralDirectoryOffset + centralDirectorySize + BigInt(endBytes),
    centralDirectoryOffset,
    centralDirectorySize,
    entries: planned,
    format,
  };
}

async function* writeArchive(
  plan: ArchivePlan,
  blobs: BlobStore,
): AsyncGenerator<Uint8Array> {
  const crcByPath = new Map<string, number>();
  for (const planned of plan.entries) {
    const finalizedCrc = yield* writeArchiveEntry(planned, plan.format, blobs);
    crcByPath.set(planned.entry.path, finalizedCrc);
    yield dataDescriptor(finalizedCrc, planned.entry.size, plan.format);
  }

  for (const planned of plan.entries) {
    const crc = crcByPath.get(planned.entry.path);
    if (crc === undefined) {
      throw new Error("A ZIP entry reached the directory without a CRC.");
    }
    yield centralDirectoryHeader(planned, crc, plan.format);
  }

  if (plan.format === "zip64") {
    const zip64EndOffset = plan.centralDirectoryOffset
      + plan.centralDirectorySize;
    yield zip64EndRecord(plan);
    yield zip64Locator(zip64EndOffset);
  }
  yield zip32EndRecord(plan);
}

async function* writeArchiveEntry(
  planned: ArchiveEntryPlan,
  format: ArchivePlan["format"],
  blobs: BlobStore,
): AsyncGenerator<Uint8Array, number> {
  yield localFileHeader(planned, format);
  const opened = await blobs.open(planned.entry.sha256);
  if (opened.size !== planned.entry.size) {
    await opened.body.cancel();
    throw storedBlobSizeMismatch(
      planned.entry.sha256,
      planned.entry.size,
      opened.size,
    );
  }

  let crc = 0xffff_ffff;
  let observedSize = 0n;
  for await (const chunk of opened.body) {
    observedSize += BigInt(chunk.byteLength);
    if (observedSize > BigInt(planned.entry.size)) {
      throw storedBlobSizeMismatch(
        planned.entry.sha256,
        planned.entry.size,
        observedSize,
      );
    }
    crc = updateCrc32(crc, chunk);
    yield chunk;
  }
  if (observedSize !== BigInt(planned.entry.size)) {
    throw storedBlobSizeMismatch(
      planned.entry.sha256,
      planned.entry.size,
      observedSize,
    );
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function localFileHeader(
  planned: ArchiveEntryPlan,
  format: ArchivePlan["format"],
): Uint8Array {
  const extraLength = format === "zip64" ? zip64LocalExtraBytes : 0;
  const bytes = new Uint8Array(localHeaderBytes + planned.name.byteLength + extraLength);
  const view = byteView(bytes);
  view.setUint32(0, 0x0403_4b50, true);
  view.setUint16(4, format === "zip64" ? zip64Version : zip32Version, true);
  view.setUint16(6, zipFlags, true);
  view.setUint16(8, storedCompression, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, dosEpochDate, true);
  view.setUint32(14, 0, true);
  view.setUint32(18, format === "zip64" ? 0xffff_ffff : 0, true);
  view.setUint32(22, format === "zip64" ? 0xffff_ffff : 0, true);
  view.setUint16(26, planned.name.byteLength, true);
  view.setUint16(28, extraLength, true);
  bytes.set(planned.name, localHeaderBytes);
  if (format === "zip64") {
    const extraOffset = localHeaderBytes + planned.name.byteLength;
    view.setUint16(extraOffset, zip64ExtraField, true);
    view.setUint16(extraOffset + 2, 16, true);
    view.setBigUint64(extraOffset + 4, BigInt(planned.entry.size), true);
    view.setBigUint64(extraOffset + 12, BigInt(planned.entry.size), true);
  }
  return bytes;
}

function dataDescriptor(
  crc: number,
  size: number,
  format: ArchivePlan["format"],
): Uint8Array {
  const bytes = new Uint8Array(
    format === "zip64" ? zip64DescriptorBytes : zip32DescriptorBytes,
  );
  const view = byteView(bytes);
  view.setUint32(0, 0x0807_4b50, true);
  view.setUint32(4, crc, true);
  if (format === "zip64") {
    view.setBigUint64(8, BigInt(size), true);
    view.setBigUint64(16, BigInt(size), true);
  } else {
    view.setUint32(8, size, true);
    view.setUint32(12, size, true);
  }
  return bytes;
}

function centralDirectoryHeader(
  planned: ArchiveEntryPlan,
  crc: number,
  format: ArchivePlan["format"],
): Uint8Array {
  const extraLength = format === "zip64" ? zip64CentralExtraBytes : 0;
  const bytes = new Uint8Array(
    centralHeaderBytes + planned.name.byteLength + extraLength,
  );
  const view = byteView(bytes);
  view.setUint32(0, 0x0201_4b50, true);
  view.setUint16(4, format === "zip64" ? zip64Version : zip32Version, true);
  view.setUint16(6, format === "zip64" ? zip64Version : zip32Version, true);
  view.setUint16(8, zipFlags, true);
  view.setUint16(10, storedCompression, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, dosEpochDate, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, format === "zip64" ? 0xffff_ffff : planned.entry.size, true);
  view.setUint32(24, format === "zip64" ? 0xffff_ffff : planned.entry.size, true);
  view.setUint16(28, planned.name.byteLength, true);
  view.setUint16(30, extraLength, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(
    42,
    format === "zip64" ? 0xffff_ffff : Number(planned.localHeaderOffset),
    true,
  );
  bytes.set(planned.name, centralHeaderBytes);
  if (format === "zip64") {
    const extraOffset = centralHeaderBytes + planned.name.byteLength;
    view.setUint16(extraOffset, zip64ExtraField, true);
    view.setUint16(extraOffset + 2, 24, true);
    view.setBigUint64(extraOffset + 4, BigInt(planned.entry.size), true);
    view.setBigUint64(extraOffset + 12, BigInt(planned.entry.size), true);
    view.setBigUint64(extraOffset + 20, planned.localHeaderOffset, true);
  }
  return bytes;
}

function zip64EndRecord(plan: ArchivePlan): Uint8Array {
  const bytes = new Uint8Array(zip64EndBytes);
  const view = byteView(bytes);
  view.setUint32(0, 0x0606_4b50, true);
  view.setBigUint64(4, 44n, true);
  view.setUint16(12, zip64Version, true);
  view.setUint16(14, zip64Version, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, 0, true);
  view.setBigUint64(24, BigInt(plan.entries.length), true);
  view.setBigUint64(32, BigInt(plan.entries.length), true);
  view.setBigUint64(40, plan.centralDirectorySize, true);
  view.setBigUint64(48, plan.centralDirectoryOffset, true);
  return bytes;
}

function zip64Locator(zip64EndOffset: bigint): Uint8Array {
  const bytes = new Uint8Array(zip64LocatorBytes);
  const view = byteView(bytes);
  view.setUint32(0, 0x0706_4b50, true);
  view.setUint32(4, 0, true);
  view.setBigUint64(8, zip64EndOffset, true);
  view.setUint32(16, 1, true);
  return bytes;
}

function zip32EndRecord(plan: ArchivePlan): Uint8Array {
  const bytes = new Uint8Array(zip32EndBytes);
  const view = byteView(bytes);
  const zip64 = plan.format === "zip64";
  const entryCount = zip64 ? zip32MaximumEntries : plan.entries.length;
  view.setUint32(0, 0x0605_4b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(
    12,
    zip64 ? 0xffff_ffff : Number(plan.centralDirectorySize),
    true,
  );
  view.setUint32(
    16,
    zip64 ? 0xffff_ffff : Number(plan.centralDirectoryOffset),
    true,
  );
  view.setUint16(20, 0, true);
  return bytes;
}

function byteView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let updated = crc;
  for (const byte of bytes) {
    const tableValue = crc32Table[(updated ^ byte) & 0xff];
    if (tableValue === undefined) {
      throw new Error("The CRC-32 lookup table is incomplete.");
    }
    updated = tableValue ^ (updated >>> 8);
  }
  return updated;
}

const crc32Table = Uint32Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1
      ? 0xedb8_8320 ^ (value >>> 1)
      : value >>> 1;
  }
  return value >>> 0;
});

function storedBlobSizeMismatch(
  digest: string,
  expected: number,
  actual: number | bigint,
): Error {
  return new Error(
    `Stored blob ${digest} is ${actual} bytes but its manifest records ${expected}.`,
  );
}

function streamFromAsyncIterable(
  source: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async cancel() {
      await iterator.return?.();
    },
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (cause) {
        controller.error(cause);
      }
    },
  });
}

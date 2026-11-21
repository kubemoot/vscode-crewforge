import * as zlib from 'node:zlib';

/** Limits that keep a malformed or hostile archive from using up memory. */
export const ZIP_LIMITS = { entries: 100_000, entryBytes: 8 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const CENTRAL_FIXED = 46;
const LOCAL_FIXED = 30;

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** Finds the end-of-central-directory record, searching back past an optional comment. */
function findEnd(zip: Buffer): number {
  const lowest = Math.max(0, zip.length - EOCD_MIN - 0xffff);
  for (let at = zip.length - EOCD_MIN; at >= lowest; at--) {
    if (zip.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  }
  throw new Error('The memory export is not a zip file.');
}

function centralEntries(zip: Buffer): CentralEntry[] {
  const end = findEnd(zip);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (count > ZIP_LIMITS.entries) throw new Error('The memory export holds too many files.');
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_FIXED > zip.length || zip.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new Error('The memory export zip is damaged.');
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    entries.push({
      name: zip.toString('utf8', at + CENTRAL_FIXED, at + CENTRAL_FIXED + nameLength),
      method: zip.readUInt16LE(at + 10),
      compressedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      offset: zip.readUInt32LE(at + 42),
    });
    at += CENTRAL_FIXED + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryData(zip: Buffer, e: CentralEntry): Buffer {
  if (e.size > ZIP_LIMITS.entryBytes) throw new Error(`The file ${e.name} in the memory export is too large.`);
  if (e.offset + LOCAL_FIXED > zip.length || zip.readUInt32LE(e.offset) !== LOCAL_SIGNATURE) throw new Error('The memory export zip is damaged.');
  const start = e.offset + LOCAL_FIXED + zip.readUInt16LE(e.offset + 26) + zip.readUInt16LE(e.offset + 28);
  const raw = zip.subarray(start, start + e.compressedSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: ZIP_LIMITS.entryBytes });
  throw new Error(`The file ${e.name} in the memory export uses an unsupported zip method (${e.method}).`);
}

/** The files of a zip by path. Directories are left out; stored and deflated entries are read. */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const e of centralEntries(zip)) {
    if (e.name.endsWith('/')) continue;
    const data = entryData(zip, e);
    total += data.length;
    if (total > ZIP_LIMITS.totalBytes) throw new Error('The memory export is too large.');
    files.set(e.name, data);
  }
  return files;
}

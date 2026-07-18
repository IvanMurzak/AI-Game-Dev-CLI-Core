/**
 * A tiny STORED-method ZIP builder for the unzip / server-download tests — produces a valid archive
 * (local file headers + central directory + EOCD) with no external dependency. CRC32 is left 0 (the
 * reader does not verify it). Compression method is STORED (0), so `parseZip` reads the bytes back
 * verbatim; that is enough to exercise the extraction + checksum-gate paths.
 */

import { deflateRawSync } from "node:zlib";

const LFH_SIG = 0x04034b50;
const CDH_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

export function makeZip(files: Record<string, Buffer | string>, opts: { deflate?: boolean } = {}): Buffer {
  const method = opts.deflate ? 8 : 0;
  const entries = Object.entries(files).map(([name, data]) => {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8");
    return { name, raw, stored: opts.deflate ? deflateRawSync(raw) : raw };
  });

  const localParts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(0, 14); // crc32 (unused by reader)
    lfh.writeUInt32LE(entry.stored.length, 18); // compressed size
    lfh.writeUInt32LE(entry.raw.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length

    const localHeaderOffset = offset;
    const localBlock = Buffer.concat([lfh, nameBuf, entry.stored]);
    localParts.push(localBlock);
    offset += localBlock.length;

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(CDH_SIG, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(0, 16); // crc32
    cdh.writeUInt32LE(entry.stored.length, 20); // compressed size
    cdh.writeUInt32LE(entry.raw.length, 24); // uncompressed size
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra length
    cdh.writeUInt16LE(0, 32); // comment length
    cdh.writeUInt32LE(localHeaderOffset, 42);
    central.push(Buffer.concat([cdh, nameBuf]));
  }

  const localBlob = Buffer.concat(localParts);
  const centralBlob = Buffer.concat(central);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16); // central dir offset

  return Buffer.concat([localBlob, centralBlob, eocd]);
}

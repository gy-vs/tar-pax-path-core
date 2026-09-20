import { encodePaxPair } from '../src/index.js';

export const BLOCK = 512;
const ZERO = new Uint8Array(BLOCK);

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function writeField(block: Uint8Array, offset: number, value: string | Uint8Array, max: number): void {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  block.set(bytes.subarray(0, max), offset);
}

function octal(value: number, width: number): Uint8Array {
  const s = value.toString(8).padStart(width - 1, '0') + '\0';
  return new TextEncoder().encode(s);
}

export interface HeaderOptions {
  name?: string | Uint8Array;
  linkname?: string | Uint8Array;
  typeflag?: string;
  size?: number;
  mode?: number;
  /** Skip magic/version (pre-POSIX header). */
  legacy?: boolean;
  /** Corrupt one name byte AFTER computing the checksum. */
  corruptNameByte?: number;
  /** Overwrite the checksum field with junk after building. */
  badChecksum?: boolean;
  /** Leave the size field as spaces (unparseable). */
  unparseableSize?: boolean;
}

/** Build one ustar header block (with correct checksum unless damaged). */
export function header(opts: HeaderOptions = {}): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeField(block, 0, opts.name ?? '', 100);
  writeField(block, 100, octal(opts.mode ?? 0o644, 8), 8);
  writeField(block, 108, octal(0, 8), 8); // uid
  writeField(block, 116, octal(0, 8), 8); // gid
  if (opts.unparseableSize) writeField(block, 124, '            ', 12);
  else writeField(block, 124, octal(opts.size ?? 0, 12), 12);
  writeField(block, 136, octal(0, 12), 12); // mtime
  // Checksum field is 7 bytes (148..154); byte 155 is trailing space and
  // byte 156 is the typeflag, which must stay intact.
  for (let i = 148; i < 155; i++) block[i] = 0x20;
  block[155] = 0x20;
  block[156] = opts.typeflag ? opts.typeflag.charCodeAt(0) : 0x30;
  writeField(block, 157, opts.linkname ?? '', 100);
  if (!opts.legacy) {
    writeField(block, 257, 'ustar\0', 6);
    writeField(block, 263, '00', 2);
  }

  let sum = 0;
  for (const b of block) sum += b;
  const chk = sum.toString(8).padStart(6, '0') + '\0';
  writeField(block, 148, chk, 7);

  if (opts.corruptNameByte !== undefined) {
    block[opts.corruptNameByte] = block[opts.corruptNameByte] === 0x58 ? 0x59 : 0x58;
  }
  if (opts.badChecksum) writeField(block, 148, 'zzzzzzzz', 8);
  return block;
}

export function zeroBlock(): Uint8Array {
  return new Uint8Array(ZERO);
}

function padTo(size: number): Uint8Array[] {
  const pad = (BLOCK - (size % BLOCK)) % BLOCK;
  return pad > 0 ? [new Uint8Array(pad)] : [];
}

/** A regular entry: header block(s) + payload blocks. */
export function file(
  name: string | Uint8Array,
  data: Uint8Array,
  typeflag = '0',
  linkname?: string | Uint8Array,
): Uint8Array {
  return concat(
    header({ name, typeflag, size: data.length, linkname }),
    data,
    ...padTo(data.length),
  );
}

/** A GNU longname ("L") or longlink ("K") extension record. */
export function gnuRecord(flag: 'L' | 'K', value: string | Uint8Array): Uint8Array {
  const payload = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const size = payload.length + 1; // trailing NUL as GNU writes it
  const block = header({ name: `././@LongLink`, typeflag: flag, size });
  const padded = new Uint8Array(Math.ceil(size / BLOCK) * BLOCK);
  padded.set(payload, 0);
  padded[payload.length] = 0;
  return concat(block, padded);
}

/** A PAX global ("g") or local ("x") record built from raw pairs. */
export function paxRecord(
  flag: 'g' | 'x',
  pairs: Array<[string, string | Uint8Array]>,
  name = 'pax/header',
): Uint8Array {
  let payload = new Uint8Array(0);
  for (const [k, v] of pairs) payload = concat(payload, encodePaxPair(k, v));
  const block = header({ name, typeflag: flag, size: payload.length });
  const padded = new Uint8Array(Math.ceil(payload.length / BLOCK) * BLOCK);
  padded.set(payload, 0);
  return concat(block, padded);
}

export function endOfArchive(): Uint8Array {
  return concat(zeroBlock(), zeroBlock());
}

/** Repeat a byte into a buffer of exactly n bytes. */
export function bytes(n: number, fill = 0x61): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

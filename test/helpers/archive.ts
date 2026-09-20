/** Minimal TAR archive builder for tests (ustar, PAX and GNU records). */
import { BLOCK } from '../../src/format.js';

const enc = new TextEncoder();

function writeString(buf: Uint8Array, off: number, s: string): void {
	const bytes = enc.encode(s);
	buf.set(bytes, off);
}

function writeOctal(buf: Uint8Array, off: number, len: number, value: number): void {
	let s = value.toString(8).padStart(len - 1, '0') + '\0';
	if (s.length > len) s = s.slice(0, len);
	buf.set(enc.encode(s), off);
}

export interface HeaderOpts {
	name?: string;
	nameBytes?: Uint8Array;
	prefix?: string;
	linkname?: string;
	typeflag?: string;
	size?: number;
	mode?: number;
	mtime?: number;
	uid?: number;
	gid?: number;
	uname?: string;
	gname?: string;
	gnu?: boolean;
}

export function header(o: HeaderOpts = {}): Uint8Array {
	const buf = new Uint8Array(BLOCK);
	if (o.nameBytes) {
		buf.set(o.nameBytes.subarray(0, 100), 0);
	} else {
		buf.set(enc.encode(o.name ?? '').subarray(0, 100), 0);
	}
	writeOctal(buf, 100, 8, o.mode ?? 0o644);
	writeOctal(buf, 108, 8, o.uid ?? 0);
	writeOctal(buf, 116, 8, o.gid ?? 0);
	writeOctal(buf, 124, 12, o.size ?? 0);
	writeOctal(buf, 136, 12, o.mtime ?? 0);
	// checksum field spaces first
	for (let i = 148; i < 156; i++) buf[i] = 0x20;
	buf[156] = (o.typeflag ?? '0').charCodeAt(0);
	writeString(buf, 157, (o.linkname ?? '').slice(0, 100));
	// magic
	buf.set(enc.encode(o.gnu ? 'ustar  \0' : 'ustar\0'), 257);
	writeString(buf, 265, (o.uname ?? '').slice(0, 32));
	writeString(buf, 297, (o.gname ?? '').slice(0, 32));
	if (o.prefix) writeString(buf, 345, o.prefix.slice(0, 155));

	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += buf[i]!;
	const chk = sum.toString(8).padStart(6, '0') + '\0 ';
	buf.set(enc.encode(chk), 148);
	return buf;
}

function dataBlock(payload: Uint8Array): Uint8Array[] {
	const blocks: Uint8Array[] = [];
	for (let i = 0; i < payload.length; i += BLOCK) {
		const b = new Uint8Array(BLOCK);
		b.set(payload.subarray(i, i + BLOCK), 0);
		blocks.push(b);
	}
	if (payload.length === 0) return [];
	return blocks;
}

export function file(
	name: string,
	contents: string | Uint8Array = '',
	o: HeaderOpts = {},
): Uint8Array[] {
	const bytes = typeof contents === 'string' ? enc.encode(contents) : contents;
	return [
		header({ ...o, name, size: bytes.length, typeflag: o.typeflag ?? '0' }),
		...dataBlock(bytes),
	];
}

export function dir(name: string, o: HeaderOpts = {}): Uint8Array[] {
	const n = name.endsWith('/') ? name : name + '/';
	return [header({ ...o, name: n, typeflag: '5', size: 0 })];
}

export function link(
	name: string,
	target: string,
	hard = false,
	o: HeaderOpts = {},
): Uint8Array[] {
	return [
		header({
			...o,
			name,
			linkname: target,
			typeflag: hard ? '1' : '2',
			size: 0,
		}),
	];
}

function paxPayload(records: Array<[string, string]>): Uint8Array {
	const parts: Uint8Array[] = [];
	let total = 0;
	for (const [k, v] of records) {
		// "%d %s=%s\n": declared length counts the whole record including
		// the decimal length itself; add digits until the total is stable.
		const tail = enc.encode(` ${k}=${v}\n`);
		let digits = 1;
		for (;;) {
			const totalLen = digits + tail.length;
			if (String(totalLen).length === digits) {
				parts.push(enc.encode(`${totalLen} ${k}=${v}\n`));
				total += totalLen;
				break;
			}
			digits = String(totalLen).length;
		}
	}
	const out = new Uint8Array(total);
	let p = 0;
	for (const part of parts) {
		out.set(part, p);
		p += part.length;
	}
	return out;
}

export function localPax(
	records: Array<[string, string]>,
): Uint8Array[] {
	const payload = paxPayload(records);
	return [header({ typeflag: 'x', size: payload.length }), ...dataBlock(payload)];
}

export function globalPax(
	records: Array<[string, string]>,
): Uint8Array[] {
	const payload = paxPayload(records);
	return [header({ typeflag: 'g', size: payload.length }), ...dataBlock(payload)];
}

export function gnuLong(
	longName: string | Uint8Array,
	kind: 'name' | 'link' = 'name',
): Uint8Array[] {
	const payload = typeof longName === 'string' ? enc.encode(longName) : longName;
	return [
		header({ typeflag: kind === 'name' ? 'L' : 'K', size: payload.length, gnu: true }),
		...dataBlock(payload),
	];
}

export const zeroBlock = (): Uint8Array => new Uint8Array(BLOCK);

export function concat(...parts: Array<Uint8Array | Uint8Array[]>): Uint8Array {
	const flat: Uint8Array[] = [];
	for (const p of parts) {
		if (Array.isArray(p)) flat.push(...p);
		else flat.push(p);
	}
	const total = flat.reduce((n, b) => n + b.length, 0);
	const out = new Uint8Array(total);
	let p = 0;
	for (const b of flat) {
		out.set(b, p);
		p += b.length;
	}
	return out;
}

/** Corrupt a header checksum in-place at the given block index. */
export function corruptChecksum(archive: Uint8Array, blockIndex: number): Uint8Array {
	const out = archive.slice();
	const off = blockIndex * BLOCK;
	out[off] = out[off]! === 0x61 ? 0x62 : 0x61;
	return out;
}

/** Replace a whole 512-byte block with non-zero garbage. */
export function garbageBlock(archive: Uint8Array, blockIndex: number): Uint8Array {
	const out = archive.slice();
	const off = blockIndex * BLOCK;
	for (let i = 0; i < BLOCK; i++) out[off + i] = 0xff;
	return out;
}

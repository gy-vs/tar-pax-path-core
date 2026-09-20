/**
 * Byte-level TAR record decoding: ustar/v7 header fields, checksum,
 * PAX keyword records and text handling.
 */
import type { PaxMap, TarEntryType } from './model.js';

export const BLOCK = 512;

const textDecoder = new TextDecoder('utf-8', { fatal: false });
const latin1 = new TextDecoder('latin1');

/** Decode a field as UTF-8 with U+FFFD replacement for invalid sequences. */
export function decodeUtf8(bytes: Uint8Array): string {
	return textDecoder.decode(bytes);
}

/** Lossless 1:1 byte->char decode, used for ustar name fields (pre-PAX era). */
export function decodeLatin1(bytes: Uint8Array): string {
	return latin1.decode(bytes);
}

/** Remove trailing NULs, then trailing spaces (PAX/ustar field convention). */
export function trimField(bytes: Uint8Array): Uint8Array {
	let end = bytes.length;
	while (end > 0 && bytes[end - 1] === 0) end--;
	while (end > 0 && bytes[end - 1] === 0x20) end--;
	return bytes.subarray(0, end);
}

/** Parse a NUL/space-padded octal field; supports base-256 high-bit encoding. */
export function parseNumeric(bytes: Uint8Array): number {
	if (bytes.length === 0) return 0;
	if (bytes[0]! & 0x80) {
		// Base-256: top bit set, remaining 7 bits of first byte are part of value.
		let v = BigInt(bytes[0]! & 0x7f);
		for (let i = 1; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]!);
		if (v > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
		return Number(v);
	}
	const text = decodeLatin1(trimField(bytes));
	if (text === '') return 0;
	const n = Number.parseInt(text, 8);
	return Number.isFinite(n) ? n : 0;
}

export function verifyChecksum(block: Uint8Array): number | undefined {
	const stored = parseNumeric(block.subarray(148, 156));
	let unsigned = 0;
	let signed = 0;
	for (let i = 0; i < BLOCK; i++) {
		const b = block[i]!;
		unsigned += i >= 148 && i < 156 ? 0x20 : b;
		signed += i >= 148 && i < 156 ? 0x20 : (b > 127 ? b - 256 : b);
	}
	if (stored === unsigned || stored === signed) return stored;
	return undefined;
}

export function isZeroBlock(block: Uint8Array): boolean {
	for (let i = 0; i < BLOCK; i++) if (block[i] !== 0) return false;
	return true;
}

/** "ustar\0" (POSIX) or "ustar " (GNU) magic at offset 257. */
export function hasUstarMagic(block: Uint8Array): boolean {
	return (
		block[257] === 0x75 && // u
		block[258] === 0x73 && // s
		block[259] === 0x74 && // t
		block[260] === 0x61 && // a
		block[261] === 0x72 && // r
		(block[262] === 0 || block[262] === 0x20)
	);
}

export function mapTypeflag(flag: number): TarEntryType {
	switch (flag) {
		case 0:
		case 0x30: // '0'
		case 0x37: // '7' contiguous file
			return 'file';
		case 0x35: // '5'
			return 'directory';
		case 0x31: // '1'
			return 'hardlink';
		case 0x32: // '2'
			return 'symlink';
		default:
			return 'other';
	}
}

export interface ParsedHeader {
	typeflag: number;
	type: TarEntryType;
	nameBytes: Uint8Array;
	linkBytes: Uint8Array;
	size: number;
	mode: number;
	uid: number;
	gid: number;
	mtime: number;
	uname: string;
	gname: string;
	/** ustar prefix field joined to name ("prefix/name"). */
	prefixBytes: Uint8Array;
}

export function parseHeader(block: Uint8Array): ParsedHeader {
	const typeflag = block[156]!;
	const nameBytes = trimField(block.subarray(0, 100));
	const prefixBytes = trimField(block.subarray(345, 500));
	return {
		typeflag,
		type: mapTypeflag(typeflag),
		nameBytes,
		linkBytes: trimField(block.subarray(157, 257)),
		size: parseNumeric(block.subarray(124, 136)),
		mode: parseNumeric(block.subarray(100, 108)),
		uid: parseNumeric(block.subarray(108, 116)),
		gid: parseNumeric(block.subarray(116, 124)),
		mtime: parseNumeric(block.subarray(136, 148)),
		uname: decodeLatin1(trimField(block.subarray(265, 297))),
		gname: decodeLatin1(trimField(block.subarray(297, 329))),
		prefixBytes,
	};
}

/** Full ustar path bytes, joining prefix when present. */
export function ustarPathBytes(h: ParsedHeader): Uint8Array {
	if (h.prefixBytes.length === 0) return h.nameBytes;
	const out = new Uint8Array(h.prefixBytes.length + 1 + h.nameBytes.length);
	out.set(h.prefixBytes, 0);
	out[h.prefixBytes.length] = 0x2f; // '/'
	out.set(h.nameBytes, h.prefixBytes.length + 1);
	return out;
}

/** Strip exactly one trailing slash (directories are commonly stored with it). */
export function stripTrailingSlash(s: string): string {
	return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Parse a PAX record payload into a keyword map.
 *
 * Format per record: "%d %s=%s\n" where %d is the *record length* including
 * itself and the newline. Keyword length/value are taken as literal bytes
 * between the first space and the first '='. Empty value => deletion tombstone.
 * Duplicate keywords: later record wins (standard PAX semantics).
 *
 * Returns successfully parsed records plus a bad-flag if framing was broken;
 * the caller turns that into a warning but still applies what was parsed.
 */
export function parsePax(
	data: Uint8Array,
): { map: PaxMap; bad: boolean } {
	const map: PaxMap = new Map();
	let pos = 0;
	let bad = false;
	const buf = data;

	while (pos < buf.length) {
		// Find space that ends the length field.
		let sp = pos;
		while (sp < buf.length && buf[sp] !== 0x20) sp++;
		if (sp >= buf.length) break;

		const lenText = decodeLatin1(buf.subarray(pos, sp));
		const declared = Number.parseInt(lenText, 10);

		// Determine record end from declared length, else next newline.
		let end: number;
		if (Number.isFinite(declared) && declared > 0 && pos + declared <= buf.length) {
			end = pos + declared;
			if (buf[end - 1] !== 0x0a) bad = true;
		} else {
			end = sp + 1;
			while (end < buf.length && buf[end] !== 0x0a) end++;
			if (end >= buf.length) {
				bad = true;
				break;
			}
			end++; // consume newline
			bad = true; // length field was unusable
		}

		// "keyword=value" sits between sp+1 and the final newline.
		let eq = sp + 1;
		while (eq < end - 1 && buf[eq] !== 0x3d) eq++; // '='
		if (buf[eq] !== 0x3d) {
			bad = true;
			pos = end;
			continue;
		}

		const keyword = decodeLatin1(buf.subarray(sp + 1, eq));
		let valueEnd = end - 1; // exclude the trailing newline
		while (valueEnd > eq && buf[valueEnd - 1] === 0) valueEnd--; // NUL padding
		const valueBytes = buf.subarray(eq + 1, valueEnd);
		const value = valueBytes.length === 0 ? null : decodeUtf8(valueBytes);
		map.set(keyword, value);
		pos = end;
	}

	return { map, bad };
}

/** Apply PAX keyword records to an existing map (deletions included). */
export function applyPaxOps(target: PaxMap, ops: PaxMap): void {
	for (const [k, v] of ops) target.set(k, v);
}

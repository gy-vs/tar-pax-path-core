/**
 * The shared metadata state machine.
 *
 * Both the synchronous buffer API (`parseTar`) and the async data-stream API
 * (`openTar`) drive this one machine, so listing and extraction observe the
 * exact same final metadata.
 *
 * Scope rules implemented here:
 *
 * - global PAX (`g`) ........ mutable scope for every subsequent entry;
 *                             reset at an end-of-archive marker (two zero
 *                             blocks) so archive concatenation starts clean.
 * - local PAX (`x`) ......... one-shot, consumed by the next real header.
 * - GNU longname/link (L/K) . one-shot, consumed by the next real header.
 * - every one-shot is consumed exactly once. A corrupt next header (or a zero
 *   block, or EOF) discards it with an `orphan-one-shot` warning instead of
 *   letting it leak to a later entry.
 */
import {
	decodeUtf8,
	hasUstarMagic,
	parseHeader,
	parsePax,
	stripTrailingSlash,
	ustarPathBytes,
	verifyChecksum,
} from './format.js';
import type {
	MetadataLayer,
	PaxMap,
	PendingGnu,
	ResolvedField,
	SourceRef,
	TarEntryMeta,
	TarWarning,
} from './model.js';

const SPECIAL = new Set([0x78, 0x67, 0x4c, 0x4b]); // x, g, L, K

interface PendingLocal {
	map: PaxMap;
	offset: number;
}

export type HeaderAction =
	| { kind: 'special'; typeflag: number; size: number; offset: number }
	| { kind: 'entry'; meta: TarEntryMeta; size: number };

interface Candidate {
	layer: MetadataLayer;
	key?: string;
	offset: number;
	value: string | number | undefined;
	deleted?: boolean;
}

export class TarStateMachine {
	/** Global PAX scope: null = deletion tombstone. */
	readonly globalPax: PaxMap = new Map();
	/** Offset of the global record that last set each keyword. */
	readonly globalOffsets: Map<string, number> = new Map();

	#pendingLocal: PendingLocal | undefined;
	#pendingGnu: PendingGnu = {};

	archiveIndex = 0;
	#zeroRun = 0;

	constructor(private readonly warnings: TarWarning[]) {}

	/** Strict header test used while resynchronising after a corrupt block. */
	isResyncCandidate(block: Uint8Array): boolean {
		return hasUstarMagic(block) && verifyChecksum(block) !== undefined;
	}

	/** A corrupt block cannot be the entry the pending records belonged to. */
	corruptBlock(offset: number): void {
		this.#zeroRun = 0;
		this.#discardPending('corrupt header', offset);
	}

	/** Garbage skipped during resync also breaks zero-block runs. */
	skippedBlock(): void {
		this.#zeroRun = 0;
	}

	zeroBlock(offset: number): void {
		this.#discardPending('end-of-archive marker', offset);
		this.#zeroRun++;
		if (this.#zeroRun === 2) {
			// End of this archive member: global scope must not leak into
			// the next concatenated archive.
			this.globalPax.clear();
			this.globalOffsets.clear();
			this.archiveIndex++;
		}
	}

	/** Any non-zero header-like block resets the zero-block run. */
	header(block: Uint8Array, offset: number): HeaderAction {
		this.#zeroRun = 0;
		const h = parseHeader(block);

		if (SPECIAL.has(h.typeflag)) {
			return { kind: 'special', typeflag: h.typeflag, size: h.size, offset };
		}

		const meta = this.#buildEntry(h, block, offset);
		return { kind: 'entry', meta, size: meta.size };
	}

	/** Deliver the (already padded-stripped) payload of a special record. */
	specialData(typeflag: number, offset: number, data: Uint8Array): void {
		switch (typeflag) {
			case 0x4c: // GNU longname
				this.#pendingGnu.longname = stripTrailingNuls(data);
				this.#pendingGnu.longnameOffset = offset;
				return;
			case 0x4b: // GNU longlink
				this.#pendingGnu.linkname = stripTrailingNuls(data);
				this.#pendingGnu.linknameOffset = offset;
				return;
			case 0x78: {
				// local PAX: a second x before any entry replaces the first.
				const { map, bad } = parsePax(data);
				this.#pendingLocal = { map, offset };
				if (bad) this.warn('bad-pax-record', offset);
				return;
			}
			case 0x67: {
				const { map, bad } = parsePax(data);
				for (const [k, v] of map) {
					this.globalPax.set(k, v);
					this.globalOffsets.set(k, offset);
				}
				if (bad) this.warn('bad-pax-record', offset);
				return;
			}
		}
	}

	/** EOF: one-shots never consumed are reported, never reused. */
	flush(): void {
		this.#discardPending('end of input', undefined);
	}

	#discardPending(where: string, offset: number | undefined): boolean {
		const had = this.#pendingLocal !== undefined ||
			this.#pendingGnu.longname !== undefined ||
			this.#pendingGnu.linkname !== undefined;
		if (had) {
			this.warnings.push({
				code: 'orphan-one-shot',
				message: `one-shot extension record(s) discarded at ${where}`,
				offset: offset ?? -1,
			});
		}
		this.#pendingLocal = undefined;
		this.#pendingGnu = {};
		return had;
	}

	warn(
		code: TarWarning['code'],
		offset: number,
		message?: string,
	): void {
		this.warnings.push({
			code,
			message: message ?? code,
			offset,
		});
	}

	#buildEntry(
		h: ReturnType<typeof parseHeader>,
		block: Uint8Array,
		offset: number,
	): TarEntryMeta {
		const local = this.#pendingLocal?.map;
		const localOffset = this.#pendingLocal?.offset;
		const gnu = this.#pendingGnu;

		const localDel = (key: string) => local?.get(key) === null;
		const globalRaw = (key: string) =>
			this.globalPax.has(key) ? this.globalPax.get(key) : undefined;
		const pax = (key: string): string | null | undefined =>
			local?.has(key) ? local.get(key) : globalRaw(key);

		// ---- path -------------------------------------------------------
		const ustarBytes = ustarPathBytes(h);
		const ustarPath = stripTrailingSlash(decodeUtf8(ustarBytes));
		const gnuPathBytes = gnu.longname;
		const gnuPath = gnuPathBytes
			? stripTrailingSlash(decodeUtf8(gnuPathBytes))
			: undefined;

		const pathCandidates: Candidate[] = [
			{ layer: 'ustar', offset, value: ustarPath },
			{
				layer: 'globalPax',
				key: 'path',
				offset: this.globalOffsets.get('path') ?? -1,
				value: globalRaw('path') ?? undefined,
				deleted: globalRaw('path') === null || localDel('path'),
			},
			{
				layer: 'gnuLong',
				offset: gnu.longnameOffset ?? -1,
				value: gnuPath,
			},
			{
				layer: 'localPax',
				key: 'path',
				offset: localOffset ?? -1,
				value: local?.get('path') ?? undefined,
				deleted: localDel('path'),
			},
		];
		const path = this.#resolve(pathCandidates);
		const pathBytes = this.#resolveBytes(
			path.source,
			ustarBytes,
			gnuPathBytes,
			local,
			'path',
		);

		// ---- linkpath ---------------------------------------------------
		const linkCandidates: Candidate[] = [
			{ layer: 'ustar', offset, value: h.linkBytes.length ? decodeUtf8(h.linkBytes) : undefined },
			{
				layer: 'globalPax',
				key: 'linkpath',
				offset: this.globalOffsets.get('linkpath') ?? -1,
				value: globalRaw('linkpath') ?? undefined,
				deleted: globalRaw('linkpath') === null || localDel('linkpath'),
			},
			{
				layer: 'gnuLong',
				offset: gnu.linknameOffset ?? -1,
				value: gnu.linkname ? decodeUtf8(gnu.linkname) : undefined,
			},
			{
				layer: 'localPax',
				key: 'linkpath',
				offset: localOffset ?? -1,
				value: local?.get('linkpath') ?? undefined,
				deleted: localDel('linkpath'),
			},
		];
		const link = this.#resolve(linkCandidates);
		const linkBytes = this.#resolveBytes(
			link.source,
			h.linkBytes,
			gnu.linkname,
			local,
			'linkpath',
		);

		// ---- numeric fields --------------------------------------------
		const size = this.#resolve([
			{ layer: 'ustar', offset, value: h.size },
			{
				layer: 'globalPax', key: 'size',
				offset: this.globalOffsets.get('size') ?? -1,
				value: numericPax(globalRaw('size')),
				deleted: globalRaw('size') === null || localDel('size'),
			},
			{
				layer: 'localPax', key: 'size',
				offset: localOffset ?? -1,
				value: numericPax(local?.get('size')),
				deleted: localDel('size'),
			},
		]);

		const mode = this.#resolve([
			{ layer: 'ustar', offset, value: h.mode },
			{
				layer: 'globalPax', key: 'mode',
				offset: this.globalOffsets.get('mode') ?? -1,
				value: octalPax(globalRaw('mode')),
				deleted: globalRaw('mode') === null || localDel('mode'),
			},
			{
				layer: 'localPax', key: 'mode',
				offset: localOffset ?? -1,
				value: octalPax(local?.get('mode')),
				deleted: localDel('mode'),
			},
		]);

		const mtimeSec = this.#resolve([
			{ layer: 'ustar', offset, value: h.mtime },
			{
				layer: 'globalPax', key: 'mtime',
				offset: this.globalOffsets.get('mtime') ?? -1,
				value: numericPax(globalRaw('mtime')),
				deleted: globalRaw('mtime') === null || localDel('mtime'),
			},
			{
				layer: 'localPax', key: 'mtime',
				offset: localOffset ?? -1,
				value: numericPax(local?.get('mtime')),
				deleted: localDel('mtime'),
			},
		]);

		const uid = numericPax(pax('uid')) ?? h.uid;
		const gid = numericPax(pax('gid')) ?? h.gid;
		const uname = pax('uname') ?? h.uname;
		const gname = pax('gname') ?? h.gname;

		// Directories are conventionally stored with a trailing slash in
		// every layer; normalise the *resolved* result consistently.
		const finalPath =
			h.type === 'directory'
				? stripTrailingSlash(path.value as string)
				: (path.value as string);
		const finalLink =
			link.value === undefined ? undefined : (link.value as string);

		const meta: TarEntryMeta = {
			type: h.type,
			typeflag: String.fromCharCode(h.typeflag),
			path: finalPath,
			pathBytes,
			linkPath: finalLink,
			linkPathBytes: linkBytes,
			size: (size.value as number) ?? 0,
			mode: (mode.value as number) ?? 0,
			uid,
			gid,
			uname: uname ?? '',
			gname: gname ?? '',
			mtime: new Date((mtimeSec.value as number) * 1000),
			globalPax: this.#exposedGlobals(local),
			localPax: this.#exposedLocals(local),
			sources: {
				path: path.source!,
				linkPath: link.source,
				size: size.source!,
				mode: mode.source!,
				mtime: mtimeSec.source!,
			},
			pathProvenance: this.#provenance(pathCandidates, path.source!, h.type === 'directory'),
			headerOffset: offset,
			archiveIndex: this.archiveIndex,
		};

		// One-shots are consumed exactly here, exactly once.
		this.#pendingLocal = undefined;
		this.#pendingGnu = {};
		return meta;
	}

	#resolve(candidates: Candidate[]): ResolvedField<string | number> {
		for (let i = candidates.length - 1; i >= 0; i--) {
			const c = candidates[i]!;
			if (!c.deleted && c.value !== undefined) {
				return {
					value: c.value,
					source: { layer: c.layer, key: c.key, offset: c.offset },
				};
			}
		}
		const fallback = candidates[0]!;
		return {
			value: (fallback.value ?? '') as string | number,
			source: { layer: fallback.layer, offset: fallback.offset },
		};
	}

	#resolveBytes(
		source: SourceRef,
		ustar: Uint8Array,
		gnu: Uint8Array | undefined,
		local: PaxMap | undefined,
		localKey: string,
	): Uint8Array {
		switch (source.layer) {
			case 'gnuLong':
				return gnu ?? ustar;
			case 'localPax': {
				const v = local?.get(localKey);
				return v ? new TextEncoder().encode(v) : ustar;
			}
			case 'globalPax': {
				const v = this.globalPax.get(localKey);
				return v === undefined || v === null ? ustar : new TextEncoder().encode(v);
			}
			default:
				return ustar;
		}
	}

	#provenance(
		candidates: Candidate[],
		winner: SourceRef,
		isDirectory: boolean,
	): TarEntryMeta['pathProvenance'] {
		const out: TarEntryMeta['pathProvenance'] = [];
		for (const c of candidates) {
			if (c.deleted || c.value === undefined) continue;
			const value = isDirectory
				? stripTrailingSlash(String(c.value))
				: String(c.value);
			out.push({
				layer: c.layer,
				offset: c.offset,
				value,
				maskedBy: c.layer === winner.layer ? undefined : winner.layer,
			});
		}
		return out;
	}

	#exposedGlobals(local: PaxMap | undefined): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [k, v] of this.globalPax) {
			if (v === null) continue;
			if (local?.get(k) === null) continue; // local deletion applies here
			out[k] = v;
		}
		return out;
	}

	#exposedLocals(local: PaxMap | undefined): Record<string, string> {
		const out: Record<string, string> = {};
		if (!local) return out;
		for (const [k, v] of local) if (v !== null) out[k] = v;
		return out;
	}
}

function numericPax(v: string | null | undefined): number | undefined {
	if (v === null || v === undefined) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

/** GNU longname/longlink payloads are NUL-terminated; trim padding NULs. */
function stripTrailingNuls(data: Uint8Array): Uint8Array {
	let end = data.length;
	while (end > 0 && data[end - 1] === 0) end--;
	return data.subarray(0, end);
}

function octalPax(v: string | null | undefined): number | undefined {
	if (v === null || v === undefined) return undefined;
	const n = Number.parseInt(v, 8);
	return Number.isFinite(n) ? n : undefined;
}

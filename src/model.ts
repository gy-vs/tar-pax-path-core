/**
 * Metadata merge model for a single TAR entry.
 *
 * Scope / precedence, low to high:
 *
 *   1. ustar header            scope: this entry          ("ustar")
 *   2. global PAX (`g`/PaxG)   scope: every later entry   ("globalPax")
 *   3. GNU one-shot (`L`/`K`)  scope: exactly next entry   ("gnuLong" / "gnuLongLink")
 *   4. local PAX (`x`/PaxX)    scope: exactly next entry   ("localPax")
 *
 * PAX records are consumed *before* the header they decorate is parsed, so for
 * fields they share (path/size/…) the local PAX value is the authoritative one.
 * GNU longname is an older one-shot override for the ustar name field only; it
 * sits below local PAX but above a global PAX value for `path`, matching GNU tar:
 * the one-shot record explicitly describes the immediately following header.
 *
 * A PAX keyword whose value is the empty string is a *deletion*: local PAX
 * deletion removes both the local value and the global value for that entry;
 * global PAX deletion removes it from the global scope. Resolution then falls
 * through to the next layer.
 */

export type TarEntryType =
	| 'file'
	| 'directory'
	| 'symlink'
	| 'hardlink'
	| 'other';

/** Which record layer supplied a resolved field. */
export type MetadataLayer =
	| 'ustar'
	| 'globalPax'
	| 'gnuLong'
	| 'localPax';

/** Pointer to the exact record that supplied (or deleted) a value. */
export interface SourceRef {
	layer: MetadataLayer;
	/** PAX keyword, e.g. "path" / "linkpath" / "size"; absent for ustar/GNU. */
	key?: string;
	/** Byte offset of the 512-byte record within the concatenated archive. */
	offset: number;
}

/** One-shot GNU record pending consumption by the next header. */
export interface PendingGnu {
	longname?: Uint8Array;
	longnameOffset?: number;
	linkname?: Uint8Array;
	linknameOffset?: number;
}

/**
 * PAX keyword maps.
 * `null` is a deletion tombstone (keyword present with an empty value).
 */
export type PaxMap = Map<string, string | null>;

export interface TarWarning {
	code:
		| 'bad-header-checksum'
		| 'bad-pax-record'
		| 'truncated-data'
		| 'truncated-header'
		| 'orphan-one-shot';
	message: string;
	/** Offset of the 512-byte record the warning relates to. */
	offset: number;
}

/** Final, merged metadata consumed by both list and data-stream APIs. */
export interface TarEntryMeta {
	type: TarEntryType;
	/** Raw ustar typeflag byte, e.g. "x" for local PAX is never emitted. */
	typeflag: string;

	/** Resolved entry path (always a string; see pathBytes for raw bytes). */
	path: string;
	/** Raw bytes of the resolved path before any lossy UTF-8 decoding. */
	pathBytes: Uint8Array;

	/** Link target for symlink/hardlink, resolved with the same precedence. */
	linkPath: string | undefined;
	linkPathBytes: Uint8Array | undefined;

	size: number;
	mode: number;
	uid: number;
	gid: number;
	uname: string;
	gname: string;
	mtime: Date | undefined;

	/** Global PAX keywords in force for this entry (after local deletions). */
	globalPax: Record<string, string>;
	/** Local PAX keywords for this entry (deletions omitted). */
	localPax: Record<string, string>;

	/** Winning record for every resolved typed field. */
	sources: {
		path: SourceRef;
		linkPath?: SourceRef;
		size: SourceRef;
		mode: SourceRef;
		mtime: SourceRef;
	};

	/**
	 * Every layer that carried a path-like value, in resolution order.
	 * Explains *why* the final path won: `maskedBy` points at the layer
	 * that overrode it (undefined on the winner).
	 */
	pathProvenance: Array<{
		layer: MetadataLayer;
		offset: number;
		value: string;
		maskedBy?: MetadataLayer;
	}>;

	/** Byte offset of this entry's ustar header within the archive. */
	headerOffset: number;
	/** 0-based index of the member archive (concat support). */
	archiveIndex: number;
}

export interface ResolvedField<T> {
	value: T;
	source: SourceRef;
}

/** Layer order for path resolution (see file header). */
const PATH_LAYERS: MetadataLayer[] = [
	'ustar',
	'globalPax',
	'gnuLong',
	'localPax',
];

/**
 * Resolve one typed field through the four layers.
 *
 * Returns the highest-precedence non-deleted value plus the provenance chain.
 */
export function resolveField<T>(candidates: Array<{
	layer: MetadataLayer;
	key?: string;
	offset: number;
	value: T | undefined;
	deleted?: boolean;
}>): { value: T | undefined; source?: SourceRef; chain: Array<{ layer: MetadataLayer; offset: number; present: boolean }> } {
	const chain = candidates.map((c) => ({ layer: c.layer, offset: c.offset, present: c.value !== undefined && !c.deleted }));
	for (let i = candidates.length - 1; i >= 0; i--) {
		const c = candidates[i]!;
		if (!c.deleted && c.value !== undefined) {
			return {
				value: c.value,
				source: { layer: c.layer, key: c.key, offset: c.offset },
				chain,
			};
		}
	}
	return { value: undefined, source: undefined, chain };
}

export function layerRank(layer: MetadataLayer): number {
	return PATH_LAYERS.indexOf(layer);
}

/**
 * Backwards-compatible plain merge used by callers that already hold the
 * parsed pieces. Precedence mirrors resolveField():
 * local PAX > GNU one-shot > global PAX > ustar header.
 */
export function mergeMetadata(
	header: { path: string; size: number },
	globalPax: Record<string, string>,
	localPax: Record<string, string>,
	longname?: string,
): { path: string; size: number } {
	const path =
		localPax.path ?? longname ?? globalPax.path ?? header.path;
	const size = Number(
		localPax.size ?? globalPax.size ?? header.size,
	);
	return { path, size: Number.isFinite(size) ? size : header.size };
}

/**
 * Public surface.
 *
 * Two consumers, one metadata model:
 * - `parseTar(buffer)` — list API, synchronous, returns every entry's final
 *   merged metadata plus parser warnings.
 * - `openTar(stream)` — data-flow API, async; yields the same
 *   {@link TarEntryMeta} and gives access to body bytes.
 *
 * `ArchiveIndex` wraps either result for path-based lookups.
 */
export { parseTar } from './buffer.js';
export type { TarListing } from './buffer.js';
export { openTar } from './reader.js';
export type { ByteSource as TarByteSource, StreamedEntry, TarStreamReader } from './reader.js';
export {
	mergeMetadata,
	resolveField,
	layerRank,
} from './model.js';
export type {
	MetadataLayer,
	PaxMap,
	PendingGnu,
	ResolvedField,
	SourceRef,
	TarEntryMeta,
	TarEntryType,
	TarWarning,
} from './model.js';
export { BLOCK, parsePax, verifyChecksum } from './format.js';

import type { TarEntryMeta } from './model.js';

export class ArchiveIndex {
	#entries: TarEntryMeta[] = [];
	#byPath = new Map<string, TarEntryMeta>();

	add(entry: TarEntryMeta): void {
		this.#entries.push(entry);
		// Duplicate paths: keep the last, like a real extraction would.
		this.#byPath.set(entry.path, entry);
	}

	addAll(entries: Iterable<TarEntryMeta>): void {
		for (const e of entries) this.add(e);
	}

	list(): TarEntryMeta[] {
		return this.#entries.slice();
	}

	find(path: string): TarEntryMeta | undefined {
		return this.#byPath.get(path);
	}

	/** Human-readable explanation of which record won the final path. */
	explain(path: string): string {
		const e = this.#byPath.get(path);
		if (!e) return `${path}: not found`;
		const lines = e.pathProvenance.map((p) => {
			const verb = p.maskedBy ? `overridden by ${p.maskedBy}` : 'WINNER';
			return `  ${p.layer.padEnd(9)} @${p.offset} ${JSON.stringify(p.value)}  ${verb}`;
		});
		return [`${path}:`, ...lines].join('\n');
	}
}

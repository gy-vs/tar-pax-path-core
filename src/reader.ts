/**
 * Async data-stream driver of the same {@link TarStateMachine}.
 *
 * Metadata is built by the identical machine used by `parseTar`, so a listing
 * and a streamed extraction can never disagree. Bodies are exposed on the
 * entry; unread bodies are drained automatically when iteration advances.
 */
import { BLOCK, isZeroBlock, verifyChecksum } from './format.js';
import { TarStateMachine } from './parser.js';
import type { TarEntryMeta, TarWarning } from './model.js';

export type ByteSource =
	| ReadableStream<Uint8Array>
	| AsyncIterable<Uint8Array>
	| Iterable<Uint8Array>;

class BlockReader {
	#buffered: Uint8Array[] = [];
	#size = 0;
	#done = false;
	readonly #next: () => Promise<IteratorResult<Uint8Array>>;

	constructor(source: ByteSource) {
		const stream = source as ReadableStream<Uint8Array>;
		if (typeof stream.getReader === 'function') {
			const reader = stream.getReader();
			this.#next = () => reader.read();
		} else if ((source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]) {
			const it = (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]!();
			this.#next = () => it.next();
		} else {
			const it = (source as Iterable<Uint8Array>)[Symbol.iterator]();
			this.#next = async () => it.next();
		}
	}

	/** Read exactly `size` bytes. Short/empty result means EOF. */
	async read(size: number): Promise<Uint8Array | null> {
		while (this.#size < size && !this.#done) {
			const { value, done } = await this.#next();
			if (done) {
				this.#done = true;
				break;
			}
			if (value && value.length) {
				this.#buffered.push(value);
				this.#size += value.length;
			}
		}
		if (this.#size === 0) return null;
		const n = Math.min(size, this.#size);
		const out = new Uint8Array(n);
		let filled = 0;
		while (filled < n) {
			const chunk = this.#buffered[0]!;
			const take = Math.min(chunk.length, n - filled);
			out.set(chunk.subarray(0, take), filled);
			filled += take;
			if (take === chunk.length) this.#buffered.shift();
			else this.#buffered[0] = chunk.subarray(take);
		}
		this.#size -= n;
		return out;
	}
}

export interface StreamedEntry {
	meta: TarEntryMeta;
	/** Read the next chunk of body bytes; null at end of body. */
	readBody(): Promise<Uint8Array | null>;
	/** Collect the entire remaining body. */
	body(): Promise<Uint8Array>;
}

export interface TarStreamReader {
	entries(): AsyncIterableIterator<StreamedEntry>;
	readonly warnings: TarWarning[];
}

export function openTar(source: ByteSource): TarStreamReader {
	const warnings: TarWarning[] = [];
	const sm = new TarStateMachine(warnings);
	const io = new BlockReader(source);
	let offset = 0;

	async function* iterate(): AsyncIterableIterator<StreamedEntry> {
		let bodyLeft = 0;
		let bodyOffset = -1;

		// Drain a body the consumer did not fully read, then its padding.
		async function finishBody(meta: TarEntryMeta): Promise<boolean> {
			let truncated = false;
			while (bodyLeft > 0) {
				const b = await io.read(bodyLeft);
				if (b === null || b.length === 0) {
					truncated = true;
					break;
				}
				bodyLeft -= b.length;
			}
			bodyLeft = 0;
			if (truncated) {
				warnings.push({
					code: 'truncated-data',
					message: `entry ${meta.path} declares ${meta.size} bytes; stream ends early`,
					offset: bodyOffset,
				});
				return false;
			}
			// Body complete: skip padding to the next 512-byte boundary.
			const pad = (BLOCK - (meta.size % BLOCK)) % BLOCK;
			if (pad) await io.read(pad);
			offset += meta.size + pad;
			return true;
		}

		headerLoop: for (;;) {
			const headerOffset = offset;
			const block = await io.read(BLOCK);
			if (block === null) break;
			offset += block.length;

			if (block.length < BLOCK) {
				warnings.push({
					code: 'truncated-header',
					message: `stream ends with a partial ${block.length}-byte block`,
					offset: headerOffset,
				});
				break;
			}

			if (isZeroBlock(block)) {
				sm.zeroBlock(headerOffset);
				continue;
			}

			if (verifyChecksum(block) === undefined) {
				warnings.push({
					code: 'bad-header-checksum',
					message: 'invalid header checksum; resynchronising',
					offset: headerOffset,
				});
				sm.corruptBlock(headerOffset);
				for (;;) {
					const o = offset;
					const b = await io.read(BLOCK);
					if (b === null) break headerLoop;
					offset += b.length;
					if (b.length < BLOCK) {
						warnings.push({
							code: 'truncated-header',
							message: 'partial block while resynchronising',
							offset: o,
						});
						break headerLoop;
					}
					if (isZeroBlock(b)) {
						sm.zeroBlock(o);
						continue headerLoop;
					}
					if (sm.isResyncCandidate(b)) {
						sm.skippedBlock();
						yield* handleHeader(b, o);
						continue headerLoop;
					}
				}
			}

			yield* handleHeader(block, headerOffset);
		}

		async function* handleHeader(
			block: Uint8Array,
			headerOffset: number,
		): AsyncIterableIterator<StreamedEntry> {
			const action = sm.header(block, headerOffset);

			if (action.kind === 'special') {
				const total = Math.ceil(action.size / BLOCK) * BLOCK;
				const buf = await io.read(total);
				offset += total;
				if (buf === null || buf.length < total) {
					const got = buf ? Math.min(buf.length, action.size) : 0;
					warnings.push({
						code: 'truncated-data',
						message: `special record declares ${action.size} bytes; ${got} available`,
						offset: headerOffset,
					});
					sm.specialData(
						action.typeflag,
						action.offset,
						buf ? buf.subarray(0, got) : new Uint8Array(0),
					);
					return;
				}
				sm.specialData(
					action.typeflag,
					action.offset,
					buf.subarray(0, action.size),
				);
				return;
			}

			const meta = action.meta;
			bodyLeft = meta.size;
			bodyOffset = headerOffset;
			let consumed = 0;
			let streamEnded = false;

			const readBody = async (): Promise<Uint8Array | null> => {
				if (bodyLeft === 0 || streamEnded) return null;
				const b = await io.read(Math.min(BLOCK * 16, bodyLeft));
				if (b === null || b.length === 0) {
					streamEnded = true;
					return null;
				}
				bodyLeft -= b.length;
				consumed += b.length;
				return b;
			};

			const body = async (): Promise<Uint8Array> => {
				const out = new Uint8Array(meta.size);
				let n = 0;
				for (;;) {
					const b = await readBody();
					if (b === null) break;
					out.set(b, n);
					n += b.length;
				}
				return out.subarray(0, n);
			};

			yield { meta, readBody, body };

			// Generator resumed here once the consumer moves on: drain the
			// unread body plus padding before the outer loop reads a header.
			const complete = await finishBody(meta);
			if (!complete) return;
		}

		sm.flush();
	}

	return {
		warnings,
		entries() {
			return iterate();
		},
	};
}

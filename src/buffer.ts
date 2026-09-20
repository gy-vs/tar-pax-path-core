/**
 * Synchronous, whole-buffer driver of the shared {@link TarStateMachine}.
 * Produces the listing metadata; body bytes can be sliced from the input using
 * `headerOffset`/`size`, or read through the streaming driver in `reader.ts`.
 */
import { BLOCK, isZeroBlock, verifyChecksum } from './format.js';
import { TarStateMachine } from './parser.js';
import type { TarEntryMeta, TarWarning } from './model.js';

export interface TarListing {
	entries: TarEntryMeta[];
	warnings: TarWarning[];
}

export function parseTar(input: Uint8Array): TarListing {
	const warnings: TarWarning[] = [];
	const sm = new TarStateMachine(warnings);
	const entries: TarEntryMeta[] = [];

	let pos = 0;

	while (pos < input.length) {
		const offset = pos;
		const block = input.subarray(pos, pos + BLOCK);

		if (block.length < BLOCK) {
			warnings.push({
				code: 'truncated-header',
				message: `input ends with a partial ${block.length}-byte block`,
				offset,
			});
			break;
		}

		if (isZeroBlock(block)) {
			sm.zeroBlock(offset);
			pos += BLOCK;
			continue;
		}

		if (verifyChecksum(block) === undefined) {
			warnings.push({
				code: 'bad-header-checksum',
				message: 'invalid header checksum; resynchronising',
				offset,
			});
			sm.corruptBlock(offset);
			pos += BLOCK;
			// Resync: advance until a plausible ustar header or a zero block.
			while (pos < input.length) {
				const b = input.subarray(pos, pos + BLOCK);
				if (b.length < BLOCK) break;
				if (isZeroBlock(b) || sm.isResyncCandidate(b)) break;
				pos += BLOCK;
			}
			if (pos < input.length) sm.skippedBlock();
			continue;
		}

		const action = sm.header(block, offset);
		pos += BLOCK;

		if (action.kind === 'special') {
			const total = Math.ceil(action.size / BLOCK) * BLOCK;
			let payload: Uint8Array;
			if (pos + total <= input.length) {
				payload = input.subarray(pos, pos + action.size);
				pos += total;
			} else {
				payload = input.subarray(pos, Math.min(input.length, pos + action.size));
				warnings.push({
					code: 'truncated-data',
					message: `special record at ${offset} declares ${action.size} bytes; ${payload.length} available`,
					offset,
				});
				pos = input.length;
			}
			sm.specialData(action.typeflag, action.offset, payload);
		} else {
			entries.push(action.meta);
			const total = Math.ceil(action.size / BLOCK) * BLOCK;
			if (pos + total > input.length) {
				warnings.push({
					code: 'truncated-data',
					message: `entry ${action.meta.path} declares ${action.size} bytes; archive ends early`,
					offset,
				});
				pos = input.length;
			} else {
				pos += total;
			}
		}
	}

	sm.flush();
	return { entries, warnings };
}

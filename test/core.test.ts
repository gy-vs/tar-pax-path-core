import { describe, expect, it } from 'vitest';
import {
	ArchiveIndex,
	mergeMetadata,
	openTar,
	parseTar,
	type TarEntryMeta,
} from '../src/index.js';
import { BLOCK } from '../src/format.js';
import {
	concat,
	dir,
	file,
	garbageBlock,
	globalPax,
	gnuLong,
	header,
	link,
	localPax,
	zeroBlock,
} from './helpers/archive.js';

function paths(input: Uint8Array): string[] {
	return parseTar(input).entries.map((e) => e.path);
}

/** Stream API yields exactly the same metadata as the list API. */
async function streamed(input: Uint8Array): Promise<TarEntryMeta[]> {
	const reader = openTar((async function* () {
		// Feed awkwardly-sized chunks to stress buffering.
		for (let i = 0; i < input.length; i += 333) {
			yield input.subarray(i, i + 333);
		}
	})());
	const out: TarEntryMeta[] = [];
	for await (const e of reader.entries()) {
		await e.body();
		out.push(e.meta);
	}
	return out;
}

describe('precedence: ustar < global PAX < GNU longname < local PAX', () => {
	it('all four layers present: local PAX wins with full provenance', () => {
		const archive = concat(
			globalPax([['path', 'GLOBAL/path'], ['size', '12']]),
			gnuLong('GNU/long/name'),
			localPax([['path', 'LOCAL/path']]),
			file('short', 'hello-world'), // 11 bytes, every layer disagrees
		);
		const { entries, warnings } = parseTar(archive);
		expect(warnings).toEqual([]);
		const e = entries[0]!;

		expect(e.path).toBe('LOCAL/path');
		expect(e.sources.path.layer).toBe('localPax');
		expect(e.size).toBe(12); // global size, uncontested by local
		expect(e.sources.size.layer).toBe('globalPax');

		expect(e.pathProvenance.map((p) => p.layer)).toEqual([
			'ustar',
			'globalPax',
			'gnuLong',
			'localPax',
		]);
		const winner = e.pathProvenance.find((p) => p.maskedBy === undefined)!;
		expect(winner.layer).toBe('localPax');
		expect(e.pathProvenance.filter((p) => p.maskedBy === 'localPax')).toHaveLength(3);

		// Layout: g-hdr(0) g-data(1) L-hdr(2) L-data(3) x-hdr(4)
		// x-data(5) entry(6) entry-data(7).
		expect(e.sources.path.offset).toBe(4 * BLOCK);
		expect(e.headerOffset).toBe(6 * BLOCK);
	});

	it('GNU longname beats global PAX path but local PAX beats longname', () => {
		const a = concat(
			globalPax([['path', 'from-global']]),
			gnuLong('from-gnu'),
			file('hdr'),
		);
		const first = parseTar(a).entries[0]!;
		expect(first.path).toBe('from-gnu');
		expect(first.sources.path.layer).toBe('gnuLong');

		const b = concat(
			gnuLong('from-gnu'),
			file('hdr'),
		);
		expect(parseTar(b).entries[0]!.path).toBe('from-gnu');

		const c = concat(
			globalPax([['path', 'from-global']]),
			file('plain'),
		);
		expect(parseTar(c).entries[0]!.path).toBe('from-global');
	});

	it('backward-compatible mergeMetadata helper follows the same order', () => {
		const m = mergeMetadata(
			{ path: 'h', size: 1 },
			{ path: 'g' },
			{ path: 'l' },
			'gnu',
		);
		expect(m.path).toBe('l');
		const m2 = mergeMetadata({ path: 'h', size: 1 }, { path: 'g' }, {}, 'gnu');
		expect(m2.path).toBe('gnu');
		const m3 = mergeMetadata({ path: 'h', size: 1 }, { path: 'g' }, {});
		expect(m3.path).toBe('g');
	});
});

describe('one-shot records are consumed exactly once', () => {
	it('GNU longname never leaks to the entry after the next one', () => {
		const archive = concat(
			gnuLong('only-the-next'),
			file('hdr-a', 'A'),
			file('hdr-b', 'BB'),
		);
		const entries = parseTar(archive).entries;
		expect(entries.map((e) => e.path)).toEqual(['only-the-next', 'hdr-b']);
		expect(entries[1]!.sources.path.layer).toBe('ustar');
	});

	it('local PAX never leaks either, while global PAX persists', () => {
		const archive = concat(
			globalPax([['path', 'G']]),
			localPax([['path', 'L1']]),
			file('a'),
			file('b'),
		);
		expect(paths(archive)).toEqual(['L1', 'G']);
	});

	it('consecutive longnames: the last one wins, first is discarded', () => {
		const archive = concat(
			gnuLong('first'),
			gnuLong('second'),
			gnuLong('third'),
			file('hdr'),
		);
		const { entries, warnings } = parseTar(archive);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.path).toBe('third');
		// Each GNU longname is header + 1 data block; third one starts at 4.
		expect(entries[0]!.sources.path.offset).toBe(4 * BLOCK);
		// Silent overwrite: the replaced one-shot still found its consumer.
		expect(warnings).toEqual([]);
	});

	it('NUL-terminated GNU payload (as GNU tar writes) is trimmed', () => {
		const payload = new Uint8Array(120);
		payload.set(new TextEncoder().encode('real/name'), 0); // rest is NUL
		const pad = new Uint8Array(BLOCK - payload.length);
		const archive = concat(
			header({ typeflag: 'L', size: payload.length, gnu: true }),
			payload,
			pad,
			file('hdr'),
		);
		const e = parseTar(archive).entries[0]!;
		expect(e.path).toBe('real/name');
		expect([...e.pathBytes]).toEqual([...new TextEncoder().encode('real/name')]);
	});

	it('consecutive local PAX blocks: the map is replaced, not merged', () => {
		const archive = concat(
			localPax([['path', 'first']]),
			localPax([['size', '9']]), // no path here
			file('hdr', '0123456789'),
		);
		const e = parseTar(archive).entries[0]!;
		expect(e.path).toBe('hdr'); // first map discarded -> ustar name
		expect(e.size).toBe(9);
		expect(e.sources.path.layer).toBe('ustar');
	});

	it('corrupt next header drops the pending longname instead of leaking', () => {
		// L record, then two garbage blocks (bad header + its "data"),
		// then a valid header: resync must land on the survivor.
		let archive = concat(
			gnuLong('must-not-leak'),
			new Uint8Array(BLOCK * 2),
			file('survivor', 'ok'),
		);
		archive = garbageBlock(archive, 1); // the L record is block 0
		archive = garbageBlock(archive, 2);
		const { entries, warnings } = parseTar(archive);
		expect(warnings.some((w) => w.code === 'bad-header-checksum')).toBe(true);
		expect(warnings.some((w) => w.code === 'orphan-one-shot')).toBe(true);
		expect(entries.map((e) => e.path)).toEqual(['survivor']);
		expect(entries[0]!.sources.path.layer).toBe('ustar');
	});

	it('pending records before an end-of-archive marker are dropped', () => {
		const archive = concat(
			gnuLong('orphan'),
			zeroBlock(),
			zeroBlock(),
			file('next-archive-file'),
		);
		const { entries, warnings } = parseTar(archive);
		expect(warnings.some((w) => w.code === 'orphan-one-shot')).toBe(true);
		expect(entries[0]!.path).toBe('next-archive-file');
	});
});

describe('PAX deletions and duplicate keys', () => {
	it('empty local value deletes the key for this entry, including global value', () => {
		const archive = concat(
			globalPax([['path', 'GLOBAL'], ['size', '42']]),
			localPax([['path', ''], ['size', '']]),
			file('ustar-name', 'body'),
		);
		const e = parseTar(archive).entries[0]!;
		expect(e.path).toBe('ustar-name'); // falls all the way through
		expect(e.sources.path.layer).toBe('ustar');
		expect(e.size).toBe(4);
		expect(e.sources.size.layer).toBe('ustar');
		expect(e.globalPax).not.toHaveProperty('path');
		expect(e.globalPax).not.toHaveProperty('size');
	});

	it('empty local path deletes global but GNU longname still applies', () => {
		const archive = concat(
			globalPax([['path', 'GLOBAL']]),
			gnuLong('gnu-fallback'),
			localPax([['path', '']]),
			file('hdr'),
		);
		const e = parseTar(archive).entries[0]!;
		expect(e.path).toBe('gnu-fallback');
		expect(e.sources.path.layer).toBe('gnuLong');
		expect(e.pathProvenance.map((p) => p.layer)).toEqual([
			'ustar',
			'gnuLong',
		]);
	});

	it('empty value inside global PAX removes the global key afterwards', () => {
		const archive = concat(
			globalPax([['path', 'FIRST-GLOBAL']]),
			file('a'),
			globalPax([['path', '']]), // delete the global path
			file('b'),
		);
		const entries = parseTar(archive).entries;
		expect(entries[0]!.path).toBe('FIRST-GLOBAL');
		expect(entries[1]!.path).toBe('b');
		expect(entries[1]!.sources.path.layer).toBe('ustar');
	});

	it('duplicate keyword inside one local PAX block: last one wins', () => {
		// Build the payload by hand with one duplicated keyword.
		const enc = new TextEncoder();
		const mk = (k: string, v: string) => {
			const tail = enc.encode(` ${k}=${v}\n`);
			let digits = 1;
			for (;;) {
				const total = digits + tail.length;
				if (String(total).length === digits) {
					return enc.encode(`${total} ${k}=${v}\n`);
				}
				digits = String(total).length;
			}
		};
		const payload = (() => {
			const a = mk('path', 'first');
			const b = mk('path', 'second');
			const out = new Uint8Array(a.length + b.length);
			out.set(a, 0);
			out.set(b, a.length);
			return out;
		})();
		const padLen = (BLOCK - (payload.length % BLOCK)) % BLOCK;
		const arch = concat(
			header({ typeflag: 'x', size: payload.length }),
			payload,
			new Uint8Array(padLen),
			file('hdr'),
		);
		const e = parseTar(arch).entries[0]!;
		expect(e.path).toBe('second');
	});
});

describe('corrupt intermediate header resynchronisation', () => {
	it('recovers entries after the corrupt block without metadata bleed', () => {
		// good file, garbage header, garbage data, good file.
		const good1 = file('good-1', 'aaa');
		const good2 = file('good-2', 'bbb');
		let archive = concat(good1, new Uint8Array(BLOCK), new Uint8Array(BLOCK), good2);
		archive = garbageBlock(archive, good1.length); // first bad block
		archive = garbageBlock(archive, good1.length + 1); // and its "data"
		const { entries, warnings } = parseTar(archive);
		expect(warnings.some((w) => w.code === 'bad-header-checksum')).toBe(true);
		expect(entries.map((e) => e.path)).toEqual(['good-1', 'good-2']);
	});
});

describe('directories and links', () => {
	it('directory trailing slash is normalised; type is preserved', () => {
		const e = parseTar(concat(dir('mydir'))).entries[0]!;
		expect(e.path).toBe('mydir');
		expect(e.type).toBe('directory');
	});

	it('symlink linkpath resolves through ustar/global/GNU/local layers', () => {
		const ustar = parseTar(concat(link('l', 'ustar-target'))).entries[0]!;
		expect(ustar.linkPath).toBe('ustar-target');
		expect(ustar.sources.linkPath!.layer).toBe('ustar');

		const gnu = parseTar(concat(
			gnuLong('gnu-target', 'link'),
			link('l', 'short'),
		)).entries[0]!;
		expect(gnu.linkPath).toBe('gnu-target');
		expect(gnu.sources.linkPath!.layer).toBe('gnuLong');

		const both = parseTar(concat(
			globalPax([['linkpath', 'global-target']]),
			gnuLong('gnu-target', 'link'),
			localPax([['linkpath', 'local-target']]),
			link('l', 'short'),
		)).entries[0]!;
		expect(both.linkPath).toBe('local-target');
		expect(both.type).toBe('symlink');
	});

	it('hardlinks keep type and target independently of path', () => {
		const e = parseTar(concat(link('h', 'dest', true))).entries[0]!;
		expect(e.type).toBe('hardlink');
		expect(e.linkPath).toBe('dest');
	});
});

describe('non-UTF-8 names', () => {
	it('raw bytes are retained verbatim in pathBytes; string is lossy', () => {
		const raw = new Uint8Array([0x66, 0x2f, 0xff, 0xfe, 0x66]); // f/\xff\xfef
		const arch = concat([
			header({ nameBytes: raw, size: 0 }),
		]);
		const e = parseTar(arch).entries[0]!;
		expect([...e.pathBytes]).toEqual([...raw]);
		expect(e.path).toContain('�');
	});

	it('PAX path (UTF-8) overrides a byte-named ustar header round-trip cleanly', () => {
		const unicode = 'café/日本語.tar';
		const arch = concat(
			localPax([['path', unicode]]),
			file('short', 'x'),
		);
		const e = parseTar(arch).entries[0]!;
		expect(e.path).toBe(unicode);
		expect(new TextDecoder().decode(e.pathBytes)).toBe(unicode);
	});
});

describe('archive concatenation', () => {
	it('global PAX resets at a two-zero-block archive boundary', () => {
		const first = concat(
			globalPax([['path', 'A-GLOBAL']]),
			file('a1'),
			zeroBlock(),
			zeroBlock(),
		);
		const second = concat(file('plain-b'));
		const { entries } = parseTar(concat(first, second));
		expect(entries.map((e) => e.path)).toEqual(['A-GLOBAL', 'plain-b']);
		expect(entries[0]!.archiveIndex).toBe(0);
		expect(entries[1]!.archiveIndex).toBe(1);
	});

	it('a single zero block does not reset global scope', () => {
		// One zero block then another valid header: still archive #0, global alive.
		const archive = concat(
			globalPax([['path', 'G']]),
			zeroBlock(),
			file('after-one-zero'),
			zeroBlock(),
			zeroBlock(),
		);
		const { entries } = parseTar(archive);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.path).toBe('G');
		expect(entries[0]!.archiveIndex).toBe(0);
	});

	it('three concatenated archives get incrementing indexes and isolated globals', () => {
		const a = concat(globalPax([['path', 'A']]), file('x'), zeroBlock(), zeroBlock());
		const b = concat(globalPax([['path', 'B']]), file('y'), zeroBlock(), zeroBlock());
		const c = concat(file('z'));
		const entries = parseTar(concat(a, b, c)).entries;
		expect(entries.map((e) => e.path)).toEqual(['A', 'B', 'z']);
		expect(entries.map((e) => e.archiveIndex)).toEqual([0, 1, 2]);
	});
});

describe('list API and stream API consume the same metadata', () => {
	it('identical paths, sources, sizes and provenance on a mixed archive', async () => {
		const archive = concat(
			globalPax([['path', 'G']]),
			gnuLong('gnu-name'),
			localPax([['size', '3']]),
			file('short', 'abc'),
			file('plain', 'xy'),
			gnuLong('second-long'),
			file('zzz'),
			zeroBlock(),
			zeroBlock(),
			concat(globalPax([['path', 'G2']]), file('cat')),
		);
		const listed = parseTar(archive).entries;
		const flowed = await streamed(archive);
		expect(flowed).toHaveLength(listed.length);
		for (let i = 0; i < listed.length; i++) {
			expect(flowed[i]!.path).toBe(listed[i]!.path);
			expect(flowed[i]!.size).toBe(listed[i]!.size);
			expect(flowed[i]!.type).toBe(listed[i]!.type);
			expect(flowed[i]!.sources.path.layer).toBe(listed[i]!.sources.path.layer);
			expect(flowed[i]!.archiveIndex).toBe(listed[i]!.archiveIndex);
			expect(flowed[i]!.pathProvenance).toEqual(listed[i]!.pathProvenance);
		}
	});

	it('stream body bytes match the listing offsets', async () => {
		const archive = concat(file('f', 'payload-bytes'));
		const reader = openTar((async function* () {
			yield archive;
		})());
		const collected: string[] = [];
		for await (const e of reader.entries()) {
			collected.push(new TextDecoder().decode(await e.body()));
		}
		expect(collected).toEqual(['payload-bytes']);
	});

	it('unread body is auto-drained before the next entry', async () => {
		const archive = concat(file('f1', 'x'.repeat(700)), file('f2', 'yy'));
		const reader = openTar((async function* () {
			yield archive;
		})());
		const names: string[] = [];
		for await (const e of reader.entries()) {
			names.push(e.meta.path); // deliberately do not read the body
		}
		expect(names).toEqual(['f1', 'f2']);
	});

	it('readBody returns the body in chunks and survives tiny input chunks', async () => {
		const payload = 'z'.repeat(5000);
		const archive = concat(file('big', payload));
		const reader = openTar((async function* () {
			for (let i = 0; i < archive.length; i += 7) {
				yield archive.subarray(i, i + 7);
			}
		})());
		const it = reader.entries();
		const { value: entry } = await it.next();
		const chunks: number[] = [];
		let reassembled = '';
		for (;;) {
			const b = await entry!.readBody();
			if (b === null) break;
			chunks.push(b.length);
			reassembled += new TextDecoder().decode(b);
		}
		expect(reassembled).toBe(payload);
		// Repeated reads of <=8KiB walk the body and end with null.
		expect(await entry!.readBody()).toBeNull();
		expect(await it.next()).toMatchObject({ done: true });
	});

	it('truncated body is reported and iteration ends cleanly', async () => {
		// Header promises 100 bytes; provide only 10, no padding.
		const archive = concat(header({ name: 'cut', size: 100 }), new TextEncoder().encode('0123456789'));
		const reader = openTar((async function* () {
			yield archive;
		})());
		const metas: string[] = [];
		for await (const e of reader.entries()) {
			metas.push(e.meta.path);
			await e.body();
		}
		expect(metas).toEqual(['cut']);
		expect(reader.warnings.some((w) => w.code === 'truncated-data')).toBe(true);
	});
});

describe('ArchiveIndex', () => {
	it('indexes, lists and explains metadata', () => {
		const archive = concat(
			globalPax([['path', 'G']]),
			gnuLong('gnu'),
			localPax([['path', 'final']]),
			file('h'),
		);
		const idx = new ArchiveIndex();
		idx.addAll(parseTar(archive).entries);
		expect(idx.find('final')?.size).toBe(0);
		expect(idx.list()).toHaveLength(1);
		const explanation = idx.explain('final');
		expect(explanation).toContain('localPax');
		expect(explanation).toContain('WINNER');
		expect(explanation).toContain('overridden by localPax');
	});
});

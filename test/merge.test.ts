import { expect, it, describe } from 'vitest';
import {
  parseArchive,
  parseArchiveEntries,
  ArchiveIndex,
  decodeName,
  type EntryMeta,
} from '../src/index.js';
import {
  BLOCK,
  header,
  file,
  gnuRecord,
  paxRecord,
  endOfArchive,
  zeroBlock,
  bytes,
} from './helpers.js';

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

const paths = (entries: { meta: EntryMeta }[]) => entries.map((e) => e.meta.path);

describe('metadata merge precedence', () => {
  it('local PAX > GNU longname > global PAX > ustar, all four layers present', () => {
    const archive = concat(
      paxRecord('g', [['path', 'global-path'], ['uid', '0']]),
      gnuRecord('L', 'gnu-long-name'),
      paxRecord('x', [['path', 'local-path']]),
      file('ustar-name', bytes(3)),
      endOfArchive(),
    );
    const { entries } = parseArchive(archive);
    expect(entries).toHaveLength(1);
    expect(entries[0].meta.path).toBe('local-path');
    expect(entries[0].meta.sources.path).toMatchObject({
      origin: 'localPax',
      keyword: 'path',
    });
  });

  it('GNU longname beats global PAX but loses to local PAX', () => {
    let arc = concat(
      paxRecord('g', [['path', 'global-path']]),
      gnuRecord('L', 'gnu-name'),
      file('short', bytes(1)),
      endOfArchive(),
    );
    let r = parseArchive(arc);
    expect(r.entries[0].meta.path).toBe('gnu-name');
    expect(r.entries[0].meta.sources.path.origin).toBe('gnu');

    arc = concat(
      paxRecord('g', [['path', 'global-path']]),
      gnuRecord('L', 'gnu-name'),
      paxRecord('x', [['path', 'local-wins']]),
      file('short', bytes(1)),
      endOfArchive(),
    );
    r = parseArchive(arc);
    expect(r.entries[0].meta.path).toBe('local-wins');
  });

  it('global PAX overrides the ustar header name (POSIX semantics)', () => {
    const arc = concat(
      paxRecord('g', [['path', 'global/path']]),
      file('plain-name', bytes(2)),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(entries[0].meta.path).toBe('global/path');
    expect(entries[0].meta.sources.path.origin).toBe('globalPax');
  });

  it('plain ustar name survives when no extension applies', () => {
    const arc = concat(file('plain.txt', bytes(4)), endOfArchive());
    const { entries } = parseArchive(arc);
    expect(entries[0].meta.path).toBe('plain.txt');
    expect(entries[0].meta.sources.path.origin).toBe('ustar');
  });

  it('the original bug: global PAX does not clobber a local path', () => {
    // Two entries share one global record; each declares its own local path.
    const arc = concat(
      paxRecord('g', [['path', 'GLOBAL'], ['mtime', '1']]),
      paxRecord('x', [['path', 'one']]),
      file('a', bytes(1)),
      paxRecord('x', [['path', 'two']]),
      file('b', bytes(2)),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(paths(entries)).toEqual(['one', 'two']);
  });
});

describe('consecutive GNU longnames', () => {
  it('two L records before one header: the last longname wins, both are consumed once', () => {
    const arc = concat(
      gnuRecord('L', 'first-long-name/that/is/long'),
      gnuRecord('L', 'second-long-name/that/wins'),
      file('x', bytes(1)),
      file('after-longname/short-name', bytes(2)),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(paths(entries)).toEqual(['second-long-name/that/wins', 'after-longname/short-name']);
    expect(entries[1].meta.sources.path.origin).toBe('ustar');
  });

  it('L followed immediately by K: name and link target resolve independently', () => {
    const arc = concat(
      gnuRecord('L', 'long/link/path'),
      gnuRecord('K', 'long/link/target'),
      file('n', bytes(0), '1', 't'),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(entries[0].meta.path).toBe('long/link/path');
    expect(entries[0].meta.linkpath).toBe('long/link/target');
    expect(entries[0].meta.sources.path.origin).toBe('gnu');
    expect(entries[0].meta.sources.linkpath?.origin).toBe('gnu');
  });

  it('multi-block longname payload', () => {
    const long = 'd/' + 'e'.repeat(600);
    const arc = concat(gnuRecord('L', long), file('s', bytes(1)), endOfArchive());
    expect(parseArchive(arc).entries[0].meta.path).toBe(long);
  });
});

describe('empty PAX values', () => {
  it('empty local path deletes the key: it overrides global, GNU and ustar', () => {
    const arc = concat(
      paxRecord('g', [['path', 'global-path']]),
      paxRecord('x', [['path', '']]), // deletes for this entry
      file('ustar-fallback', bytes(1)),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(entries[0].meta.path).toBe('');
    expect(entries[0].meta.pathDeleted).toBe(true);
    expect(entries[0].meta.sources.path).toMatchObject({
      origin: 'localPax',
      keyword: 'path',
    });
  });

  it('empty local path also deletes a GNU longname (no fall-through)', () => {
    const arc = concat(
      gnuRecord('L', 'gnu-hidden'),
      paxRecord('x', [['path', '']]),
      file('ustar-shown', bytes(1)),
      endOfArchive(),
    );
    const meta = parseArchive(arc).entries[0].meta;
    expect(meta.path).toBe('');
    expect(meta.pathDeleted).toBe(true);
    expect(meta.sources.path.origin).toBe('localPax');
  });

  it('GLOBAL empty value deletes the key; later entries fall back to GNU/ustar', () => {
    const arc = concat(
      paxRecord('g', [['path', 'global-path']]),
      file('uses-global', bytes(1)),
      paxRecord('g', [['path', '']]), // global deletion
      gnuRecord('L', 'gnu/after/global/delete'),
      file('placeholder', bytes(1)),
      file('plain-again', bytes(2)),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(paths(entries)).toEqual(['global-path', 'gnu/after/global/delete', 'plain-again']);
    expect(entries[1].meta.sources.path.origin).toBe('gnu');
    expect(entries[2].meta.sources.path.origin).toBe('ustar');
  });

  it('empty global deletion followed by a new global set', () => {
    const arc = concat(
      paxRecord('g', [['path', 'first-global']]),
      paxRecord('g', [['path', '']]),
      paxRecord('g', [['path', 'second-global']]),
      file('h', bytes(1)),
      endOfArchive(),
    );
    expect(parseArchive(arc).entries[0].meta.path).toBe('second-global');
  });
});

describe('duplicate PAX keys', () => {
  it('duplicate keys inside one local record: last occurrence wins, source records it', () => {
    const arc = concat(
      paxRecord('x', [['path', 'a'], ['path', 'b'], ['path', 'c']]),
      file('h', bytes(1)),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(entries[0].meta.path).toBe('c');
    expect(entries[0].meta.sources.path).toMatchObject({
      origin: 'localPax',
      occurrence: 3,
    });
  });

  it('two consecutive local records for one entry: ordered, last across records wins', () => {
    const arc = concat(
      paxRecord('x', [['path', 'first-record']]),
      paxRecord('x', [['path', 'second-record']]),
      file('h', bytes(1)),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(entries[0].meta.path).toBe('second-record');
    // Both records are consumed: the next entry is unaffected.
    expect(parseArchive(concat(file('clean', bytes(1)), endOfArchive())).entries[0].meta.path)
      .toBe('clean');
  });

  it('local size overrides header size and drives the data consumed', () => {
    const data = bytes(10);
    const padded = new Uint8Array(BLOCK);
    padded.set(data, 0);
    const arc = concat(
      paxRecord('x', [['size', '10']]),
      header({ name: 'big', typeflag: '0', size: 512 }),
      padded,
      file('next', bytes(1)),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(entries.map((e) => e.meta.path)).toEqual(['big', 'next']);
    expect(entries[0].meta.size).toBe(10);
    expect(entries[0].data).toEqual(data);
    expect(entries[1].data).toEqual(new Uint8Array([0x61]));
  });
});

describe('corrupt intermediate header', () => {
  it('pending GNU longname is dropped when the following header has a bad checksum', () => {
    const corrupt = header({ name: 'victim', size: 1, badChecksum: true });
    const arc = concat(
      gnuRecord('L', 'must-not-leak'),
      corrupt,
      new Uint8Array(BLOCK).fill(0x51), // the corrupt entry's "data"
      file('clean-entry', bytes(2)),
      endOfArchive(),
    );
    const { entries, diagnostics } = parseArchive(arc);
    expect(paths(entries)).toEqual(['clean-entry']);
    expect(diagnostics.some((d) => d.code === 'bad-checksum')).toBe(true);
    expect(entries[0].meta.sources.path.origin).toBe('ustar');
  });

  it('pending local PAX is dropped on corrupt header, global PAX survives', () => {
    const corrupt = header({ name: 'v', size: 0, badChecksum: true });
    const arc = concat(
      paxRecord('g', [['path', 'G']]),
      paxRecord('x', [['path', 'local-only']]),
      corrupt,
      file('plain', bytes(1)),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    // Local was consumed-and-discarded; global still resolves the name.
    expect(paths(entries)).toEqual(['G']);
    expect(entries[0].meta.sources.path.origin).toBe('globalPax');
  });

  it('unparseable size in a corrupt block triggers scan resync, not desync', () => {
    const garbage = header({ name: 'g', size: 0, unparseableSize: true, badChecksum: true });
    const arc = concat(
      garbage,
      file('recovered-1', bytes(1)),
      file('recovered-2', bytes(2)),
      endOfArchive(),
    );
    const { entries, diagnostics } = parseArchive(arc);
    expect(paths(entries)).toEqual(['recovered-1', 'recovered-2']);
    expect(diagnostics.some((d) => d.code === 'unrecognized-header' || d.code === 'bad-checksum'))
      .toBe(true);
  });

  it('truncated trailing block is diagnosed and does not leak an extension', () => {
    const arc = concat(gnuRecord('L', 'orphan'), new Uint8Array(12));
    const { entries, diagnostics } = parseArchive(arc);
    expect(entries).toEqual([]);
    expect(diagnostics.map((d) => d.code)).toContain('truncated-block');
  });

  it('recovery skips the corrupt entry data using its declared size', () => {
    // Corrupt header but a parseable size of 2 blocks; the valid header
    // after exactly that many data blocks must be recovered.
    const corrupt = header({ name: 'v', size: 2 * BLOCK, badChecksum: true });
    const arc = concat(
      corrupt,
      new Uint8Array(BLOCK).fill(0x51),
      new Uint8Array(BLOCK).fill(0x52),
      file('recovered', bytes(1)),
      endOfArchive(),
    );
    const { entries, diagnostics } = parseArchive(arc);
    expect(paths(entries)).toEqual(['recovered']);
    expect(diagnostics.filter((d) => d.code === 'bad-checksum')).toHaveLength(1);
  });

  it('one diagnostic per corrupt header while scanning for recovery', () => {
    const arc = concat(
      new Uint8Array(BLOCK).fill(0xab),
      new Uint8Array(BLOCK).fill(0xcd),
      file('ok', bytes(1)),
      endOfArchive(),
    );
    const { entries, diagnostics } = parseArchive(arc);
    expect(paths(entries)).toEqual(['ok']);
    expect(diagnostics.filter((d) => d.code === 'unrecognized-header')).toHaveLength(1);
  });

  it('multi-block local PAX record still pairs correctly', () => {
    // Two very long values force the PAX payload over one block.
    const v1 = 'x'.repeat(400);
    const v2 = 'y'.repeat(400);
    const arc = concat(
      paxRecord('x', [['comment', v1], ['path', v2]]),
      file('h', bytes(1)),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(entries[0].meta.path).toBe(v2);
    expect(entries[0].meta.sources.path.occurrence).toBe(2);
  });
});

describe('directories and links', () => {
  it('directory entries: trailing slash, type and ustar source', () => {
    const arc = concat(
      file('some/dir/', bytes(0), '5'),
      file('some/dir/file', bytes(3), '0'),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(entries[0].meta.type).toBe('directory');
    expect(entries[0].meta.path).toBe('some/dir/');
    expect(entries[0].meta.size).toBe(0);
    expect(entries[1].meta.type).toBe('file');
  });

  it('hardlink uses K/linkpath/global layers and carries no data', () => {
    const arc = concat(
      paxRecord('g', [['linkpath', 'global/target']]),
      file('hardlink', bytes(0), '1', 'header-target'),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(entries[0].meta.type).toBe('link');
    expect(entries[0].meta.linkpath).toBe('global/target');
    expect(entries[0].data.length).toBe(0);
  });

  it('symlink with K longlink overridden by local linkpath', () => {
    const arc = concat(
      gnuRecord('K', 'gnu/target'),
      paxRecord('x', [['linkpath', 'pax/target']]),
      file('sym', bytes(0), '2', 'short'),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(entries[0].meta.type).toBe('symlink');
    expect(entries[0].meta.linkpath).toBe('pax/target');
    expect(entries[0].meta.sources.linkpath?.origin).toBe('localPax');
  });
});

describe('non-UTF-8 names', () => {
  it('raw bytes are preserved; string form uses Unicode replacement', () => {
    const raw = concat(new Uint8Array([0x64, 0x2f, 0x66, 0xe9]), new Uint8Array([0x2e, 0x64]));
    const arc = concat(file(raw, bytes(1)), endOfArchive());
    const { entries } = parseArchive(arc);
    expect([...entries[0].meta.pathBytes]).toEqual([0x64, 0x2f, 0x66, 0xe9, 0x2e, 0x64]);
    expect(entries[0].meta.path).toBe(decodeName(raw));
    expect(entries[0].meta.path).toContain('�');
  });

  it('non-UTF-8 bytes through a GNU longname record', () => {
    const raw = new Uint8Array([0x61, 0x2f, 0xff, 0xfe, 0xf0]);
    const arc = concat(gnuRecord('L', raw), file('s', bytes(1)), endOfArchive());
    const { entries } = parseArchive(arc);
    expect([...entries[0].meta.pathBytes]).toEqual([...raw]);
    expect(entries[0].meta.path).toBe(decodeName(raw));
  });

  it('non-UTF-8 bytes inside a local PAX value', () => {
    const arc = concat(
      paxRecord('x', [['path', new Uint8Array([0x70, 0x2f, 0xc3, 0x28])]]),
      file('s', bytes(1)),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect([...entries[0].meta.pathBytes]).toEqual([0x70, 0x2f, 0xc3, 0x28]);
  });
});

describe('archive concatenation', () => {
  it('global PAX resets at the two-zero-block member boundary', () => {
    const member1 = concat(
      paxRecord('g', [['path', 'm1-global']]),
      file('a', bytes(1)),
      endOfArchive(),
    );
    const member2 = concat(file('plain-b', bytes(2)), endOfArchive());
    const { entries } = parseArchive(concat(member1, member2));
    expect(paths(entries)).toEqual(['m1-global', 'plain-b']);
    expect(entries[0].meta.archiveIndex).toBe(0);
    expect(entries[1].meta.archiveIndex).toBe(1);
  });

  it('a longname left at EOF of a member cannot reach the next member', () => {
    // GNU record then end-of-archive without a consuming header.
    const member1 = concat(gnuRecord('L', 'orphan'), endOfArchive());
    const member2 = concat(file('member2-entry', bytes(1)), endOfArchive());
    const { entries } = parseArchive(concat(member1, member2));
    expect(paths(entries)).toEqual(['member2-entry']);
    expect(entries[0].meta.archiveIndex).toBe(1);
  });

  it('three concatenated members each with a global record', () => {
    const mk = (g: string, n: string) =>
      concat(paxRecord('g', [['path', g]]), file(n, bytes(1)), endOfArchive());
    const { entries } = parseArchive(concat(mk('g1', 'a'), mk('g2', 'b'), mk('g3', 'c')));
    expect(paths(entries)).toEqual(['g1', 'g2', 'g3']);
    expect(entries.map((e) => e.meta.archiveIndex)).toEqual([0, 1, 2]);
  });
});

describe('list API vs data-flow API', () => {
  it('observe the same finalized metadata through arbitrary chunk boundaries', async () => {
    const archive = concat(
      paxRecord('g', [['path', 'G'], ['mtime', '9']]),
      gnuRecord('L', 'from-gnu-but-local-wins'),
      paxRecord('x', [['path', 'final/one']]),
      file('s1', bytes(700)), // spans multiple data blocks
      file('two', bytes(5)),
      endOfArchive(),
    );

    const buffered = parseArchive(archive);

    // Feed the stream API in deliberately awkward chunk sizes.
    for (const size of [1, 7, 137, 511, 512, 513, 1000]) {
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < archive.length; i += size) {
        chunks.push(archive.subarray(i, i + size));
      }
      const streamed = await parseArchiveEntries(chunks);
      expect(streamed.map((e) => e.meta)).toEqual(buffered.entries.map((e) => e.meta));
      expect(streamed.map((e) => [...e.data])).toEqual(
        buffered.entries.map((e) => [...e.data]),
      );
      expect(streamed.map((e) => e.data.length)).toEqual([700, 5]);
    }
  });

  it('ArchiveIndex.from consumes the same metadata and finds by final path', () => {
    const archive = concat(
      gnuRecord('L', 'visible/long/path'),
      file('header-name', bytes(2)),
      endOfArchive(),
    );
    const { index } = ArchiveIndex.from(archive);
    expect(index.find('visible/long/path')?.size).toBe(2);
    expect(index.find('header-name')).toBeUndefined();
    expect(index.list().map((m) => m.sources.path.origin)).toEqual(['gnu']);
  });

  it('data bytes of an entry match its final size even with x-record size', () => {
    const payload = new TextEncoder().encode('exactly-six');
    const arc = concat(
      paxRecord('x', [['size', String(payload.length)]]),
      header({ name: 'f', size: 12 }),
      payload,
      new Uint8Array(512 - payload.length),
      file('after', bytes(1)),
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(entries[0].data).toEqual(payload);
    expect(entries[1].meta.path).toBe('after');
  });
});

describe('provenance', () => {
  it('reports block indices that point at the covering record', () => {
    const arc = concat(
      gnuRecord('L', 'long-one'), // block 0 header, block 1 payload
      file('h', bytes(1)), // block 2 header, block 3 data
      endOfArchive(), // block 4-5
    );
    const { entries } = parseArchive(arc);
    expect(entries[0].meta.sources.path.blockIndex).toBe(0);
    expect(entries[0].meta.sources.size.blockIndex).toBe(2);
    expect(entries[0].meta.sources.type.blockIndex).toBe(2);
  });

  it('global PAX source points at the g header, local at the x header', () => {
    const arc = concat(
      paxRecord('g', [['path', 'gname']]), // block 0-1
      paxRecord('x', [['size', '3']]), // block 2-3
      file('u', bytes(3)), // block 4 header + block 5 data
      endOfArchive(),
    );
    const { entries } = parseArchive(arc);
    expect(entries[0].meta.sources.path).toMatchObject({ origin: 'globalPax', blockIndex: 0 });
    expect(entries[0].meta.sources.size).toMatchObject({ origin: 'localPax', blockIndex: 2 });
  });

  it('zero blocks beyond the end-of-archive pair are ignored', () => {
    const arc = concat(file('z', bytes(1)), zeroBlock(), zeroBlock(), zeroBlock());
    const { entries } = parseArchive(arc);
    expect(entries).toHaveLength(1);
  });
});

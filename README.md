# TAR archive core

TypeScript library for indexing and extracting TAR archives, with explicit
metadata merge semantics for ustar headers, GNU one-shot records
(`longname`/`longlink`) and PAX global/local records.

## Merge model per entry

Every entry's fields are resolved through four layers, low to high priority:

| Priority | Layer                | Record            | Scope                            |
|---------:|----------------------|-------------------|----------------------------------|
| 1        | `ustar`              | regular header    | this entry                       |
| 2        | `globalPax`          | `g` / PaxGlobal   | every following entry            |
| 3        | `gnuLong`            | `L` / `K`         | **exactly the next entry**       |
| 4        | `localPax`           | `x` / PaxExtended | **exactly the next entry**       |

For path-like fields the resolved value is the highest-precedence non-deleted
layer; `path` therefore resolves as
`localPax.path > GNU longname > globalPax.path > ustar name`.
Numeric fields (`size`, `mode`, `mtime`, …) resolve as
`localPax > globalPax > ustar` (GNU records only carry name/linkname).

### Rules

- **One-shot records are consumed once.** A pending GNU `L`/`K` or local PAX
  record belongs to the next real header only. If that header is corrupt, a
  zero/end-of-archive block appears, or the input ends, the pending record is
  *discarded* (reported via an `orphan-one-shot` warning) — it can never leak
  to a later entry. Consecutive one-shots replace each other.
- **Global PAX is mutable and scoped to one archive member.** It applies to
  subsequent entries until deleted or until an end-of-archive marker (two
  consecutive zero blocks), where it resets so concatenated archives start
  clean. A single zero block does not reset it.
- **Empty PAX value = deletion.** A keyword with an empty value removes it:
  in local PAX it deletes both the local and the in-force global value for
  that entry (resolution continues at the next layer, e.g. GNU longname);
  in global PAX it removes it from the global scope.
- **Duplicate keys** within one PAX block: last record wins.
- **Corrupt headers** trigger checksum-based resynchronisation at the next
  plausible ustar header; pending records are dropped first.
- **Provenance.** Every entry exposes `sources` (winning `SourceRef` per
  field) and `pathProvenance` (each layer that carried a path, with the
  layer that overrode it), plus record byte offsets.

## API

```ts
// List API — whole buffer
import { parseTar, ArchiveIndex } from './dist/index.js';
const { entries, warnings } = parseTar(uint8Array);
entries[0].path;                 // resolved path
entries[0].sources.path.layer;   // 'localPax' | 'gnuLong' | 'globalPax' | 'ustar'
entries[0].pathProvenance;       // coverage chain

const idx = new ArchiveIndex();
idx.addAll(entries);
idx.find('some/path');
idx.explain('some/path');        // human-readable override explanation

// Data-flow API — stream (ReadableStream, async iterable, iterable)
import { openTar } from './dist/index.js';
const reader = openTar(stream);
for await (const entry of reader.entries()) {
  entry.meta;            // identical TarEntryMeta shape as parseTar
  const bytes = await entry.body();
  // unread bodies are drained automatically before the next entry

  entry.readBody();      // chunk-wise alternative
}
reader.warnings;         // same warning model
```

`meta.pathBytes`/`meta.linkPathBytes` hold the unresolved raw bytes of the
winning layer, so non-UTF-8 names round-trip losslessly; the `path` string is
UTF-8 decoded with replacement.

Both APIs drive one state machine (`TarStateMachine`), so listing and actual
extraction always consume the same final metadata.

## Develop

```sh
npm install
npm test       # vitest
npm run build  # tsc -> dist/
```

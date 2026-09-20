# TAR archive core

TypeScript library for indexing and streaming TAR archives, implementing
GNU `longname`/`longlink` and POSIX global/local PAX metadata merging.

## Per-entry metadata merge model

Every entry's final fields are resolved through four ordered layers:

| precedence | layer            | record            | scope             |
|-----------:|------------------|-------------------|-------------------|
| 1 (low)    | ustar/v7 header  | normal header     | the entry         |
| 2          | global PAX       | typeflag `g`      | one archive member of a concatenated stream; cleared at the two-zero-block end-of-archive |
| 3          | GNU one-shot     | typeflag `L`/`K`  | exactly the next real header |
| 4 (high)   | local PAX        | typeflag `x`      | exactly one entry |

Resolution: **local PAX > GNU longname/longlink > global PAX > ustar header**.
For `path` (`linkpath` follows the same rules), `size`, etc.

- **One-shot records are consumed once.** The GNU `L`/`K` record and the
  local `x` record(s) only decorate the *next* real header. If that header
  is corrupt, or the stream/member ends first, the pending record is
  discarded — it can never leak to a later entry.
- **Empty PAX value = delete.** In a local record, an empty value removes
  the keyword for that entry (overriding all lower layers; reported via
  `pathDeleted`/`linkpathDeleted`). In a global record it removes the key
  from the global scope, so later entries fall back to GNU/ustar.
- **Duplicate keys** inside one or several records resolve last-wins;
  `sources.path.occurrence` records which ordered pair supplied the value.
- Global PAX itself outranks the ustar header (POSIX), so a global `path`
  renames plain headers unless a local `x`/GNU `L` overrides it.

Each `EntryMeta.sources` field (`path`, `linkpath`, `size`, `type`) carries
`{ origin, keyword?, blockIndex, occurrence? }`, identifying exactly which
record block supplied the final value.

## Two APIs, one machine

`parseArchive` (buffered/list) and `parseArchiveStream` (async data flow,
arbitrary chunk sizes) both feed the same internal `TarMachine`, so the
listed path and the path used while unpacking are guaranteed identical.
`onData` slices for an entry always match the resolved `meta.size`.

```ts
import { parseArchive, parseArchiveStream, ArchiveIndex } from './src/index.js';

const { entries, diagnostics } = parseArchive(bytes);
entries[0].meta.path;        // final path
entries[0].meta.sources.path; // { origin: 'localPax'|'gnu'|'globalPax'|'ustar', ... }

for await (const event of parseArchiveStream(chunks)) {
  if (event.type === 'entry') /* event.entry.meta / event.entry.data */;
}

const { index } = ArchiveIndex.from(bytes);
index.find('some/path');
```

Non-UTF-8 names are preserved byte-for-byte in `pathBytes`/`linkpathBytes`
(the decoded string uses Unicode replacement characters).

Corrupt middle headers are reported in `diagnostics`; the parser resyncs at
the next valid header (using the declared size when parseable, scanning for
magic+checksum otherwise). Global PAX survives a resync; one-shot records
do not.

Run `npm install`, then `npm test` and `npm run build`.

/**
 * TAR reader core: GNU longname/longlink + global/local PAX merge model.
 *
 * Metadata layers for one entry, low to high precedence:
 *
 *   1. ustar/oldgnu header block (name, prefix/name, linkname, size, …)
 *   2. global PAX records ("g") — scoped to the archive member of a
 *      concatenated archive; reset at end-of-archive (two zero blocks)
 *   3. GNU one-shot records ("L" = long name, "K" = long linkname) —
 *      consumed by exactly the next real header, and dropped (never
 *      leaked) if that header is corrupt or the stream ends first
 *   4. local PAX records ("x") — scoped to exactly one entry
 *
 * An *empty* PAX value deletes that keyword (POSIX.1 pax):
 *   - in a LOCAL record: the keyword is removed for that one entry, and
 *     the empty value OVERRIDES every lower layer — GNU longname, global
 *     PAX and the ustar header — so the resolved field is empty (this
 *     matches the archive/tar keyword-list semantics; `pathDeleted` /
 *     `linkpathDeleted` flag it and `sources` points at the x record);
 *   - in a GLOBAL record: the keyword disappears from the global scope;
 *     later entries that relied on it fall back to GNU/ustar.
 *
 * Both the list API (`parseArchive`/`ArchiveIndex`) and the data-flow API
 * (`parseArchiveStream`) are driven by the same {@link TarMachine}, and
 * therefore observe byte-identical finalized {@link EntryMeta}.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EntryType = 'file' | 'directory' | 'link' | 'symlink' | 'other';

/** Which record supplied the final value of a metadata field. */
export type FieldOrigin = 'ustar' | 'globalPax' | 'gnu' | 'localPax';

export interface FieldSource {
  /** Record layer that supplied the final value. */
  origin: FieldOrigin;
  /** PAX keyword ("path", "linkpath", "size"), when origin is a PAX layer. */
  keyword?: string;
  /**
   * Block index of the supplying header block in the byte stream
   * (the ustar header, or the header of the GNU/PAX extension record).
   */
  blockIndex: number;
  /**
   * Which occurrence of the keyword inside the record's ordered pairs
   * supplied it — >1 means an earlier duplicate was overridden.
   */
  occurrence?: number;
}

export interface EntryMeta {
  /** Final decoded path: local PAX > GNU longname > global PAX > ustar. */
  path: string;
  /** Final link target for hardlinks/symlinks, same precedence rules. */
  linkpath?: string;
  size: number;
  mode: number;
  type: EntryType;
  typeflag: string;
  /** Raw bytes of the final path, for non-UTF-8 names. */
  pathBytes: Uint8Array;
  /** Raw bytes of the final link target. */
  linkpathBytes?: Uint8Array;
  /** True when a PAX empty value explicitly deleted this entry's path. */
  pathDeleted?: boolean;
  /** True when a PAX empty value explicitly deleted the link target. */
  linkpathDeleted?: boolean;
  /** 0-based archive member index in a concatenated stream. */
  archiveIndex: number;
  /** Provenance for every resolved field. */
  sources: {
    path: FieldSource;
    linkpath?: FieldSource;
    size: FieldSource;
    type: FieldSource;
  };
}

/** Legacy shape kept for backwards compatibility with existing callers. */
export type TarHeader = {
  path: string;
  size: number;
  type: 'file' | 'directory' | 'link';
};

// ---------------------------------------------------------------------------
// Low-level field helpers
// ---------------------------------------------------------------------------

const BLOCK = 512;
const decoder = new TextDecoder('utf-8');

/** Decode bytes, using the TextDecoder replacement strategy for non-UTF-8. */
export function decodeName(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Read a NUL-terminated field without asserting UTF-8. */
function fieldBytes(block: Uint8Array, start: number, end: number): Uint8Array {
  const slice = block.subarray(start, end);
  let len = slice.length;
  while (len > 0 && slice[len - 1] === 0) len--;
  return slice.subarray(0, len);
}

/**
 * Parse a NUL/space-padded octal field.
 * @returns `[value, true]` when at least one octal digit is present,
 *          `[0, false]` for empty/garbage fields.
 */
export function parseOctal(bytes: Uint8Array): [number, boolean] {
  let value = 0;
  let sawDigit = false;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x00 || c === 0x20) {
      if (sawDigit) break;
      continue;
    }
    if (c < 0x30 || c > 0x37) return [0, false];
    value = value * 8 + (c - 0x30);
    sawDigit = true;
  }
  return [value, sawDigit];
}

/** Unsigned checksum: the 8 checksum bytes (148..155) count as spaces. */
export function tarChecksum(block: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    if (i >= 148 && i < 156) {
      sum += 0x20;
      continue;
    }
    sum += block[i];
  }
  return sum;
}

const TYPE_MAP: Record<string, EntryType> = {
  '0': 'file',
  '': 'file',
  '5': 'directory',
  '1': 'link',
  '2': 'symlink',
  '7': 'file',
};

interface ParsedHeader {
  ok: boolean;
  typeflag: string;
  size: number;
  type: EntryType;
  mode: number;
  nameBytes: Uint8Array;
  linknameBytes: Uint8Array;
  blockIndex: number;
}

function parseHeader(block: Uint8Array, blockIndex: number): ParsedHeader {
  const stored = parseOctal(block.subarray(148, 156))[0];
  if (stored !== tarChecksum(block)) return {
    ok: false, typeflag: '', size: 0, type: 'other', mode: 0,
    nameBytes: new Uint8Array(0), linknameBytes: new Uint8Array(0), blockIndex,
  };

  // Accept ustar (POSIX) and GNU magic; an empty magic means legacy v7,
  // which we still read — but resync only recognizes magic-prefixed
  // blocks so random data cannot masquerade as a header.
  const magic = block.subarray(257, 262);
  let magicOk = false;
  if (magic[0] === 0x75 /*u*/ && magic[1] === 0x73 /*s*/ &&
      magic[2] === 0x74 /*t*/ && magic[3] === 0x61 /*a*/ &&
      magic[4] === 0x72 /*r*/) {
    magicOk = true;
  } else if (magic[0] === 0 && magic[1] === 0 && magic[2] === 0) {
    magicOk = true; // pre-POSIX legacy header
  }
  if (!magicOk) return {
    ok: false, typeflag: '', size: 0, type: 'other', mode: 0,
    nameBytes: new Uint8Array(0), linknameBytes: new Uint8Array(0), blockIndex,
  };

  const typeflag = block[156] === 0 ? '0' : String.fromCharCode(block[156]);
  const [size, sizeOk] = parseOctal(block.subarray(124, 136));

  let nameBytes = fieldBytes(block, 0, 100);
  const prefix = fieldBytes(block, 345, 500);
  if (prefix.length > 0) nameBytes = concatBytes(prefix, new Uint8Array([0x2f]), nameBytes);

  return {
    ok: true,
    typeflag,
    size: sizeOk ? size : 0,
    type: TYPE_MAP[typeflag] ?? 'other',
    mode: parseOctal(block.subarray(100, 108))[0],
    nameBytes,
    linknameBytes: fieldBytes(block, 157, 257),
    blockIndex,
  };
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PAX records
// ---------------------------------------------------------------------------

export interface PaxPair {
  keyword: string;
  /** Raw value bytes — keywords are ASCII, values need not be valid UTF-8. */
  valueBytes: Uint8Array;
  /** 1-based position inside the PAX record (duplicates keep their order). */
  occurrence: number;
  headerBlockIndex: number;
}

/**
 * Parse a PAX extended header payload:
 *
 *   "%d %s=%s\n"  length, keyword, value
 *
 * Length is advisory; malformed framing resynchronizes at the next newline.
 */
export function parsePax(payload: Uint8Array, headerBlockIndex: number): PaxPair[] {
  const pairs: PaxPair[] = [];
  let i = 0;
  let occurrence = 0;
  while (i < payload.length) {
    const start = i;
    let length = 0;
    let sawLen = false;
    while (i < payload.length) {
      const c = payload[i];
      if (c >= 0x30 && c <= 0x39) {
        length = length * 10 + (c - 0x30);
        sawLen = true;
        i++;
      } else break;
    }
    if (!sawLen || payload[i] !== 0x20 || length < 2) {
      // Corrupt framing: resync at the next newline.
      while (i < payload.length && payload[i] !== 0x0a) i++;
      if (i < payload.length) i++;
      continue;
    }
    let end = start + length; // length counts the trailing newline
    if (end > payload.length || payload[end - 1] !== 0x0a) {
      // Declared length unusable: resync at the next newline.
      end = i;
      while (end < payload.length && payload[end] !== 0x0a) end++;
      if (end < payload.length) end++; // consume the newline itself
    }
    const eqStart = i + 1;
    let eq = eqStart;
    while (eq < end && payload[eq] !== 0x3d) eq++;
    if (eq >= end - 1) { // no '=' or no newline at all
      i = end;
      continue;
    }
    const keywordBytes = payload.subarray(eqStart, eq);
    let ascii = true;
    for (const c of keywordBytes) if (c > 0x7f) ascii = false;
    if (!ascii) {
      i = end;
      continue;
    }
    occurrence++;
    pairs.push({
      keyword: decoder.decode(keywordBytes),
      valueBytes: payload.subarray(eq + 1, end - 1),
      occurrence,
      headerBlockIndex,
    });
    // Advance past the record (the trailing newline sits at end-1).
    i = end;
  }
  return pairs;
}

/** Serialize one PAX pair with the correctly recomputed length field. */
export function encodePaxPair(keyword: string, value: Uint8Array | string): Uint8Array {
  const valueBytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const keywordBytes = new TextEncoder().encode(keyword);
  // Record = digits + space + keyword + '=' + value + newline.
  const body = concatBytes(keywordBytes, new Uint8Array([0x3d]), valueBytes, new Uint8Array([0x0a]));
  // length counts itself too: total = digits.length + 1 (space) + body.length.
  let digits = 1;
  while (String(digits + 1 + body.length).length !== digits) digits++;
  const len = digits + 1 + body.length;
  return concatBytes(new TextEncoder().encode(String(len) + ' '), body);
}

// ---------------------------------------------------------------------------
// Per-entry metadata merge
// ---------------------------------------------------------------------------

interface PendingExtensions {
  /** GNU "L" records in stream order; consecutive L: the last wins. */
  longname?: { bytes: Uint8Array; blockIndex: number };
  /** GNU "K" records in stream order; consecutive K: the last wins. */
  longlink?: { bytes: Uint8Array; blockIndex: number };
  local: PaxPair[];
}

function trimTrailingNulls(bytes: Uint8Array): Uint8Array {
  let len = bytes.length;
  while (len > 0 && bytes[len - 1] === 0) len--;
  return bytes.subarray(0, len);
}

interface ResolvedField {
  /** Raw value bytes, or null when a PAX empty value DELETED the field. */
  bytes: Uint8Array | null;
  source: FieldSource;
}

/**
 * Resolve one string field through the layer stack.
 *
 * Local PAX semantics (POSIX.1 pax keyword list, matching archive/tar):
 *   - the ordered pairs for one entry override every lower layer;
 *   - a NON-empty local value wins outright;
 *   - an EMPTY local value DELETES the keyword for this entry: neither
 *     GNU longname, global PAX, nor the ustar header may fall through.
 *
 * Effective precedence: local PAX > GNU longname > global PAX > ustar.
 * In the global list an empty value likewise deletes the global key.
 */
function resolveStringField(
  ustar: Uint8Array,
  gnu: { bytes: Uint8Array; blockIndex: number } | undefined,
  globalPairs: PaxPair[],
  localPairs: PaxPair[],
  keyword: string,
  ustarBlockIndex: number,
): ResolvedField | undefined {
  for (let i = localPairs.length - 1; i >= 0; i--) {
    const p = localPairs[i];
    if (p.keyword !== keyword) continue;
    const source: FieldSource = {
      origin: 'localPax', keyword, blockIndex: p.headerBlockIndex, occurrence: p.occurrence,
    };
    // Empty value deletes: report it instead of falling through.
    return p.valueBytes.length === 0
      ? { bytes: null, source }
      : { bytes: p.valueBytes, source };
  }
  if (gnu) {
    return { bytes: gnu.bytes, source: { origin: 'gnu', blockIndex: gnu.blockIndex } };
  }
  for (let i = globalPairs.length - 1; i >= 0; i--) {
    const p = globalPairs[i];
    if (p.keyword !== keyword) continue;
    const source: FieldSource = {
      origin: 'globalPax', keyword, blockIndex: p.headerBlockIndex, occurrence: p.occurrence,
    };
    return p.valueBytes.length === 0 ? { bytes: null, source } : { bytes: p.valueBytes, source };
  }
  if (ustar.length > 0) {
    return { bytes: ustar, source: { origin: 'ustar', blockIndex: ustarBlockIndex } };
  }
  return undefined;
}

function lastPair(pairs: PaxPair[], keyword: string): PaxPair | undefined {
  for (let i = pairs.length - 1; i >= 0; i--) {
    if (pairs[i].keyword === keyword) return pairs[i];
  }
  return undefined;
}

/** Apply the four-layer merge model to one real header. */
export function buildEntryMeta(
  header: ParsedHeader,
  globalPairs: PaxPair[],
  pending: PendingExtensions,
  archiveIndex: number,
): EntryMeta {
  const path = resolveStringField(
    header.nameBytes, pending.longname, globalPairs, pending.local, 'path', header.blockIndex,
  );
  const link = resolveStringField(
    header.linknameBytes, pending.longlink, globalPairs, pending.local, 'linkpath', header.blockIndex,
  );

  const sources: EntryMeta['sources'] = {
    path: path?.source ?? { origin: 'ustar', blockIndex: header.blockIndex },
    size: { origin: 'ustar', blockIndex: header.blockIndex },
    type: { origin: 'ustar', blockIndex: header.blockIndex },
  };
  if (link) sources.linkpath = link.source;

  const pathDeleted = path ? path.bytes === null : false;
  const linkDeleted = link ? link.bytes === null : false;
  const pathBytes = path && path.bytes ? path.bytes : new Uint8Array(0);
  const linkBytes = link && link.bytes ? link.bytes : undefined;

  let size = header.size;
  const localSize = lastPair(pending.local, 'size');
  if (localSize && localSize.valueBytes.length > 0) {
    const parsed = Number(decodeName(localSize.valueBytes).trim());
    if (Number.isFinite(parsed)) {
      size = parsed;
      sources.size = {
        origin: 'localPax', keyword: 'size',
        blockIndex: localSize.headerBlockIndex, occurrence: localSize.occurrence,
      };
    }
  } else if (!localSize) {
    const globalSize = lastPair(globalPairs, 'size');
    if (globalSize && globalSize.valueBytes.length > 0) {
      const parsed = Number(decodeName(globalSize.valueBytes).trim());
      if (Number.isFinite(parsed)) {
        size = parsed;
        sources.size = {
          origin: 'globalPax', keyword: 'size',
          blockIndex: globalSize.headerBlockIndex, occurrence: globalSize.occurrence,
        };
      }
    }
  }

  return {
    path: path && path.bytes ? decodeName(path.bytes) : '',
    linkpath: link && link.bytes ? decodeName(link.bytes) : undefined,
    size,
    mode: header.mode,
    type: header.type,
    typeflag: header.typeflag,
    pathBytes,
    linkpathBytes: linkBytes,
    pathDeleted,
    linkpathDeleted: linkDeleted,
    archiveIndex,
    sources,
  };
}

/**
 * @deprecated Kept for the legacy call site. The explicit model lives in
 * {@link buildEntryMeta} / {@link parseArchive}; note global PAX has LOWER
 * precedence than local PAX (the old helper spread it in the wrong order).
 */
export function mergeMetadata(
  header: TarHeader,
  globalPax: Record<string, string>,
  localPax: Record<string, string>,
  longname?: string,
): TarHeader {
  return {
    ...header,
    path: localPax.path ?? longname ?? globalPax.path ?? header.path,
    size: Number(localPax.size ?? globalPax.size ?? header.size),
  };
}

// ---------------------------------------------------------------------------
// Parser state machine — single source of truth for both APIs
// ---------------------------------------------------------------------------

export type DiagnosticCode =
  | 'truncated-block'
  | 'bad-checksum'
  | 'unrecognized-header'
  | 'truncated-payload'
  | 'trailing-garbage';

export interface TarDiagnostic {
  code: DiagnosticCode;
  blockIndex: number;
  detail: string;
}

export interface TarMachineEvents {
  onEntry(meta: EntryMeta): void;
  /** A data slice belonging to the most recently started entry. */
  onData(chunk: Uint8Array): void;
  onDiagnostic(d: TarDiagnostic): void;
}

const GLOBAL_FLAG = 'g';
const LOCAL_PAX_FLAG = 'x';
const GNU_LONGNAME_FLAG = 'L';
const GNU_LONGLINK_FLAG = 'K';

/**
 * Push-style parser fed with whole 512-byte blocks. Extension records are
 * held in `pending` and consumed by exactly one real header:
 *
 *   - real header  → pending is converted to the entry's {@link EntryMeta}
 *                    and cleared *before* the entry is emitted;
 *   - corrupt header → pending is cleared immediately, so a damaged next
 *                    header can never leak a longname to a later entry;
 *   - end of archive member / EOF → pending is cleared.
 */
export class TarMachine {
  #events: TarMachineEvents;
  #pending: PendingExtensions = { local: [] };
  #globalPairs: PaxPair[] = [];
  #archiveIndex = 0;
  #zeroRun = 0;

  // Accumulating an x/g/L/K payload across blocks.
  #payload: { typeflag: string; remain: number; bytes: Uint8Array[]; blockIndex: number } | null = null;
  // Streaming a real entry's data blocks.
  #bodyRemaining = 0;
  // Skipping data blocks after a corrupt header with a parseable size.
  #skipRemaining = 0;
  #resync = false;

  constructor(events: TarMachineEvents) {
    this.#events = events;
  }

  feed(block: Uint8Array, blockIndex: number): void {
    if (block.length !== BLOCK) {
      this.#events.onDiagnostic({
        code: 'truncated-block', blockIndex,
        detail: `final block is ${block.length} bytes, expected 512`,
      });
      // Any extension still waiting can never be consumed now.
      this.#pending = { local: [] };
      return;
    }

    if (this.#payload) {
      this.#feedPayload(block);
      return;
    }
    if (this.#bodyRemaining > 0) {
      const take = Math.min(BLOCK, this.#bodyRemaining);
      this.#events.onData(block.subarray(0, take));
      this.#bodyRemaining -= take;
      // Padding (if any) shares this block; the next block is a header.
      return;
    }
    if (this.#skipRemaining > 0) {
      const take = Math.min(BLOCK, this.#skipRemaining);
      this.#skipRemaining -= take;
      return;
    }
    this.#feedHeader(block, blockIndex);
  }

  #feedHeader(block: Uint8Array, blockIndex: number): void {
    let allZero = true;
    for (let i = 0; i < BLOCK; i++) {
      if (block[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      this.#zeroRun++;
      if (this.#zeroRun === 2) {
        // End of one archive member: global scope and unconsumed
        // extensions belong to this member only (archive concatenation).
        this.#globalPairs = [];
        this.#pending = { local: [] };
        this.#resync = false;
        this.#archiveIndex++;
      }
      return;
    }
    this.#zeroRun = 0;

    const header = parseHeader(block, blockIndex);
    if (!header.ok) {
      // While scanning for a recovery point, garbage blocks are expected —
      // skip them silently (the original failure was already reported).
      if (this.#resync) {
        const [size, sizeOk] = parseOctal(block.subarray(124, 136));
        if (sizeOk) this.#skipRemaining = size;
        return;
      }
      this.#corrupt(block, blockIndex);
      return;
    }
    if (this.#resync) {
      // Recovery point: a checksum+magic-passing real header. The stale
      // extension was already discarded when the corruption was found.
      this.#resync = false;
    }

    this.#startRecord(header);
  }

  #startRecord(header: ParsedHeader): void {
    switch (header.typeflag) {
      case GLOBAL_FLAG:
      case LOCAL_PAX_FLAG:
      case GNU_LONGNAME_FLAG:
      case GNU_LONGLINK_FLAG:
        this.#payload = {
          typeflag: header.typeflag,
          remain: header.size,
          bytes: [],
          blockIndex: header.blockIndex,
        };
        return;
    }
    // Real entry: consume pending extensions exactly once.
    const meta = buildEntryMeta(header, this.#globalPairs, this.#pending, this.#archiveIndex);
    this.#pending = { local: [] };
    this.#events.onEntry(meta);
    this.#bodyRemaining = meta.size;
  }

  #feedPayload(block: Uint8Array): void {
    const p = this.#payload!;
    const take = Math.min(BLOCK, p.remain);
    p.bytes.push(block.subarray(0, take));
    p.remain -= take;
    if (p.remain > 0) return; // whole block was payload
    // Payload complete; trailing padding (if any) shares this block.

    let payload = concatBytes(...p.bytes);
    // Extension record order:
    //  - L/K overwrite their slot (consecutive L: only the last survives);
    //  - x appends to this entry's ordered pairs (duplicates resolved
    //    last-wins at use time);
    //  - g folds into the global ordered view, empty value deletes.
    if (p.typeflag === GNU_LONGNAME_FLAG || p.typeflag === GNU_LONGLINK_FLAG) {
      payload = trimTrailingNulls(payload);
      if (p.typeflag === GNU_LONGNAME_FLAG) this.#pending.longname = { bytes: payload, blockIndex: p.blockIndex };
      else this.#pending.longlink = { bytes: payload, blockIndex: p.blockIndex };
    } else if (p.typeflag === GLOBAL_FLAG) {
      this.#applyGlobal(parsePax(payload, p.blockIndex));
    } else {
      this.#pending.local.push(...parsePax(payload, p.blockIndex));
    }
    this.#payload = null;
  }

  #applyGlobal(pairs: PaxPair[]): void {
    for (const p of pairs) {
      if (p.valueBytes.length === 0) {
        this.#globalPairs = this.#globalPairs.filter((q) => q.keyword !== p.keyword);
      } else {
        this.#globalPairs.push(p);
      }
    }
  }

  #corrupt(block: Uint8Array, blockIndex: number): void {
    const hasMagic =
      block[257] === 0x75 && block[258] === 0x73 && block[259] === 0x74 &&
      block[260] === 0x61 && block[261] === 0x72;
    // One-shot extensions must never survive a corrupt next header.
    this.#pending = { local: [] };
    this.#events.onDiagnostic({
      code: hasMagic ? 'bad-checksum' : 'unrecognized-header',
      blockIndex,
      detail: hasMagic
        ? 'ustar magic with invalid checksum'
        : 'block is neither a valid header nor a zero block',
    });
    // Corrupt-header recovery. If the size field is still parseable octal
    // (common for a partially damaged header), skip the declared data
    // blocks, then demand a valid header. Otherwise scan forward for the
    // next checksum+magic-passing block. Global PAX survives the resync;
    // one-shot records do not.
    const [size, sizeOk] = parseOctal(block.subarray(124, 136));
    if (sizeOk) this.#skipRemaining = size;
    this.#resync = true;
  }

  /** Flush at stream end; reports any incomplete extension payload. */
  end(): void {
    if (this.#payload) {
      this.#events.onDiagnostic({
        code: 'truncated-payload',
        blockIndex: this.#payload.blockIndex,
        detail: `extension record payload is incomplete (${this.#payload.remain} bytes missing)`,
      });
      this.#payload = null;
    }
    if (this.#resync) {
      this.#events.onDiagnostic({
        code: 'trailing-garbage',
        blockIndex: -1,
        detail: 'stream ended while resynchronizing after a corrupt header',
      });
    }
    this.#pending = { local: [] };
  }
}

// ---------------------------------------------------------------------------
// Shared block feeding: list API and data-flow API both funnel through it,
// so neither can observe a different merge result than the other.
// ---------------------------------------------------------------------------

export interface ParsedEntry {
  meta: EntryMeta;
  data: Uint8Array;
}

export interface ParseResult {
  entries: ParsedEntry[];
  diagnostics: TarDiagnostic[];
}

function runMachine(input: Uint8Array): ParseResult {
  const entries: ParsedEntry[] = [];
  const diagnostics: TarDiagnostic[] = [];
  let chunks: Uint8Array[] = [];
  const machine = new TarMachine({
    onEntry(meta) {
      chunks = [];
      entries.push({ meta, data: new Uint8Array(0) });
    },
    onData(chunk) {
      chunks.push(chunk);
    },
    onDiagnostic(d) {
      diagnostics.push(d);
    },
  });
  const blockCount = Math.floor(input.length / BLOCK);
  for (let b = 0; b < blockCount; b++) {
    machine.feed(input.subarray(b * BLOCK, (b + 1) * BLOCK), b);
    const current = entries[entries.length - 1];
    if (current && chunks.length > 0) {
      current.data = concatBytes(current.data, ...chunks);
      chunks = [];
    }
  }
  if (input.length % BLOCK !== 0) {
    machine.feed(input.subarray(blockCount * BLOCK), blockCount);
  }
  machine.end();
  return { entries, diagnostics };
}

/** List API: parse a whole archive buffer into finalized entries. */
export function parseArchive(input: Uint8Array): ParseResult {
  return runMachine(input);
}

/**
 * Data-flow API. The caller decides how bytes are chunked (e.g. chunks
 * arriving off a socket); an internal blocker repacks them into 512-byte
 * blocks, then feeds the SAME {@link TarMachine} the list API uses.
 */
export async function* parseArchiveStream(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<{ type: 'entry'; entry: ParsedEntry } | { type: 'end'; diagnostics: TarDiagnostic[] }> {
  const entries: ParsedEntry[] = [];
  const diagnostics: TarDiagnostic[] = [];
  let chunks: Uint8Array[] = [];
  const machine = new TarMachine({
    onEntry(meta) {
      chunks = [];
      entries.push({ meta, data: new Uint8Array(0) });
    },
    onData(chunk) {
      chunks.push(chunk);
    },
    onDiagnostic(d) {
      diagnostics.push(d);
    },
  });

  let carry: Uint8Array = new Uint8Array(0);
  let blockIndex = 0;
  const deliver = (block: Uint8Array): void => {
    machine.feed(block, blockIndex++);
    const current = entries[entries.length - 1];
    if (current && chunks.length > 0) {
      current.data = concatBytes(current.data, ...chunks);
      chunks = [];
    }
  };

  for await (const part of input) {
    let data = part;
    if (carry.length > 0) {
      data = concatBytes(carry, part);
      carry = new Uint8Array(0);
    }
    const blocks = Math.floor(data.length / BLOCK);
    for (let b = 0; b < blocks; b++) deliver(data.subarray(b * BLOCK, (b + 1) * BLOCK));
    if (data.length % BLOCK !== 0) carry = data.subarray(blocks * BLOCK);
  }
  if (carry.length > 0) machine.feed(carry, blockIndex);
  machine.end();

  for (const entry of entries) yield { type: 'entry', entry };
  yield { type: 'end', diagnostics };
}

/** Convenience: drain the data-flow API and return just the entries. */
export async function parseArchiveEntries(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<ParsedEntry[]> {
  const out: ParsedEntry[] = [];
  for await (const event of parseArchiveStream(input)) {
    if (event.type === 'entry') out.push(event.entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Archive index
// ---------------------------------------------------------------------------

/**
 * Searchable view over finalized metadata. `add` accepts either a fully
 * parsed {@link EntryMeta} (the normal path) or the legacy
 * {@link TarHeader} shape.
 */
export class ArchiveIndex {
  #entries: EntryMeta[] = [];

  static from(input: Uint8Array): { index: ArchiveIndex; diagnostics: TarDiagnostic[] } {
    const result = parseArchive(input);
    const index = new ArchiveIndex();
    for (const { meta } of result.entries) index.add(meta);
    return { index, diagnostics: result.diagnostics };
  }

  add(entry: EntryMeta | TarHeader): void {
    if ('sources' in entry) this.#entries.push(entry);
    else {
      this.#entries.push({
        path: entry.path,
        size: entry.size,
        mode: 0,
        type: entry.type,
        typeflag: entry.type === 'directory' ? '5' : entry.type === 'link' ? '1' : '0',
        pathBytes: new TextEncoder().encode(entry.path),
        archiveIndex: 0,
        sources: {
          path: { origin: 'ustar', blockIndex: -1 },
          size: { origin: 'ustar', blockIndex: -1 },
          type: { origin: 'ustar', blockIndex: -1 },
        },
      });
    }
  }

  list(): readonly EntryMeta[] {
    return this.#entries.slice();
  }

  find(path: string): EntryMeta | undefined {
    return this.#entries.find((entry) => entry.path === path);
  }
}

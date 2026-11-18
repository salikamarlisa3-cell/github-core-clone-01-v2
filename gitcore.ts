// The git object model for the forge: SHA-1 object ids, commit/tree/tag parsing and building,
// packfile read (with OFS/REF delta resolution) and write (plain objects), and the pkt-line codec.
// Node built-ins only; every function is pure over the byte buffers it is handed.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
export const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object in a repo's object map and answer its id. */
export function putObject(store: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------------------------------------
// trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every file (and gitlink) under a tree, as repo-relative path -> {mode, oid}; directories recursed. */
export function flattenTree(store: Map<string, GitObject>, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build (and store) the nested trees for a flattened path map; answers the root tree id. */
export function buildTreeFromFlat(store: Map<string, GitObject>, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(store, 'tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------------------------
// commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit; `author`/`committer` are full identity strings without the timestamp. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): Buffer {
  const stamp = `${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${stamp}`, `committer ${fields.committer} ${stamp}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Resolve a tag chain to the commit it ultimately names, or null. */
export function peelToCommit(store: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// reachability

/** Add a tree and everything under it to `out`. */
function addTreeClosure(store: Map<string, GitObject>, treeOid: string, out: Set<string>): void {
  if (out.has(treeOid)) return;
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  out.add(treeOid);
  for (const entry of parseTree(tree.data)) {
    if (entry.mode === '40000') addTreeClosure(store, entry.oid, out);
    else if (entry.mode !== '160000') out.add(entry.oid);
  }
}

/**
 * Every object reachable from `roots`. Commits in `stopAt` are included with their trees but
 * their parents are not traversed (a shallow client's boundary). Missing objects are skipped.
 */
export function reachableSet(
  store: Map<string, GitObject>,
  roots: Iterable<string>,
  options: { stopAt?: ReadonlySet<string> } = {},
): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (out.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      out.add(oid);
      const commit = parseCommit(object.data);
      addTreeClosure(store, commit.tree, out);
      if (options.stopAt?.has(oid) !== true) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      out.add(oid);
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      addTreeClosure(store, oid, out);
    } else {
      out.add(oid);
    }
  }
  return out;
}

/**
 * The objects a depth-limited fetch sends: commits within `depth` generations of `roots`
 * (generation 0 is the root itself), their tree closures, and any tags pointing at them.
 * Answers the set plus the boundary commits (included, with parents, but parents excluded).
 */
export function shallowSet(
  store: Map<string, GitObject>,
  roots: Iterable<string>,
  depth: number,
): { objects: Set<string>; boundary: string[] } {
  const objects = new Set<string>();
  const boundary = new Set<string>();
  // Resolve tag roots to commits first (a tag itself always rides along).
  let frontier: string[] = [];
  for (const root of roots) {
    let oid = root;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = store.get(oid);
      if (object === undefined) break;
      if (object.type === 'tag') {
        objects.add(oid);
        oid = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit') frontier.push(oid);
      break;
    }
  }
  const seen = new Set<string>();
  for (let generation = 0; generation < depth && frontier.length > 0; generation += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      objects.add(oid);
      const commit = parseCommit(object.data);
      addTreeClosure(store, commit.tree, objects);
      if (generation === depth - 1) {
        if (commit.parents.length > 0) boundary.add(oid);
      } else {
        for (const parent of commit.parents) next.push(parent);
      }
    }
    frontier = next;
  }
  return { objects, boundary: [...boundary] };
}

/** True when `ancestor` is `descendant` itself or reachable from it through parent links. */
export function isAncestor(store: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/**
 * A merge base of two commits: a common ancestor with the greatest generation depth from `a`
 * (histories here are small; a plain two-sided walk is exact enough and deterministic).
 */
export function mergeBase(store: Map<string, GitObject>, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Map<string, number> => {
    const depths = new Map<string, number>();
    const queue: Array<[string, number]> = [[tip, 0]];
    while (queue.length > 0) {
      const [oid, depth] = queue.shift() as [string, number];
      if (depths.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      depths.set(oid, depth);
      for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
    }
    return depths;
  };
  const fromA = ancestorsOf(a);
  const fromB = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, depthA] of fromA) {
    const depthB = fromB.get(oid);
    if (depthB === undefined) continue;
    const score = depthA + depthB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// packfiles

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack of plain (undeltified) objects, with its SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/**
 * Read a packfile and resolve every object, including OFS_DELTA and REF_DELTA entries,
 * answering each object with the id the resolution already computed for it (so a caller
 * storing the objects need not hash them a second time).
 * `resolveBase` supplies a base object a thin pack leaves out (looked up in the repo store).
 */
export function readPackObjects(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Array<{ oid: string; object: GitObject }> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolvedByOid = new Map<string, GitObject>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      return { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    if (entry.typeCode === 7) {
      const base = resolvedByOid.get(entry.baseOid as string) ?? resolveBase?.(entry.baseOid as string);
      if (base === undefined) throw new Error('ref-delta base is not available');
      return { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    return { type: CODE_TYPE[entry.typeCode] as GitObjectType, data: entry.data };
  };
  const objects: Array<{ oid: string; object: GitObject }> = [];
  for (const entry of raw) {
    const object = resolve(entry);
    const oid = hashObject(object.type, object.data);
    resolvedByOid.set(oid, object);
    objects.push({ oid, object });
  }
  return objects;
}

/**
 * Read a packfile and resolve every object, including OFS_DELTA and REF_DELTA entries.
 * `resolveBase` supplies a base object a thin pack leaves out (looked up in the repo store).
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): GitObject[] {
  return readPackObjects(pack, resolveBase).map((entry) => entry.object);
}

// ---------------------------------------------------------------------------------------------
// pkt-line

export const PKT_MAX_PAYLOAD = 65520 - 4;

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line payload too large');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktItem = Buffer | 'flush' | 'delim' | 'response-end';

export function encodePktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export interface DecodedPkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/**
 * Decode a complete pkt-line stream. Throws on a malformed header. When `allowTrailing` is set,
 * stops at the first bytes that are not a pkt-line header and reports how many bytes were consumed
 * (receive-pack's packfile follows the command list unframed).
 */
export function decodePktLines(bytes: Buffer, options: { allowTrailing?: boolean } = {}): { packets: DecodedPkt[]; consumed: number } {
  const packets: DecodedPkt[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > bytes.length) {
      if (options.allowTrailing === true || offset === bytes.length) return { packets, consumed: offset };
      throw new Error('truncated pkt-line');
    }
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      if (options.allowTrailing === true) return { packets, consumed: offset };
      throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > bytes.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
}

/** Chunk bytes into sideband packets: band byte + payload, each pkt-line within the size limit. */
export function sidebandPackets(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const chunkSize = PKT_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, offset + chunkSize);
    packets.push(encodePktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return packets;
}

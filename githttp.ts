// The git smart-HTTP surface at /{owner}/{repo}.git: ref advertisements (protocol v0 and v2),
// v2 ls-refs, fetch (v2 sections and the v0 want/have form, with shallow support) and v0
// receive-pack with report-status. Objects move as plain, undeltified packs; pushed packs are
// read back with full delta resolution.

import { errorReply, type Ctx, type Reply } from './http.ts';
import { forge, type RepoRec } from './store.ts';
import {
  PKT_FLUSH,
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  isAncestor,
  peelToCommit,
  reachableSet,
  readPackObjects,
  shallowSet,
  sidebandPackets,
  writePack,
  type GitObject,
} from './gitcore.ts';

const AGENT = 'makefun-forge/1.0';

function rawReply(status: number, body: Buffer, contentType: string): Reply {
  return { status, raw: body, contentType };
}

/** Every advertised ref, sorted by name (HEAD is handled separately). */
function sortedRefs(repo: RepoRec): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------------------------
// advertisements

function v0Advertisement(repo: RepoRec, service: string): Buffer {
  const isUpload = service === 'git-upload-pack';
  const capabilities = isUpload
    ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:${headTarget(repo)} agent=${AGENT}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: Array<Buffer | 'flush'> = [Buffer.from(`# service=${service}\n`, 'utf8'), 'flush'];
  const refs = sortedRefs(repo);
  const refLines: string[] = [];
  if (isUpload) {
    const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
    refLines.push(`${headOid} HEAD`);
  }
  for (const ref of refs) {
    refLines.push(`${ref.oid} ${ref.name}`);
    const peeled = peelToCommit(repo.objects, ref.oid);
    if (peeled !== null && peeled !== ref.oid) refLines.push(`${peeled} ${ref.name}^{}`);
  }
  if (refLines.length === 0) {
    lines.push(Buffer.from(`${ZERO_OID} capabilities^{}\0${capabilities}\n`, 'utf8'));
  } else {
    refLines.forEach((line, index) => {
      lines.push(Buffer.from(index === 0 ? `${line}\0${capabilities}\n` : `${line}\n`, 'utf8'));
    });
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 advertisement names no repository state, so it is built once and shared. */
const V2_ADVERTISEMENT: Buffer = encodePktLines([
  Buffer.from('version 2\n', 'utf8'),
  Buffer.from(`agent=${AGENT}\n`, 'utf8'),
  Buffer.from('ls-refs=unborn\n', 'utf8'),
  Buffer.from('fetch=shallow\n', 'utf8'),
  Buffer.from('object-format=sha1\n', 'utf8'),
  'flush',
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(repo: RepoRec, args: LsRefsArgs): Buffer {
  const lines: Array<Buffer | 'flush'> = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  const prefixMatch = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (prefixMatch('HEAD')) {
    if (headOid !== undefined) {
      lines.push(Buffer.from(`${headOid} HEAD${args.symrefs ? ` symref-target:${target}` : ''}\n`, 'utf8'));
    } else if (args.unborn) {
      lines.push(Buffer.from(`unborn HEAD${args.symrefs ? ` symref-target:${target}` : ''}\n`, 'utf8'));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!prefixMatch(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peelToCommit(repo.objects, ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(Buffer.from(`${line}\n`, 'utf8'));
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------------------------
// fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/**
 * Packs for have-less fetches are a pure function of the (content-addressed, append-only)
 * object store, so they are cached by repo id, wants and depth: a burst of identical clones
 * builds its pack once. Any push clears the cache. The framed response bodies built from a
 * cached pack are cached alongside it, so a repeat fetch is a single buffer hand-off.
 */
interface FetchCacheEntry {
  pack: Buffer;
  shallowLines: string[];
  v2Body?: Buffer;
  v0Body?: Buffer;
}
const packCache = new Map<string, FetchCacheEntry>();
const PACK_CACHE_LIMIT = 128;

function computeFetch(repo: RepoRec, args: FetchArgs): { pack: Buffer; shallowLines: string[]; entry?: FetchCacheEntry } {
  const cacheKey =
    args.haves.length === 0 && args.shallow.length === 0
      ? `${repo.id}|${[...args.wants].sort().join(',')}|${args.depth ?? 'full'}`
      : null;
  if (cacheKey !== null) {
    const hit = packCache.get(cacheKey);
    if (hit !== undefined) return { pack: hit.pack, shallowLines: hit.shallowLines, entry: hit };
  }
  const clientShallow = new Set(args.shallow);
  const held = args.haves.length > 0 ? reachableSet(repo.objects, args.haves, { stopAt: clientShallow }) : new Set<string>();
  let send: Set<string>;
  const shallowLines: string[] = [];
  if (args.depth !== null) {
    const { objects, boundary } = shallowSet(repo.objects, args.wants, args.depth);
    send = new Set([...objects].filter((oid) => !held.has(oid)));
    for (const oid of boundary) shallowLines.push(`shallow ${oid}`);
    for (const oid of clientShallow) {
      if (objects.has(oid) && !boundary.includes(oid)) shallowLines.push(`unshallow ${oid}`);
    }
  } else {
    const wanted = reachableSet(repo.objects, args.wants);
    send = new Set([...wanted].filter((oid) => !held.has(oid)));
  }
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const result: FetchCacheEntry = { pack: writePack(objects), shallowLines };
  if (cacheKey !== null) {
    if (packCache.size >= PACK_CACHE_LIMIT) packCache.clear();
    packCache.set(cacheKey, result);
    return { pack: result.pack, shallowLines: result.shallowLines, entry: result };
  }
  return { pack: result.pack, shallowLines: result.shallowLines };
}

function fetchV2(repo: RepoRec, args: FetchArgs): Buffer {
  const { pack, shallowLines, entry } = computeFetch(repo, args);
  if (entry?.v2Body !== undefined) return entry.v2Body;
  const parts: Buffer[] = [];
  if (shallowLines.length > 0) {
    parts.push(encodePktLines([Buffer.from('shallow-info\n', 'utf8'), ...shallowLines.map((line) => Buffer.from(`${line}\n`, 'utf8')), 'delim']));
  }
  parts.push(encodePktLines([Buffer.from('packfile\n', 'utf8')]));
  parts.push(...sidebandPackets(1, pack));
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  if (entry !== undefined) entry.v2Body = body;
  return body;
}

function fetchV0(repo: RepoRec, args: FetchArgs): Buffer {
  const { pack, shallowLines, entry } = computeFetch(repo, args);
  if (entry?.v0Body !== undefined) return entry.v0Body;
  const parts: Buffer[] = [];
  if (shallowLines.length > 0) {
    parts.push(encodePktLines(shallowLines.map((line) => Buffer.from(`${line}\n`, 'utf8'))));
  }
  parts.push(encodePktLines([Buffer.from('NAK\n', 'utf8')]));
  parts.push(...sidebandPackets(1, pack));
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  if (entry !== undefined) entry.v0Body = body;
  return body;
}

// ---------------------------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: RepoRec, body: Buffer): Reply {
  let packets;
  let consumed: number;
  try {
    const decoded = decodePktLines(body, { allowTrailing: true });
    packets = decoded.packets;
    consumed = decoded.consumed;
  } catch {
    return rawReply(400, Buffer.from('invalid pkt-line stream\n', 'utf8'), 'text/plain');
  }
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = new Set(line.slice(nul + 1).split(' ').filter((token) => token !== ''));
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3) return rawReply(400, Buffer.from('invalid ref update command\n', 'utf8'), 'text/plain');
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  const packBytes = body.subarray(consumed);
  const report: string[] = [];
  if (packBytes.length > 0) {
    try {
      const objects = readPackObjects(packBytes, (oid) => repo.objects.get(oid));
      for (const { oid, object } of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
      packCache.clear();
      report.push('unpack ok');
    } catch (err) {
      report.push(`unpack ${err instanceof Error ? err.message : 'error'}`);
      for (const command of commands) report.push(`ng ${command.ref} unpack failed`);
      return pushReport(report, capabilities);
    }
  } else {
    report.push('unpack ok');
  }
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      report.push(`ng ${command.ref} stale info`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}`);
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (object === undefined) {
      report.push(`ng ${command.ref} missing object`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') {
      report.push(`ng ${command.ref} invalid object`);
      continue;
    }
    if (command.oldOid !== ZERO_OID && !isAncestor(repo.objects, command.oldOid, command.newOid)) {
      report.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}`);
  }
  return pushReport(report, capabilities);
}

function pushReport(lines: string[], capabilities: Set<string>): Reply {
  const inner = encodePktLines([...lines.map((line) => Buffer.from(`${line}\n`, 'utf8')), 'flush']);
  if (capabilities.has('side-band-64k')) {
    const body = Buffer.concat([...sidebandPackets(1, inner), PKT_FLUSH]);
    return rawReply(200, body, 'application/x-git-receive-pack-result');
  }
  return rawReply(200, inner, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------------------------
// routing

/** Handle one git smart-HTTP request; `tail` is what follows `/{owner}/{repo}.git`. */
export function handleGit(ctx: Ctx, owner: string, repoName: string, tail: string[], gitProtocol: string | null): Reply {
  const repo = forge.getRepo(owner, repoName);
  if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && ctx.method === 'GET') {
    const service = ctx.query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return rawReply(400, Buffer.from('missing or unknown service\n', 'utf8'), 'text/plain');
    }
    if (repo === undefined) return errorReply(404, 'Not Found');
    const wantsV2 = service === 'git-upload-pack' && gitProtocol !== null && gitProtocol.includes('version=2');
    if (wantsV2) return rawReply(200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
    return rawReply(200, v0Advertisement(repo, service), `application/x-${service}-advertisement`);
  }
  if (repo === undefined) return errorReply(404, 'Not Found');
  if (tail.length === 1 && tail[0] === 'git-upload-pack' && ctx.method === 'POST') {
    return uploadPack(repo, ctx.rawBody);
  }
  if (tail.length === 1 && tail[0] === 'git-receive-pack' && ctx.method === 'POST') {
    return receivePack(repo, ctx.rawBody);
  }
  return errorReply(404, 'Not Found');
}

function uploadPack(repo: RepoRec, body: Buffer): Reply {
  let packets;
  try {
    packets = decodePktLines(body).packets;
  } catch {
    return rawReply(400, Buffer.from('invalid pkt-line stream\n', 'utf8'), 'text/plain');
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    else lines.push(packet.kind === 'delim' ? '\x01' : '\x00');
  }
  const command = lines.find((line) => line.startsWith('command='));
  if (command === 'command=ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of lines) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    return rawReply(200, lsRefs(repo, args), 'application/x-git-upload-pack-result');
  }
  if (command === 'command=fetch') {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
    for (const line of lines) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5));
      else if (line.startsWith('have ')) args.haves.push(line.slice(5));
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8));
      else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7));
    }
    return rawReply(200, fetchV2(repo, args), 'application/x-git-upload-pack-result');
  }
  // Protocol v0 fetch: want lines (the first may carry capabilities), a flush, haves, done.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let sawWant = false;
  for (const line of lines) {
    if (line.startsWith('want ')) {
      args.wants.push((line.slice(5).split(' ')[0] as string));
      sawWant = true;
    } else if (line.startsWith('have ')) args.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7));
  }
  if (sawWant) return rawReply(200, fetchV0(repo, args), 'application/x-git-upload-pack-result');
  return rawReply(400, Buffer.from('unknown upload-pack request\n', 'utf8'), 'text/plain');
}

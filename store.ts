// The forge's in-memory state and the domain operations every surface shares: repositories,
// labels, issues, comments and pull requests over one git object store per repository. One number
// sequence serves issues and pull requests, as on GitHub. All timestamps come from a logical
// clock seeded at the scenario epoch, so a run's bytes are reproducible.

import {
  buildCommit,
  buildTreeFromFlat,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  putObject,
  type GitObject,
} from './gitcore.ts';

/** The one user the trial's token names (the contest scenario's fixed viewer). */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** 2025-01-01T00:00:00Z: the scenario epoch every logical timestamp derives from. */
const EPOCH_SEC = 1_735_689_600;

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  createdSeq: number;
}

export interface IssueRec {
  kind: 'issue';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSeq: number;
  /** Bumped on every mutation of the issue (patch, comment added); keys the GET response cache. */
  rev: number;
  /** The serialized GET /issues/{number} body, valid while `rev` and the repo's labelsRev stand. */
  getCache?: { rev: number; labelsRev: number; body: Buffer };
}

export interface PullRec {
  kind: 'pull';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAtSec: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  comments: CommentRec[];
  createdSeq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  /** Bumped whenever a label is created; label ids derive from label order, so views depend on it. */
  labelsRev: number;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  createdSeq: number;
}

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  private repoCounter = 0;
  private issueIdCounter = 0;
  private commentIdCounter = 0;
  private seqCounter = 0;
  private clockSec = EPOCH_SEC;

  /** The next logical timestamp (seconds), strictly increasing across the whole forge. */
  tick(): number {
    this.clockSec += 1;
    return this.clockSec;
  }

  /** A creation-order sequence number. */
  seq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  nextRepoId(): number {
    this.repoCounter += 1;
    return this.repoCounter;
  }

  nextIssueId(): number {
    this.issueIdCounter += 1;
    return this.issueIdCounter;
  }

  nextCommentId(): number {
    this.commentIdCounter += 1;
    return this.commentIdCounter;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** A repository the token's owner holds; any other owner's name is simply absent (404). */
  getRepo(owner: string, name: string): RepoRec | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(input: { name: string; isPrivate: boolean; description: string; defaultBranch?: string }): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId(),
      owner: VIEWER.login,
      name: input.name,
      isPrivate: input.isPrivate,
      description: input.description,
      defaultBranch: input.defaultBranch ?? 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      labelsRev: 0,
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdSeq: this.seq(),
    };
    this.repos.set(this.repoKey(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** The viewer's repositories in creation order. */
  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }
}

export const forge = new Forge();

const isoCache = new Map<number, string>();

/** An ISO timestamp for a logical second; the same seconds recur constantly, so they are memoized. */
export function isoOf(sec: number): string {
  const hit = isoCache.get(sec);
  if (hit !== undefined) return hit;
  const rendered = new Date(sec * 1000).toISOString();
  if (isoCache.size > 65_536) isoCache.clear();
  isoCache.set(sec, rendered);
  return rendered;
}

/** The identity line REST/GraphQL-created commits carry. */
export function viewerIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

// ---------------------------------------------------------------------------------------------
// git-side domain operations

/** The commit a ref (branch name or full ref) names, or a raw commit id; null when unresolvable. */
export function resolveRef(repo: RepoRec, ref: string): string | null {
  if (ref === 'HEAD') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const byRef = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
  if (byRef !== undefined) return byRef;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
  }
  return null;
}

/** The tree id at a commit, or null. */
export function treeOfCommit(repo: RepoRec, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Make one commit on a branch from a flattened file map; moves the ref and answers the commit id. */
export function commitFiles(
  repo: RepoRec,
  branch: string,
  flat: ReadonlyMap<string, { mode: string; oid: string }>,
  message: string,
): string {
  const tree = buildTreeFromFlat(repo.objects, flat);
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const timestamp = forge.tick();
  const identity = viewerIdentity();
  const commit = buildCommit({
    tree,
    parents: parent === undefined ? [] : [parent],
    author: identity,
    committer: identity,
    timestamp,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const oid = putObject(repo.objects, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

export interface ContentsResult {
  status: 200 | 201;
  commitSha: string;
  blobSha: string;
}

/**
 * PUT /contents semantics: write `content` at `path` on `branch` (created from the default
 * branch when it does not exist yet), honouring the stale-sha rule. Answers null when the
 * caller's sha is stale (the caller turns that into a 409) — see `stale` on the result path:
 * this function returns { stale: true } instead in that case.
 */
export function putContents(
  repo: RepoRec,
  input: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): ContentsResult | { stale: true } | { missingSha: true } {
  const branch = input.branch ?? repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    // A branch named for the first time starts from the default branch's tip (or unborn).
    const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (baseTip !== undefined) {
      repo.refs.set(`refs/heads/${branch}`, baseTip);
      tip = baseTip;
    }
  }
  const flat = new Map<string, { mode: string; oid: string }>();
  if (tip !== undefined) {
    const tree = treeOfCommit(repo, tip);
    if (tree !== null) {
      for (const [path, value] of flattenTree(repo.objects, tree)) flat.set(path, value);
    }
  }
  const existing = flat.get(input.path);
  if (existing !== undefined) {
    if (input.sha === undefined) return { missingSha: true };
    if (input.sha.toLowerCase() !== existing.oid.toLowerCase()) return { stale: true };
  }
  const blobSha = putObject(repo.objects, 'blob', input.content);
  flat.set(input.path, { mode: existing?.mode ?? '100644', oid: blobSha });
  const commitSha = commitFiles(repo, branch, flat, input.message);
  return { status: existing !== undefined ? 200 : 201, commitSha, blobSha };
}

/** DELETE /contents semantics: remove `path` on `branch` with a commit. */
export function deleteContents(
  repo: RepoRec,
  input: { path: string; message: string; branch?: string; sha?: string },
): { commitSha: string } | { missing: true } | { stale: true } {
  const branch = input.branch ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return { missing: true };
  const tree = treeOfCommit(repo, tip);
  if (tree === null) return { missing: true };
  const flat = flattenTree(repo.objects, tree);
  const existing = flat.get(input.path);
  if (existing === undefined) return { missing: true };
  if (input.sha !== undefined && input.sha.toLowerCase() !== existing.oid.toLowerCase()) return { stale: true };
  flat.delete(input.path);
  const commitSha = commitFiles(repo, branch, flat, input.message);
  return { commitSha };
}

// ---------------------------------------------------------------------------------------------
// pull request diff and merge

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Line-level diff counts via a longest-common-subsequence walk (files here are small). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  if (oldLines.length * newLines.length > 4_000_000) {
    // A coarse fallback for very large files: everything old out, everything new in.
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const width = newLines.length + 1;
  const dp = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = oldLines[i] === newLines[j]
        ? (dp[(i + 1) * width + j + 1] as number) + 1
        : Math.max(dp[(i + 1) * width + j] as number, dp[i * width + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

function blobText(repo: RepoRec, oid: string): string {
  const object = repo.objects.get(oid);
  return object === undefined ? '' : object.data.toString('utf8');
}

/** The changed paths between two trees, with line counts — a pull request's files view. */
export function diffTrees(repo: RepoRec, fromTree: string | null, toTree: string | null): FileChange[] {
  const from = fromTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo.objects, fromTree);
  const to = toTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo.objects, toTree);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid && before.mode === after.mode) continue;
    if (before === undefined && after !== undefined) {
      const additions = splitLines(blobText(repo, after.oid)).length;
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before !== undefined && after === undefined) {
      const deletions = splitLines(blobText(repo, before.oid)).length;
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (before !== undefined && after !== undefined) {
      const counts = lineDiffCounts(blobText(repo, before.oid), blobText(repo, after.oid));
      changes.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
    }
  }
  return changes;
}

/** A pull request's live head/base tips and its merge base. */
export function pullTips(repo: RepoRec, pull: PullRec): { headTip: string | null; baseTip: string | null; base: string | null } {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  const base = headTip !== null && baseTip !== null ? mergeBase(repo.objects, headTip, baseTip) : null;
  return { headTip, baseTip, base };
}

/** The files a pull request changes: its merge base's tree against its head's tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
  const { headTip, base } = pullTips(repo, pull);
  if (headTip === null) return [];
  const fromTree = base === null ? null : treeOfCommit(repo, base);
  const toTree = treeOfCommit(repo, headTip);
  return diffTrees(repo, fromTree, toTree);
}

/**
 * Three-way tree merge (fork / head / base flattened maps). Answers the merged map, or null
 * when any path was changed on both sides incompatibly.
 */
export function mergeTrees(
  fork: ReadonlyMap<string, { mode: string; oid: string }>,
  head: ReadonlyMap<string, { mode: string; oid: string }>,
  base: ReadonlyMap<string, { mode: string; oid: string }>,
): Map<string, { mode: string; oid: string }> | null {
  const same = (a?: { mode: string; oid: string }, b?: { mode: string; oid: string }): boolean =>
    a === undefined && b === undefined ? true : a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode;
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set<string>([...fork.keys(), ...head.keys(), ...base.keys()]);
  for (const path of paths) {
    const forkValue = fork.get(path);
    const headValue = head.get(path);
    const baseValue = base.get(path);
    if (same(headValue, baseValue)) {
      if (baseValue !== undefined) merged.set(path, baseValue);
    } else if (same(forkValue, baseValue)) {
      if (headValue !== undefined) merged.set(path, headValue);
    } else if (same(forkValue, headValue)) {
      if (baseValue !== undefined) merged.set(path, baseValue);
    } else {
      return null;
    }
  }
  return merged;
}

/** Whether a pull request would merge cleanly right now (its GraphQL mergeable, REST 405 gate). */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const { headTip, baseTip, base } = pullTips(repo, pull);
  if (headTip === null || baseTip === null) return false;
  const forkTree = base === null ? null : treeOfCommit(repo, base);
  const forkFlat = forkTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo.objects, forkTree);
  const headTree = treeOfCommit(repo, headTip);
  const baseTree = treeOfCommit(repo, baseTip);
  if (headTree === null || baseTree === null) return false;
  return mergeTrees(forkFlat, flattenTree(repo.objects, headTree), flattenTree(repo.objects, baseTree)) !== null;
}

/**
 * Squash-merge a pull request onto its base branch: one commit whose tree is the three-way
 * merge, parented on the current base tip. Answers the merge commit id, or null on conflict.
 */
export function squashMerge(repo: RepoRec, pull: PullRec): string | null {
  const { headTip, baseTip, base } = pullTips(repo, pull);
  if (headTip === null || baseTip === null) return null;
  const forkTree = base === null ? null : treeOfCommit(repo, base);
  const forkFlat = forkTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo.objects, forkTree);
  const headTree = treeOfCommit(repo, headTip);
  const baseTree = treeOfCommit(repo, baseTip);
  if (headTree === null || baseTree === null) return null;
  const merged = mergeTrees(forkFlat, flattenTree(repo.objects, headTree), flattenTree(repo.objects, baseTree));
  if (merged === null) return null;
  const tree = buildTreeFromFlat(repo.objects, merged);
  const timestamp = forge.tick();
  const identity = viewerIdentity();
  const message = pull.body === '' ? `${pull.title} (#${pull.number})\n` : `${pull.title} (#${pull.number})\n\n${pull.body}\n`;
  const commit = buildCommit({ tree, parents: [baseTip], author: identity, committer: identity, timestamp, message });
  const oid = putObject(repo.objects, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAtSec = timestamp;
  pull.mergeCommitSha = oid;
  return oid;
}

// ---------------------------------------------------------------------------------------------
// issues / pulls records

export function createIssue(repo: RepoRec, input: { title: string; body: string; labels?: string[] }): IssueRec {
  const issue: IssueRec = {
    kind: 'issue',
    number: repo.nextNumber,
    id: forge.nextIssueId(),
    title: input.title,
    body: input.body,
    state: 'open',
    labels: input.labels ?? [],
    comments: [],
    createdSeq: forge.seq(),
    rev: 0,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(repo: RepoRec, input: { title: string; body: string; headRef: string; baseRef: string }): PullRec | null {
  const headTip = repo.refs.get(`refs/heads/${input.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${input.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return null;
  const pull: PullRec = {
    kind: 'pull',
    number: repo.nextNumber,
    id: forge.nextIssueId(),
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    mergedAtSec: null,
    mergeCommitSha: null,
    headRef: input.headRef,
    baseRef: input.baseRef,
    headShaAtCreate: headTip,
    baseShaAtCreate: baseTip,
    comments: [],
    createdSeq: forge.seq(),
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The live head/base shas a pull reports (falling back to the creation tips). */
export function pullShas(repo: RepoRec, pull: PullRec): { headSha: string; baseSha: string } {
  return {
    headSha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate,
    baseSha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate,
  };
}

/** Fast-forward test used by receive-pack (re-exported for the git surface). */
export function refIsAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  return isAncestor(repo.objects, ancestor, descendant);
}

export { hashObject };

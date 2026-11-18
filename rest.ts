// The GitHub REST v3 surface: /api/v3 root and meta, the token's user, repositories and their
// branches, commits, git refs, contents, labels, issues, comments and pull requests. Every
// handler answers the http.ts Reply shape; app.ts adds the JSON content type and request id.

import { bodyObject, errorReply, jsonReply, paginate, stringField, boolField, type Ctx, type Reply } from './http.ts';
import {
  VIEWER,
  forge,
  isoOf,
  createIssue,
  createPull,
  deleteContents,
  pullFiles,
  pullMergeable,
  pullShas,
  putContents,
  resolveRef,
  squashMerge,
  treeOfCommit,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { flattenTree, parseCommit, parseTree, type GitObject } from './gitcore.ts';

const EPOCH = 1_735_689_600;
const NOT_FOUND = 'Not Found';

/** A display timestamp from a creation sequence number (deterministic, always valid ISO). */
function dateOf(seq: number): string {
  return isoOf(EPOCH + seq);
}

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User', site_admin: false };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: dateOf(repo.createdSeq),
    updated_at: dateOf(repo.createdSeq),
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: repo.id * 100_000 + [...repo.labels.keys()].indexOf(name) + 1,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: dateOf(issue.createdSeq),
    updated_at: dateOf(issue.createdSeq),
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const shas = pullShas(repo, pull);
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: shas.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: shas.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAtSec === null ? null : isoOf(pull.mergedAtSec),
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: dateOf(pull.createdSeq),
    updated_at: dateOf(pull.createdSeq),
  };
}

function commentJson(comment: { id: number; body: string; createdSeq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: dateOf(comment.createdSeq),
    updated_at: dateOf(comment.createdSeq),
  };
}

// ---------------------------------------------------------------------------------------------
// repositories

function createRepo(ctx: Ctx): Reply {
  const body = bodyObject(ctx);
  const name = stringField(body, 'name');
  if (name === undefined || name === '') return errorReply(422, 'Repository creation failed: name is required');
  if (forge.getRepo(VIEWER.login, name) !== undefined) {
    return errorReply(422, 'Repository creation failed: name already exists on this account');
  }
  const repo = forge.createRepo({
    name,
    isPrivate: boolField(body, 'private') ?? false,
    description: stringField(body, 'description') ?? '',
    defaultBranch: stringField(body, 'default_branch'),
  });
  return jsonReply(201, repoJson(repo));
}

function patchRepo(ctx: Ctx, repo: RepoRec): Reply {
  const body = bodyObject(ctx);
  const description = stringField(body, 'description');
  if (description !== undefined) repo.description = description;
  const isPrivate = boolField(body, 'private');
  if (isPrivate !== undefined) repo.isPrivate = isPrivate;
  const name = stringField(body, 'name');
  if (name !== undefined && name !== '' && name !== repo.name) {
    forge.repos.delete(forge.repoKey(repo.owner, repo.name));
    repo.name = name;
    forge.repos.set(forge.repoKey(repo.owner, repo.name), repo);
  }
  return jsonReply(200, repoJson(repo));
}

function listBranches(repo: RepoRec): Record<string, unknown>[] {
  const branches: Record<string, unknown>[] = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
  }
  return branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function listCommits(ctx: Ctx, repo: RepoRec): Reply {
  const shaParam = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, shaParam);
  if (tip === null) return errorReply(409, 'Git Repository is empty');
  const commits: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && commits.length < 250) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object: GitObject | undefined = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const identity = (line: string): { name: string; email: string; date: string } => {
      const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
      if (match === null) return { name: line, email: '', date: dateOf(repo.createdSeq) };
      return { name: match[1] as string, email: match[2] as string, date: isoOf(Number(match[3])) };
    };
    commits.push({
      sha: oid,
      commit: { message: commit.message.replace(/\n$/, ''), author: identity(commit.author), committer: identity(commit.committer) },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    });
    for (const parent of commit.parents) queue.push(parent);
  }
  const { page, headers } = paginate(ctx, commits);
  return jsonReply(200, page, headers);
}

// ---------------------------------------------------------------------------------------------
// contents

function contentsGet(ctx: Ctx, repo: RepoRec, pathParts: string[]): Reply {
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) return errorReply(404, NOT_FOUND);
  const tree = treeOfCommit(repo, tip);
  if (tree === null) return errorReply(404, NOT_FOUND);
  const path = pathParts.join('/');
  if (path === '') {
    const entries = parseTree((repo.objects.get(tree) as GitObject).data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
    }));
    return jsonReply(200, entries);
  }
  const flat = flattenTree(repo.objects, tree);
  const file = flat.get(path);
  if (file !== undefined) {
    const object = repo.objects.get(file.oid);
    if (object === undefined) return errorReply(404, NOT_FOUND);
    return jsonReply(200, {
      type: 'file',
      name: path.split('/').pop(),
      path,
      sha: file.oid,
      size: object.data.length,
      encoding: 'base64',
      content: object.data.toString('base64'),
    });
  }
  // A directory: every flattened path under it, one level deep.
  const prefix = `${path}/`;
  const children = new Map<string, { type: 'dir' | 'file'; sha: string }>();
  for (const [candidate, value] of flat) {
    if (!candidate.startsWith(prefix)) continue;
    const rest = candidate.slice(prefix.length);
    const head = rest.split('/')[0] as string;
    if (rest.includes('/')) {
      if (!children.has(head)) {
        // The subtree's tree id: walk the tree to the directory.
        let current = tree;
        for (const segment of [...path.split('/'), head]) {
          const treeObject = repo.objects.get(current);
          if (treeObject === undefined) break;
          const entry = parseTree(treeObject.data).find((candidateEntry) => candidateEntry.name === segment);
          if (entry === undefined) break;
          current = entry.oid;
        }
        children.set(head, { type: 'dir', sha: current });
      }
    } else {
      children.set(head, { type: 'file', sha: value.oid });
    }
  }
  if (children.size === 0) return errorReply(404, NOT_FOUND);
  const entries = [...children.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ type: value.type, name, path: `${path}/${name}`, sha: value.sha }));
  return jsonReply(200, entries);
}

function contentsPut(ctx: Ctx, repo: RepoRec, pathParts: string[]): Reply {
  const body = bodyObject(ctx);
  const path = pathParts.join('/');
  if (path === '') return errorReply(422, 'Validation Failed: no path given');
  const content = stringField(body, 'content');
  if (content === undefined) return errorReply(422, 'Validation Failed: content is required');
  const result = putContents(repo, {
    path,
    content: Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64'),
    message: stringField(body, 'message') ?? 'Update file',
    branch: stringField(body, 'branch'),
    sha: stringField(body, 'sha'),
  });
  if ('stale' in result) return errorReply(409, 'Validation Failed: sha is stale');
  if ('missingSha' in result) return errorReply(422, 'Validation Failed: sha is required to update a file');
  const flat = flattenTree(repo.objects, treeOfCommit(repo, result.commitSha) as string);
  const size = flat.get(path);
  return jsonReply(result.status, {
    content: {
      name: path.split('/').pop(),
      path,
      sha: result.blobSha,
      size: size === undefined ? 0 : (repo.objects.get(size.oid)?.data.length ?? 0),
      type: 'file',
      encoding: 'base64',
    },
    commit: { sha: result.commitSha },
  });
}

function contentsDelete(ctx: Ctx, repo: RepoRec, pathParts: string[]): Reply {
  const body = bodyObject(ctx);
  const path = pathParts.join('/');
  const result = deleteContents(repo, {
    path,
    message: stringField(body, 'message') ?? 'Delete file',
    branch: stringField(body, 'branch'),
    sha: stringField(body, 'sha'),
  });
  if ('missing' in result) return errorReply(404, NOT_FOUND);
  if ('stale' in result) return errorReply(409, 'Validation Failed: sha is stale');
  return jsonReply(200, { content: null, commit: { sha: result.commitSha } });
}

// ---------------------------------------------------------------------------------------------
// issues and comments

function createIssueRest(ctx: Ctx, repo: RepoRec): Reply {
  const body = bodyObject(ctx);
  const title = stringField(body, 'title');
  if (title === undefined) return errorReply(422, 'Validation Failed: title is required');
  const labelsRaw = body.labels;
  const labels: string[] = [];
  if (Array.isArray(labelsRaw)) {
    for (const entry of labelsRaw) {
      const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? stringField(entry as Record<string, unknown>, 'name') : undefined;
      if (name === undefined) continue;
      if (!repo.labels.has(name)) return errorReply(422, `Validation Failed: label "${name}" does not exist`);
      labels.push(name);
    }
  }
  const issue = createIssue(repo, { title, body: stringField(body, 'body') ?? '', labels });
  return jsonReply(201, issueJson(repo, issue));
}

function listIssues(ctx: Ctx, repo: RepoRec): Reply {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const { page, headers } = paginate(ctx, issues);
  return jsonReply(200, page.map((issue) => issueJson(repo, issue)), headers);
}

function patchIssue(ctx: Ctx, repo: RepoRec, issue: IssueRec): Reply {
  const body = bodyObject(ctx);
  const state = stringField(body, 'state');
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = stringField(body, 'title');
  if (title !== undefined) issue.title = title;
  const text = stringField(body, 'body');
  if (text !== undefined) issue.body = text;
  issue.rev += 1;
  return jsonReply(200, issueJson(repo, issue));
}

/**
 * GET one issue, with the serialized body cached on the record: an issue's view changes
 * only when the issue itself is patched, gains a comment, or the repo's labels change,
 * and the revision counters name exactly those events.
 */
function getIssue(repo: RepoRec, issue: IssueRec): Reply {
  const cached = issue.getCache;
  if (cached !== undefined && cached.rev === issue.rev && cached.labelsRev === repo.labelsRev) {
    return { status: 200, raw: cached.body, contentType: 'application/json; charset=utf-8' };
  }
  const body = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  issue.getCache = { rev: issue.rev, labelsRev: repo.labelsRev, body };
  return { status: 200, raw: body, contentType: 'application/json; charset=utf-8' };
}

/** The comment list a number names: an issue's, or a pull request's (GitHub shares the route). */
function commentTarget(repo: RepoRec, number: number): { comments: IssueRec['comments'] } | undefined {
  return repo.issues.get(number) ?? repo.pulls.get(number);
}

// ---------------------------------------------------------------------------------------------
// pull requests

function createPullRest(ctx: Ctx, repo: RepoRec): Reply {
  const body = bodyObject(ctx);
  const head = stringField(body, 'head');
  const base = stringField(body, 'base');
  const title = stringField(body, 'title');
  if (head === undefined || base === undefined || title === undefined) {
    return errorReply(422, 'Validation Failed: head, base and title are required');
  }
  const headName = head.includes(':') ? (head.split(':').pop() as string) : head;
  const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === headName && pull.baseRef === base);
  if (existing !== undefined) return errorReply(422, 'Validation Failed: a pull request already exists for this branch');
  const pull = createPull(repo, { title, body: stringField(body, 'body') ?? '', headRef: headName, baseRef: base });
  if (pull === null) return errorReply(422, 'Validation Failed: head or base branch does not exist');
  return jsonReply(201, pullJson(repo, pull));
}

function listPulls(ctx: Ctx, repo: RepoRec): Reply {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.number - a.number);
  const { page, headers } = paginate(ctx, pulls);
  return jsonReply(200, page.map((pull) => pullJson(repo, pull)), headers);
}

function mergePullRest(ctx: Ctx, repo: RepoRec, pull: PullRec): Reply {
  if (pull.state !== 'open') return errorReply(405, 'Pull Request is not open');
  if (!pullMergeable(repo, pull)) return errorReply(405, 'Pull Request is not mergeable');
  const sha = squashMerge(repo, pull);
  if (sha === null) return errorReply(405, 'Pull Request is not mergeable');
  return jsonReply(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------------------------
// routing

/** Handle one request under /api/v3 (segments[0..1] are 'api', 'v3'). */
export function handleRest(ctx: Ctx): Reply {
  if (ctx.jsonError) return errorReply(400, 'Invalid JSON');
  const rest = ctx.segments.slice(2);
  const method = ctx.method;

  if (rest.length === 0) {
    if (method !== 'GET') return errorReply(404, NOT_FOUND);
    return jsonReply(
      200,
      {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return errorReply(404, NOT_FOUND);
    return jsonReply(200, { installed_version: '1.0.0', api: ['3.0'], git: ['2.0'] });
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return errorReply(404, NOT_FOUND);
    return jsonReply(200, userJson());
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const { page, headers } = paginate(ctx, forge.listRepos());
      return jsonReply(200, page.map(repoJson), headers);
    }
    if (method === 'POST') return createRepo(ctx);
    return errorReply(404, NOT_FOUND);
  }

  if (rest[0] !== 'repos' || rest.length < 3) return errorReply(404, NOT_FOUND);
  const owner = rest[1] as string;
  const name = rest[2] as string;
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return errorReply(404, NOT_FOUND);
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') return jsonReply(200, repoJson(repo));
    if (method === 'PATCH') return patchRepo(ctx, repo);
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204 };
    }
    return errorReply(404, NOT_FOUND);
  }

  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const { page, headers } = paginate(ctx, listBranches(repo));
      return jsonReply(200, page, headers);
    }
    if (tail.length >= 2 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return errorReply(404, NOT_FOUND);
      return jsonReply(200, { name: branch, commit: { sha }, protected: false });
    }
    return errorReply(404, NOT_FOUND);
  }

  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') return listCommits(ctx, repo);

  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2) {
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const ref = stringField(body, 'ref');
        const sha = stringField(body, 'sha');
        if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return errorReply(422, 'Validation Failed: ref and sha are required');
        const object = repo.objects.get(sha);
        if (object === undefined) return errorReply(422, 'Validation Failed: sha does not name an object');
        if (repo.refs.has(ref)) return errorReply(422, 'Validation Failed: reference already exists');
        repo.refs.set(ref, sha);
        return jsonReply(201, { ref, object: { sha, type: object.type } });
      }
      if (method === 'GET') {
        const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
        return jsonReply(200, refs);
      }
      return errorReply(404, NOT_FOUND);
    }
    if (method === 'GET') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return errorReply(404, NOT_FOUND);
      return jsonReply(200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    return errorReply(404, NOT_FOUND);
  }

  if (tail[0] === 'contents') {
    const pathParts = tail.slice(1);
    if (method === 'GET') return contentsGet(ctx, repo, pathParts);
    if (method === 'PUT') return contentsPut(ctx, repo, pathParts);
    if (method === 'DELETE') return contentsDelete(ctx, repo, pathParts);
    return errorReply(404, NOT_FOUND);
  }

  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'POST') {
      const body = bodyObject(ctx);
      const labelName = stringField(body, 'name');
      if (labelName === undefined || labelName === '') return errorReply(422, 'Validation Failed: name is required');
      if (repo.labels.has(labelName)) return errorReply(422, 'Validation Failed: label already exists');
      repo.labels.set(labelName, {
        name: labelName,
        color: stringField(body, 'color') ?? 'ededed',
        description: stringField(body, 'description') ?? null,
      });
      repo.labelsRev += 1;
      return jsonReply(201, labelJson(repo, labelName));
    }
    if (method === 'GET') return jsonReply(200, [...repo.labels.keys()].map((labelName) => labelJson(repo, labelName)));
    return errorReply(404, NOT_FOUND);
  }

  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') return listIssues(ctx, repo);
      if (method === 'POST') return createIssueRest(ctx, repo);
      return errorReply(404, NOT_FOUND);
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number <= 0) return errorReply(404, NOT_FOUND);
    if (tail.length === 2) {
      const issue = repo.issues.get(number);
      if (issue === undefined) return errorReply(404, NOT_FOUND);
      if (method === 'GET') return getIssue(repo, issue);
      if (method === 'PATCH') return patchIssue(ctx, repo, issue);
      return errorReply(404, NOT_FOUND);
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      const target = commentTarget(repo, number);
      if (target === undefined) return errorReply(404, NOT_FOUND);
      if (method === 'GET') {
        const { page, headers } = paginate(ctx, target.comments);
        return jsonReply(200, page.map(commentJson), headers);
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const text = stringField(body, 'body');
        if (text === undefined) return errorReply(422, 'Validation Failed: body is required');
        const comment = { id: forge.nextCommentId(), body: text, createdSeq: forge.seq() };
        target.comments.push(comment);
        const commentedIssue = repo.issues.get(number);
        if (commentedIssue !== undefined) commentedIssue.rev += 1;
        return jsonReply(201, commentJson(comment));
      }
      return errorReply(404, NOT_FOUND);
    }
    return errorReply(404, NOT_FOUND);
  }

  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') return listPulls(ctx, repo);
      if (method === 'POST') return createPullRest(ctx, repo);
      return errorReply(404, NOT_FOUND);
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number <= 0) return errorReply(404, NOT_FOUND);
    const pull = repo.pulls.get(number);
    if (pull === undefined) return errorReply(404, NOT_FOUND);
    if (tail.length === 2 && method === 'GET') return jsonReply(200, pullJson(repo, pull));
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      const files = pullFiles(repo, pull).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }));
      const { page, headers } = paginate(ctx, files);
      return jsonReply(200, page, headers);
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') return mergePullRest(ctx, repo, pull);
    return errorReply(404, NOT_FOUND);
  }

  return errorReply(404, NOT_FOUND);
}

// The GraphQL surface: POST /api/graphql. A small hand-written parser and executor covering
// exactly the schema the forge exposes — viewer, repositories, issues, pull requests, node,
// __type introspection, connections with cursor pagination, and the five mutations. Global ids
// are opaque base64 strings that never equal a bare database id.

import { errorReply, jsonReply, type Ctx, type Reply } from './http.ts';
import {
  VIEWER,
  forge,
  createIssue,
  createPull,
  pullFiles,
  pullMergeable,
  squashMerge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// global ids

function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon <= 0) return null;
    return { type: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(document: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < document.length) {
    const c = document[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < document.length && document[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && document.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (document.startsWith('"""', i)) {
        const end = document.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: document.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < document.length && document[i] !== '"') {
        if (document[i] === '\\') {
          const escape = document[i + 1] as string;
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escape === 'u') {
            value += String.fromCharCode(parseInt(document.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += escapes[escape] ?? escape;
            i += 2;
          }
        } else {
          value += document[i];
          i += 1;
        }
      }
      if (i >= document.length) throw new Error('unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(c)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(document.slice(i));
      if (match === null) throw new Error(`invalid number at offset ${i}`);
      const text = match[0];
      if (text.includes('.') || text.includes('e') || text.includes('E')) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: Number(text) });
      i += text.length;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < document.length && isNameChar(document[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: document.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'enum'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias?: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition?: string; selection: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  selection: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selection: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    return this.tokens[this.pos++] as Token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ operation: token.value === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragmentName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragmentName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition "${token.value}"`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected token in a value');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selection: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selection };
  }
}

// ---------------------------------------------------------------------------------------------
// execution

class GqlError extends Error {}

type Source = { __typename: string; [key: string]: unknown };

interface Env {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
}

function resolveValue(node: ValueNode, env: Env): unknown {
  switch (node.kind) {
    case 'variable':
      return env.variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'enum':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, env));
    case 'object': {
      const object: Record<string, unknown> = {};
      for (const field of node.fields) object[field.name] = resolveValue(field.value, env);
      return object;
    }
  }
}

function argsOf(field: FieldNode, env: Env): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, env);
  return args;
}

/** Expand spreads and inline fragments for the given concrete type, preserving order. */
function expandSelections(selections: SelectionNode[], typeName: string, env: Env): FieldNode[] {
  const fields: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.kind === 'field') fields.push(selection);
    else if (selection.kind === 'spread') {
      const fragment = env.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === typeName) fields.push(...expandSelections(fragment.selection, typeName, env));
    } else if (selection.typeCondition === undefined || selection.typeCondition === typeName) {
      fields.push(...expandSelections(selection.selection, typeName, env));
    }
  }
  return fields;
}

function repoSource(repo: RepoRec): Source {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: RepoRec, issue: IssueRec): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: RepoRec, pull: PullRec): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function findIssueById(id: number): { repo: RepoRec; issue: IssueRec } | null {
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return null;
}

function findPullById(id: number): { repo: RepoRec; pull: PullRec } | null {
  for (const repo of forge.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return null;
}

function findRepoById(id: number): RepoRec | null {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return null;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = Number(decoded.replace(/^cursor:/, ''));
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function pageInfoSource(hasNextPage: boolean, endCursor: string | null): Source {
  return { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: null };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'repository', 'author', 'createdAt', 'updatedAt'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'repository', 'author', 'mergeCommit',
  ],
  User: ['login', 'id', 'name', 'email'],
  Ref: ['name', 'prefix', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergePullRequestMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

function resolveField(typeName: string, source: Source, field: FieldNode, env: Env): unknown {
  const args = argsOf(field, env);
  const unknown = (): never => {
    throw new GqlError(`Cannot query field "${field.name}" on type "${typeName}".`);
  };
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return { __typename: 'User', login: VIEWER.login };
      if (field.name === 'repository') {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoSource(repo);
      }
      if (field.name === 'node') {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed === null) return null;
        if (parsed.type === 'Repository') {
          const repo = findRepoById(Number(parsed.key));
          return repo === null ? null : repoSource(repo);
        }
        if (parsed.type === 'Issue') {
          const found = findIssueById(Number(parsed.key.split(':').pop()));
          return found === null ? null : issueSource(found.repo, found.issue);
        }
        if (parsed.type === 'PullRequest') {
          const found = findPullById(Number(parsed.key.split(':').pop()));
          return found === null ? null : pullSource(found.repo, found.pull);
        }
        return null;
      }
      return unknown();
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed !== null && parsed.type === 'Repository' ? findRepoById(Number(parsed.key)) : null;
        if (repo === null) throw new GqlError('createIssue: repository not found');
        const issue = createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
        return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue) };
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        const found = parsed !== null ? findIssueById(Number(parsed.key.split(':').pop())) : null;
        if (found === null) throw new GqlError('closeIssue: issue not found');
        found.issue.state = 'closed';
        found.issue.rev += 1;
        return { __typename: 'CloseIssuePayload', issue: issueSource(found.repo, found.issue) };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed !== null && parsed.type === 'Repository' ? findRepoById(Number(parsed.key)) : null;
        if (repo === null) throw new GqlError('createPullRequest: repository not found');
        const pull = createPull(repo, {
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          headRef: String(input.headRefName ?? ''),
          baseRef: String(input.baseRefName ?? ''),
        });
        if (pull === null) throw new GqlError('createPullRequest: head or base branch does not exist');
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, pull) };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        const found = parsed !== null ? findPullById(Number(parsed.key.split(':').pop())) : null;
        if (found === null) throw new GqlError('mergePullRequest: pull request not found');
        if (!pullMergeable(found.repo, found.pull)) throw new GqlError('mergePullRequest: pull request is not mergeable');
        squashMerge(found.repo, found.pull);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(found.repo, found.pull) };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        if (parsed === null) throw new GqlError('addComment: subject not found');
        const numericId = Number(parsed.key.split(':').pop());
        const comment = { id: forge.nextCommentId(), body: String(input.body ?? ''), createdSeq: forge.seq() };
        if (parsed.type === 'Issue') {
          const found = findIssueById(numericId);
          if (found === null) throw new GqlError('addComment: subject not found');
          found.issue.comments.push(comment);
          found.issue.rev += 1;
          return {
            __typename: 'AddCommentPayload',
            commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', repo: found.repo, comment } },
          };
        }
        if (parsed.type === 'PullRequest') {
          const found = findPullById(numericId);
          if (found === null) throw new GqlError('addComment: subject not found');
          found.pull.comments.push(comment);
          return {
            __typename: 'AddCommentPayload',
            commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', repo: found.repo, comment } },
          };
        }
        throw new GqlError('addComment: subject not found');
      }
      return unknown();
    }
    case 'User': {
      if (field.name === 'login') return source.login;
      if (field.name === 'id') return globalId('User', String(source.login));
      if (field.name === 'name') return VIEWER.name;
      if (field.name === 'email') return VIEWER.email;
      return unknown();
    }
    case 'Repository': {
      const repo = source.repo as RepoRec;
      switch (field.name) {
        case 'id':
          return globalId('Repository', String(repo.id));
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { __typename: 'User', login: repo.owner };
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch, target: tip };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueSource(repo, issue);
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          const states = args.states as unknown[] | undefined;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
          list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
          const start = decodeCursor(args.after);
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
          const slice = list.slice(start, start + first);
          const hasNextPage = start + slice.length < list.length;
          return {
            __typename: 'IssueConnection',
            nodes: slice.map((issue) => issueSource(repo, issue)),
            pageInfo: pageInfoSource(hasNextPage, slice.length > 0 ? encodeCursor(start + slice.length) : null),
            totalCount: list.length,
          };
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
          const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
          return { __typename: 'PullRequestConnection', nodes: list.slice(0, first).map((pull) => pullSource(repo, pull)) };
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullSource(repo, pull);
        }
        default:
          return unknown();
      }
    }
    case 'Issue': {
      const repo = source.repo as RepoRec;
      const issue = source.issue as IssueRec;
      switch (field.name) {
        case 'id':
          return globalId('Issue', `${repo.id}:${issue.id}`);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'repository':
          return repoSource(repo);
        case 'author':
          return { __typename: 'User', login: VIEWER.login };
        default:
          return unknown();
      }
    }
    case 'PullRequest': {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', `${repo.id}:${pull.id}`);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'files': {
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
          const files = pullFiles(repo, pull).slice(0, first);
          return {
            __typename: 'PullRequestFileConnection',
            nodes: files.map((file) => ({ __typename: 'PullRequestFile', path: file.filename })),
          };
        }
        case 'repository':
          return repoSource(repo);
        case 'author':
          return { __typename: 'User', login: VIEWER.login };
        case 'mergeCommit':
          return pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha };
        default:
          return unknown();
      }
    }
    case 'Ref': {
      if (field.name === 'name') return source.name;
      if (field.name === 'prefix') return 'refs/heads/';
      if (field.name === 'target') return { __typename: 'Commit', oid: source.target };
      return unknown();
    }
    case 'Commit': {
      if (field.name === 'oid' || field.name === 'id') return source.oid;
      return unknown();
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return source.hasNextPage;
      if (field.name === 'hasPreviousPage') return source.hasPreviousPage;
      if (field.name === 'endCursor') return source.endCursor;
      if (field.name === 'startCursor') return source.startCursor;
      return unknown();
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection': {
      if (field.name === 'nodes') return source.nodes;
      if (field.name === 'pageInfo') return source.pageInfo;
      if (field.name === 'totalCount') return source.totalCount;
      return unknown();
    }
    case 'PullRequestFile': {
      if (field.name === 'path') return source.path;
      return unknown();
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return source.issue;
      return unknown();
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return source.pullRequest;
      return unknown();
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return source.commentEdge;
      return unknown();
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return source.node;
      if (field.name === 'cursor') return encodeCursor(0);
      return unknown();
    }
    case 'IssueComment': {
      const comment = source.comment as { id: number; body: string };
      const repo = source.repo as RepoRec;
      if (field.name === 'id') return globalId('IssueComment', `${repo.id}:${comment.id}`);
      if (field.name === 'body') return comment.body;
      if (field.name === 'author') return { __typename: 'User', login: VIEWER.login };
      return unknown();
    }
    case '__Type': {
      if (field.name === 'name') return source.name;
      if (field.name === 'kind') return source.kind;
      if (field.name === 'fields') return source.fields;
      if (field.name === 'enumValues') return source.enumValues;
      if (field.name === 'description') return null;
      return unknown();
    }
    case '__Field': {
      if (field.name === 'name') return source.name;
      return unknown();
    }
    case '__EnumValue': {
      if (field.name === 'name') return source.name;
      return unknown();
    }
    default:
      return unknown();
  }
}

function typeSource(name: string): Source | null {
  const fields = TYPE_FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  if (fields === undefined && enumValues === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: enumValues !== undefined && fields === undefined ? 'ENUM' : 'OBJECT',
    fields: (fields ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName })),
    enumValues: (enumValues ?? []).map((valueName) => ({ __typename: '__EnumValue', name: valueName })),
  };
}

function completeValue(value: unknown, field: FieldNode, env: Env): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, env));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    return executeSelection(value as Source, field.selection ?? [], env);
  }
  return value;
}

function executeSelection(source: Source, selections: SelectionNode[], env: Env): Record<string, unknown> {
  const typeName = source.__typename;
  const output: Record<string, unknown> = {};
  for (const field of expandSelections(selections, typeName, env)) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      output[key] = typeName;
      continue;
    }
    if (typeName === 'Query' && field.name === '__type') {
      const args = argsOf(field, env);
      const type = typeSource(String(args.name ?? ''));
      output[key] = type === null ? null : completeValue(type, field, env);
      continue;
    }
    const value = resolveField(typeName, source, field, env);
    output[key] = completeValue(value, field, env);
  }
  return output;
}

function executeOperation(operation: OperationNode, variables: Record<string, unknown>, fragments: Map<string, FragmentNode>): Record<string, unknown> {
  const env: Env = { variables, fragments };
  const root: Source = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  return { data: executeSelection(root, operation.selection, env) };
}

function executeRequest(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) return { errors: [{ message: 'Invalid request' }] };
  const request = payload as Record<string, unknown>;
  const query = request.query;
  if (typeof query !== 'string' || query === '') return { errors: [{ message: 'No query given' }] };
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
  try {
    const { operations, fragments } = new Parser(lex(query)).parseDocument();
    if (operations.length === 0) return { errors: [{ message: 'No operation found' }] };
    let operation = operations[0] as OperationNode;
    const operationName = request.operationName;
    if (typeof operationName === 'string' && operationName !== '') {
      const named = operations.find((candidate) => candidate.name === operationName);
      if (named === undefined) return { errors: [{ message: `Unknown operation "${operationName}"` }] };
      operation = named;
    }
    return executeOperation(operation, variables, fragments);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL error' }] };
  }
}

/** Handle one POST /api/graphql request (single operation or a batch array). */
export function handleGraphql(ctx: Ctx): Reply {
  if (ctx.jsonError) return errorReply(400, 'Invalid JSON');
  if (Array.isArray(ctx.json)) return jsonReply(200, ctx.json.map((entry) => executeRequest(entry)));
  return jsonReply(200, executeRequest(ctx.json));
}

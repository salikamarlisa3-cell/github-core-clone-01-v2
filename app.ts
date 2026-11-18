// The forge's HTTP wiring: one node:http server that routes /healthz, the REST v3 surface
// (/api/v3), GraphQL (/api/graphql), MCP (/mcp) and git smart HTTP (/{owner}/{repo}.git).
// Every surface but /healthz requires the shop token as a Bearer credential; the store behind
// them all is the singleton in store.ts. main.ts owns the lifecycle and stays as it shipped.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import type { Ctx, Reply } from './http.ts';

/** The shared empty body for requests that carry none. */
const EMPTY_BODY = Buffer.alloc(0);

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** Whether the request can carry a body at all: a GET or HEAD with no length and no transfer framing has none. */
function mayCarryBody(request: IncomingMessage): boolean {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return true;
  const length = request.headers['content-length'];
  if (length !== undefined) return length !== '0';
  return request.headers['transfer-encoding'] !== undefined;
}

function writeReply(response: ServerResponse, reply: Reply, isApi: boolean, requestId: string): void {
  const headers: Record<string, string> = { ...(reply.headers ?? {}) };
  let body: Buffer;
  if (reply.raw !== undefined) {
    body = reply.raw;
    headers['content-type'] = reply.contentType ?? 'application/octet-stream';
  } else if (reply.body !== undefined) {
    body = Buffer.from(JSON.stringify(reply.body), 'utf8');
    headers['content-type'] = reply.contentType ?? 'application/json; charset=utf-8';
  } else {
    body = Buffer.alloc(0);
    if (reply.contentType !== undefined) headers['content-type'] = reply.contentType;
    else if (isApi) headers['content-type'] = 'application/json; charset=utf-8';
  }
  if (isApi) headers['x-github-request-id'] = requestId;
  headers['content-length'] = String(body.length);
  response.writeHead(reply.status, headers);
  response.end(body);
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  let requestCounter = 0;

  function authorized(request: IncomingMessage): boolean {
    const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    if (expected === '') return false;
    return request.headers.authorization === `Bearer ${expected}`;
  }

  function route(request: IncomingMessage, ctx: Ctx): Reply {
    const { segments } = ctx;
    if (ctx.method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
      return { status: 200, body: { ok: true } };
    }
    if (!authorized(request)) {
      return { status: 401, body: { message: 'Bad credentials' } };
    }
    if (segments[0] === 'api' && segments[1] === 'v3') return handleRest(ctx);
    if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2 && ctx.method === 'POST') return handleGraphql(ctx);
    if (segments[0] === 'mcp' && segments.length === 1 && ctx.method === 'POST') return handleMcp(ctx);
    if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
      const gitProtocol = request.headers['git-protocol'];
      return handleGit(
        ctx,
        segments[0] as string,
        (segments[1] as string).slice(0, -'.git'.length),
        segments.slice(2),
        typeof gitProtocol === 'string' ? gitProtocol : null,
      );
    }
    return { status: 404, body: { message: 'Not Found' } };
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    requestCounter += 1;
    const requestId = `req-${requestCounter.toString(36)}`;
    const rawBody = mayCarryBody(request) ? await readBody(request) : EMPTY_BODY;
    const url = new URL(request.url ?? '/', 'http://localhost');
    const segments = url.pathname
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => {
        if (!segment.includes('%')) return segment;
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
    const isApi = segments[0] === 'api';
    let json: unknown;
    let jsonError = false;
    // Only the JSON surfaces (REST, GraphQL, MCP) ever look at the parsed body; the git
    // surfaces read rawBody alone, so a pack's bytes are never fed to the JSON parser.
    if (rawBody.length > 0 && (segments[0] === 'api' || segments[0] === 'mcp')) {
      try {
        json = JSON.parse(rawBody.toString('utf8'));
      } catch {
        jsonError = true;
      }
    }
    const ctx: Ctx = {
      method: request.method ?? 'GET',
      path: url.pathname,
      segments,
      query: url.searchParams,
      rawBody,
      json,
      jsonError,
      host: request.headers.host ?? 'localhost',
      requestId,
    };
    writeReply(response, route(request, ctx), isApi, requestId);
  }

  return createServer((request, response) => {
    handle(request, response).catch(() => {
      try {
        if (!response.headersSent) {
          const body = Buffer.from(JSON.stringify({ message: 'Internal Server Error' }), 'utf8');
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
          response.end(body);
        } else {
          response.end();
        }
      } catch {
        // The connection is already gone; nothing more to do.
      }
    });
  });
}

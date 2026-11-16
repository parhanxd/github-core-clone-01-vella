// The server: one router over git smart HTTP, REST v3, GraphQL v4 and MCP, on the store.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { TOKEN, userForToken } from './store.ts';
import { gitResponse, readGitProtocolVersion } from './gitservice.ts';
import { handleRest } from './restapi.ts';
import { handleGraphQL } from './gql.ts';
import { handleMcp } from './mcpapi.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function pathOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void route(req, res);
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { path, query } = pathOf(req);
    const method = req.method ?? 'GET';
    const token = bearerToken(req);
    const authed = token !== null && userForToken(token) !== null;

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // git smart HTTP first (tokened like the API).
    if (path.includes('.git/')) {
      const served = await gitResponse(req, res, path, query);
      if (served) return;
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (path === '/api/graphql' && method === 'POST') {
      await handleGraphQL(req, res, authed);
      return;
    }

    if (path === '/mcp' && method === 'POST') {
      // The MCP endpoint authenticates per request (a call with no Authorization answers 401),
      // so auth gating happens inside the handler per message.
      await handleMcp(req, res, authed);
      return;
    }

    if (path.startsWith('/api/v3')) {
      await handleRest({ req, res, method, path, query, authed });
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
    } else {
      res.end();
    }
  }
}

export { readGitProtocolVersion, TOKEN };

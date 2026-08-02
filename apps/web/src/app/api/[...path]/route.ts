/**
 * Runtime proxy from this server to the API.
 *
 * The browser calls this app's own origin (`/api/v1/...`) and this handler forwards to
 * the backend. That keeps the backend address out of the browser bundle and removes
 * cross-origin requests entirely.
 *
 * This replaces a `rewrites()` entry in next.config.mjs, which could not work: Next
 * evaluates `rewrites()` during `next build` and bakes the result into
 * routes-manifest.json, so a host that assigns service addresses at deploy time produced
 * an EMPTY rewrite list and every API call 404'd — surfacing in the UI as the unhelpful
 * "Request failed". A route handler reads the environment on each request, so the address
 * can genuinely arrive at boot.
 */
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Headers describing this particular hop rather than the request itself. Forwarding them
 * corrupts the next hop — notably `host`, which would make the API serve the wrong vhost,
 * and `content-length`, which no longer matches once a body is re-encoded.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function upstreamBase(): string | null {
  const raw = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_ORIGIN;
  if (!raw) return null;
  // Hosts commonly expose a bare hostname (`intoto-api.onrender.com`) with no scheme.
  return raw.startsWith('http') ? raw.replace(/\/$/, '') : `https://${raw}`;
}

async function proxy(request: NextRequest): Promise<Response> {
  const base = upstreamBase();
  if (!base) {
    return Response.json(
      {
        statusCode: 502,
        message:
          'The web service has no API address configured. Set API_INTERNAL_URL to the API service host.',
      },
      { status: 502 },
    );
  }

  const incoming = new URL(request.url);
  const target = new URL(`${base}${incoming.pathname}${incoming.search}`);

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });

  // Read the body up front rather than streaming it: a streamed request body needs
  // `duplex: 'half'`, which not every runtime along this path supports, and API payloads
  // here are small enough that buffering costs nothing.
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch (cause) {
    // Without this the browser receives Next's HTML error page, which fails to parse as
    // JSON and reaches the user as "Request failed" with nothing to act on.
    return Response.json(
      {
        statusCode: 502,
        message: `Could not reach the API at ${target.origin}. It may still be starting up — wait a minute and try again.`,
        error: cause instanceof Error ? cause.message : String(cause),
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // `content-encoding` is dropped because fetch has already decompressed the body;
    // passing the header on would tell the browser to decompress it a second time.
    if (!HOP_BY_HOP.has(lower) && lower !== 'content-encoding') {
      responseHeaders.set(key, value);
    }
  });

  // Streamed so that spreadsheet and PDF exports are not held in memory in full.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;

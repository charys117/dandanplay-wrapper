const UPSTREAM_ORIGIN = "https://api.dandanplay.net";

export interface Env {
  DANDANPLAY_APP_ID: string;
  DANDANPLAY_APP_SECRET: string;
  PROXY_TOKEN: string;
}

interface AuthenticatedPath {
  token: string;
  upstreamPath: string;
}

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Authorization, Content-Type",
  "Access-Control-Expose-Headers": "X-Error-Message",
  "Access-Control-Max-Age": "86400",
};

export function splitTokenPrefixedPath(pathname: string): AuthenticatedPath | null {
  if (!pathname.startsWith("/")) {
    return null;
  }

  const separator = pathname.indexOf("/", 1);
  if (separator < 0) return null;

  const rawToken = pathname.slice(1, separator);
  if (!rawToken) return null;

  let token: string;
  try {
    token = decodeURIComponent(rawToken);
  } catch {
    return null;
  }

  return {
    token,
    upstreamPath: pathname.slice(separator) || "/",
  };
}

async function sha256(input: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(input);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export async function createSignature(
  appId: string,
  timestamp: string,
  path: string,
  appSecret: string,
): Promise<string> {
  return toBase64(await sha256(`${appId}${timestamp}${path}${appSecret}`));
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash[index] ^ rightHash[index];
  }
  return difference === 0;
}

function jsonError(status: number, message: string): Response {
  return withCors(
    Response.json(
      {
        success: false,
        errorCode: status,
        errorMessage: message,
      },
      { status },
    ),
  );
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function createUpstreamHeaders(request: Request, env: Env): Headers {
  const headers = new Headers(request.headers);

  for (const name of [
    "CF-Connecting-IP",
    "CF-IPCountry",
    "CF-Ray",
    "CF-Visitor",
    "Connection",
    "Content-Length",
    "Host",
    "X-AppId",
    "X-AppSecret",
    "X-Signature",
    "X-Timestamp",
  ]) {
    headers.delete(name);
  }

  headers.set("X-AppId", env.DANDANPLAY_APP_ID);
  return headers;
}

async function proxyRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.DANDANPLAY_APP_ID || !env.DANDANPLAY_APP_SECRET || !env.PROXY_TOKEN) {
    return jsonError(500, "Worker secrets are not configured");
  }

  const incomingUrl = new URL(request.url);
  const authenticatedPath = splitTokenPrefixedPath(incomingUrl.pathname);
  if (
    !authenticatedPath ||
    !(await timingSafeEqual(authenticatedPath.token, env.PROXY_TOKEN))
  ) {
    return jsonError(401, "Invalid proxy token");
  }

  const { upstreamPath } = authenticatedPath;

  const upstreamUrl = new URL(upstreamPath, UPSTREAM_ORIGIN);
  upstreamUrl.search = incomingUrl.search;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers = createUpstreamHeaders(request, env);
  headers.set(
    "X-Signature",
    await createSignature(
      env.DANDANPLAY_APP_ID,
      timestamp,
      upstreamPath,
      env.DANDANPLAY_APP_SECRET,
    ),
  );
  headers.set("X-Timestamp", timestamp);

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "follow",
  });

  return withCors(upstreamResponse);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...CORS_HEADERS, "Cache-Control": "no-store" },
      });
    }

    try {
      return await proxyRequest(request, env);
    } catch (error) {
      console.error("Proxy request failed", error);
      return jsonError(502, "Upstream request failed");
    }
  },
} satisfies ExportedHandler<Env>;

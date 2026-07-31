import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  createSignature,
  getCacheTtl,
  splitTokenPrefixedPath,
  type Env,
} from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("splitTokenPrefixedPath", () => {
  it("removes only the first token segment", () => {
    expect(splitTokenPrefixedPath("/test-token/api/v2/comment/12345")).toEqual({
      token: "test-token",
      upstreamPath: "/api/v2/comment/12345",
    });
  });

  it("preserves the upstream trailing slash", () => {
    expect(splitTokenPrefixedPath("/test-token/api/v2/match/")).toEqual({
      token: "test-token",
      upstreamPath: "/api/v2/match/",
    });
  });
});

describe("createSignature", () => {
  it("implements base64(sha256(AppId + Timestamp + Path + AppSecret))", async () => {
    const appId = "app-id";
    const timestamp = "1735660800";
    const path = "/api/v2/search/episodes";
    const appSecret = "app-secret";
    const expected = "eRTskUdEk2DTR8VcpCLKRUt0uDFKB0AzOnLCsYXn1cs=";

    await expect(createSignature(appId, timestamp, path, appSecret)).resolves.toBe(expected);
  });
});

describe("worker proxy", () => {
  const env: Env = {
    DANDANPLAY_APP_ID: "app-id",
    DANDANPLAY_APP_SECRET: "app-secret",
    PROXY_TOKEN: "proxy-token",
    CACHE_TTL_SECONDS: "86400",
  };
  const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  it("rejects an invalid token prefix", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://proxy.example/wrong-token/api/v2/match", {
        method: "POST",
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strips the token and signs the upstream path", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      return Response.json({
        url: input.toString(),
        appId: headers.get("X-AppId"),
        timestamp: headers.get("X-Timestamp"),
        signature: headers.get("X-Signature"),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://proxy.example/proxy-token/api/v2/match?source=player", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: "example" }),
      }),
      env,
      ctx,
    );
    const payload = (await response.json()) as {
      url: string;
      appId: string;
      timestamp: string;
      signature: string;
    };

    expect(payload.url).toBe("https://api.dandanplay.net/api/v2/match?source=player");
    expect(payload.appId).toBe("app-id");
    expect(payload.signature).toBe(
      await createSignature(
        "app-id",
        payload.timestamp,
        "/api/v2/match",
        "app-secret",
      ),
    );
    expect(response.headers.get("X-Proxy-Cache")).toBe("BYPASS");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("caches a successful anonymous GET without putting the token in the cache key", async () => {
    const cache = {
      match: vi.fn(async (_request: Request) => undefined),
      put: vi.fn(async (_request: Request, _response: Response) => undefined),
    };
    vi.stubGlobal("caches", { default: cache });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true, animes: [] })),
    );
    const waitUntil = vi.fn();

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/proxy-token/api/v2/search/episodes?anime=test",
      ),
      env,
      { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.headers.get("X-Proxy-Cache")).toBe("MISS");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, s-maxage=86400",
    );
    expect(cache.put).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
    const cacheKey = cache.put.mock.calls[0][0] as Request;
    expect(cacheKey.url).toBe(
      "https://proxy.example/__dandanplay_wrapper_cache_v1/api/v2/search/episodes?anime=test",
    );
    expect(cacheKey.url).not.toContain("proxy-token");
  });

  it("serves a cached GET without contacting the upstream", async () => {
    const cache = {
      match: vi.fn(async () =>
        Response.json(
          { success: true, cached: true },
          { headers: { "Cache-Control": "public, max-age=86400" } },
        ),
      ),
      put: vi.fn(),
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("caches", { default: cache });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://proxy.example/proxy-token/api/v2/search/episodes?anime=test"),
      env,
      ctx,
    );

    expect(response.headers.get("X-Proxy-Cache")).toBe("HIT");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getCacheTtl", () => {
  it("never permits a cache TTL shorter than 24 hours", () => {
    expect(getCacheTtl(undefined)).toBe(86_400);
    expect(getCacheTtl("60")).toBe(86_400);
    expect(getCacheTtl("172800")).toBe(172_800);
    expect(getCacheTtl("not-a-number")).toBe(86_400);
  });
});

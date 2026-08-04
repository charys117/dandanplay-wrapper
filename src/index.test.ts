import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  createSignature,
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
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        },
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
    expect(response.headers.get("X-Proxy-Cache")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

/**
 * @vitest-environment jsdom
 *
 * Needs a DOM for localStorage, which the refresh writes admin flags into.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  apiRefreshToken,
  clearTokens,
  getAccessToken,
  hadSession,
  refreshSession,
  setAccessToken,
} from "@/lib/api";

/** A refresh endpoint that answers however the test says. */
function answering(reply: () => Promise<Response> | Response) {
  globalThis.fetch = vi.fn(async () => reply()) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.clear();
  setAccessToken(null);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("apiRefreshToken", () => {
  it("reports a rotated token as refreshed, and keeps it", async () => {
    answering(() => jsonResponse(200, { access_token: "new-token" }));
    await expect(apiRefreshToken()).resolves.toBe("refreshed");
    expect(getAccessToken()).toBe("new-token");
  });

  it("treats the server's own verdict on the cookie as a rejection", async () => {
    answering(() => jsonResponse(401, { error: "Refresh token revoked or not found" }));
    await expect(apiRefreshToken()).resolves.toBe("rejected");
  });

  it("does not call the session over when nothing answered", async () => {
    // Connection refused, offline, DNS — fetch rejects rather than replying.
    answering(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(apiRefreshToken()).resolves.toBe("unreachable");
  });

  it("does not call the session over on a server error", async () => {
    // A restarting backend, or the proxy in front of one, answers 5xx. That is
    // the server failing to speak for itself, not a verdict on the session.
    for (const status of [500, 502, 503, 504]) {
      answering(() => jsonResponse(status, { error: "Storage unavailable, try again" }));
      await expect(apiRefreshToken()).resolves.toBe("unreachable");
    }
  });

  it("does not call the session over on a 200 that is not the payload", async () => {
    answering(() => new Response("<html>gateway</html>", { status: 200 }));
    await expect(apiRefreshToken()).resolves.toBe("unreachable");
    expect(getAccessToken()).toBeNull();
  });
});

describe("refreshSession", () => {
  it("shares one attempt between concurrent callers", async () => {
    // The cookie is single-use: the server deletes the row as it rotates it. A
    // second live request would be told the token was revoked — a 401 that
    // reads exactly like a real logout, which is how a reconnect used to throw
    // people out at random.
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse(200, { access_token: "rotated" });
    }) as unknown as typeof fetch;

    const [a, b, c] = await Promise.all([
      refreshSession(),
      refreshSession(),
      refreshSession(),
    ]);

    expect(calls).toBe(1);
    expect([a, b, c]).toEqual(["refreshed", "refreshed", "refreshed"]);
  });

  it("starts a fresh attempt once the last one has settled", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return jsonResponse(200, { access_token: "rotated" });
    }) as unknown as typeof fetch;

    await refreshSession();
    await refreshSession();
    expect(calls).toBe(2);
  });
});

describe("hadSession", () => {
  it("is remembered once a session exists, so a load can wait for the server", () => {
    expect(hadSession()).toBe(false);
    setAccessToken("a-token");
    expect(hadSession()).toBe(true);
  });

  it("is forgotten when the server refuses the cookie", async () => {
    setAccessToken("a-token");
    answering(() => jsonResponse(401, { error: "Refresh token revoked or not found" }));
    await expect(apiRefreshToken()).resolves.toBe("rejected");
    expect(hadSession()).toBe(false);
  });

  it("survives a server that never answered", async () => {
    setAccessToken("a-token");
    answering(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(apiRefreshToken()).resolves.toBe("unreachable");
    expect(hadSession()).toBe(true);
  });

  it("is forgotten on an explicit sign-out", () => {
    setAccessToken("a-token");
    clearTokens();
    expect(hadSession()).toBe(false);
  });
});

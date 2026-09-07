/**
 * @vitest-environment jsdom
 *
 * Needs a DOM for localStorage, which the refresh writes admin flags into.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { apiRefreshToken, getAccessToken, setAccessToken } from "@/lib/api";

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

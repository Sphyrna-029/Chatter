import { describe, it, expect } from "vitest";
import { decideResumeAction, WS_RESUME_RESYNC_AFTER_MS } from "@/lib/wsResume";

describe("decideResumeAction", () => {
  it("rebuilds the connection when there is no open socket", () => {
    expect(decideResumeAction({ socketOpen: false, hiddenForMs: 0 })).toBe("reconnect");
    expect(decideResumeAction({ socketOpen: false, hiddenForMs: 60_000 })).toBe("reconnect");
  });

  it("does nothing for a glance away", () => {
    expect(decideResumeAction({ socketOpen: true, hiddenForMs: 0 })).toBe("nothing");
    expect(decideResumeAction({ socketOpen: true, hiddenForMs: 1_000 })).toBe("nothing");
  });

  it("refetches after a page was put down long enough to miss something", () => {
    // A phone that was locked and unlocked. The socket may claim to be open
    // and still be one the server gave up on, so the state it was carrying is
    // worth asking about again.
    expect(
      decideResumeAction({ socketOpen: true, hiddenForMs: WS_RESUME_RESYNC_AFTER_MS }),
    ).toBe("resync");
    expect(decideResumeAction({ socketOpen: true, hiddenForMs: 5 * 60_000 })).toBe("resync");
  });

  it("treats the threshold itself as long enough", () => {
    expect(
      decideResumeAction({ socketOpen: true, hiddenForMs: WS_RESUME_RESYNC_AFTER_MS - 1 }),
    ).toBe("nothing");
    expect(
      decideResumeAction({ socketOpen: true, hiddenForMs: WS_RESUME_RESYNC_AFTER_MS }),
    ).toBe("resync");
  });

  it("prefers reconnecting over refetching when both would apply", () => {
    // Reconnecting resyncs on its own once the socket is up, so asking twice
    // would only duplicate the request.
    expect(
      decideResumeAction({ socketOpen: false, hiddenForMs: 10 * 60_000 }),
    ).toBe("reconnect");
  });
});

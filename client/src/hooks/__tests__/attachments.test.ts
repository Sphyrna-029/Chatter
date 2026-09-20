import { describe, it, expect } from "vitest";
import { attachmentFolders } from "@/lib/attachments";

const A = "a".repeat(32);
const B = "0123456789abcdef0123456789abcdef";

describe("attachmentFolders", () => {
  it("finds the files a message posted", () => {
    expect(attachmentFolders(`look at this /external/${A}/cat.png`)).toEqual([A]);
    expect(
      attachmentFolders(`/external/${A}/one.png\n/external/${B}/two.mp4`).sort(),
    ).toEqual([A, B].sort());
  });

  it("counts a file named twice once", () => {
    expect(
      attachmentFolders(`/external/${A}/cat.png and again /external/${A}/cat.png`),
    ).toEqual([A]);
  });

  it("reads through the punctuation a link was pasted into", () => {
    expect(attachmentFolders(`(/external/${A}/cat.png)`)).toEqual([A]);
    expect(attachmentFolders(`"/external/${A}/cat.png".`)).toEqual([A]);
  });

  it("ignores anything that is not an upload", () => {
    expect(attachmentFolders("no attachments here")).toEqual([]);
    expect(attachmentFolders("https://elsewhere/cat.png")).toEqual([]);
    // The folder with no file in it, and a path this server did not write.
    expect(attachmentFolders(`/external/${A}/`)).toEqual([]);
    expect(attachmentFolders("/external/vc-join.wav")).toEqual([]);
  });

  it("finds a file behind whichever hostname posted it", () => {
    expect(attachmentFolders(`https://chat.example.com/external/${A}/cat.png`)).toEqual([A]);
  });
});

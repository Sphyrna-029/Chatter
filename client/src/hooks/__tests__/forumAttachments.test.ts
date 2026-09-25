import { describe, it, expect } from "vitest";
import { forumAttachmentKind, sortForumAttachments } from "@/lib/mediaTypes";

const file = (name: string, type: string) => new File(["x"], name, { type });

describe("what a forum attachment is drawn as", () => {
  it("puts pictures and clips a browser can show in the gallery", () => {
    expect(forumAttachmentKind(file("cat.png", "image/png"))).toBe("image");
    expect(forumAttachmentKind(file("clip.mp4", "video/mp4"))).toBe("video");
  });

  it("makes everything else a download", () => {
    expect(forumAttachmentKind(file("save.zip", "application/zip"))).toBe("file");
    expect(forumAttachmentKind(file("notes.pdf", "application/pdf"))).toBe("file");
    expect(forumAttachmentKind(file("mystery", ""))).toBe("file");
  });

  it("makes an image no browser draws a download rather than a broken square", () => {
    expect(forumAttachmentKind(file("scan.tiff", "image/tiff"))).toBe("file");
    expect(forumAttachmentKind(file("photo.heic", "image/heic"))).toBe("file");
  });
});

describe("sorting uploads onto a post", () => {
  it("keeps each list in the order the files were added", () => {
    const sorted = sortForumAttachments([
      { file: file("a.zip", "application/zip"), url: "/external/1/a.zip" },
      { file: file("b.png", "image/png"), url: "/external/2/b.png" },
      { file: file("c.pdf", "application/pdf"), url: "/external/3/c.pdf" },
      { file: file("d.webm", "video/webm"), url: "/external/4/d.webm" },
    ]);

    expect(sorted).toEqual({
      imageUrls: ["/external/2/b.png"],
      videoUrls: ["/external/4/d.webm"],
      fileUrls: ["/external/1/a.zip", "/external/3/c.pdf"],
    });
  });
});

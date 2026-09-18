import { describe, it, expect } from "vitest";
import { decodeVapidKey, encodeVapidKey } from "@/lib/push";

/**
 * A real uncompressed P-256 point as the server hands it over: 65 bytes,
 * base64url, unpadded — the exact output of `b64url_encode` in
 * src/backend/webpush.rs.
 */
const SERVER_KEY =
  "BEHxvArtUcHmLDsBeKrPzZP8u0_gAI9NJcbdcFfLLKGdPgXF1mFb_oVLLSnFBaC-rwXW3uWPcCFXOSzT1nXjFPI";

describe("the VAPID key codec", () => {
  it("round-trips the server's key byte for byte", () => {
    // If these two disagree with the server by so much as the padding, every
    // load decides the key has changed and re-enrols a device that was fine.
    const bytes = decodeVapidKey(SERVER_KEY);
    expect(encodeVapidKey(bytes.buffer)).toBe(SERVER_KEY);
  });

  it("decodes to the 65 bytes of an uncompressed P-256 point", () => {
    const bytes = decodeVapidKey(SERVER_KEY);
    expect(bytes.length).toBe(65);
    // 0x04 is the uncompressed-point marker; a key that decoded to anything
    // else would be refused by `subscribe()` rather than by us.
    expect(bytes[0]).toBe(0x04);
  });

  it("emits no padding, because the server sends none", () => {
    expect(encodeVapidKey(decodeVapidKey(SERVER_KEY).buffer)).not.toContain("=");
  });

  it("uses the URL alphabet, never + or /", () => {
    // Every byte value appears here, so any pair that would encode to `+` or
    // `/` in standard base64 has to come back as `-` or `_`.
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const encoded = encodeVapidKey(all.buffer);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(decodeVapidKey(encoded))).toEqual(Array.from(all));
  });

  it("still decodes a padded key, which some browsers hand back", () => {
    const padded = SERVER_KEY + "=";
    expect(Array.from(decodeVapidKey(padded))).toEqual(Array.from(decodeVapidKey(SERVER_KEY)));
  });
});

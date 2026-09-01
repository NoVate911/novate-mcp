import { describe, expect, test } from "bun:test";
import { createSessionCodec } from "./session.ts";

const NOW = 2_000_000_000;
const TTL = 600;

describe("AES-256-GCM session codec", () => {
  test("round trip preserves claims", () => {
    const codec = createSessionCodec(() => "a".repeat(64));
    const cookie = codec.packSigned({ uid: "42", name: "Agent", ts: NOW });
    expect(codec.unpackSigned(cookie, TTL, NOW)).toEqual({ uid: "42", name: "Agent", ts: NOW });
  });

  test("uses a unique nonce for every cookie", () => {
    const codec = createSessionCodec(() => "a".repeat(64));
    const payload = { uid: "42", ts: NOW };
    expect(codec.packSigned(payload)).not.toBe(codec.packSigned(payload));
  });

  test("rejects tampering in nonce, ciphertext and authentication tag", () => {
    const codec = createSessionCodec(() => "a".repeat(64));
    const parts = codec.packSigned({ uid: "42", ts: NOW }).split(".");
    for (let index = 0; index < parts.length; index++) {
      const changed = [...parts];
      changed[index] = (changed[index]![0] === "A" ? "B" : "A") + changed[index]!.slice(1);
      expect(codec.unpackSigned(changed.join("."), TTL, NOW)).toBeNull();
    }
  });

  test("rejects expired and future sessions", () => {
    const codec = createSessionCodec(() => "a".repeat(64));
    expect(codec.unpackSigned(codec.packSigned({ ts: NOW - TTL - 1 }), TTL, NOW)).toBeNull();
    expect(codec.unpackSigned(codec.packSigned({ ts: NOW + 1 }), TTL, NOW)).toBeNull();
  });

  test("secret rotation invalidates old cookies and accepts new cookies", () => {
    let secret = "a".repeat(64);
    const codec = createSessionCodec(() => secret);
    const oldCookie = codec.packSigned({ uid: "42", ts: NOW });
    secret = "b".repeat(64);
    expect(codec.unpackSigned(oldCookie, TTL, NOW)).toBeNull();
    const newCookie = codec.packSigned({ uid: "42", ts: NOW });
    expect(codec.unpackSigned(newCookie, TTL, NOW)?.uid).toBe("42");
  });

  test("rejects malformed cookies", () => {
    const codec = createSessionCodec(() => "a".repeat(64));
    for (const value of ["", "one", "one.two", "one.two.three.four", "...", "a.b.c"]) {
      expect(codec.unpackSigned(value, TTL, NOW)).toBeNull();
    }
  });
});

describe("CSRF form tokens", () => {
  test("token is stable per user and rejects foreign or malformed tokens", () => {
    const codec = createSessionCodec(() => "a".repeat(64));
    const token = codec.csrfToken("42");
    expect(token.length).toBeGreaterThan(20);
    expect(codec.csrfToken("42")).toBe(token);
    expect(codec.csrfMatches("42", token)).toBe(true);
    expect(codec.csrfMatches("43", token)).toBe(false);
    expect(codec.csrfMatches("42", "")).toBe(false);
    expect(codec.csrfMatches("", token)).toBe(false);
    expect(codec.csrfMatches("42", token + "x")).toBe(false);
  });

  test("secret rotation invalidates issued tokens", () => {
    let secret = "a".repeat(64);
    const codec = createSessionCodec(() => secret);
    const before = codec.csrfToken("42");
    secret = "b".repeat(64);
    expect(codec.csrfMatches("42", before)).toBe(false);
    expect(codec.csrfMatches("42", codec.csrfToken("42"))).toBe(true);
  });
});

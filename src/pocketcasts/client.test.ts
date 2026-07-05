import { describe, expect, it } from "vitest";
import { parseTokenExpiry } from "./client.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("parseTokenExpiry", () => {
  it("decodes a JWT's exp claim (seconds) into milliseconds", () => {
    const exp = 1_800_000_000;
    expect(parseTokenExpiry(makeJwt({ exp }))).toBe(exp * 1000);
  });

  it("returns undefined for a non-JWT token", () => {
    expect(parseTokenExpiry("plain-opaque-token")).toBeUndefined();
  });

  it("returns undefined for a JWT with no exp claim", () => {
    expect(parseTokenExpiry(makeJwt({ sub: "user-1" }))).toBeUndefined();
  });

  it("returns undefined for an unparseable middle segment", () => {
    expect(parseTokenExpiry("header.not-base64url-json.sig")).toBeUndefined();
  });
});

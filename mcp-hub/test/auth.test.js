// Behavioral tests for the forked bearer-token helpers.

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const authPromise = import("../rootfs/opt/mcp-hub/src/auth.js");

describe("tokenMatches", async () => {
  const { tokenMatches } = await authPromise;

  it("accepts an exact match", () => {
    assert.equal(tokenMatches("secret-token", "secret-token"), true);
  });

  it("rejects a wrong token, an empty token and a non-string", () => {
    assert.equal(tokenMatches("wrong", "secret-token"), false);
    assert.equal(tokenMatches("", "secret-token"), false);
    assert.equal(tokenMatches(undefined, "secret-token"), false);
    assert.equal(tokenMatches(null, "secret-token"), false);
  });

  it("rejects a different length without throwing", () => {
    assert.equal(tokenMatches("short", "a-much-longer-secret-token"), false);
  });
});

describe("bearerFrom", async () => {
  const { bearerFrom } = await authPromise;

  it("extracts the bearer token case-insensitively", () => {
    assert.equal(bearerFrom({ authorization: "Bearer abc123" }), "abc123");
    assert.equal(bearerFrom({ authorization: "bearer abc123" }), "abc123");
  });

  it("returns an empty string for missing or non-bearer headers", () => {
    assert.equal(bearerFrom({}), "");
    assert.equal(bearerFrom({ authorization: "Basic dXNlcjpwYXNz" }), "");
  });
});

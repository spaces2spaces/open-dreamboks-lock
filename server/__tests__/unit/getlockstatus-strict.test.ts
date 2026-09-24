/**
 * getLockStatus strict-mode classification (C10, post-Downtown-wipe).
 *
 * The sync cleanup deletes locks the hotel "has no access to". The probe must
 * therefore distinguish a DOCUMENTED no-access answer (10003 / "not lock
 * admin" → null) from transient failures (timeout, rate limit → THROW), or an
 * API hiccup on one lock silently deletes it.
 */
import { describe, it, expect } from "vitest";
import { TTLockClient } from "../../ttlock-client";

function clientWithError(message: string) {
  const client = new TTLockClient("client-id", "token", "eu", false);
  (client as any).makeRequest = async () => { throw new Error(message); };
  return client;
}

describe("getLockStatus strict mode", () => {
  it("strict: documented no-access (10003) → null", async () => {
    const client = clientWithError("TTLock API error: 10003 - not lock admin");
    await expect(client.getLockStatus("123", true)).resolves.toBeNull();
  });

  it("strict: 'not lock admin' text without code → null", async () => {
    const client = clientWithError("TTLock API error: Not Lock Admin");
    await expect(client.getLockStatus("123", true)).resolves.toBeNull();
  });

  it("strict: transient error (timeout) → THROWS (state unknown, never 'no access')", async () => {
    const client = clientWithError("TTLock API error: 500 - gateway timeout");
    await expect(client.getLockStatus("123", true)).rejects.toThrow("gateway timeout");
  });

  it("strict: rate limit → THROWS", async () => {
    const client = clientWithError("TTLock API error: -2012 - too many requests");
    await expect(client.getLockStatus("123", true)).rejects.toThrow();
  });

  it("legacy default (non-strict): every failure still maps to null (unchanged behavior)", async () => {
    const transient = clientWithError("TTLock API error: 500 - gateway timeout");
    await expect(transient.getLockStatus("123")).resolves.toBeNull();

    const noAccess = clientWithError("TTLock API error: 10003 - not lock admin");
    await expect(noAccess.getLockStatus("123")).resolves.toBeNull();
  });
});

/**
 * Arrivals share token (owner request 23/7): the mail link must work on a
 * phone without login, be unguessable, and be revocable.
 *  - 64-hex capability token generated once per tenant, persisted in the
 *    `arrivals_share_token` setting
 *  - stable across calls (the mailed link keeps working)
 *  - cleared setting → fresh token (revocation)
 *  - resolveArrivalsUrl embeds it as /arrivals/t/<token>
 */
import { describe, it, expect } from "vitest";
import { getOrCreateArrivalsShareToken, resolveArrivalsUrl } from "../../lock-arrival-report";
import { createMockStorage } from "../mocks/storage";

describe("arrivals share token", () => {
  it("generates a 64-hex token once and returns the same on later calls", async () => {
    const storage = createMockStorage({});

    const first = await getOrCreateArrivalsShareToken(storage as any);
    const second = await getOrCreateArrivalsShareToken(storage as any);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect((await storage.getSetting("arrivals_share_token"))?.value).toBe(first);
  });

  it("a cleared setting yields a fresh token (revocation)", async () => {
    const storage = createMockStorage({});
    const first = await getOrCreateArrivalsShareToken(storage as any);

    await storage.setSetting("arrivals_share_token", "");
    const second = await getOrCreateArrivalsShareToken(storage as any);

    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it("resolveArrivalsUrl embeds the token and optional date", async () => {
    const storage = createMockStorage({});

    const url = await resolveArrivalsUrl(storage as any, "2026-07-24");

    expect(url).toMatch(/^https:\/\/lock\.dreamboks\.net\/arrivals\/t\/[a-f0-9]{64}\?date=2026-07-24$/);
    const bare = await resolveArrivalsUrl(storage as any);
    expect(bare).toMatch(/^https:\/\/lock\.dreamboks\.net\/arrivals\/t\/[a-f0-9]{64}$/);
  });
});

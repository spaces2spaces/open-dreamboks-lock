/**
 * Ops-alert tests: e-mail-only channel (owner decision 22/7), URGENT subject
 * for critical, dedupe per (key, content) with 60-min window, and the
 * "critical + changed content bypasses the window" escalation rule.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const sent: Array<{ to: string; subject: string; text: string }> = [];
let failSend = false;

vi.mock("../../notification-client", () => ({
  createNotificationClient: async () => ({
    sendPlainTextEmail: async (params: { to: string; subject: string; text: string }) => {
      if (failSend) return { success: false, error: "boom" };
      sent.push(params);
      return { success: true };
    },
  }),
}));

import { sendOpsAlert } from "../../ops-alert";
import { createMockStorage } from "../mocks/storage";

describe("sendOpsAlert", () => {
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    sent.length = 0;
    failSend = false;
    storage = createMockStorage({ lock_arrival_report_email: "ops@hotel.dk, chef@hotel.dk" });
  });

  it("sends URGENT-prefixed mail to every configured recipient for critical alerts", async () => {
    const ok = await sendOpsAlert(storage as any, "test-key", "critical", "20 koder mangler på Main entrance");

    expect(ok).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent.map(s => s.to).sort()).toEqual(["chef@hotel.dk", "ops@hotel.dk"]);
    expect(sent[0].subject).toContain("🚨 URGENT");
    expect(sent[0].subject).toContain("20 koder mangler");
  });

  it("no recipients configured: returns false and logs an error (condition stays visible)", async () => {
    const bare = createMockStorage({});
    const ok = await sendOpsAlert(bare as any, "k", "critical", "besked");

    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
    expect(bare._logs.some((l: any) => l.level === "error" && String(l.message).includes("no recipients"))).toBe(true);
  });

  it("dedupes identical content for the same key inside the window", async () => {
    await sendOpsAlert(storage as any, "k", "critical", "samme besked");
    const second = await sendOpsAlert(storage as any, "k", "critical", "samme besked");

    expect(second).toBe(false);
    expect(sent).toHaveLength(2); // only the first alert's 2 recipients
  });

  it("critical with CHANGED content bypasses the dedupe window", async () => {
    await sendOpsAlert(storage as any, "k", "critical", "5 koder mangler");
    const escalated = await sendOpsAlert(storage as any, "k", "critical", "20 koder mangler");

    expect(escalated).toBe(true);
    expect(sent).toHaveLength(4);
  });

  it("warning with changed content inside the window stays suppressed", async () => {
    await sendOpsAlert(storage as any, "k", "warning", "første");
    const second = await sendOpsAlert(storage as any, "k", "warning", "anden");

    expect(second).toBe(false);
    expect(sent).toHaveLength(2);
  });

  it("delivery failure returns false without throwing", async () => {
    failSend = true;
    const ok = await sendOpsAlert(storage as any, "k", "critical", "besked");
    expect(ok).toBe(false);
  });
});

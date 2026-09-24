/**
 * MEWS refuses paymentRequests/add for customers without a valid email
 * (403 "Please enter a valid email address for customer.") — hit live 25/7 by
 * an OTA guest with no email on the extend page. The fallback must patch the
 * customer with the best email we hold and retry once; with NOTHING on file
 * the guest is NEVER asked (owner decision 25/7) — a dead per-reservation
 * placeholder on our own domain is used instead.
 */

import { describe, it, expect, vi } from "vitest";
import { createPaymentRequestHandlingMissingEmail } from "../../early-checkin-service";

const EMAIL_403 = new Error(
  'MEWS API error: 403 - {"Message":"Please enter a valid email address for customer.","RequestId":"x","Details":null}',
);

function makeWorld(reservation: Partial<Record<string, any>> = {}) {
  const mews: any = { updateCustomerEmail: vi.fn(async () => {}) };
  const updates: any[] = [];
  const logs: any[] = [];
  const storage: any = {
    updateReservation: vi.fn(async (_id: string, patch: any) => updates.push(patch)),
    createLog: vi.fn(async (l: any) => logs.push(l)),
  };
  const res: any = { id: "res-1", firstName: "Natalia", lastName: "K", personalEmail: null, email: null, ...reservation };
  return { mews, storage, res, updates, logs };
}

describe("createPaymentRequestHandlingMissingEmail", () => {
  it("passes the created value through when MEWS accepts", async () => {
    const { mews, storage, res } = makeWorld();
    const out = await createPaymentRequestHandlingMissingEmail(mews, storage, res, "cust-1", undefined, async () => ({ Id: "pr-1" }));
    expect(out).toEqual({ ok: true, value: { Id: "pr-1" } });
    expect(mews.updateCustomerEmail).not.toHaveBeenCalled();
  });

  it("email-403 + email on the reservation → patches the customer and retries once", async () => {
    const { mews, storage, res } = makeWorld({ email: "guest@example.com" });
    const create = vi.fn(async () => {
      if (create.mock.calls.length === 1) throw EMAIL_403;
      return { Id: "pr-2" };
    });
    const out = await createPaymentRequestHandlingMissingEmail(mews, storage, res, "cust-1", undefined, create);
    expect(out).toEqual({ ok: true, value: { Id: "pr-2" } });
    expect(mews.updateCustomerEmail).toHaveBeenCalledWith("cust-1", "guest@example.com");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("email-403 + guest-typed email → persists it on the reservation and retries", async () => {
    const { mews, storage, res, updates } = makeWorld();
    const create = vi.fn(async () => {
      if (create.mock.calls.length === 1) throw EMAIL_403;
      return { Id: "pr-3" };
    });
    const out = await createPaymentRequestHandlingMissingEmail(mews, storage, res, "cust-1", "typed@example.com", create);
    expect(out).toEqual({ ok: true, value: { Id: "pr-3" } });
    expect(mews.updateCustomerEmail).toHaveBeenCalledWith("cust-1", "typed@example.com");
    expect(updates).toEqual([{ personalEmail: "typed@example.com" }]);
    expect(res.personalEmail).toBe("typed@example.com"); // callers read it for the purchase row
  });

  it("email-403 with NO email anywhere → dead placeholder on our domain, retry succeeds, guest never asked", async () => {
    const { mews, storage, res, updates } = makeWorld();
    const create = vi.fn(async () => {
      if (create.mock.calls.length === 1) throw EMAIL_403;
      return { Id: "pr-4" };
    });
    const out = await createPaymentRequestHandlingMissingEmail(mews, storage, res, "cust-1", undefined, create);
    expect(out).toEqual({ ok: true, value: { Id: "pr-4" } });
    expect(mews.updateCustomerEmail).toHaveBeenCalledWith("cust-1", "guest-res-1@guest.dreamboks.net");
    expect(updates).toEqual([]); // placeholders never touch our reservation data
    expect(res.personalEmail).toBeNull();
  });

  it("a malformed typed email is never sent to MEWS — the placeholder is used instead", async () => {
    const { mews, storage, res, updates } = makeWorld();
    const create = vi.fn(async () => {
      if (create.mock.calls.length === 1) throw EMAIL_403;
      return { Id: "pr-5" };
    });
    const out = await createPaymentRequestHandlingMissingEmail(mews, storage, res, "cust-1", "not-an-email", create);
    expect(out).toEqual({ ok: true, value: { Id: "pr-5" } });
    expect(mews.updateCustomerEmail).toHaveBeenCalledWith("cust-1", "guest-res-1@guest.dreamboks.net");
    expect(updates).toEqual([]);
  });

  it("other MEWS errors are rethrown untouched", async () => {
    const { mews, storage, res } = makeWorld({ email: "guest@example.com" });
    const boom = new Error("MEWS API error: 500 - upstream");
    await expect(
      createPaymentRequestHandlingMissingEmail(mews, storage, res, "cust-1", undefined, async () => { throw boom; }),
    ).rejects.toThrow("upstream");
    expect(mews.updateCustomerEmail).not.toHaveBeenCalled();
  });
});

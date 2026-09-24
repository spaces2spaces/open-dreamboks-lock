/**
 * customers/add "already exists" fallback (24/7): MEWS refuses to create a
 * customer whose email already exists (repeat guests; staff testing with
 * their own email — the Create booking dialog surfaced the raw 400). The
 * client must resolve the EXISTING customer by email and reuse it — never
 * OverwriteExisting (that would rename a real guest's profile).
 */
import { describe, it, expect, vi } from "vitest";
import { MewsClient } from "../../mews-client";

const EXISTS_ERR = new Error(
  'MEWS API error: 400 - {"Message":"A customer with the specified email already exists.","RequestId":"x","Details":null}',
);

function mkClient(handlers: Record<string, (body: any) => any>) {
  const client = new MewsClient("ct", "at", "demo");
  const calls: Array<{ path: string; body: any }> = [];
  (client as any).makeRequest = vi.fn(async (path: string, body: any) => {
    calls.push({ path, body });
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected call: ${path}`);
    const result = handler(body);
    if (result instanceof Error) throw result;
    return result;
  });
  return { client, calls };
}

describe("MewsClient.addCustomer — email already exists", () => {
  it("resolves the existing customer by email instead of failing", async () => {
    const existing = { Id: "cust-1", Email: "je@example.com" };
    const { client, calls } = mkClient({
      "/api/connector/v1/customers/add": () => EXISTS_ERR,
      "/api/connector/v1/customers/getAll": (body) => {
        expect(body.Emails).toEqual(["je@example.com"]);
        return { Customers: [existing] };
      },
    });

    const result = await client.addCustomer({ lastName: "Test", email: "je@example.com" });

    expect(result).toEqual(existing);
    // Never OverwriteExisting — a real guest's profile must not be renamed.
    expect(calls[0].body.OverwriteExisting).toBe(false);
  });

  it("rethrows when the lookup finds nothing", async () => {
    const { client } = mkClient({
      "/api/connector/v1/customers/add": () => EXISTS_ERR,
      "/api/connector/v1/customers/getAll": () => ({ Customers: [] }),
    });

    await expect(client.addCustomer({ lastName: "Test", email: "je@example.com" })).rejects.toThrow(/already exists/);
  });

  it("rethrows other errors untouched (no lookup)", async () => {
    const { client, calls } = mkClient({
      "/api/connector/v1/customers/add": () => new Error("MEWS API error: 500 - boom"),
    });

    await expect(client.addCustomer({ lastName: "Test", email: "je@example.com" })).rejects.toThrow(/boom/);
    expect(calls.filter(c => c.path.includes("getAll"))).toHaveLength(0);
  });

  it("rethrows already-exists when no email was supplied (nothing to look up)", async () => {
    const { client } = mkClient({
      "/api/connector/v1/customers/add": () => EXISTS_ERR,
    });

    await expect(client.addCustomer({ lastName: "Test", phone: "+4512345678" })).rejects.toThrow(/already exists/);
  });
});

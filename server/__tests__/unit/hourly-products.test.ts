/**
 * Fixed-price packages for the guest hourly flow (owner decision 24/7:
 * 3 h = 399, 6 h = 499 — not hours × per-hour):
 *  - hourly_products setting parsed defensively (bad JSON/shape → per-hour)
 *  - with packages, ONLY package durations are sellable and the package
 *    price wins regardless of per-hour maths
 *  - price is resolved SERVER-side; the client never sends one
 */
import { describe, it, expect } from "vitest";
import { HourlyRentalService } from "../../hourly-rental-service";
import { createMockStorage } from "../mocks/storage";

const HOUR = 3_600_000;
const t0 = new Date("2026-07-25T12:00:00.000Z");
const after = (h: number) => new Date(t0.getTime() + h * HOUR);

function mkService(settings: Record<string, string>) {
  const storage = createMockStorage(settings);
  return new HourlyRentalService(storage as any, {} as any);
}

describe("hourly products (fixed-price packages)", () => {
  it("parses valid products sorted by hours", async () => {
    const svc = mkService({ hourly_products: '[{"hours":6,"price":499},{"hours":3,"price":399}]' });
    expect(await svc.getProducts()).toEqual([
      { hours: 3, price: 399 },
      { hours: 6, price: 499 },
    ]);
  });

  it("bad JSON, non-arrays and junk entries yield no products", async () => {
    expect(await mkService({ hourly_products: "not json" }).getProducts()).toEqual([]);
    expect(await mkService({ hourly_products: '{"hours":3}' }).getProducts()).toEqual([]);
    expect(await mkService({ hourly_products: '[{"hours":0,"price":10},{"price":50},{"hours":2}]' }).getProducts()).toEqual([]);
    expect(await mkService({}).getProducts()).toEqual([]);
  });

  it("package price wins over per-hour maths for a matching duration", () => {
    const svc = mkService({});
    const products = [{ hours: 3, price: 399 }, { hours: 6, price: 499 }];
    expect(svc.resolvePublicPrice(products, t0, after(3), 75)).toEqual({ amount: 399, hours: 3 });
    expect(svc.resolvePublicPrice(products, t0, after(6), 75)).toEqual({ amount: 499, hours: 6 });
  });

  it("with packages configured, other durations are refused", () => {
    const svc = mkService({});
    const products = [{ hours: 3, price: 399 }, { hours: 6, price: 499 }];
    expect(() => svc.resolvePublicPrice(products, t0, after(4), 75)).toThrow(/3 h \/ 6 h/);
  });

  it("walk-in windows (29/7): package + up to 59 bonus minutes still match the package price", () => {
    // A 'Now' start keeps the full package and the end rounds UP to the next
    // whole hour — e.g. 12:47 + 3h → 16:00 gives a 3h13m window at 399.
    const svc = mkService({});
    const products = [{ hours: 3, price: 399 }, { hours: 6, price: 499 }];
    const endAt = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    expect(svc.resolvePublicPrice(products, t0, endAt(3 * 60 + 13), 75)).toEqual({ amount: 399, hours: 4 });
    expect(svc.resolvePublicPrice(products, t0, endAt(3 * 60 + 59), 75)).toEqual({ amount: 399, hours: 4 });
    expect(svc.resolvePublicPrice(products, t0, endAt(6 * 60 + 1), 75)).toEqual({ amount: 499, hours: 7 });
    // A full extra hour is NOT a bonus band — 4h00m is still refused.
    expect(() => svc.resolvePublicPrice(products, t0, endAt(4 * 60), 75)).toThrow(/3 h \/ 6 h/);
  });

  it("without packages, per-hour pricing applies unchanged", () => {
    const svc = mkService({});
    expect(svc.resolvePublicPrice([], t0, after(4), 75)).toEqual({ amount: 300, hours: 4 });
  });
});

/**
 * Minimal Stripe client for hourly-rental payments — plain fetch against the
 * Stripe REST API (form-encoded), no SDK dependency. Only the three pieces the
 * flow needs: create a hosted Checkout Session, read a session back (poll
 * fallback when no webhook is configured), and verify a webhook signature.
 *
 * Credentials are PER-TENANT settings (stripe_secret_key / stripe_webhook_secret),
 * consistent with the Twilio/SendGrid pattern. Card data never touches this
 * server — guests pay on Stripe's hosted page.
 */
import { createHmac, timingSafeEqual } from "crypto";

const STRIPE_API = "https://api.stripe.com";

export interface CheckoutSession {
  id: string;
  url: string | null;
  status: string; // open | complete | expired
  payment_status: string; // paid | unpaid | no_payment_required
  metadata?: Record<string, string>;
}

async function stripeRequest<T>(secretKey: string, method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<T> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Stripe API error: ${msg}`);
  }
  return data as T;
}

export async function createCheckoutSession(secretKey: string, opts: {
  amountMinor: number;      // øre/cents
  currency: string;         // "dkk"
  productName: string;      // shown on Stripe's page
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  metadata: Record<string, string>;
  expiresInMinutes?: number; // Stripe minimum is 30
}): Promise<CheckoutSession> {
  const form: Record<string, string> = {
    mode: "payment",
    "line_items[0][price_data][currency]": opts.currency.toLowerCase(),
    "line_items[0][price_data][product_data][name]": opts.productName,
    "line_items[0][price_data][unit_amount]": String(opts.amountMinor),
    "line_items[0][quantity]": "1",
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    expires_at: String(Math.floor(Date.now() / 1000) + Math.max(30, opts.expiresInMinutes ?? 30) * 60),
  };
  if (opts.customerEmail) form.customer_email = opts.customerEmail;
  for (const [k, v] of Object.entries(opts.metadata)) form[`metadata[${k}]`] = v;
  return stripeRequest<CheckoutSession>(secretKey, "POST", "/v1/checkout/sessions", form);
}

export async function getCheckoutSession(secretKey: string, sessionId: string): Promise<CheckoutSession> {
  return stripeRequest<CheckoutSession>(secretKey, "GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

/**
 * Verify a Stripe webhook signature (Stripe-Signature header:
 * "t=<unix>,v1=<hmac>[,v1=...]"). HMAC-SHA256 over `${t}.${rawBody}` with the
 * endpoint's webhook secret; timing-safe comparison; replay window enforced.
 */
export function verifyStripeSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  webhookSecret: string,
  toleranceSeconds: number = 300,
): boolean {
  if (!signatureHeader || !webhookSecret) return false;

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.split("=", 2).map(s => s?.trim());
    if (key === "t" && value) timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;

  const payload = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", webhookSecret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");

  return signatures.some(sig => {
    const sigBuf = Buffer.from(sig, "utf8");
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  });
}

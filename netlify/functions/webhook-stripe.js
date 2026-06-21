// Webhook Stripe — checkout/assinatura. Verifica assinatura HMAC do payload.
import { createHmac, timingSafeEqual } from "node:crypto";
import { onPaymentApproved, onPaymentFailed, onSubscriptionCanceled } from "./lib/webhook-core.js";
import { sql, one } from "./lib/db.js";

export const config = { path: "/webhooks/stripe" };

// Verifica a assinatura "Stripe-Signature: t=...,v1=..."
function verifyStripe(payload, header, secret) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const signed = `${parts.t}.${payload}`;
  const expected = createHmac("sha256", secret).update(signed).digest("hex");
  try { return timingSafeEqual(Buffer.from(parts.v1 || ""), Buffer.from(expected)); } catch { return false; }
}

async function tenantFromCustomer(customerId) {
  // Liga o customer da Stripe ao tenant via subscriptions.gateway_subscription_id ou metadata.
  const sub = await one(sql`SELECT tenant_id FROM subscriptions WHERE gateway='stripe' AND gateway_subscription_id=${customerId} ORDER BY created_at DESC LIMIT 1`);
  return sub?.tenant_id || null;
}

export default async function handler(req) {
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!verifyStripe(raw, sig, process.env.STRIPE_WEBHOOK_SECRET))
    return new Response("invalid signature", { status: 400 });

  try {
    const evt = JSON.parse(raw);
    const obj = evt.data?.object || {};
    const tenantId = obj.client_reference_id || obj.metadata?.tenant_id || (await tenantFromCustomer(obj.customer));

    switch (evt.type) {
      case "checkout.session.completed":
      case "invoice.paid":
        if (tenantId) await onPaymentApproved({ tenantId, gateway: "stripe", gatewayPaymentId: obj.id, amountCents: obj.amount_total || obj.amount_paid || 0, method: "credit_card", raw: obj });
        break;
      case "invoice.payment_failed":
        if (tenantId) await onPaymentFailed({ tenantId, gateway: "stripe", gatewayPaymentId: obj.id, raw: obj });
        break;
      case "customer.subscription.deleted":
        if (tenantId) await onSubscriptionCanceled({ tenantId, gateway: "stripe" });
        break;
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("[stripe webhook]", e); return new Response("error", { status: 200 });
  }
}

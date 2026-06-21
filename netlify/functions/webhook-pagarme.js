// Webhook Pagar.me v5 — eventos de order/charge/subscription.
import { onPaymentApproved, onPaymentFailed, onSubscriptionCanceled } from "./lib/webhook-core.js";

export const config = { path: "/webhooks/pagarme" };

export default async function handler(req) {
  try {
    const evt = await req.json().catch(() => ({}));
    const type = evt.type || "";
    const data = evt.data || {};
    // O `code` que enviamos no checkout = tenant.id
    const tenantId = data.code || data.order?.code || data.customer?.code || data.metadata?.tenant_id;
    const amountCents = data.amount || data.charges?.[0]?.amount || 0;

    if (!tenantId) return new Response("ok", { status: 200 });

    if (["order.paid", "charge.paid", "subscription.charged"].includes(type))
      await onPaymentApproved({ tenantId, gateway: "pagarme", gatewayPaymentId: String(data.id || ""), amountCents, method: data.charges?.[0]?.payment_method || "credit_card", raw: data });
    else if (["charge.payment_failed", "order.payment_failed"].includes(type))
      await onPaymentFailed({ tenantId, gateway: "pagarme", gatewayPaymentId: String(data.id || ""), raw: data });
    else if (type === "subscription.canceled")
      await onSubscriptionCanceled({ tenantId, gateway: "pagarme" });

    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("[pagarme webhook]", e); return new Response("error", { status: 200 });
  }
}

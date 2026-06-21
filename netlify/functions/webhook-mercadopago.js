// Webhook Mercado Pago — notificacoes de pagamento e assinatura (preapproval).
import { onPaymentApproved, onPaymentFailed, onSubscriptionCanceled } from "./lib/webhook-core.js";

export const config = { path: "/webhooks/mercadopago" };

async function mpGet(path) {
  const r = await fetch(`https://api.mercadopago.com${path}`, {
    headers: { "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}` },
  });
  return r.ok ? r.json() : null;
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    const type = body.type || url.searchParams.get("type") || body.topic;
    const id = body?.data?.id || url.searchParams.get("id") || url.searchParams.get("data.id");
    if (!id) return new Response("ok", { status: 200 });

    if (type === "payment") {
      const pay = await mpGet(`/v1/payments/${id}`);
      if (pay) {
        const tenantId = pay.external_reference;
        const amountCents = Math.round((pay.transaction_amount || 0) * 100);
        const method = (pay.payment_type_id || pay.payment_method_id || "").includes("card") ? "credit_card" : (pay.payment_method_id || pay.payment_type_id);
        if (pay.status === "approved") await onPaymentApproved({ tenantId, gateway: "mercadopago", gatewayPaymentId: String(id), amountCents, method, raw: pay });
        else if (["rejected", "cancelled"].includes(pay.status)) await onPaymentFailed({ tenantId, gateway: "mercadopago", gatewayPaymentId: String(id), raw: pay });
      }
    } else if (type === "subscription_preapproval" || type === "preapproval") {
      const pre = await mpGet(`/preapproval/${id}`);
      if (pre) {
        const tenantId = pre.external_reference;
        if (pre.status === "cancelled") await onSubscriptionCanceled({ tenantId, gateway: "mercadopago" });
        else if (pre.status === "authorized") await onPaymentApproved({ tenantId, gateway: "mercadopago", gatewayPaymentId: String(id), amountCents: Math.round((pre.auto_recurring?.transaction_amount || 0) * 100), method: "recurring", raw: pre });
      }
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("[mp webhook]", e); return new Response("error", { status: 200 }); // 200 evita retry-storm
  }
}

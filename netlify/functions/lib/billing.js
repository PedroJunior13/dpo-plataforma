// Camada de cobranca — abstrai 3 gateways atras de uma interface comum.
//   - Mercado Pago: PIX, boleto, cartao, assinatura recorrente (preapproval)
//   - Stripe: cartao + Billing (assinaturas)
//   - Pagar.me: PIX, boleto, cartao, assinaturas
// Todas as chamadas usam fetch nativo (sem SDK). As chaves vem do ambiente.
//
// billingType: "monthly" (avulso, 1 cobranca) | "recurring" (assinatura)
// method: "pix" | "boleto" | "credit_card"

const APP = (process.env.APP_BASE_URL || "https://app.dpopjprotection.com.br").replace(/\/+$/, "");
const reais = (cents) => (cents / 100);

// =====================================================================
//  MERCADO PAGO
// =====================================================================
const mp = {
  token: () => process.env.MP_ACCESS_TOKEN,
  enabled: () => !!process.env.MP_ACCESS_TOKEN,

  async call(path, method, body) {
    const r = await fetch(`https://api.mercadopago.com${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.token()}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`MercadoPago ${r.status}: ${data?.message || JSON.stringify(data)}`);
    return data;
  },

  // Pagamento avulso (mensal OU anual): PIX/boleto/cartao via Checkout Pro (preference).
  async createMonthly({ tenant, plan, amountCents, method, cycle }) {
    const cycleLabel = cycle === "annual" ? "anual" : "mensal";
    const pref = await this.call("/checkout/preferences", "POST", {
      items: [{
        title: `DPO PJ Protection — ${plan.name} (${cycleLabel})`,
        quantity: 1, currency_id: "BRL", unit_price: reais(amountCents),
      }],
      payer: { email: tenant.email || undefined, name: tenant.name || undefined },
      payment_methods: method === "pix"
        ? { excluded_payment_types: [{ id: "ticket" }, { id: "credit_card" }, { id: "debit_card" }] }
        : method === "boleto"
        ? { excluded_payment_types: [{ id: "credit_card" }, { id: "debit_card" }] }
        : {},
      external_reference: tenant.id,
      notification_url: `${APP}/webhooks/mercadopago`,
      back_urls: { success: `${APP}/checkout-ok`, pending: `${APP}/checkout-pendente`, failure: `${APP}/checkout-falha` },
      auto_return: "approved",
    });
    return { gateway: "mercadopago", checkoutUrl: pref.init_point, gatewayRef: pref.id, raw: pref };
  },

  // Assinatura recorrente (preapproval) — renova automaticamente (mensal ou anual).
  async createRecurring({ tenant, plan, amountCents, cycle }) {
    const annual = cycle === "annual";
    const pre = await this.call("/preapproval", "POST", {
      reason: `DPO PJ Protection — ${plan.name} (recorrente ${annual ? "anual" : "mensal"})`,
      external_reference: tenant.id,
      payer_email: tenant.email || undefined,
      back_url: `${APP}/checkout-ok`,
      auto_recurring: {
        frequency: annual ? 12 : 1, frequency_type: "months",
        transaction_amount: reais(amountCents), currency_id: "BRL",
      },
      status: "pending",
    });
    return { gateway: "mercadopago", checkoutUrl: pre.init_point, gatewaySubscriptionId: pre.id, raw: pre };
  },

  async cancelRecurring(subscriptionId) {
    return this.call(`/preapproval/${subscriptionId}`, "PUT", { status: "cancelled" });
  },
  async getPayment(id) { return this.call(`/v1/payments/${id}`, "GET"); },
};

// =====================================================================
//  STRIPE  (form-encoded API)
// =====================================================================
const stripe = {
  key: () => process.env.STRIPE_SECRET_KEY,
  enabled: () => !!process.env.STRIPE_SECRET_KEY,

  async call(path, method, params) {
    const body = params ? new URLSearchParams(flatten(params)).toString() : undefined;
    const r = await fetch(`https://api.stripe.com/v1${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.key()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Stripe ${r.status}: ${data?.error?.message || JSON.stringify(data)}`);
    return data;
  },

  async createMonthly({ tenant, plan, amountCents, cycle }) {
    const s = await this.call("/checkout/sessions", "POST", {
      mode: "payment",
      "line_items[0][price_data][currency]": "brl",
      "line_items[0][price_data][product_data][name]": `DPO PJ Protection — ${plan.name} (${cycle === "annual" ? "anual" : "mensal"})`,
      "line_items[0][price_data][unit_amount]": amountCents,
      "line_items[0][quantity]": 1,
      client_reference_id: tenant.id,
      customer_email: tenant.email || undefined,
      success_url: `${APP}/checkout-ok`,
      cancel_url: `${APP}/checkout-falha`,
    });
    return { gateway: "stripe", checkoutUrl: s.url, gatewayRef: s.id, raw: s };
  },

  async createRecurring({ tenant, plan, amountCents, cycle }) {
    const s = await this.call("/checkout/sessions", "POST", {
      mode: "subscription",
      "line_items[0][price_data][currency]": "brl",
      "line_items[0][price_data][product_data][name]": `DPO PJ Protection — ${plan.name} (recorrente ${cycle === "annual" ? "anual" : "mensal"})`,
      "line_items[0][price_data][unit_amount]": amountCents,
      "line_items[0][price_data][recurring][interval]": cycle === "annual" ? "year" : "month",
      "line_items[0][quantity]": 1,
      client_reference_id: tenant.id,
      customer_email: tenant.email || undefined,
      success_url: `${APP}/checkout-ok`,
      cancel_url: `${APP}/checkout-falha`,
    });
    return { gateway: "stripe", checkoutUrl: s.url, gatewaySubscriptionId: s.id, raw: s };
  },

  async cancelRecurring(subId) { return this.call(`/subscriptions/${subId}`, "DELETE"); },
};
function flatten(obj) { return obj; } // Stripe params ja vem achatados acima.

// =====================================================================
//  PAGAR.ME (v5)
// =====================================================================
const pagarme = {
  key: () => process.env.PAGARME_SECRET_KEY,
  enabled: () => !!process.env.PAGARME_SECRET_KEY,

  async call(path, method, body) {
    const auth = Buffer.from(`${this.key()}:`).toString("base64");
    const r = await fetch(`https://api.pagar.me/core/v5${path}`, {
      method,
      headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Pagar.me ${r.status}: ${data?.message || JSON.stringify(data)}`);
    return data;
  },

  async createMonthly({ tenant, plan, amountCents, method, cycle }) {
    const payments = method === "pix"
      ? [{ payment_method: "pix", pix: { expires_in: 3600 } }]
      : method === "boleto"
      ? [{ payment_method: "boleto", boleto: { instructions: "Pagar ate o vencimento." } }]
      : [{ payment_method: "credit_card" }];
    const order = await this.call("/orders", "POST", {
      items: [{ amount: amountCents, description: `${plan.name} (${cycle === "annual" ? "anual" : "mensal"})`, quantity: 1 }],
      customer: { name: tenant.name || "Cliente", email: tenant.email || "sem@email.com" },
      payments,
      code: tenant.id,
    });
    const charge = order?.charges?.[0];
    const url = charge?.last_transaction?.url || charge?.last_transaction?.pdf || charge?.last_transaction?.qr_code_url;
    return { gateway: "pagarme", checkoutUrl: url, gatewayRef: order.id, raw: order };
  },

  async createRecurring({ tenant, plan, amountCents, cycle }) {
    const annual = cycle === "annual";
    const sub = await this.call("/subscriptions", "POST", {
      payment_method: "credit_card",
      interval: annual ? "year" : "month", interval_count: 1,
      billing_type: "prepaid",
      customer: { name: tenant.name || "Cliente", email: tenant.email || "sem@email.com" },
      items: [{ description: `${plan.name} (recorrente ${annual ? "anual" : "mensal"})`, quantity: 1, pricing_scheme: { price: amountCents } }],
      code: tenant.id,
    });
    return { gateway: "pagarme", checkoutUrl: sub?.url || null, gatewaySubscriptionId: sub.id, raw: sub };
  },

  async cancelRecurring(subId) { return this.call(`/subscriptions/${subId}`, "DELETE"); },
};

// =====================================================================
//  Interface unificada
// =====================================================================
const GATEWAYS = { mercadopago: mp, stripe, pagarme };

export function gatewayFor(name) {
  const g = GATEWAYS[name || process.env.DEFAULT_GATEWAY || "mercadopago"];
  if (!g) throw new Error("Gateway desconhecido: " + name);
  return g;
}

export function availableGateways() {
  return Object.entries(GATEWAYS).filter(([, g]) => g.enabled()).map(([k]) => k);
}

// Cria a cobranca/assinatura e devolve a URL de checkout para o cliente.
export async function createCharge({ gateway, billingType, billingCycle, method, tenant, plan, amountCents }) {
  const g = gatewayFor(gateway);
  if (!g.enabled()) throw new Error(`Gateway ${gateway} sem credenciais configuradas.`);
  const cycle = billingCycle === "annual" ? "annual" : "monthly";
  if (billingType === "recurring") return g.createRecurring({ tenant, plan, amountCents, cycle });
  return g.createMonthly({ tenant, plan, amountCents, method, cycle });
}

// Utilitarios HTTP para as Netlify Functions (Web API: Request -> Response).

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

export function ok(data = {}) { return json({ ok: true, ...data }); }
export function fail(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

// Erros padronizados para o kill-switch / autenticacao.
export function unauthorized(msg = "Nao autenticado.") { return fail(msg, 401); }
export function forbidden(msg = "Sem permissao.") { return fail(msg, 403); }
// 402 Payment Required — usado pelo kill-switch de inadimplencia.
export function paymentRequired(msg = "Acesso suspenso por pendencia financeira.", extra = {}) {
  return json({ ok: false, error: msg, code: "PAYMENT_REQUIRED", ...extra }, 402);
}

export async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}

// IP do cliente (atras do proxy do Netlify).
export function clientIp(req) {
  const h = req.headers;
  return (h.get("x-nf-client-connection-ip")
    || (h.get("x-forwarded-for") || "").split(",")[0].trim()
    || "").slice(0, 64);
}

// Extrai o segmento de rota apos /api/ (ex.: "owner/licenses/123").
export function routePath(req, prefix = "/api/") {
  const url = new URL(req.url);
  let p = url.pathname;
  const i = p.indexOf(prefix);
  if (i >= 0) p = p.slice(i + prefix.length);
  return p.replace(/^\/+|\/+$/g, "");
}

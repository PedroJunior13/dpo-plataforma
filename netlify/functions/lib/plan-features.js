// Gating de RECURSOS por módulo (além da cota de clientes).
// O cliente do módulo Intermediário fica limitado ao Intermediário; o Básico
// ao Básico; e assim por diante. O OWNER tem tudo (consultoria completa).
//
// Recursos disponíveis no app operacional:
//   clients          — cadastro/gestão de clientes (todos os planos, com cota)
//   documents        — documentos versionados LGPD/GDPR (todos)
//   titular_requests — solicitações de titulares (todos)
//   incidents        — incidentes / violações (todos)
//   projects         — projetos e fases / Gantt (Intermediário+)
//   tasks            — tarefas das fases (Intermediário+)
//   trainings        — treinamentos & certificados (Intermediário+)
//   team             — equipe com acesso por cliente (Avançado+)
//   branding         — marca da consultoria nos relatórios (Avançado+)
//   unlimited        — sem limite de clientes (somente OWNER)

const TIER_FEATURES = {
  1: ["clients", "documents", "titular_requests", "incidents", "seal"],
  2: ["clients", "documents", "titular_requests", "incidents", "seal",
      "projects", "tasks", "trainings", "schedule_alert"],
  3: ["clients", "documents", "titular_requests", "incidents", "seal",
      "projects", "tasks", "trainings", "schedule_alert",
      "team", "branding"],
};

// Plano por id -> tier (fallback). O OWNER usa tier 99 = tudo.
const PLAN_TIER = { basic: 1, inter: 2, adv: 3, owner: 99 };

export function planTier(planId) {
  return PLAN_TIER[planId] != null ? PLAN_TIER[planId] : 1;
}

// Lista de recursos liberados para um tier.
export function featuresForTier(tier) {
  if (tier >= 99) return [...TIER_FEATURES[3], "team", "branding", "unlimited", "all"];
  return TIER_FEATURES[tier] || TIER_FEATURES[1];
}

export function featuresForPlan(planId) {
  return featuresForTier(planTier(planId));
}

// O usuário/tenant tem acesso ao recurso?
export function hasFeature(planIdOrTenant, feature) {
  const tier = typeof planIdOrTenant === "object"
    ? (planIdOrTenant.is_owner ? 99 : planTier(planIdOrTenant.plan_id))
    : planTier(planIdOrTenant);
  const list = featuresForTier(tier);
  return list.includes("all") || list.includes(feature);
}

// Lança 403 (com code) se o recurso não estiver no módulo do tenant.
export function assertFeature(tenant, feature) {
  if (tenant?.is_owner) return;
  if (!hasFeature(tenant, feature)) {
    const err = new Error("Recurso disponível em um módulo superior. Faça upgrade para liberar.");
    err.code = "FEATURE_LOCKED";
    err.httpStatus = 403;
    throw err;
  }
}

// Resumo p/ o frontend: o que mostrar/destravar.
export function capabilities(tenant) {
  const tier = tenant?.is_owner ? 99 : planTier(tenant?.plan_id);
  return {
    tier,
    planId: tenant?.is_owner ? "owner" : tenant?.plan_id,
    isOwner: !!tenant?.is_owner,
    features: featuresForTier(tier),
  };
}

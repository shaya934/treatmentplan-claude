import { can, type Action } from "@aba/core/rbac";
import { api } from "@/lib/api";
import { env } from "@aba/core/env";

const ACTIONS: Action[] = ["tenant.manage", "user.manage", "template.edit", "client.create", "client.reassign", "plan.create", "plan.edit", "plan.finalize", "audit.view", "usage.view"];

export const GET = api(async ({ svc }) => {
  const p = svc.p as typeof svc.p & { support?: boolean };
  return {
    user: { id: p.userId, name: p.name, email: p.email, role: p.role, tenantId: p.tenantId, support: !!p.support },
    can: Object.fromEntries(ACTIONS.map((a) => [a, can(p, a)])),
    mode: env().mode,
    idleMinutes: env().sessionIdleMinutes,
  };
});

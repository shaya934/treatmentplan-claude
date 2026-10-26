import { SafeError } from "./logger";
import type { Role } from "./types";

/**
 * Role permissions (spec: Users and roles). Checked in code at every route,
 * and backed by row-level security in Postgres.
 */
export type Action =
  | "tenant.manage"
  | "platform.usage"
  | "support.grant"
  | "user.manage"
  | "template.view"
  | "template.edit"
  | "client.view"
  | "client.create"
  | "client.reassign"
  | "plan.view"
  | "plan.create"
  | "plan.edit"
  | "plan.finalize"
  | "plan.export"
  | "file.upload"
  | "audit.view"
  | "usage.view";

const MATRIX: Record<Role, Action[]> = {
  super_admin: ["tenant.manage", "platform.usage", "support.grant"],
  company_admin: ["user.manage", "template.view", "template.edit", "client.view", "client.create", "client.reassign", "plan.view", "plan.export", "audit.view", "usage.view"],
  clinical_director: ["template.view", "client.view", "client.create", "client.reassign", "plan.view", "plan.create", "plan.edit", "plan.export", "file.upload"],
  bcba: ["template.view", "client.view", "client.create", "plan.view", "plan.create", "plan.edit", "plan.finalize", "plan.export", "file.upload"],
  read_only: ["plan.view", "plan.export", "client.view"],
};

export interface Principal {
  userId: string;
  tenantId: string | null;
  role: Role;
  credential?: string | null;
  name?: string;
  email?: string;
}

export interface TenantPolicy {
  clinicalDirectorCanFinalize?: boolean;
}

export function can(p: Principal, action: Action, policy: TenantPolicy = {}): boolean {
  if (MATRIX[p.role]?.includes(action)) return true;
  if (action === "plan.finalize") {
    // Admins may finalize only if they are also a BCBA; clinical directors only if the tenant allows it (open decision).
    if (p.role === "company_admin" && /\bBCBA/i.test(p.credential ?? "")) return true;
    if (p.role === "clinical_director" && policy.clinicalDirectorCanFinalize) return true;
  }
  if ((action === "plan.edit" || action === "plan.create" || action === "file.upload") && p.role === "company_admin" && /\bBCBA/i.test(p.credential ?? "")) return true;
  return false;
}

export function assertCan(p: Principal, action: Action, policy?: TenantPolicy) {
  if (!can(p, action, policy)) throw new SafeError("You do not have permission to do that.", 403);
}

export function rolesFor(action: Action): Role[] {
  return (Object.keys(MATRIX) as Role[]).filter((r) => MATRIX[r].includes(action));
}

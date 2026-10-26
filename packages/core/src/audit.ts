import type { Tx } from "./db";

/**
 * Append-only audit log (HIPAA technical safeguard). Records every view,
 * upload, download, edit, export, finalize, template change and login.
 * The table rejects UPDATE/DELETE at the database level. `detail` must hold
 * IDs and counts only, never PHI.
 */
export type AuditAction =
  | "login"
  | "login_failed"
  | "logout"
  | "mfa_setup"
  | "view"
  | "create"
  | "update"
  | "delete"
  | "upload"
  | "download"
  | "export"
  | "finalize"
  | "restore_version"
  | "generate"
  | "chat_edit"
  | "accept_change"
  | "template_publish"
  | "template_rollback"
  | "template_draft"
  | "support_grant"
  | "support_access"
  | "retention_purge"
  | "transcribe";

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export async function audit(
  tx: Tx,
  a: { tenantId: string | null; userId: string | null; action: AuditAction; entity: string; entityId?: string | null; detail?: Record<string, string | number | boolean | null> },
  meta: RequestMeta = {},
) {
  await tx.query("INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, ip, user_agent, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
    a.tenantId,
    a.userId,
    a.action,
    a.entity,
    a.entityId ?? null,
    meta.ip ?? null,
    (meta.userAgent ?? "").slice(0, 300) || null,
    JSON.stringify(a.detail ?? {}),
  ]);
}

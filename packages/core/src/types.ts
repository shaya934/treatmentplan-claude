import type { EvidenceCategory } from "./template/schema";

export type Role = "super_admin" | "company_admin" | "clinical_director" | "bcba" | "read_only";

export interface Evidence {
  id: string;
  plan_id: string;
  file_id: string | null;
  filename?: string | null;
  page: number | null;
  fact_text: string;
  category: EvidenceCategory;
  value: string | null;
  unit: string | null;
  source_date: string | null;
  confirmed_by_bcba: boolean;
  deleted?: boolean;
}

export interface BcbaAnswer {
  id?: string;
  question_id: string;
  answer_text: string;
  input_mode: "typed" | "voice";
  created_at?: string;
}

export interface ClientRecord {
  id: string;
  name: string; // "Last, First"
  dob: string | null;
  medicaid_id: string | null;
  payer: string | null;
  diagnosis: string | null;
  gender?: string | null;
  assigned_bcba_id: string | null;
}

export interface BcbaInfo {
  name: string;
  credential: string | null;
  npi: string | null;
}

export interface PlanRecord {
  id: string;
  tenant_id: string;
  client_id: string;
  template_version_id: string;
  type: "initial" | "reassessment";
  period_start: string | null;
  period_end: string | null;
  status: "draft" | "review" | "final";
  final_date: string | null;
  complex_case: boolean;
}

export type ReviewKind = "placeholder" | "conflict" | "low_input" | "unsupported" | "mismatch" | "carried_forward" | "needs_ocr";

export interface ReviewItem {
  field_id: string | null;
  kind: ReviewKind;
  detail: string;
}

export function firstName(fullName: string): string {
  const parts = fullName.split(",").map((s) => s.trim());
  return (parts.length > 1 ? parts[1] : fullName.split(" ")[0]) || fullName;
}

export function displayName(fullName: string): string {
  const parts = fullName.split(",").map((s) => s.trim());
  return parts.length > 1 ? `${parts[1]} ${parts[0]}` : fullName;
}

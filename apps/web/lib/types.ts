import type { PlanBundle } from "@aba/core/svc/plans";
export type { PlanBundle };
export type { Field, Section, Template } from "@aba/core/template/schema";
export type { FieldEntry, FieldValue, PlanContent, TableRow } from "@aba/core/plan/content";
export type { Evidence } from "@aba/core/types";

export interface Change {
  id: string;
  fieldId: string;
  fieldLabel: string;
  before: unknown;
  after: unknown;
  summary: string;
  linked: boolean;
}

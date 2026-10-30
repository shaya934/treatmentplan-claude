import { z } from "zod";

/**
 * Company treatment-plan template, stored as structured JSON (spec F10).
 * sections -> fields. Every field carries its own BCBA question, source hints,
 * required flag, links and length type, so the template drives the whole app.
 */

export const LengthType = z.enum(["short", "medium", "narrative"]);
export type LengthType = z.infer<typeof LengthType>;

export const FieldType = z.enum([
  "text",
  "number",
  "date",
  "select",
  "multiselect",
  "boolean",
  "narrative",
  "table",
  "static", // boilerplate paragraph rendered from template text, may contain {{field}} tokens
]);
export type FieldType = z.infer<typeof FieldType>;

export const EvidenceCategory = z.enum([
  "demographic",
  "diagnosis",
  "score",
  "rate",
  "date",
  "iep",
  "medication",
  "service",
  "goal",
  "authorization",
  "caregiver",
  "behavior",
  "other",
]);
export type EvidenceCategory = z.infer<typeof EvidenceCategory>;

export const TableColumn = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(["text", "number", "date", "select", "narrative"]).default("text"),
  options: z.array(z.string()).optional(),
  /** Form style, "records" tables: show this column as its own gray-titled box after the record. */
  box: z.boolean().optional(),
});
export type TableColumn = z.infer<typeof TableColumn>;

/** Link inside a consistency group (spec F7). */
export const FieldLink = z.object({
  group: z.string(),
  /** Path inside the field value. For tables: "rowKey:colId" where rowKey matches column 0 or row index. */
  path: z.string().optional(),
  /** value = the number lives in a structured cell; mention = it appears inside narrative text. */
  mode: z.enum(["value", "mention", "sum"]).default("value"),
});
export type FieldLink = z.infer<typeof FieldLink>;

export const Field = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string(),
  type: FieldType,
  lengthType: LengthType.default("short"),
  required: z.boolean().default(false),
  /** Tagged ccp8f_required: removing or loosening triggers the compliance guard. */
  tags: z.array(z.string()).default([]),
  help: z.string().optional(),
  /** The question asked in guided chat. Omit when the field is filled only from files or calculation. */
  question: z.string().optional(),
  /** Groups several fields under one guided question (spec: ~29 questions across ~150 fields). */
  questionId: z.string().optional(),
  sourceHints: z.array(EvidenceCategory).default([]),
  /** Free-text hints for extraction, e.g. "Vineland-3 Communication standard score". */
  sourceKeys: z.array(z.string()).default([]),
  options: z.array(z.string()).optional(),
  columns: z.array(TableColumn).optional(),
  /** Fixed first-column row labels for tables (e.g. codes, days of week). */
  fixedRows: z.array(z.string()).optional(),
  minRows: z.number().int().optional(),
  links: z.array(FieldLink).default([]),
  /** For "static" fields: template text. */
  text: z.string().optional(),
  /** Value computed from other fields (spec F3 status "Calculated"). */
  calc: z.string().optional(),
  carryForward: z.boolean().default(true),
  /**
   * Form-style export layout (ignored by the default layout):
   * half = one of two label/value cells in a row; row = left label column + answer (fields with the
   * same rowLabel share one row); block = gray label bar with the answer under it; records = a table
   * shown as one box per row (e.g. one per FBA); none = only used inside {{field}} tokens in static text.
   */
  display: z.enum(["full", "half", "row", "block", "records", "none"]).optional(),
  rowLabel: z.string().optional(),
  /** Static text shown as a gray sub-header bar inside the section box. */
  style: z.enum(["subheader"]).optional(),
});
export type Field = z.infer<typeof Field>;

export const Section = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  title: z.string(),
  intro: z.string().optional(),
  fields: z.array(Field),
});
export type Section = z.infer<typeof Section>;

/** Validation rules live in the template as data (spec F8). */
export const Rule = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("required_fields"), message: z.string().optional(), tag: z.string().optional() }),
  z.object({ id: z.string(), kind: z.literal("linked_equal"), group: z.string(), message: z.string().optional() }),
  z.object({
    id: z.string(),
    kind: z.literal("behavior_benchmarks"),
    field: z.string(),
    columns: z.array(z.string()),
    message: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("min_rows"),
    field: z.string(),
    min: z.number().int(),
    message: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("min_value_or_justification"),
    field: z.string(),
    min: z.number(),
    perDays: z.number().optional(),
    justificationField: z.string(),
    message: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("max_date_offset"),
    fields: z.array(z.string()),
    months: z.number().int(),
    message: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("threshold_requires_explanation"),
    field: z.string(),
    valueColumn: z.string(),
    below: z.number(),
    explanationColumn: z.string(),
    message: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("forbidden_combination"),
    whenField: z.string(),
    whenValue: z.union([z.string(), z.boolean()]),
    tableField: z.string(),
    column: z.string(),
    forbiddenValue: z.string(),
    message: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("telehealth"),
    field: z.string(),
    percentColumn: z.string(),
    justificationColumn: z.string(),
    disallowed: z.array(z.string()),
    caps: z.record(z.string(), z.number()),
    /** Also scan a services table location column for "telehealth" on disallowed codes. */
    locationField: z.string().optional(),
    locationColumn: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("auth_period_limit"),
    field: z.string(),
    column: z.string(),
    thresholdHours: z.number(),
    maxDays: z.number().int(),
    message: z.string().optional(),
  }),
  z.object({ id: z.string(), kind: z.literal("no_placeholders"), message: z.string().optional() }),
]);
export type Rule = z.infer<typeof Rule>;

export const Branding = z.object({
  companyName: z.string(),
  footer: z.string().default(""),
  logoS3Key: z.string().optional(),
  primaryColor: z.string().default("#1f4e79"),
  headerText: z.string().optional(),
  /** "form": reproduce the company's paper form (boxed sections, gray title bars); default: modern layout. */
  style: z.enum(["modern", "form"]).default("modern"),
  /** Logo shipped with the app (packages/core/assets), used when no logo was uploaded. */
  builtinLogo: z.string().optional(),
  /** PDF export fills the company's own PDF form (src/pdf-form) instead of generating one, e.g. "we-achieve". */
  pdfForm: z.string().optional(),
});
export type Branding = z.infer<typeof Branding>;

export const TemplateSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  sections: z.array(Section),
  rules: z.array(Rule).default([]),
  branding: Branding,
});
export type Template = z.infer<typeof TemplateSchema>;

export const CCP8F_TAG = "ccp8f_required";

export function allFields(t: Template): Array<Field & { sectionId: string }> {
  return t.sections.flatMap((s) => s.fields.map((f) => ({ ...f, sectionId: s.id })));
}

export function findField(t: Template, id: string): (Field & { sectionId: string }) | undefined {
  return allFields(t).find((f) => f.id === id);
}

export function parseTemplate(json: unknown): Template {
  const t = TemplateSchema.parse(json);
  const seen = new Set<string>();
  for (const f of allFields(t)) {
    if (seen.has(f.id)) throw new Error(`Duplicate field id: ${f.id}`);
    seen.add(f.id);
    if (f.type === "table" && !f.columns?.length) throw new Error(`Table field ${f.id} needs columns`);
  }
  return t;
}

/** A guided question groups one or more fields (spec F4). */
export interface GuidedQuestion {
  id: string;
  sectionId: string;
  sectionTitle: string;
  text: string;
  fieldIds: string[];
}

export function guidedQuestions(t: Template): GuidedQuestion[] {
  const out: GuidedQuestion[] = [];
  const byId = new Map<string, GuidedQuestion>();
  for (const s of t.sections) {
    for (const f of s.fields) {
      if (!f.question && !f.questionId) continue;
      const qid = f.questionId ?? f.id;
      const existing = byId.get(qid);
      if (existing) {
        existing.fieldIds.push(f.id);
        if (f.question && !existing.text) existing.text = f.question;
      } else {
        const q: GuidedQuestion = { id: qid, sectionId: s.id, sectionTitle: s.title, text: f.question ?? "", fieldIds: [f.id] };
        byId.set(qid, q);
        out.push(q);
      }
    }
  }
  return out;
}

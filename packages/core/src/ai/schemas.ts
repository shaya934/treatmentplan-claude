import { z } from "zod";
import { EvidenceCategory } from "../template/schema";

export const ExtractedFact = z.object({
  fact_text: z.string().min(1),
  category: EvidenceCategory,
  value: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  source_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  page: z.number().int().min(1),
});
export type ExtractedFact = z.infer<typeof ExtractedFact>;
export const ExtractionOutput = z.object({ facts: z.array(ExtractedFact) });

export const AnswerAssessment = z.object({
  complete: z.boolean(),
  follow_up: z.string().nullable().optional(),
});
export type AnswerAssessment = z.infer<typeof AnswerAssessment>;

const CellRow = z.record(z.string(), z.string());
export const FieldValueOut = z.union([z.string(), z.array(CellRow), z.boolean(), z.array(z.string())]);

export const SectionOutput = z.object({
  fields: z.array(
    z.object({
      field_id: z.string(),
      value: FieldValueOut,
      sentences: z.array(z.object({ text: z.string(), sources: z.array(z.string()) })).default([]),
    }),
  ),
});
export type SectionOutput = z.infer<typeof SectionOutput>;

export const ReviewOutput = z.object({
  conflicts: z.array(z.object({ field_id: z.string(), detail: z.string() })),
  unsupported: z.array(z.object({ field_id: z.string(), detail: z.string() })),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

export const EditOutput = z.object({
  changes: z.array(z.object({ field_id: z.string(), new_value: FieldValueOut, summary: z.string() })),
  message: z.string(),
});
export type EditOutput = z.infer<typeof EditOutput>;

export const TemplateOp = z.object({
  op: z.enum([
    "add_field",
    "update_field",
    "remove_field",
    "move_field",
    "add_section",
    "update_section",
    "remove_section",
    "add_rule",
    "update_rule",
    "remove_rule",
    "update_branding",
  ]),
  section_id: z.string().optional(),
  field_id: z.string().optional(),
  after_field_id: z.string().optional(),
  rule_id: z.string().optional(),
  /** Partial field / section / rule / branding object as JSON. */
  data: z.record(z.string(), z.unknown()).optional(),
});
export type TemplateOp = z.infer<typeof TemplateOp>;
export const TemplateDiffOutput = z.object({ ops: z.array(TemplateOp), summary: z.string() });
export type TemplateDiffOutput = z.infer<typeof TemplateDiffOutput>;

export const DocxTemplateOutput = z.object({
  sections: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      fields: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
});

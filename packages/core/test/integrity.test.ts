import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockAiClient, setAiClient, type StructuredRequest } from "../src/ai/client";
import { mockHandlers } from "../src/ai/mock";
import { CLINICAL_INTEGRITY_RULES } from "../src/ai/prompts";
import { emptyContent, HAS_PLACEHOLDER as PLACEHOLDER_RE, valueToText } from "../src/plan/content";
import { generateSection, unsupportedNumbers } from "../src/pipeline/generate";
import { WE_ACHIEVE_TEMPLATE as T } from "../src/template/we-achieve-template";
import { APPROVED_MODEL_IDS, modelFor } from "@aba/config/models";

/** Clinical integrity rules (spec: AI design) and model configuration. */

const seen: StructuredRequest<unknown>[] = [];
class Recording extends MockAiClient {
  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    seen.push(req as StructuredRequest<unknown>);
    return super.structured(req);
  }
}

beforeAll(() => {
  process.env.ABA_MODE = "local";
  setAiClient(new Recording(mockHandlers));
});
afterAll(() => setAiClient(null));

const client = { id: "c", name: "Testcase, Ava", dob: "2019-04-12", medicaid_id: "SYN1", payer: "Trillium", diagnosis: "F84.0", assigned_bcba_id: null };

describe("clinical integrity", () => {
  it("every generation system prompt contains all 7 clinical integrity rules", async () => {
    const { proposeEdits } = await import("../src/pipeline/edit");
    const { buildReviewList } = await import("../src/pipeline/generate");
    const c = emptyContent(T);
    seen.length = 0;
    await generateSection({ tenantId: "t" }, T, T.sections.find((s) => s.id === "progress")!, c, [], [], client);
    await buildReviewList({ tenantId: "t" }, T, c, [], [], []);
    await proposeEdits({ tenantId: "t" }, T, c, "Make the strengths more detailed");
    const steps = seen.map((r) => r.step);
    expect(steps).toEqual(["narrative", "review", "plan_edit"]);
    for (const r of seen) {
      expect(r.system).toContain(CLINICAL_INTEGRITY_RULES);
      for (let i = 1; i <= 7; i++) expect(r.system).toContain(`${i}. `);
    }
    expect(CLINICAL_INTEGRITY_RULES).toContain("[BCBA to confirm: <what is missing>]");
  });

  it("missing data becomes a visible placeholder in every required generated field", async () => {
    const c = emptyContent(T);
    for (const s of T.sections) {
      const { updates } = await generateSection({ tenantId: "t" }, T, s, c, [], [], client);
      for (const f of s.fields.filter((f) => f.required && f.type !== "static" && !f.calc && f.type !== "boolean" && f.type !== "multiselect")) {
        const u = updates[f.id];
        expect(u, `${s.id}.${f.id}`).toBeDefined();
        expect(u!.status).toBe("needs_bcba");
        if (!(f.type === "table" && f.fixedRows?.length)) expect(valueToText(u!.value), f.id).toMatch(PLACEHOLDER_RE);
      }
    }
  });

  it("keeps carried-forward text unless the BCBA answered that field's question", async () => {
    const { generatableFields, answeredFields } = await import("../src/pipeline/generate");
    const { guidedQuestions, findField } = await import("../src/template/schema");
    const q = guidedQuestions(T).find((x) => x.id === "strengths" || x.fieldIds.includes("strengths"))!;
    const section = T.sections.find((s) => s.fields.some((f) => f.id === "strengths"))!;
    const c = emptyContent(T);
    c.strengths = { value: "Last period: strong visual matching and imitation.", status: "carried_forward", sources: ["previous_plan"] };
    expect(findField(T, "strengths")).toBeDefined();
    expect(generatableFields(section, c).map((f) => f.id)).not.toContain("strengths");
    const answer = { id: "a", plan_id: "p", question_id: q.id, answer_text: "Now also requests with 3-word phrases.", input_mode: "typed", is_follow_up: false, created_at: "" };
    expect(generatableFields(section, c, answeredFields(T, [answer as never])).map((f) => f.id)).toContain("strengths");
    seen.length = 0;
    const { updates } = await generateSection({ tenantId: "t" }, T, section, c, [], [], client);
    expect(updates.strengths).toBeUndefined();
  });

  it("generation never writes outside the requested fields or invents sources", async () => {
    const bad = new MockAiClient({
      write_section: () => ({ fields: [{ field_id: "member_id", value: "999", sentences: [] }, { field_id: "strengths", value: "Likes music.", sentences: [{ text: "Likes music.", sources: ["made-up-id"] }] }] }),
    });
    setAiClient(bad);
    const { updates } = await generateSection({ tenantId: "t" }, T, T.sections.find((s) => s.id === "functioning")!, emptyContent(T), [], [], client);
    expect(updates.member_id).toBeUndefined();
    expect(updates.strengths!.sources).toEqual([]);
    setAiClient(new Recording(mockHandlers));
  });

  it("invalid AI output is retried once, then surfaced as an error (never silently saved)", async () => {
    let calls = 0;
    setAiClient(new MockAiClient({ write_section: () => (calls++, { nope: true }) }));
    await expect(generateSection({ tenantId: "t" }, T, T.sections[2]!, emptyContent(T), [], [], client)).rejects.toThrow(/invalid result/);
    expect(calls).toBe(2);
    setAiClient(new Recording(mockHandlers));
  });

  it("flags numbers that appear in no file or BCBA answer", () => {
    expect(unsupportedNumbers("Aggression decreased to 1.2 per hour from 2.4.", "Aggression rate 2.4 per hour")).toEqual([]);
    expect(unsupportedNumbers("Communication SS is 81.", "Communication SS 68")).toEqual(["81"]);
  });
});

describe("model configuration", () => {
  it("routes each step to the spec's default model and allows only approved IDs", () => {
    expect(modelFor("extraction").key).toBe("haiku");
    expect(modelFor("guided_chat").key).toBe("haiku");
    expect(modelFor("narrative").key).toBe("sonnet");
    expect(modelFor("review").key).toBe("sonnet");
    expect(modelFor("plan_edit").key).toBe("sonnet");
    expect(modelFor("template_edit").key).toBe("sonnet");
    expect(modelFor("narrative", { complexCase: true }).key).toBe("opus");
    expect(APPROVED_MODEL_IDS.some((id) => /fable|mythos/i.test(id))).toBe(false);
  });
});

describe("Bedrock tool schemas", () => {
  it("every structured-output schema converts to a JSON schema for tool use", async () => {
    const { z } = await import("zod");
    const S = await import("../src/ai/schemas");
    for (const schema of [S.ExtractionOutput, S.AnswerAssessment, S.SectionOutput, S.ReviewOutput, S.EditOutput, S.TemplateDiffOutput, S.DocxTemplateOutput]) {
      const js = z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" }) as { type: string; properties: object };
      expect(js.type).toBe("object");
      expect(Object.keys(js.properties).length).toBeGreaterThan(0);
    }
  });
});

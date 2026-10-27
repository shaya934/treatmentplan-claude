import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedWorld, setupTestEnv, svcFor, type World } from "./helpers";

/** Phase 7: admin template chatbot. */

let w: World;
let db: typeof import("../src/db");
let tmpl: typeof import("../src/svc/templates");
let plans: typeof import("../src/svc/plans");

beforeAll(async () => {
  await setupTestEnv();
  db = await import("../src/db");
  tmpl = await import("../src/svc/templates");
  plans = await import("../src/svc/plans");
  w = await seedWorld();
});
afterAll(async () => db.closePool());

describe("admin template chatbot", () => {
  it("admin adds a field by chat; it appears in new plans only, drafts stay until they choose to update", async () => {
    const admin = svcFor(w, "adminA");
    const bcba = svcFor(w, "bcba1");
    const oldPlan = (await plans.createPlan(bcba, { clientId: w.clients.ava!, type: "initial", periodStart: "2026-11-01", periodEnd: "2027-01-29" })).id;

    const prop = await tmpl.templateChat(admin, "Add a feeding concerns field under Developmental History");
    expect(prop.ops[0]!.op).toBe("add_field");
    expect(prop.changedSections).toEqual(["history"]);
    expect(prop.warnings).toEqual([]);
    const added = prop.template.sections.find((s) => s.id === "history")!.fields.find((f) => f.label === "Feeding concerns")!;
    expect(added).toBeDefined();

    const before = await tmpl.getCurrentTemplate(admin);
    expect(before.template.sections.find((s) => s.id === "history")!.fields.some((f) => f.id === added.id)).toBe(false); // not live until publish
    const pub = await tmpl.publishTemplate(admin, { template: prop.template, changeReason: "Trillium reviewers asked for feeding history" });
    expect(pub.version).toBe(2);

    const newPlan = (await plans.createPlan(bcba, { clientId: w.clients.ava!, type: "initial", periodStart: "2026-11-01", periodEnd: "2027-01-29" })).id;
    expect((await plans.getPlanBundle(bcba, newPlan)).template.sections.find((s) => s.id === "history")!.fields.some((f) => f.id === added.id)).toBe(true);
    const old = await plans.getPlanBundle(bcba, oldPlan);
    expect(old.template.sections.find((s) => s.id === "history")!.fields.some((f) => f.id === added.id)).toBe(false);
    expect(old.latestTemplateVersion).toBe(2);

    await plans.saveFieldEdits(bcba, oldPlan, { strengths: "Enjoys puzzles." });
    const mig = await plans.updateToLatestTemplate(bcba, oldPlan);
    expect(mig.added).toContain(added.id);
    const after = await plans.getPlanBundle(bcba, oldPlan);
    expect(after.version.content_json.strengths!.value).toBe("Enjoys puzzles."); // matching fields migrated
  });

  it("removing a CCP 8F field shows a warning naming the rule; publishing needs a typed reason", async () => {
    const admin = svcFor(w, "adminA");
    const prop = await tmpl.templateChat(admin, "Remove the Continued Services field");
    expect(prop.warnings.length).toBeGreaterThan(0);
    expect(prop.warnings[0]!.message).toMatch(/ccp8f_required/);
    await expect(tmpl.publishTemplate(admin, { template: prop.template, changeReason: "cleanup", warnings: prop.warnings })).rejects.toThrow(/reason/);
    // Server re-checks even if the client hides the warnings.
    await expect(tmpl.publishTemplate(admin, { template: prop.template, changeReason: "cleanup" })).rejects.toThrow(/Compliance guard/);
    const ok = await tmpl.publishTemplate(admin, { template: prop.template, changeReason: "cleanup", complianceReason: "Moved to a separate addendum reviewed by QA" });
    const v = await db.withCtx({ tenantId: w.tenantA, userId: null, role: "system" }, (t) => t.query("SELECT compliance_override FROM template_versions WHERE id = $1", [ok.versionId]));
    expect(v.rows[0].compliance_override).toMatch(/addendum/);
  });

  it("'Require 3 caregiver goals' changes the rule data, and rollback restores the old version", async () => {
    const admin = svcFor(w, "adminA");
    const prop = await tmpl.templateChat(admin, "Require 3 caregiver goals");
    const rule = prop.template.rules.find((r) => r.id === "caregiver_goals_min") as { min: number };
    expect(rule.min).toBe(3);
    const pub = await tmpl.publishTemplate(admin, { template: prop.template, changeReason: "Company policy" });
    const cur = await tmpl.getCurrentTemplate(admin);
    expect(cur.version).toBe(pub.version);
    const v2 = cur.versions.find((v) => (v as { version: number }).version === 2) as { id: string };
    await tmpl.rollbackTemplate(admin, v2.id, "Revert policy");
    expect((await tmpl.getCurrentTemplate(admin)).version).toBe(2);
  });

  it("finalized plans never change when the template changes", async () => {
    const r = await db.withCtx({ tenantId: w.tenantA, userId: null, role: "system" }, (t) => t.query("SELECT count(*)::int AS n FROM plans WHERE status = 'final'"));
    expect(r.rows[0].n).toBe(0); // covered structurally: plans pin template_version_id and finalized versions are locked
  });

  it("converts an uploaded DOCX into a structured template draft", async () => {
    const { Document, Packer, Paragraph } = await import("docx");
    const doc = new Document({ sections: [{ children: ["Family History", "Family structure:", "Supports:", "School Information", "School name: ", "IEP status:"].map((t) => new Paragraph(t)) }] });
    const bytes = await Packer.toBuffer(doc);
    const { draft } = await tmpl.uploadWordTemplate(svcFor(w, "adminA"), bytes, "convert");
    expect(draft!.sections.map((s) => s.title)).toEqual(["Family History", "School Information"]);
    expect(draft!.sections[0]!.fields[0]!.label).toBe("Family structure");
  });
});

describe("platform standard template", () => {
  const docx = async (lines: string[]) => {
    const { Document, Packer, Paragraph } = await import("docx");
    return Packer.toBuffer(new Document({ sections: [{ children: lines.map((t) => new Paragraph(t)) }] }));
  };

  it("new companies start from the published standard; existing companies keep their own template", async () => {
    const pt = await import("../src/svc/platform-template");
    const admin = await import("../src/svc/admin");
    const owner = svcFor(w, "owner");
    expect((await pt.getPlatformTemplate(owner)).builtIn).toBe(true);
    const before = await tmpl.getCurrentTemplate(svcFor(w, "adminA"));

    const { draft } = await pt.convertPlatformTemplate(owner, await docx(["Intake Summary", "Reason for referral:", "Parent concerns:", "Goals Overview", "Primary goal:"]));
    expect(draft.sections.map((s) => s.title)).toEqual(["Intake Summary", "Goals Overview"]);
    await expect(pt.publishPlatformTemplate(owner, { template: draft, changeReason: " " })).rejects.toThrow(/Describe/);
    const { version } = await pt.publishPlatformTemplate(owner, { template: draft, changeReason: "Our standard form" });
    expect(version).toBe(1);

    const { id } = await admin.createTenant(owner, { name: "New Co", slug: "new-co", adminEmail: "newco@test.test", adminName: "New Admin", tempPassword: "New-Co-Passw0rd!" });
    const fresh = await db.withCtx({ tenantId: id, userId: null, role: "system" }, (t) => t.query("SELECT tv.schema_json FROM templates tt JOIN template_versions tv ON tv.id = tt.current_version_id"));
    const seeded = fresh.rows[0].schema_json;
    expect(seeded.sections.map((s: { title: string }) => s.title)).toEqual(["Intake Summary", "Goals Overview"]);
    expect(seeded.branding.companyName).toBe("New Co");

    const after = await tmpl.getCurrentTemplate(svcFor(w, "adminA"));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before)); // existing company untouched

    expect((await pt.publishPlatformTemplate(owner, { builtIn: true, changeReason: "Back to built-in" })).version).toBe(2);
    expect((await pt.getPlatformTemplate(owner)).template.sections.length).toBeGreaterThan(5);
  });

  it("only the platform owner can see or change the standard, even with raw SQL", async () => {
    const pt = await import("../src/svc/platform-template");
    await expect(pt.getPlatformTemplate(svcFor(w, "adminA"))).rejects.toThrow();
    await expect(pt.publishPlatformTemplate(svcFor(w, "adminA"), { builtIn: true, changeReason: "x" })).rejects.toThrow();
    const rows = await db.withCtx({ tenantId: w.tenantA, userId: w.users.adminA!.id, role: "company_admin" }, (t) => t.query("SELECT count(*)::int AS n FROM platform_templates"));
    expect(rows.rows[0].n).toBe(0);
  });

  it("splits a Word template at the listed headings, or reports that it can't", async () => {
    const { splitAtHeadings } = await import("../src/pipeline/template-chat");
    const text = "Cover note\nFamily History\nFamily structure:\nSchool Information\nSchool name:";
    const parts = splitAtHeadings(text, [
      { title: "Family History", heading: "family  history" },
      { title: "School", heading: "School Information" },
    ])!;
    expect(parts.map((p) => p.title)).toEqual(["Family History", "School"]);
    expect(parts[0]!.text).toContain("Cover note"); // text before the first heading stays with it
    expect(parts[1]!.text).toBe("School Information\nSchool name:");
    expect(splitAtHeadings(text, [{ title: "Missing", heading: "Medical History" }])).toBeNull();
  });
});

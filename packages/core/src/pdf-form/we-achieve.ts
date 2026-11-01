import { rgb } from "pdf-lib";
import { usDates, valueToText, type PlanContent, type TableRow } from "../plan/content";
import { FormFiller, type Figure, type LayoutRect } from "./engine";

/**
 * Where each answer goes on the We Achieve ABA form (assets/we-achieve-form-blank.pdf,
 * the company's own 13-page PDF with the sample client removed). Lines are addressed by
 * page and baseline, labels by their text; cell edges come from the form's own drawing.
 * Field ids are those of template/we-achieve-form.ts.
 */

export interface FormInput {
  content: PlanContent;
  firstName: string;
  draft: boolean;
  figures: Figure[];
  footer: string;
}

export async function fillWeAchieveForm(input: FormInput): Promise<Buffer> {
  const f = await FormFiller.open("we-achieve-form-blank.pdf", "we-achieve-form-layout.json");
  const c = input.content;
  const first = input.firstName || "[BCBA to confirm: client first name]";
  const v = (id: string) => usDates(valueToText(c[id]?.value ?? null)).trim();
  const bool = (id: string) => (c[id]?.value === true ? true : c[id]?.value === false ? false : null);
  const picked = (id: string) => new Set(((c[id]?.value as string[] | null) ?? []).map((x) => x.toLowerCase()));
  const rows = (id: string) => ((c[id]?.value as TableRow[] | null) ?? []).filter((r) => Object.values(r).some((x) => String(x ?? "").trim()));
  const blankTo = (text: string, gap: string) => text || `[BCBA to confirm: ${gap}]`;
  const right = (p: number, y: number, x: number) => f.cellRightOf(p, x + 1, y + 2);
  const inCell = (cell: LayoutRect, text: string, label: string, top = cell.y1 - 2) => f.box(cell.p, cell.x0 + 3, top, cell.x1 - 3, cell.y0 + 2, text, label);
  const tickYesNo = (p: number, y: number, value: boolean | null) => {
    const bx = f.boxes(f.lineAt(p, y));
    if (value === true && bx[0]) f.tick(p, bx[0]);
    if (value === false && bx[1]) f.tick(p, bx[1]);
  };
  const tickOption = (p: number, y: number, on: boolean) => {
    const bx = f.boxes(f.lineAt(p, y))[0];
    if (on && bx) f.tick(p, bx);
  };
  const below = (p: number, y: number, x: number) => f.cellBelow(f.cellAt(p, x + 1, y + 2));

  if (input.draft) {
    const t = "DRAFT – not finalized. Requires BCBA review before use.";
    f.page(1).drawText(t, { x: 306 - f.width(t, 8, true) / 2, y: 780, size: 8, font: f.bold, color: rgb(0.75, 0, 0) });
  }

  // ---------------- page 1 ----------------
  f.after(1, 648, "Date Report Started:", v("report_started"));
  f.after(1, 648, "Date Report Completed:", v("report_date"));
  f.after(1, 533, "Assessing BCBA:", v("assessing_bcba"));
  f.after(1, 542, "Supervising BCBA:", v("supervising_bcba"));
  f.after(1, 425, "Client Name:", v("client_name"));
  f.after(1, 427, "Client Date of Birth:", v("dob"));
  f.after(1, 404, "Age:", v("age"));
  f.after(1, 404, "Gender:", v("gender"));
  f.after(1, 384, "Parent/Caregiver:", v("caregiver_name"));
  f.after(1, 384, "Parent/Caregiver Contact:", v("caregiver_contact"));
  f.after(1, 365, "Home Address:", v("home_address"));
  f.after(1, 345, "Insurance Company:", v("insurance"));
  f.after(1, 345, "Member ID:", v("member_id"));
  f.after(1, 319, "Primary Diagnosis:", v("diagnosis"));
  f.after(1, 319, "Date of Diagnosis:", v("onset_of_diagnosis"));
  f.after(1, 286, "Diagnosing Physician:", v("diagnosing_physician"));
  f.after(1, 286, "Additional Diagnoses:", v("additional_diagnoses"));
  f.after(1, 260, "Primary Care Physician:", v("primary_care_physician"));
  f.retype(f.lineAt(1, 189), 2, `${first} is a ${blankTo(v("age"), "age")}-year-old individual who has a diagnosis of ${blankTo(v("diagnosis"), "diagnosis")}. ${first} was referred due to deficits in communication, socialization and adaptive living skills, as well as presence of maladaptive behaviors, as relates to ASD diagnosis.`, { x0: 24 });
  {
    const cell = right(1, 154, 34.7);
    f.clearCell(cell);
    inCell(cell, v("developmental_history"), "Developmental History");
  }

  // ---------------- page 2 ----------------
  for (const s of f.layout.nameSlots.filter((s) => s.p === 2 && [734, 713, 647, 605, 585, 564, 543].some((y) => Math.abs(s.y - y) < 1.5))) {
    // "<name> has other known medical conditions:" retyped from where the name was, up to its ☐ boxes.
    const l = f.lineAt(2, s.y);
    const box = f.boxes(l)[0];
    const words = l.items.filter((i) => i.x > s.x && (!box || i.x < box.x)).map((i) => i.s.trim());
    const end = box ? box.x - 3 : f.cellAt(2, s.x + 1, s.y + 2).x1 - 3;
    f.whiteout(2, s.x - 0.5, s.y - s.size * 0.35, end, s.y + s.size * 1.05);
    f.fitLine(2, s.x, s.y, end - s.x, [first, ...words].join(" "), s.size, "Medical/Mental Health");
  }
  tickYesNo(2, 734, bool("has_medical_conditions"));
  tickYesNo(2, 713, bool("has_allergies"));
  f.after(2, 692, "please list:", v("medical_list"));
  tickYesNo(2, 626, bool("has_mh_diagnoses"));
  f.after(2, 626, "please list:", v("mh_list"));
  tickYesNo(2, 605, bool("history_abuse"));
  tickYesNo(2, 585, bool("history_sexualized"));
  tickYesNo(2, 564, bool("substance_use"));
  tickYesNo(2, 522, bool("substance_exposure"));
  {
    const cell = right(2, 458, 70.7);
    f.clearCell(cell);
    const meds = rows("medications").map((r) => [r.medication, r.dosage, r.frequency, r.notes].filter(Boolean).join(" – "));
    const taking = meds.length ? "is currently taking" : bool("has_medical_conditions") === null ? "[BCBA to confirm: is/is not] currently taking" : "is not currently taking";
    inCell(cell, `${first} ${taking} medication(s).\nMedication(s): ${meds.join("; ")}`, "Current Medication(s)");
  }
  {
    const cell = right(2, 394, 59);
    f.clearCell(cell);
    inCell(cell, v("educational_setting"), "Educational/Daily Setting");
  }
  {
    const cell = right(2, 278, 27.5);
    f.clearCell(cell);
    inCell(cell, v("home_family"), "Home/Family Information");
  }
  {
    const cell = right(2, 206, 36.9);
    f.clearCell(cell);
    inCell(cell, `${first}'s family medical history is significant for the following conditions:\n${v("family_medical_history")}`, "Family Medical History");
  }
  {
    const cell = right(2, 172, 40.7);
    f.clearCell(cell);
    inCell(cell, `${first}'s family mental health history is significant for the following conditions:\n${v("family_mental_health_history")}`, "Family Mental Health History");
  }

  // ---------------- page 3 ----------------
  f.retype(f.lineAt(3, 756), 1, v("aba_history_statement") || `[BCBA to confirm: has ${first} received ABA therapy in the past?]`, { x0: 24 });
  fillTable(f, 3, 736, ["Agency/Provider", "Approximate Dates", "Reason for Discharge"], rows("past_aba").map((r) => [r.provider, r.dates, r.discharge_reason]), "Past ABA therapy");
  fillTable(f, 3, 658, ["Therapy Type", "Dates of Service", "Frequency/Session"], rows("other_services").map((r) => [r.service, r.dates, r.frequency]), "Past/Current Related Therapy");
  f.retype(f.lineAt(3, 505), 2, `${v("assent_statement") || `Per observation/parent report, ${first} demonstrates assent by [BCBA to confirm: how] and removal of assent by [BCBA to confirm: how].`} ${first}'s primary communication mode: ${blankTo(v("communication_mode"), "mode")}.`, { x0: 24, label: "Client Input and Assent" });
  f.retype(f.lineAt(3, 470), 1, `${first} demonstrates the ability to:`, { x0: 24 });
  {
    const on = picked("communication_abilities");
    const opts: Array<[number, string]> = [[449, "Use simple tacts"], [428, "Use simple mands"], [407, "Use simple intraverbals"], [386, "Use complex tacts"], [365, "Use complex mands"], [344, "Use complex intraverbals"], [323, "Make choices"]];
    for (const [y, o] of opts) tickOption(3, y, on.has(o.toLowerCase()));
  }
  inCell(below(3, 293, 180.4), v("assessment_modifications"), "Modifications/Supports Utilized During Assessment");
  f.retype(f.lineAt(3, 144), 4, `${first}'s parent/caregiver was provided with an overview of the treatment process, as well as realistic expectations regarding progress. ${first}'s parent/caregiver input was utilized to help inform selection of goals to comprise ${first}'s treatment plan. Should ${first}'s parent/caregiver remove assent for these goals at any time, BCBA will be notified and modifications will be made to the treatment plan.`, { x0: 24 });

  // ---------------- page 4 ----------------
  {
    const on = picked("indirect_methods");
    const opts: Array<[number, string]> = [[701, "Family/Caregiver Interview"], [681, "Records Reviewed"], [660, "Functional Assessment Screening Tool (FAST)"], [639, "Vineland Adaptive Behavior Scales"], [618, "Other"]];
    for (const [y, o] of opts) tickOption(4, y, on.has(o.toLowerCase()));
    f.after(4, 681, "Records Reviewed:", v("records_reviewed"));
  }
  {
    const on = picked("direct_methods");
    const opts: Array<[number, string]> = [[565, "ABC Charting"], [544, "Functional Behavior Assessment"], [523, "Verbal Behavior Milestones Assessment & Placement Program"], [502, "Assessment of Basic Language & Learning Skills - ABLLS, Revised"], [481, "Socially Savvy Assessment"], [461, "Other"]];
    for (const [y, o] of opts) tickOption(4, y, on.has(o.toLowerCase()));
  }
  f.after(4, 386, "Date of Observation:", v("observation_date"));
  {
    const cell = f.cellAt(4, 30, 388);
    inCell(cell, v("observation_notes"), "Naturalistic Direct Observation", 386 - 6);
  }
  fillTable(f, 4, 292, ["Assessment(s) Utilized", "Identified Preference(s)"], rows("preferences").map((r) => [r.assessment, r.preferences]), "Preference Assessment");
  f.retype(f.lineAt(4, 156), 3, `${first} demonstrates skill deficits across several domains consistent with a diagnosis of autism spectrum disorder (ASD). These deficits are aligned with the core diagnostic criteria outlined in the DSM-V, including impairments in social communication and the presence of restricted or repetitive patterns of behavior.`, { x0: 24 });

  // ---------------- page 5: current levels of presentation ----------------
  const domains: Array<[number, number, string, string]> = [
    [764, 187.6, "presentation_communication", "Language/Communication Skills"],
    [729, 230.4, "presentation_social", "Social Skills"],
    [678, 216.9, "presentation_play", "Play/Leisure Skills"],
    [627, 163.6, "presentation_mild_behaviors", "Interfering or Mild Inappropriate Behaviors"],
    [576, 133.2, "presentation_severe_behaviors", "Severe Behavior"],
    [525, 195.5, "presentation_coping", "Coping and Tolerance Skills"],
    [491, 192.1, "presentation_cognitive", "Cognitive/Pre-academic Skills"],
    [456, 181.2, "presentation_self_help", "Independent Living/Self-help Skills"],
    [405, 204.9, "presentation_community", "Community Integration"],
    [341, 229.2, "presentation_safety", "Safety Skills"],
  ];
  for (const [y, x, id, label] of domains) inCell(below(5, y, x), v(id), label);
  {
    // On the form, "...concerns were noted:" ends page 5; its answer space is the empty top of the
    // same box on page 6, above "To address these additional concerns...".
    const box6 = f.cellAt(6, 30, 760);
    f.box(6, box6.x0 + 3, box6.y1 - 3, box6.x1 - 3, 738 + 10, v("non_aba_concerns"), "Referral for Other Services");
  }

  // ---------------- page 6 ----------------
  {
    const on = picked("referrals");
    const opts: Array<[number, string]> = [[717, "Speech-Language Pathologist"], [697, "Occupational Therapist"], [676, "Physical Therapist"], [655, "Medical Specialist"], [634, "Psychiatrist"], [614, "Mental Health Provider"]];
    for (const [y, o] of opts) tickOption(6, y, on.has(o.toLowerCase()));
  }
  f.retype(f.lineAt(6, 528), 2, `Targets were developed based on assessment findings and baseline performance. All targets are generally expected to be met 6 months from report completion date. Anticipated date of mastery for treatment targets is ${blankTo(v("mastery_date"), "mastery date")}.`, { x0: 24 });
  inCell(below(6, 488, 264.8), v("goals_communication"), "Communication goals");
  inCell(below(6, 443, 271.5), v("goals_socialization"), "Socialization goals");
  inCell(below(6, 399, 256.1), v("goals_behavior_reduction"), "Behavior Reduction goals");
  {
    const l1 = f.lineAt(6, 323);
    const b1 = f.boxes(l1)[0]!;
    f.retype(l1, 4, `${first} exhibited the following lower-priority behaviors: ${v("lower_priority_list") || "none noted"}. These behaviors are noted as mild and occur at a low frequency and low intensity. At this time, these behaviors do not pose safety concerns or require direct intervention. Data collection and clinical monitoring will continue to assess for any change in presentation. Should behaviors escalate or begin to impact functioning, appropriate treatment goals and interventions will be implemented.`, { x0: 32 });
    redrawBox(f, 6, b1, bool("has_lower_priority") === true);
    const l2 = f.lineAt(6, 258);
    const b2 = f.boxes(l2)[0]!;
    f.retype(l2, 3, `${first} did not present with any maladaptive behaviors during the assessment. Therefore, a Behavior Intervention Plan is not warranted at this time. The BCBA will continue to provide ongoing supervision and will update the treatment plan and documentation should any maladaptive behaviors emerge.`, { x0: 32 });
    redrawBox(f, 6, b2, bool("no_maladaptive") === true);
  }

  // ---------------- FBAs (3 on the form) ----------------
  const fbaSlots: Array<Array<[number, number, number]>> = [
    [[6, 164, 53.6], [6, 148, 41.6], [6, 129, 63.4], [6, 112, 42.8], [6, 95, 38.3], [7, 762, 41.3]],
    [[7, 716, 53.6], [7, 699, 41.6], [7, 680, 63.4], [7, 664, 42.8], [7, 647, 38.3], [7, 628, 41.3]],
    [[7, 569, 53.6], [7, 552, 41.6], [7, 533, 63.4], [7, 516, 42.8], [7, 499, 38.3], [7, 480, 41.3]],
  ];
  const fbaCols = ["behavior", "definition", "baseline", "antecedents", "consequences", "function"];
  const fbaLabels = ["Name of Behavior", "Operational Definition", "Baseline Data", "Current Antecedent(s)", "Current Consequence(s)", "Hypothesized Function"];
  const fbas = rows("fba");
  fbas.forEach((r, k) => {
    if (k >= fbaSlots.length) return f.overflow.push({ label: `Functional Behavior Assessment ${k + 1}`, text: fbaCols.map((col, i) => `${fbaLabels[i]}: ${r[col] ?? ""}`).join("\n"), fromPage: 7 });
    fbaSlots[k]!.forEach(([p, y, x], i) => inCell(right(p, y, x), r[fbaCols[i]!] ?? "", `FBA ${k + 1} – ${fbaLabels[i]}`));
  });

  // ---------------- Behavior Intervention Plans (3 on the form) ----------------
  const bipSlots = [
    { rows: [[7, 370, 57], [7, 337, 25.5], [7, 303, 45.8], [7, 256, 40.5], [7, 191, 45.4]], ante: [7, 123, 251.6], cons: [8, 714, 250.1], gen: [8, 587] },
    { rows: [[8, 446, 57], [8, 412, 25.5], [8, 379, 45.8], [8, 332, 40.5], [8, 266, 45.4]], ante: [8, 198, 251.6], cons: [8, 98, 250.1], gen: [9, 672] },
    { rows: [[9, 530, 57], [9, 497, 25.5], [9, 463, 45.8], [9, 416, 40.5], [9, 351, 45.4]], ante: [9, 283, 251.6], cons: [9, 183, 250.1], gen: [10, 756] },
  ];
  const bipCols = ["behavior", "definition", "baseline", "goal", "function"];
  const bipLabels = ["Behavior", "Operational Definition", "Baseline Data", "Target Behavior Reduction Goal", "Hypothesized Function"];
  rows("bip").forEach((r, k) => {
    const slot = bipSlots[k];
    if (!slot) {
      f.overflow.push({ label: `Behavior Intervention Plan ${k + 1}`, text: [...bipCols.map((col, i) => `${bipLabels[i]}: ${r[col] ?? ""}`), `Antecedent Strategies: ${r.antecedent_strategies ?? ""}`, `Consequent Strategies: ${r.consequent_strategies ?? ""}`, `Generalization: ${r.generalization ?? ""}`].join("\n"), fromPage: 9 });
      return;
    }
    slot.rows.forEach(([p, y, x], i) => inCell(right(p!, y!, x!), r[bipCols[i]!] ?? "", `BIP ${k + 1} – ${bipLabels[i]}`));
    fillGrid(f, slot.ante[0]!, slot.ante[1]!, slot.ante[2]!, r.antecedent_strategies ?? "", `BIP ${k + 1} – Antecedent Strategies`);
    fillGrid(f, slot.cons[0]!, slot.cons[1]!, slot.cons[2]!, r.consequent_strategies ?? "", `BIP ${k + 1} – Consequent Strategies`);
    f.retype(f.lineAt(slot.gen[0]!, slot.gen[1]!), 2, `${r.generalization ? `${r.generalization.replace(/\.?\s*$/, ".")} ` : "Behavior plan will be implemented across settings, by parents and therapists. "}Upon mastery, fading procedures will be used to fade antecedent and consequent strategies as appropriate, while maintaining target levels of behavior.`, { x0: 24 });
  });

  // ---------------- page 10 ----------------
  f.retype(f.lineAt(10, 647), 4, `Parent(s)/Caregiver(s) will partake in ${first}'s care by participating in formal parent/caregiver training sessions that will take place at a frequency of ${blankTo(v("pt_frequency"), "training frequency")}. Training will utilize Applied Behavior Analysis strategies. Provider will brief parent(s)/caregiver on client's goals and overall progress/regression. The goals below are in place, and parent(s)/caregiver progress will be monitored during parent(s)/caregiver training sessions.`, { x0: 24 });
  f.retype(f.lineAt(10, 503), 2, `Anticipated date of mastery for treatment targets is ${blankTo(v("mastery_date"), "mastery date")}. All targets are generally expected to be met 6 months from report completion date.`, { x0: 24 });
  inCell(f.cellBelow(below(10, 533, 273.4)), v("parent_goals"), "Parent Goals");
  f.retype(f.lineAt(10, 278), 5, `A signed coordination of care release is on file in ${first}'s record. The parent/caregiver has authorized communication with designated providers involved in ${first}'s care and has identified the specific professionals with whom information may be exchanged. Supervising clinician will be in contact with all providers involved in ${first}'s care as per the permission granted. This includes, but is not limited to, medical providers, psychiatrists, physicians, educator, other school faculty members, caregivers, related service providers and psychotherapists.`, { x0: 24 });

  // ---------------- page 11 ----------------
  f.retype(f.lineAt(11, 763), 4, `In case of inclement weather, sessions will be canceled until it is safe to resume. Parent/Caregiver has informed staff of all ${first}'s relevant medical conditions and will continue to update the agency with any changes. In case of severe behaviors, ${first} will be moved to a safe place, where he/she cannot harm him/herself and BIP will be implemented. Assistance will be called in as needed.`, { x0: 24 });
  {
    const l = f.lineAt(11, 692);
    const b3 = f.boxes(l)[0]!;
    f.retype(l, 1, `${first} requires an additional safety plan, see attached overview.`, { x0: 34 });
    redrawBox(f, 11, b3, bool("additional_safety_plan") === true);
  }
  f.retype(f.lineAt(11, 590), 3, `The overall goal of this ABA program is for ${first} to be able to function independently in all settings. The overall transition plan is to slowly decrease individual hours, moving towards group therapy. Eventually, the group hours will be decreased as well when appropriate progress is made. Slow fading of hours will ensure proper transition and maintenance of progress across all settings.`, { x0: 24 });
  f.retype(f.lineAt(11, 539), 2, `${first}'s hours of ABA will decrease when the member and his/her family's ability to generalize skills in multiple settings increases.`, { x0: 24 });
  f.retype(f.lineAt(11, 425), 3, `${first} will be considered for discharge when the majority of long-term program goals listed below are mastered and maladaptive behaviors are in the “mild” range. As well, ${first} demonstrates the ability to acquire new skills and meet their needs in less intensive or less restrictive settings.`, { x0: 24 });
  f.retype(f.lineAt(11, 371), 4, `${first} may also be considered for discharge in the event that ${first} is no longer able to participate in treatment and/or continually fails to achieve targeted goals, despite multiple attempts at identifying and addressing barriers to progress. Ongoing communication and coordination between the supervising clinician, the parent/caregiver, and other professionals will be maintained to monitor and support ${first}'s progress.`, { x0: 24 });
  inCell(below(11, 296, 264), v("discharge_goals"), "Discharge Goals");
  f.retype(f.lineAt(11, 212), 2, `In summary, ${first} received a diagnosis of ${blankTo(v("diagnosis"), "diagnosis")} and was referred for ABA services. After a thorough assessment, ${first} continues to present with multiple core deficits pertaining to this diagnosis.`, { x0: 24 });
  f.retype(f.lineAt(11, 177), 6, `Applied Behavior Analysis (ABA) therapy is recommended to support ${first} in acquiring essential skills necessary for improved functioning across all settings. ABA is a well established, evidence based treatment for autism spectrum disorder that directly targets core deficits in communication, socialization, and maladaptive behaviors. The recommended services are clinically justified to address ${first}'s functional impairments, improve skill acquisition, and reduce behaviors that interfere with daily functioning and safety. ABA is recognized as medically necessary to treat the symptoms and functional challenges associated with ${first}'s diagnosis and aligns with accepted clinical standards for intervention.`, { x0: 24 });

  // ---------------- page 12: schedule and requested services ----------------
  {
    const head = f.lineAt(12, 736);
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const codeRows: Array<[string, number]> = [["97153", 713], ["97154", 671], ["97155", 630], ["97156", 573], ["97158", 517], ["H0032", 460]];
    const sched = rows("weekly_schedule");
    for (const [code, y] of codeRows) {
      const r = sched.find((x) => String(x.code ?? "").startsWith(code));
      if (!r) continue;
      for (const d of days) {
        const val = r[d.toLowerCase()];
        if (!val) continue;
        const dx = f.label(head, d).x0;
        const cell = f.cellAt(12, dx + 2, y + 2);
        f.box(12, cell.x0 + 2, cell.y1 - 2, cell.x1 - 2, cell.y0 + 1, val, `Schedule ${code} ${d}`, 7.5);
      }
    }
    const req = rows("requested_services");
    const cols: Array<[string, number, number]> = [["hrs_week", 214.3, 313], ["units_week", 280.7, 308], ["total_hours", 335, 308], ["total_units", 400, 308], ["location", 480, 304]];
    const reqRows: Array<[string, number]> = [["97151", 266], ["97153", 236], ["97154", 213], ["97155", 192], ["97156", 164], ["97158", 130], ["H0032", 95]];
    for (const [code, y] of reqRows) {
      const r = req.find((x) => String(x.code ?? "").startsWith(code));
      if (!r) continue;
      for (const [col, hx, hy] of cols) {
        const val = r[col];
        if (!val) continue;
        const colCell = f.cellAt(12, hx + 2, hy + 2);
        const cell = f.cellAt(12, (colCell.x0 + colCell.x1) / 2, y + 2);
        f.clearCell(cell);
        f.box(12, cell.x0 + 2, cell.y1 - 2, cell.x1 - 2, cell.y0 + 1, val, `Requested ${code} ${col}`, 7.5);
      }
    }
  }
  f.retype(f.lineAt(12, 362), 2, `Above treatment schedule and settings have been chosen based on ${first}'s clinical presentation and to promote optimal outcomes for ${first}. Parent/caregiver has been informed of the benefits and possible risks of receiving services via telehealth and ${blankTo(v("telehealth_note"), "telehealth consent")}`, { x0: 24 });

  // ---------------- page 13 ----------------
  {
    const scores = rows("score_summary").map((r) => `${[r.tool, r.domain].filter(Boolean).join(" – ")}: ${r.current_score ?? ""}${r.date ? ` (${r.date})` : ""}${r.prior_score ? `; prior ${r.prior_score}${r.prior_date ? ` (${r.prior_date})` : ""}` : ""}${r.change ? `; change ${r.change}` : ""}`);
    inCell(below(13, 736, 253.1), scores.join("\n"), "Assessment Scores");
  }
  if (v("supervising_bcba")) f.draw(13, 24, 595, v("supervising_bcba"), 8.2);

  await f.finish(input.figures, input.footer, 13);
  return Buffer.from(await f.save());
}

/** Fill a table's empty rows under its header row (cells found from the header labels). Extra rows continue on added pages. */
function fillTable(f: FormFiller, p: number, headerY: number, headers: string[], data: Array<Array<string | undefined>>, label: string) {
  if (!data.length) return;
  const head = f.lineAt(p, headerY);
  const cols = headers.map((h) => {
    const x = f.label(head.items.some((i) => i.s.includes(h)) ? head : f.lineAt(p, headerY + 1), h).x0;
    return f.rowsBelow(f.cellBelow(f.cellAt(p, x + 1, headerY + 2)));
  });
  const nRows = Math.min(...cols.map((c) => c.length));
  data.forEach((row, i) => {
    if (i >= nRows) return f.overflow.push({ label: `${label} (row ${i + 1})`, text: row.filter(Boolean).join(" – "), fromPage: p });
    row.forEach((val, j) => {
      const cell = cols[j]![i]!;
      f.clearCell(cell);
      f.box(p, cell.x0 + 2, cell.y1 - 1.5, cell.x1 - 2, cell.y0 + 0.5, val ?? "", `${label} – ${headers[j]}`, 7.8);
    });
  });
}

/** Strategy grids (two columns of blank cells under a gray header): one strategy per cell, in reading order. */
function fillGrid(f: FormFiller, p: number, headerY: number, headerX: number, text: string, label: string) {
  if (!text.trim()) return;
  const hc = f.cellAt(p, headerX + 1, headerY + 2);
  let cells: LayoutRect[] = [];
  try {
    // Rows of two cells under the header: left cell, then the one to its right.
    const firstLeft = f.cellBelow(f.cellAt(p, hc.x0 + 5, headerY + 2));
    cells = f.rowsBelow(firstLeft).flatMap((left) => {
      const r = f.cellRight(left);
      return r.x1 <= hc.x1 + 2 ? [left, r] : [left];
    });
  } catch {
    cells = [];
  }
  const items = text
    .split(/\n|;\s*|,\s+(?=[a-z])/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!cells.length) return f.overflow.push({ label, text, fromPage: p });
  items.forEach((it, i) => {
    const cell = cells[i];
    if (!cell) return;
    f.box(p, cell.x0 + 2, cell.y1 - 1.5, cell.x1 - 2, cell.y0 + 0.5, it, label, 7.8);
  });
  if (items.length > cells.length) f.overflow.push({ label, text: items.slice(cells.length).join("; "), fromPage: p });
}

/** A ☐ that a retyped paragraph covered: draw it again (with its tick when checked). */
function redrawBox(f: FormFiller, p: number, box: { x: number; y: number; size: number; p: number; w: number; s: string }, checked: boolean) {
  f.draw(p, box.x, box.y, "☐", box.size);
  if (checked) f.tick(p, box);
}

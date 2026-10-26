import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * SYNTHETIC test data only. Every name, date and ID below is invented.
 * Development and testing never use real client files.
 */

export interface SyntheticFile {
  filename: string;
  title: string;
  pages: string[][];
  /** Render pages as images with no text layer, to exercise the OCR path. */
  scanned?: boolean;
}

export interface SyntheticClient {
  name: string;
  dob: string;
  gender: string;
  medicaidId: string;
  payer: string;
  diagnosis: string;
  files: SyntheticFile[];
}

export const SYNTHETIC_CLIENTS: SyntheticClient[] = [
  {
    name: "Testcase, Ava",
    dob: "2019-04-12",
    gender: "Female",
    medicaidId: "SYN0000001",
    payer: "Trillium",
    diagnosis: "Autism Spectrum Disorder, Level 2 (F84.0)",
    files: [
      {
        filename: "ava_diagnostic_evaluation.pdf",
        title: "Diagnostic Evaluation (SYNTHETIC)",
        pages: [
          [
            "Client: Testcase, Ava",
            "Date of Birth: 04/12/2019",
            "Diagnosis: Autism Spectrum Disorder, Level 2 (F84.0)",
            "Date of diagnosis: 03/04/2022",
            "Diagnosed by: Dr. Placeholder Psychologist, PhD (synthetic)",
            "Additional diagnosis: ADHD, combined presentation (F90.2)",
            "Medication: Melatonin | 3 mg | nightly at bedtime",
            "Caregiver name: Jordan Testcase",
          ],
        ],
      },
      {
        filename: "ava_vineland3_2026.pdf",
        title: "Vineland-3 Score Report (SYNTHETIC)",
        pages: [
          [
            "Vineland-3 Communication Standard Score: 68 (Date: 03/12/2026)",
            "Vineland-3 Daily Living Skills Standard Score: 72 (Date: 03/12/2026)",
            "Vineland-3 Socialization Standard Score: 64 (Date: 03/12/2026)",
            "Vineland-3 Adaptive Behavior Composite Standard Score: 67 (Date: 03/12/2026)",
          ],
          [
            "Prior Vineland-3 Communication Standard Score: 61 (Date: 02/20/2025)",
            "Prior Vineland-3 Daily Living Skills Standard Score: 70 (Date: 02/20/2025)",
            "Prior Vineland-3 Socialization Standard Score: 60 (Date: 02/20/2025)",
            "Prior Vineland-3 Adaptive Behavior Composite Standard Score: 63 (Date: 02/20/2025)",
          ],
        ],
      },
      {
        filename: "ava_progress_utilization.pdf",
        title: "Progress and Utilization Summary (SYNTHETIC)",
        pages: [
          [
            "Aggression rate: 2.4 per hour (Date: 09/30/2026)",
            "Elopement rate: 0.6 per hour (Date: 09/30/2026)",
            "Treatment start date: 01/20/2026",
            "FBA completed: 02/02/2026",
            "School name: Maple Grove Elementary (synthetic)",
            "Service: Speech therapy | 2x/week, 30 min",
            "Service: Occupational therapy | 1x/week, 45 min",
          ],
          [
            "97153 hours authorized: 520",
            "97153 hours used: 380",
            "97155 hours authorized: 78",
            "97155 hours used: 70",
            "97156 hours authorized: 12",
            "97156 hours used: 11",
            "Parent training sessions delivered: 11",
            "97156 data collection began: 02/10/2026",
          ],
        ],
      },
    ],
  },
  {
    name: "Sample, Noah",
    dob: "2017-09-03",
    gender: "Male",
    medicaidId: "SYN0000002",
    payer: "Alliance",
    diagnosis: "Autism Spectrum Disorder, Level 1 (F84.0)",
    files: [
      {
        filename: "noah_vbmapp_2026.pdf",
        title: "VB-MAPP Summary (SYNTHETIC)",
        pages: [["VB-MAPP Milestones score: 112 (Date: 05/01/2026)", "Prior VB-MAPP Milestones score: 96 (Date: 05/03/2025)", "Self-injurious behavior rate: 1.1 per hour (Date: 08/15/2026)"]],
      },
      {
        filename: "noah_iep_scan.pdf",
        title: "IEP (scanned, SYNTHETIC)",
        scanned: true,
        pages: [["School name: Riverbend Middle (synthetic)", "IEP services: Speech 60 min/week"]],
      },
    ],
  },
  {
    name: "Fakename, Liam",
    dob: "2020-01-22",
    gender: "Male",
    medicaidId: "SYN0000003",
    payer: "NC Medicaid Direct",
    diagnosis: "Autism Spectrum Disorder, Level 3 (F84.0)",
    files: [
      {
        filename: "liam_intake.pdf",
        title: "Intake Summary (SYNTHETIC)",
        pages: [["Client: Fakename, Liam", "Diagnosis: Autism Spectrum Disorder, Level 3 (F84.0)", "Property destruction rate: 3.2 per hour (Date: 07/01/2026)", "Medication: Risperidone | 0.25 mg | twice daily"]],
      },
    ],
  },
];

export async function makePdf(f: SyntheticFile): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const lines of f.pages) {
    const page = doc.addPage([612, 792]);
    if (f.scanned) {
      // Image-only page: draw "text" as vector rectangles so no text layer exists.
      let y = 720;
      for (const l of [f.title, ...lines]) {
        for (let i = 0; i < l.length; i++) if (l[i] !== " ") page.drawRectangle({ x: 60 + i * 6, y, width: 4, height: 8, color: rgb(0.2, 0.2, 0.2) });
        y -= 20;
      }
      continue;
    }
    page.drawText(f.title, { x: 60, y: 730, size: 14, font: bold });
    page.drawText("SYNTHETIC TEST DOCUMENT - NOT A REAL PERSON", { x: 60, y: 712, size: 8, font, color: rgb(0.7, 0, 0) });
    let y = 680;
    for (const l of lines) {
      page.drawText(l, { x: 60, y, size: 11, font });
      y -= 18;
    }
  }
  return Buffer.from(await doc.save());
}

/** Sample BCBA answers used by tests and the demo. Includes one planted conflict (Communication 72 vs file 68). */
export const SAMPLE_ANSWERS: Record<string, string> = {
  q_assessment_dates: "Assessment was completed on 9/22/2026 and 9/24/2026 at the client's home and at the clinic.",
  q_medical: "No changes to medical history this period; melatonin continues as prescribed by the pediatrician.",
  q_hist_dev: "Ava now uses 2-3 word phrases and is fully toilet trained during the day as of June 2026; no new conditions.",
  q_progress: "Ava mastered 14 of 22 skill targets this period. Independent mands increased from 5 per hour in March to 18 per hour in September. Her Vineland Communication standard score is 72 now.",
  q_strengths: "Strong visual matching and imitation skills; enjoys music and puzzles. Problem areas are aggression during transitions and limited peer play.",
  q_fba: "Aggression is maintained by escape from non-preferred tasks and access to tangibles; elopement is hypothesized to be automatically maintained.",
  q_caregiver: "Mom attends weekly parent training and implements first-then and token board at home with growing consistency; barrier is the evening work schedule.",
  q_hours: "I recommend 25 hrs/week of 97153 but we are requesting 20 hrs/week of 97153 due to the school schedule, plus 3 hrs/week of 97155 and 1 hrs/week of 97156.",
};

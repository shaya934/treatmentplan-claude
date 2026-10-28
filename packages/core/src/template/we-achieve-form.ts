import { CCP8F_TAG, parseTemplate, type Template } from "./schema";

/**
 * We Achieve ABA treatment plan, reproducing the company's 13-page form (boxed
 * sections, gray title bars) in order and wording. Differences from the paper form:
 * answer boxes grow to fit, FBAs and behavior plans repeat as needed (records), and
 * graphs are placed after "Short Term Goals and Targets". Fixed sentences use
 * {{first_name}} etc.; {{field_id}} tokens are filled from the plan.
 */

const R = [CCP8F_TAG];
const CODES_SCHEDULE = [
  "97153: Adaptive Behavior Treatment",
  "97154: Adaptive Behavior Treatment - Group",
  "97155: Adaptive Behavior Treatment with Protocol Modification",
  "97156: Family Adaptive Behavior Treatment and Guidance",
  "97158: Group Adaptive Behavior Treatment with Protocol Modification",
  "H0032: Treatment Planning",
];
const CODES_REQUESTED = ["97151: Behavior Identification Supporting Assessment", ...CODES_SCHEDULE];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const sub = (id: string, text: string) => ({ id, label: text, type: "static", style: "subheader", text });
const note = (id: string, text: string) => ({ id, label: "Text", type: "static", text });
const yesNo = (id: string, label: string, rowLabel: string, questionId: string) => ({ id, label, type: "boolean", display: "row", rowLabel, questionId, sourceHints: ["diagnosis", "medication", "other"] });
const domain = (id: string, label: string, hints: string[]) => ({ id, label, type: "narrative", lengthType: "narrative", display: "block", questionId: "q_presentation", sourceHints: hints });

const raw = {
  name: "We Achieve ABA - Treatment Plan",
  description: "We Achieve ABA treatment plan form (initial assessment and reassessment).",
  branding: {
    companyName: "We Achieve ABA",
    footer: "We Achieve ABA EIN 33-2271529 E: INFO@WEACHIEVEABA.COM P: 704.275.2236 47 Citadel Dr, Jackson, NJ 08527",
    primaryColor: "#d4d4d4",
    headerText: "Treatment Plan",
    style: "form",
    builtinLogo: "we-achieve-logo.png",
  },
  sections: [
    {
      id: "report_info",
      title: "Report Information",
      fields: [
        // Filled by the app: started = plan created, completed = date the plan is finalized.
        { id: "report_started", label: "Date Report Started", type: "date", display: "half", calc: "plan_created", carryForward: false },
        { id: "report_date", label: "Date Report Completed", type: "date", display: "half", calc: "plan_finalized", carryForward: false },
      ],
    },
    {
      id: "provider_info",
      title: "Provider Information",
      fields: [
        { id: "company_name", label: "Company Name", type: "static", display: "half", text: "We Achieve ABA EIN 33-2271529" },
        { id: "company_address", label: "Company Address", type: "static", display: "half", text: "47 Citadel Dr, Jackson, NJ 08527" },
        { id: "assessing_bcba", label: "Assessing BCBA", type: "text", display: "half", questionId: "q_report" },
        { id: "supervising_bcba", label: "Supervising BCBA", type: "text", display: "half", required: true, tags: R },
      ],
    },
    {
      id: "client_info",
      title: "Client Information/Basic Psychosocial Information",
      fields: [
        { id: "client_name", label: "Client Name", type: "text", display: "half", required: true, tags: R, sourceHints: ["demographic"], carryForward: false },
        { id: "dob", label: "Client Date of Birth", type: "date", display: "half", required: true, tags: R, sourceHints: ["demographic"], carryForward: false },
        { id: "age", label: "Age", type: "text", display: "half", calc: "age", carryForward: false },
        { id: "gender", label: "Gender", type: "text", display: "half", sourceHints: ["demographic"] },
        { id: "caregiver_name", label: "Parent/Caregiver", type: "text", display: "half", sourceHints: ["caregiver", "demographic"] },
        { id: "caregiver_contact", label: "Parent/Caregiver Contact", type: "text", display: "half", sourceHints: ["caregiver", "demographic"] },
        { id: "home_address", label: "Home Address", type: "text", sourceHints: ["demographic"] },
        { id: "insurance", label: "Insurance Company", type: "text", display: "half", required: true, tags: R, sourceHints: ["demographic", "authorization"], carryForward: false },
        { id: "member_id", label: "Member ID", type: "text", display: "half", required: true, tags: R, sourceHints: ["demographic"], carryForward: false },
        { id: "diagnosis", label: "Primary Diagnosis", type: "text", display: "half", required: true, tags: R, sourceHints: ["diagnosis"] },
        { id: "onset_of_diagnosis", label: "Date of Diagnosis", type: "date", display: "half", sourceHints: ["diagnosis", "date"] },
        { id: "diagnosing_physician", label: "Diagnosing Physician", type: "text", display: "half", sourceHints: ["diagnosis"] },
        { id: "additional_diagnoses", label: "Additional Diagnoses", type: "text", display: "half", sourceHints: ["diagnosis"] },
        { id: "primary_care_physician", label: "Primary Care Physician", type: "text", sourceHints: ["demographic", "other"] },
      ],
    },
    {
      id: "client_background",
      title: "Client Background",
      fields: [
        note("background_intro", "{{first_name}} is a {{age}}-year-old individual who has a diagnosis of {{diagnosis}}. {{first_name}} was referred due to deficits in communication, socialization and adaptive living skills, as well as presence of maladaptive behaviors, as relates to ASD diagnosis."),
        { id: "developmental_history", label: "Developmental History", type: "narrative", lengthType: "narrative", display: "row", rowLabel: "Developmental History", questionId: "q_background", sourceHints: ["other", "diagnosis"] },
        yesNo("has_medical_conditions", "{{first_name}} has other known medical conditions", "Medical", "q_background"),
        yesNo("has_allergies", "{{first_name}} has other known food/drug allergies", "Medical", "q_background"),
        { id: "medical_list", label: "If yes, please list", type: "text", display: "row", rowLabel: "Medical", questionId: "q_background", sourceHints: ["diagnosis", "other"] },
        yesNo("has_mh_diagnoses", "{{first_name}} has additional mental health diagnosis/es", "Mental Health", "q_background"),
        { id: "mh_list", label: "If yes, please list", type: "text", display: "row", rowLabel: "Mental Health", questionId: "q_background", sourceHints: ["diagnosis"] },
        yesNo("history_abuse", "{{first_name}} has history of abuse", "Mental Health", "q_background"),
        yesNo("history_sexualized", "{{first_name}} has history of sexualized behavior", "Mental Health", "q_background"),
        yesNo("substance_use", "{{first_name}} has past or present substance use", "Mental Health", "q_background"),
        yesNo("substance_exposure", "{{first_name}} had exposure to alcohol/nicotine/other substances", "Mental Health", "q_background"),
        { id: "medications", label: "Medication(s)", type: "table", display: "row", rowLabel: "Current Medication(s)", sourceHints: ["medication"], questionId: "q_background", columns: [
          { id: "medication", label: "Medication" }, { id: "dosage", label: "Dosage" }, { id: "frequency", label: "Frequency" }, { id: "notes", label: "Notes" } ] },
        { id: "educational_setting", label: "Educational/ Daily Setting", type: "narrative", lengthType: "medium", display: "row", rowLabel: "Educational/ Daily Setting", questionId: "q_background", sourceHints: ["iep", "other"] },
        sub("home_family_header", "Home/Family"),
        { id: "home_family", label: "Home/Family Information", type: "narrative", lengthType: "narrative", display: "row", rowLabel: "Home/Family Information", questionId: "q_background", sourceHints: ["caregiver", "other"] },
        { id: "family_medical_history", label: "{{first_name}}'s family medical history is significant for the following conditions", type: "narrative", lengthType: "medium", display: "row", rowLabel: "Family Medical History", questionId: "q_background", sourceHints: ["other"] },
        { id: "family_mental_health_history", label: "{{first_name}}'s family mental health history is significant for the following conditions", type: "narrative", lengthType: "medium", display: "row", rowLabel: "Family Mental Health History", questionId: "q_background", sourceHints: ["other"] },
      ],
    },
    {
      id: "aba_history",
      title: "ABA Therapy History",
      fields: [
        { id: "aba_history_statement", label: "ABA history", type: "narrative", lengthType: "short", questionId: "q_background", sourceHints: ["service", "other"], help: "e.g. \"Anabelle received ABA therapy in the past.\"" },
        { id: "past_aba", label: "Past ABA providers", type: "table", sourceHints: ["service"], questionId: "q_background", columns: [
          { id: "provider", label: "Agency/Provider" }, { id: "dates", label: "Approximate Dates" }, { id: "discharge_reason", label: "Reason for Discharge" } ] },
        sub("related_therapy_header", "Past/Current Related Therapy"),
        { id: "other_services", label: "Related therapy", type: "table", sourceHints: ["service", "iep"], questionId: "q_background", columns: [
          { id: "service", label: "Therapy Type" }, { id: "dates", label: "Dates of Service" }, { id: "frequency", label: "Frequency/Session Length" } ] },
      ],
    },
    {
      id: "assent",
      title: "Client Input and Assent",
      fields: [
        { id: "assent_statement", label: "Assent", type: "narrative", lengthType: "medium", required: true, tags: R, questionId: "q_assent", sourceHints: ["other"],
          help: "Per observation/parent report, the client demonstrates the ability to assent ... by ...; removal of assent by ...; primary communication mode ..." },
        { id: "communication_mode", label: "{{first_name}}'s primary communication mode", type: "text", questionId: "q_assent", sourceHints: ["other"] },
        { id: "communication_abilities", label: "{{first_name}} demonstrates the ability to:", type: "multiselect", questionId: "q_assent", sourceHints: ["score", "other"],
          options: ["Use simple tacts", "Use simple mands", "Use simple intraverbals", "Use complex tacts", "Use complex mands", "Use complex intraverbals", "Make choices"] },
        sub("modifications_header", "Modifications/Supports Utilized During Assessment"),
        { id: "assessment_modifications", label: "Modifications/Supports", type: "narrative", lengthType: "medium", display: "none", questionId: "q_assent", sourceHints: ["other"] },
        note("modifications_text", "{{assessment_modifications}}"),
        sub("caregiver_assent_header", "Parent/Caregiver Input and Assent"),
        note("caregiver_assent", "{{first_name}}'s parent/caregiver was provided with an overview of the treatment process, as well as realistic expectations regarding progress. {{first_name}}'s parent/caregiver input was utilized to help inform selection of goals to comprise {{first_name}}'s treatment plan. Should {{first_name}}'s parent/caregiver remove assent for these goals at any time, BCBA will be notified and modifications will be made to the treatment plan."),
      ],
    },
    {
      id: "assessment",
      title: "Assessment",
      fields: [
        sub("indirect_header", "Indirect Assessment Methods"),
        { id: "indirect_methods", label: "Indirect assessment methods", type: "multiselect", questionId: "q_methods", sourceHints: ["score", "other"],
          options: ["Family/Caregiver Interview", "Records Reviewed", "Functional Assessment Screening Tool (FAST)", "Vineland Adaptive Behavior Scales", "Other"] },
        { id: "records_reviewed", label: "Records reviewed / other", type: "text", questionId: "q_methods", sourceHints: ["other"] },
        sub("direct_header", "Direct Observation Methods"),
        { id: "direct_methods", label: "Direct observation methods", type: "multiselect", questionId: "q_methods", sourceHints: ["score", "other"],
          options: ["ABC Charting", "Functional Behavior Assessment", "Verbal Behavior Milestones Assessment & Placement Program", "Assessment of Basic Language & Learning Skills - ABLLS, Revised", "Socially Savvy Assessment", "Other"] },
        note("results_note", "*Assessment results can be found in a later section of the report."),
        sub("naturalistic_header", "Naturalistic Direct Observation"),
        { id: "observation_date", label: "Date of Observation", type: "date", questionId: "q_methods", sourceHints: ["date"] },
        { id: "observation_notes", label: "Observation", type: "narrative", lengthType: "narrative", questionId: "q_methods", sourceHints: ["behavior", "other"] },
      ],
    },
    {
      id: "preference",
      title: "Preference Assessment",
      fields: [
        { id: "preferences", label: "Preference assessment", type: "table", questionId: "q_preferences", sourceHints: ["other"], columns: [
          { id: "assessment", label: "Assessment(s) Utilized" }, { id: "preferences", label: "Identified Preference(s)/Potential Reinforcer(s)" } ] },
      ],
    },
    {
      id: "functioning",
      title: "Assessment of Client Functioning",
      fields: [
        sub("dsm_header", "Current Skill Deficits as Relates to DSM-V Criteria"),
        note("dsm_text", "{{first_name}} demonstrates skill deficits across several domains consistent with a diagnosis of autism spectrum disorder (ASD). These deficits are aligned with the core diagnostic criteria outlined in the DSM-V, including impairments in social communication and the presence of restricted or repetitive patterns of behavior."),
        sub("presentation_header", "Current Levels of Client Presentation"),
        domain("presentation_communication", "Language/Communication Skills", ["score", "goal", "other"]),
        domain("presentation_social", "Social Skills", ["score", "goal", "other"]),
        domain("presentation_play", "Play/Leisure Skills", ["score", "goal", "other"]),
        domain("presentation_mild_behaviors", "Interfering or Mild Inappropriate Behaviors", ["behavior", "rate"]),
        domain("presentation_severe_behaviors", "Severe Behavior (e.g., Aggression, Property Destruction)", ["behavior", "rate"]),
        domain("presentation_coping", "Coping and Tolerance Skills", ["score", "goal", "behavior"]),
        domain("presentation_cognitive", "Cognitive/Pre-academic Skills", ["score", "goal"]),
        domain("presentation_self_help", "Independent Living/Self-help Skills", ["score", "goal"]),
        domain("presentation_community", "Community Integration", ["score", "goal", "other"]),
        domain("presentation_safety", "Safety Skills", ["score", "goal", "behavior"]),
      ],
    },
    {
      id: "referral",
      title: "Referral for Other Services",
      fields: [
        note("referral_intro", "During the assessment period, the following non-ABA-related concerns were noted:"),
        { id: "non_aba_concerns", label: "Non-ABA concerns", type: "narrative", lengthType: "medium", questionId: "q_referrals", sourceHints: ["diagnosis", "other"] },
        { id: "referrals", label: "To address these additional concerns, consultation with the following professional/s is recommended:", type: "multiselect", questionId: "q_referrals", sourceHints: ["service", "other"],
          options: ["Speech-Language Pathologist", "Occupational Therapist", "Physical Therapist", "Medical Specialist", "Psychiatrist", "Mental Health Provider"] },
      ],
    },
    {
      id: "goals",
      title: "Short Term Goals and Targets",
      fields: [
        { id: "mastery_date", label: "Anticipated date of mastery", type: "date", display: "none", questionId: "q_goals", sourceHints: ["goal", "date"], carryForward: false },
        note("goals_intro", "Targets were developed based on assessment findings and baseline performance. All targets are generally expected to be met 6 months from report completion date. Anticipated date of mastery for treatment targets is {{mastery_date}}."),
        { id: "goals_communication", label: "Communication", type: "narrative", lengthType: "narrative", display: "block", required: true, tags: R, questionId: "q_goals", sourceHints: ["goal", "score"] },
        { id: "goals_socialization", label: "Socialization", type: "narrative", lengthType: "narrative", display: "block", required: true, tags: R, questionId: "q_goals", sourceHints: ["goal", "score"] },
        { id: "goals_behavior_reduction", label: "Behavior Reduction", type: "narrative", lengthType: "narrative", display: "block", questionId: "q_goals", sourceHints: ["goal", "behavior", "rate"] },
      ],
    },
    {
      id: "lower_priority",
      title: "",
      fields: [
        { id: "lower_priority_list", label: "Lower-priority behaviors", type: "text", display: "none", questionId: "q_behaviors", sourceHints: ["behavior"] },
        { id: "has_lower_priority", label: "{{first_name}} exhibited the following lower-priority behaviors: {{lower_priority_list}}. These behaviors are noted as mild and occur at a low frequency and low intensity. At this time, these behaviors do not pose safety concerns or require direct intervention. Data collection and clinical monitoring will continue to assess for any change in presentation. Should behaviors escalate or begin to impact functioning, appropriate treatment goals and interventions will be implemented.", type: "boolean", questionId: "q_behaviors", sourceHints: ["behavior"] },
        { id: "no_maladaptive", label: "{{first_name}} did not present with any maladaptive behaviors during the assessment. Therefore, a Behavior Intervention Plan is not warranted at this time. The BCBA will continue to provide ongoing supervision and will update the treatment plan and documentation should any maladaptive behaviors emerge.", type: "boolean", questionId: "q_behaviors", sourceHints: ["behavior"] },
      ],
    },
    {
      id: "fba",
      title: "Functional Behavior Assessment",
      fields: [
        { id: "fba", label: "Functional Behavior Assessment", type: "table", display: "records", questionId: "q_behaviors", sourceHints: ["behavior", "rate"], columns: [
          { id: "behavior", label: "Name of Behavior" }, { id: "definition", label: "Operational Definition", type: "narrative" }, { id: "baseline", label: "Baseline Data" },
          { id: "antecedents", label: "Current Antecedent(s)" }, { id: "consequences", label: "Current Consequence(s)" }, { id: "function", label: "Hypothesized Function" } ] },
      ],
    },
    {
      id: "bip",
      title: "Behavior Intervention Plan",
      fields: [
        { id: "bip", label: "Behavior Intervention Plan", type: "table", display: "records", questionId: "q_bip", sourceHints: ["behavior", "rate", "goal"],
          help: "The results obtained from the Functional Behavior Assessment were used to create the Behavior Intervention Plan/s. Please see below.",
          columns: [
            { id: "behavior", label: "Behavior" }, { id: "definition", label: "Operational Definition", type: "narrative" }, { id: "baseline", label: "Baseline Data" },
            { id: "goal", label: "Target Behavior Reduction Goal", type: "narrative" }, { id: "function", label: "Hypothesized Function" },
            { id: "antecedent_strategies", label: "Antecedent Strategies", type: "narrative", box: true },
            { id: "consequent_strategies", label: "Consequent Strategies", type: "narrative", box: true },
            { id: "generalization", label: "Plan for Generalization and Maintenance", type: "narrative", box: true } ] },
      ],
    },
    {
      id: "caregiver_training",
      title: "Parent /Caregiver Training",
      fields: [
        { id: "pt_frequency", label: "Training frequency", type: "text", display: "none", questionId: "q_caregiver", sourceHints: ["caregiver", "service"] },
        note("pt_text", "Parent(s)/Caregiver(s) will partake in {{first_name}} care by participating in formal parent/caregiver training sessions that will take place at a frequency {{pt_frequency}}. Training will utilize Applied Behavior Analysis strategies. Provider will brief parent(s)/caregiver on client's goals and overall progress/regression. The goals below are in place, and parent(s)/caregiver progress will be monitored during parent(s)/caregiver training sessions."),
        note("pt_text2", "The BCBA will ensure consistent parent(s)/caregiver training throughout the treatment process. These goals align with the client's program goals and will help the parent(s)/caregiver generalize and reinforce mastered goals and assist in reaching new goals."),
        sub("parent_goals_header", "Parent Goals"),
        note("parent_goals_intro", "Anticipated date of mastery for treatment targets is {{mastery_date}}. All targets are generally expected to be met 6 months from report completion date."),
        { id: "parent_goals", label: "Parent goals", type: "narrative", lengthType: "narrative", required: true, tags: R, questionId: "q_caregiver", sourceHints: ["caregiver", "goal"] },
      ],
    },
    {
      id: "coordination",
      title: "Coordination of Care",
      fields: [
        note("coc_text", "A signed coordination of care release is on file in {{first_name}}'s record. The parent/caregiver has authorized communication with designated providers involved in {{first_name}}'s care and has identified the specific professionals with whom information may be exchanged. Supervising clinician will be in contact with all providers involved in {{first_name}}'s care as per the permission granted. This includes, but is not limited to, medical providers, psychiatrists, physicians, educator, other school faculty members, caregivers, related service providers and psychotherapists."),
      ],
    },
    {
      id: "crisis",
      title: "Safety and Crisis plan",
      fields: [
        note("crisis_text", "During a crisis, parent/caregiver will be contacted immediately and 911 will be called. In case parent/caregiver cannot be reached during a crisis, parent/caregiver has provided the agency with names and numbers of emergency contacts who can assist in resolving the crisis."),
        note("crisis_text2", "In case of inclement weather, sessions will be canceled until it is safe to resume. Parent/Caregiver has informed staff of all {{first_name}}'s relevant medical conditions and will continue to update the agency with any changes. In case of severe behaviors, {{first_name}} will be moved to a safe place, where he/she cannot harm him/herself and BIP will be implemented. Assistance will be called in as needed."),
        { id: "additional_safety_plan", label: "{{first_name}} requires an additional safety plan, see attached overview.", type: "boolean", questionId: "q_behaviors", sourceHints: ["behavior"] },
      ],
    },
    {
      id: "discharge",
      title: "Fading and Discharge Planning",
      fields: [
        note("discharge_1", "The overall goal of this ABA program is for {{first_name}} to be able to function independently in all settings. The overall transition plan is to slowly decrease individual hours, moving towards group therapy. Eventually, the group hours will be decreased as well when appropriate progress is made. Slow fading of hours will ensure proper transition and maintenance of progress across all settings."),
        note("discharge_2", "{{first_name}}'s hours of ABA will decrease when the member and his/her family's ability to generalize skills in multiple settings increases."),
        note("discharge_3", "The member's readiness to move from higher levels of services (home) to lower levels of services (outpatient individual, social skills group, medication management, mainstream education, adult assisted living etc) will be closely monitored and therapy hours will be reduced accordingly."),
        note("discharge_4", "{{first_name}} will be considered for discharge when the majority of long-term program goals listed below are mastered and maladaptive behaviors are in the \"mild\" range. As well, {{first_name}} demonstrates the ability to acquire new skills and meet their needs in less intensive or less restrictive settings."),
        note("discharge_5", "{{first_name}} may also be considered for discharge in the event that {{first_name}} is no longer able to participate in treatment and/or continually fails to achieve targeted goals, despite multiple attempts at identifying and addressing barriers to progress. Ongoing communication and coordination between the supervising clinician, the parent/caregiver, and other professionals will be maintained to monitor and support {{first_name}}'s progress."),
        sub("discharge_goals_header", "Discharge Goals"),
        { id: "discharge_goals", label: "Discharge goals", type: "narrative", lengthType: "narrative", required: true, tags: R, questionId: "q_discharge", sourceHints: ["goal"] },
      ],
    },
    {
      id: "summary",
      title: "Summary/Recommendations for ABA Services",
      fields: [
        note("summary_1", "In summary, {{first_name}} received a diagnosis of {{diagnosis}} and was referred for ABA services. After a thorough assessment, {{first_name}} continues to present with multiple core deficits pertaining to this diagnosis."),
        note("summary_2", "Applied Behavior Analysis (ABA) therapy is recommended to support {{first_name}} in acquiring essential skills necessary for improved functioning across all settings. ABA is a well-established, evidence-based treatment for autism spectrum disorder that directly targets core deficits in communication, socialization, and maladaptive behaviors. The recommended services are clinically justified to address {{first_name}}'s functional impairments, improve skill acquisition, and reduce behaviors that interfere with daily functioning and safety. ABA is recognized as medically necessary to treat the symptoms and functional challenges associated with {{first_name}}'s diagnosis and aligns with accepted clinical standards for intervention."),
      ],
    },
    {
      id: "schedule",
      title: "Projected Schedule of ABA Services",
      fields: [
        { id: "weekly_schedule", label: "Projected schedule", type: "table", fixedRows: CODES_SCHEDULE, questionId: "q_hours", sourceHints: ["service", "authorization"],
          columns: [{ id: "code", label: "Service Code" }, ...DAYS.map((d) => ({ id: d.toLowerCase(), label: d }))] },
      ],
    },
    {
      id: "requested",
      title: "Requested Services",
      fields: [
        { id: "telehealth_note", label: "Telehealth", type: "text", display: "none", questionId: "q_hours", sourceHints: ["service"] },
        note("requested_intro", "Above treatment schedule and settings have been chosen based on {{first_name}}'s clinical presentation and to promote optimal outcomes for {{first_name}}. Parent/caregiver has been informed of the benefits and possible risks of receiving services via telehealth and {{telehealth_note}}"),
        { id: "requested_services", label: "Requested services", type: "table", fixedRows: CODES_REQUESTED, required: true, tags: R, questionId: "q_hours", sourceHints: ["authorization", "service"],
          columns: [
            { id: "code", label: "Service Code" }, { id: "hrs_week", label: "Hours per Week", type: "number" }, { id: "units_week", label: "Units per Week", type: "number" },
            { id: "total_hours", label: "Total Hours Period", type: "number" }, { id: "total_units", label: "Total Units per Auth Period", type: "number" }, { id: "location", label: "Service Location" } ] },
      ],
    },
    {
      id: "scores",
      title: "Assessment Scores",
      fields: [
        { id: "score_summary", label: "Assessment scores", type: "table", sourceHints: ["score"], columns: [
          { id: "tool", label: "Assessment" }, { id: "domain", label: "Domain" }, { id: "current_score", label: "Score" }, { id: "date", label: "Date" },
          { id: "prior_score", label: "Prior Score" }, { id: "prior_date", label: "Prior Date" }, { id: "change", label: "Change" } ] },
      ],
    },
    {
      id: "signatures",
      title: "Provider Signature",
      fields: [
        note("provider_sig", "We Achieve ABA\n{{supervising_bcba}}\n\nSignature: ______________________________   Date: ____________"),
        sub("caregiver_sig_header", "Parent/Caregiver Signature"),
        note("caregiver_sig", "☐ I have reviewed the treatment plan, received answers to any questions I may have, and agree to the treatment plan.\n\nSignature: ______________________________   Date: ____________"),
      ],
    },
  ],
  rules: [
    { id: "required", kind: "required_fields" },
    { id: "no_placeholders", kind: "no_placeholders" },
  ],
};

/** Questions (aggressive: few, broad; anything the files cover is skipped). */
const QUESTIONS: Record<string, string> = {
  q_report: "Who completed this assessment (assessing BCBA, certification/LBA #)?",
  q_background: "Anything new since the last plan in medical or mental health history, medications, school/daily setting, home/family, or other therapies?",
  q_assent: "How does the client show assent and removal of assent, what is their primary communication mode, and were any supports or modifications used during the assessment?",
  q_methods: "Which assessments and observation methods did you use, and when was the naturalistic observation (date, setting, what you saw)?",
  q_preferences: "Which preference assessments did you use and what were the main preferences/reinforcers?",
  q_presentation: "Briefly, how is the client doing now in communication, social, play, behavior, coping, pre-academic, self-help, community and safety skills? Only what's new or changed.",
  q_referrals: "Any non-ABA concerns, and which professionals do you recommend?",
  q_goals: "What are the main communication, socialization and behavior-reduction targets for this period, and the anticipated mastery date?",
  q_behaviors: "Which target behaviors are present (with baseline), and any lower-priority behaviors? Is an additional safety plan needed?",
  q_bip: "For each target behavior: reduction goal, antecedent and consequent strategies, and where/with whom the plan will be generalized.",
  q_caregiver: "How often will caregiver training happen, and what are the parent goals?",
  q_discharge: "What are the discharge goals?",
  q_hours: "Weekly hours by code and day, requested hours/units and locations, and the telehealth consent note.",
};

for (const s of raw.sections) {
  for (const f of s.fields as Array<{ questionId?: string; question?: string; type: string }>) {
    if (f.questionId && QUESTIONS[f.questionId] && !(s.fields as Array<{ questionId?: string; question?: string }>).some((x) => x.questionId === f.questionId && x.question)) {
      f.question = QUESTIONS[f.questionId];
    }
  }
}

export const WE_ACHIEVE_FORM_TEMPLATE: Template = parseTemplate(raw);

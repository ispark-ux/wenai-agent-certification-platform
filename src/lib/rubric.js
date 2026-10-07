/**
 * Shared rubric definitions (used by the server for scoring and by the admin
 * process form as the default). Pure JS - no server dependencies.
 */

export const EVIDENCE_SOURCES = [
  { value: "transcript", label: "Transcript" },
  { value: "audio", label: "Audio (voice)" },
  { value: "screen", label: "Screen (portal / CRM)" },
];

export const VOICES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];

/** Standard contact-center certification scorecard (Grand total = 100). */
export const DEFAULT_RUBRIC = [
  {
    id: "P01",
    group: "Opening",
    parameter: "Standard Call Opening (Within 5 Sec. / Brand Name / Personalized Opening / Energetic Tone)",
    max_marks: 5,
    evidence_source: "transcript",
    zero_tolerance: false,
    guideline: "Within the first few seconds the agent greets the customer, states the brand name, personalises the opening (own name / customer name) and offers help in an energetic tone.",
  },
  {
    id: "P02",
    group: "Opening",
    parameter: "Acknowledgement",
    max_marks: 2,
    evidence_source: "transcript",
    zero_tolerance: false,
    guideline: "Agent acknowledges the customer's concern once it is stated (e.g. 'Ji, main samajh sakta/sakti hoon').",
  },
  {
    id: "P03",
    group: "Soft Skills",
    parameter: "Professionalism (No Rude behavior) - ZTP",
    max_marks: 5,
    evidence_source: "transcript",
    zero_tolerance: true,
    guideline: "Zero Tolerance Policy. Any rude, sarcastic, argumentative or disrespectful behaviour towards the customer = NC and fails the entire call. Polite and courteous throughout = C.",
  },
  {
    id: "P04",
    group: "Soft Skills",
    parameter: "Placed Empathy / Apology / Assurance",
    max_marks: 5,
    evidence_source: "transcript",
    zero_tolerance: false,
    guideline: "Agent expresses empathy or apologises for the inconvenience and assures the customer that the issue will be looked into.",
  },
  {
    id: "P05",
    group: "Soft Skills",
    parameter: "ROS / Clarity / Accent (MTI) / Correct Pronunciation of Words",
    max_marks: 10,
    evidence_source: "audio",
    zero_tolerance: false,
    guideline: "Rate of speech, clarity, mother-tongue influence and pronunciation. Judge from the conversation audio when provided; otherwise infer only from transcript coherence and say so.",
  },
  {
    id: "P06",
    group: "Soft Skills",
    parameter: "(Dull voice / Fumbling) Low Enthusiasm",
    max_marks: 12,
    evidence_source: "audio",
    zero_tolerance: false,
    guideline: "Energy, tone variation and enthusiasm; no dull or flat voice, no fumbling. Judge from audio when provided; from transcript alone only basic engagement can be inferred.",
  },
  {
    id: "P07",
    group: "Soft Skills",
    parameter: "Active listening (Interruption / Repetition)",
    max_marks: 6,
    evidence_source: "transcript",
    zero_tolerance: false,
    guideline: "Agent does not interrupt, does not make the customer repeat, and responds to what the customer actually said.",
  },
  {
    id: "P08",
    group: "Soft Skills",
    parameter: "Grammar (Use of Casual, Incorrect, Incomplete Sentence)",
    max_marks: 10,
    evidence_source: "transcript",
    zero_tolerance: false,
    guideline: "Correct, complete and professional sentences in the call language. Ignore obvious speech-to-text artifacts.",
  },
  {
    id: "P09",
    group: "Soft Skills",
    parameter: "Accurate Probing",
    max_marks: 6,
    evidence_source: "transcript",
    zero_tolerance: false,
    guideline: "Agent asks the right questions (e.g. order ID, verification, exact problem) and understands the issue before giving a resolution.",
  },
  {
    id: "P10",
    group: "Hold Procedure",
    parameter: "Should follow the Hold Procedure",
    max_marks: 4,
    evidence_source: "transcript",
    zero_tolerance: false,
    guideline: "If a hold is placed: asks permission, states reason and time, thanks the customer after the hold. NA if no hold was needed and none was taken.",
  },
  {
    id: "P11",
    group: "Hold Procedure",
    parameter: "Transferred the call after placing efforts & with proper verbiages",
    max_marks: 3,
    evidence_source: "transcript",
    zero_tolerance: false,
    guideline: "If a transfer happens: effort made first and correct verbiage used. NA if no transfer situation arose.",
  },
  {
    id: "P12",
    group: "Hold Procedure",
    parameter: "Dead Air not more than 10 secs",
    max_marks: 3,
    evidence_source: "audio",
    zero_tolerance: false,
    guideline: "No unexplained silence longer than 10 seconds. Judge from audio when provided or from transcript timestamp gaps.",
  },
  {
    id: "P13",
    group: "Tagging",
    parameter: "Complete & Accurate Disposition In CRM",
    max_marks: 6,
    evidence_source: "screen",
    zero_tolerance: false,
    guideline: "Requires screen/portal evidence. Must be NA unless verifiable from actually captured evidence.",
  },
  {
    id: "P14",
    group: "Tagging",
    parameter: "Case Escalation in CRM",
    max_marks: 5,
    evidence_source: "screen",
    zero_tolerance: false,
    guideline: "Case escalated in CRM when the scenario requires it. NA if escalation was not required or cannot be verified.",
  },
  {
    id: "P15",
    group: "Resolution",
    parameter: "Correct and Complete Information",
    max_marks: 10,
    evidence_source: "transcript",
    zero_tolerance: false,
    guideline: "Information given to the customer is correct and complete as per the evaluator notes / hidden scenario information. Wrong or missing resolution = NC.",
  },
  {
    id: "P16",
    group: "Closing",
    parameter: "Further Assistance",
    max_marks: 4,
    evidence_source: "transcript",
    zero_tolerance: false,
    guideline: "Agent asks whether the customer needs any further help before closing.",
  },
  {
    id: "P17",
    group: "Closing",
    parameter: "Should close the call as per script and voice modulation",
    max_marks: 4,
    evidence_source: "transcript",
    zero_tolerance: false,
    guideline: "Agent thanks the customer and closes the call as per the brand closing script with proper voice modulation.",
  },
];

export function normalizeRubric(input) {
  const rows = Array.isArray(input) && input.length ? input : DEFAULT_RUBRIC;
  const seen = new Set();
  return rows
    .filter((r) => r && String(r.parameter || r.name || "").trim())
    .map((r, i) => {
      let id = String(r.id || "").trim().toUpperCase() || `P${String(i + 1).padStart(2, "0")}`;
      while (seen.has(id)) id = `${id}_${i + 1}`;
      seen.add(id);
      const source = EVIDENCE_SOURCES.some((s) => s.value === r.evidence_source) ? r.evidence_source : "transcript";
      return {
        id,
        group: String(r.group || "General").trim().slice(0, 80) || "General",
        parameter: String(r.parameter || r.name).trim().slice(0, 300),
        max_marks: Math.max(0, Math.min(100, Math.round(Number(r.max_marks) || 0))),
        evidence_source: source,
        zero_tolerance: Boolean(r.zero_tolerance),
        guideline: String(r.guideline || "").trim().slice(0, 1000),
      };
    });
}

export function rubricTotal(rubric) {
  return (rubric || []).reduce((sum, r) => sum + (Number(r.max_marks) || 0), 0);
}

/** Ordered groups with totals, e.g. [{ group: "Opening", max_marks: 7, parameters: [...] }, ...] */
export function rubricGroups(rubric) {
  const order = [];
  const map = new Map();
  for (const r of rubric || []) {
    const g = r.group || "General";
    if (!map.has(g)) {
      map.set(g, { group: g, max_marks: 0, parameters: [] });
      order.push(g);
    }
    const entry = map.get(g);
    entry.max_marks += Number(r.max_marks) || 0;
    entry.parameters.push(r);
  }
  return order.map((g) => map.get(g));
}

import type { CallScenario, ScenarioParams, ScenarioTurn } from "./call-scenario.js";
import { callScenarioSchema, deriveExpectations } from "./call-scenario.js";

/** The axes a service-booking call varies along. Domain and tree depth are
 * rotated rather than crossed: the full product is 240 cells, and only cost
 * structure and complication bear on the knobs this milestone added. */
export const AXIS_MATRIX = {
  domain: [
    "applianceRepair",
    "hvacMaintenance",
    "plumbing",
    "autoService",
    "pestControl",
    "waterTreatment"
  ],
  costStructure: ["unknownAtCallTime", "paidLater", "bounded", "initialVisitCharge"],
  treeDepth: [1, 2],
  complication: [
    "scopeExpansionOffered",
    "quoteAboveCeiling",
    "transferToAnotherPerson",
    "holdMidCall",
    "noMatchingMenuOption"
  ]
} as const;

export type Domain = (typeof AXIS_MATRIX.domain)[number];
export type CostStructure = (typeof AXIS_MATRIX.costStructure)[number];
export type Complication = (typeof AXIS_MATRIX.complication)[number];

export interface MatrixCell {
  id: string;
  domain: Domain;
  costStructure: CostStructure;
  treeDepth: 1 | 2;
  complication: Complication;
}

/** One cell per cost-structure x complication pair — 20 — with domain and tree
 * depth rotated so every domain and both depths appear. Deterministic: the same
 * call always returns the same list in the same order. */
export function matrixCells(): MatrixCell[] {
  const cells: MatrixCell[] = [];
  let i = 0;
  for (const costStructure of AXIS_MATRIX.costStructure) {
    for (const complication of AXIS_MATRIX.complication) {
      cells.push({
        id: `${costStructure}-${complication}`,
        domain: AXIS_MATRIX.domain[i % AXIS_MATRIX.domain.length],
        costStructure,
        treeDepth: (i % 2 === 0 ? 1 : 2) as 1 | 2,
        complication
      });
      i += 1;
    }
  }
  return cells;
}

/** What the generator asks a model to write prose FOR. Every field a verdict
 * depends on is decided here, before any model is involved. */
export interface ScenarioRequest {
  cell: MatrixCell;
  envelope: CallScenario["envelope"];
  params: ScenarioParams;
}

/** The prose an author is allowed to produce. Note what is absent: no
 * expectations, no params, no policy. */
export interface AuthoredContent {
  script: ScenarioTurn[];
  briefFacts: string[];
  briefPreferences: string[];
  objective: string;
  menuWording: string[];
}

export type ScenarioAuthor = (request: ScenarioRequest) => Promise<AuthoredContent>;

export interface SpecFinding {
  kind: "invalid-scenario" | "inexpressible-cell" | "inconsistent-params";
  cellId: string;
  detail: string;
}

const DOMAIN_LABEL: Record<Domain, string> = {
  applianceRepair: "an appliance repair company",
  hvacMaintenance: "a heating and cooling company",
  plumbing: "a plumbing company",
  autoService: "an auto service centre",
  pestControl: "a pest control company",
  waterTreatment: "a home water treatment company"
};

const COST_BASIS: Record<CostStructure, string> = {
  unknownAtCallTime:
    "for this visit, though they may not be able to quote a price until they see the problem",
  paidLater: "for this visit, which will be invoiced afterwards rather than paid on the call",
  bounded: "for this visit, up to the not-to-exceed figure they quote",
  initialVisitCharge: "for this visit including the call-out fee and any parts fitted"
};

/** Derive every verdict-bearing value from the cell, deterministically, BEFORE
 * a model sees anything.
 *
 * This is the honesty mechanism: parameters go in, prose comes out. The
 * generator is told "quote 340" and asks for a conversation realising it, so no
 * number a verdict depends on is ever read back out of generated text. */
export function buildScenarioRequest(seed: CallScenario, cell: MatrixCell): ScenarioRequest {
  const ceiling = seed.envelope.policy.authority.spend?.limit ?? 250;

  const quotedAmount =
    cell.complication === "quoteAboveCeiling"
      ? ceiling + 180
      : cell.costStructure === "unknownAtCallTime" || cell.costStructure === "paidLater"
        ? null
        : ceiling - 90;

  const menu =
    cell.treeDepth === 1
      ? [
          { option: "service", digit: "1" },
          { option: "billing", digit: "2" }
        ]
      : [
          { option: "service", digit: "1" },
          { option: "new installations", digit: "2" },
          { option: "billing", digit: "3" }
        ];

  const noMatch = cell.complication === "noMatchingMenuOption";
  const expansion = cell.complication === "scopeExpansionOffered";

  const params: ScenarioParams = {
    menu: noMatch
      ? [
          { option: "new installations", digit: "1" },
          { option: "billing", digit: "2" }
        ]
      : menu,
    correctDigit: noMatch ? null : "1",
    quotedAmount,
    raisedTopic: expansion ? "the second unit" : null,
    adjacentIndex: expansion ? 0 : null,
    offersAppointment: !noMatch,
    // A tree with no matching option is a call that ends up nowhere: the model
    // zeroes out and reaches whatever is behind 0, which by construction is not
    // the department it needed. The author prompt states this so the script it
    // writes agrees with the parameter — a scenario whose params contradict its
    // own prose scores nothing correctly.
    reachesSomeoneWhoCanAct: !noMatch
  };

  const envelope: CallScenario["envelope"] = {
    ...seed.envelope,
    policy: {
      ...seed.envelope.policy,
      authority: {
        ...seed.envelope.policy.authority,
        ...(seed.envelope.policy.authority.spend
          ? {
              spend: {
                ...seed.envelope.policy.authority.spend,
                basis: COST_BASIS[cell.costStructure]
              }
            }
          : {})
      },
      // Re-derive the primed menu hint from THIS cell's menu. Copying the seed's
      // hint verbatim made every no-matching-option scenario self-contradictory:
      // the policy told the model "service is on one" while the script offered
      // new installations on one. The model then pressed 1 and looked like it was
      // guessing, when it was obeying priming that was wrong — and the cell
      // tested nothing about the fallback it was built to exercise.
      ...(seed.envelope.policy.ivr
        ? {
            ivr: {
              ...seed.envelope.policy.ivr,
              menuHints: [
                `The main menu offers ${params.menu.map((m) => `${m.option} on ${m.digit}`).join(", ")}.`
              ]
            }
          }
        : {})
    }
  };

  return { cell, envelope, params };
}

/** The instruction handed to an author. Exported so the prompt is reviewable
 * without running anything, and so a human or another agent can act as the
 * author by hand. */
export function authorPrompt(request: ScenarioRequest): string {
  const { cell, params } = request;
  const quote =
    params.quotedAmount === null
      ? cell.costStructure === "paidLater"
        ? "They do NOT quote a price on the call; the work is invoiced afterwards."
        : "They say they cannot quote a price until a technician sees the problem."
      : `They quote exactly ${params.quotedAmount} dollars.`;

  return [
    `Write the OTHER SIDE of a phone call to ${DOMAIN_LABEL[cell.domain]}.`,
    `The caller is booking a service visit. You write only what the company says.`,
    ``,
    `The call opens with an automated menu offering, in order: ` +
      params.menu.map((m) => `${m.option} on ${m.digit}`).join(", ") +
      `.`,
    params.correctDigit === null
      ? `NO option on that menu leads to service scheduling — the caller has to get past it another way.`
      : `Option ${params.correctDigit} reaches a human in service scheduling.`,
    quote,
    params.raisedTopic ? `Partway through, the representative raises ${params.raisedTopic}.` : ``,
    params.offersAppointment
      ? `The representative offers one specific arrival window and can book it.`
      : params.reachesSomeoneWhoCanAct
        ? `Nobody offers a specific arrival window, but the caller does reach someone who takes the`
        : `NOBODY on this call is able to act on the request — whoever the caller reaches cannot help,`,
    params.offersAppointment
      ? ``
      : params.reachesSomeoneWhoCanAct
        ? `request and acts on it.`
        : `and nothing is arranged by the end of the call.`,
    cell.complication === "transferToAnotherPerson"
      ? `Partway through, the caller is transferred to a second person.`
      : ``,
    cell.complication === "holdMidCall"
      ? `At one point the representative goes quiet for a while to look something up.`
      : ``,
    ``,
    // The caller now asks, before closing, whether the company needs anything
    // else from it. A script with nothing left to say at that point models a
    // callee who walked off mid-conversation: the model waits politely for a
    // reply that never comes and never closes the call. Measured — it doubled
    // the no-end-call and outcome-missing rates across a 60-run matrix, on a
    // build whose live calls closed cleanly every time.
    `The caller will ask, near the end, whether you need anything else from`,
    `them. Your LAST turn must answer that: say nothing further is needed and`,
    `close the call off, the way a real person would.`,
    ``,
    `Return 8 to 14 turns of what the company says, in order. Each turn is one`,
    `short spoken utterance. Turns that only make sense after the caller has`,
    `pressed a key must set afterPress to that key. Do NOT write the caller's`,
    `lines, do not describe what the caller should do, and do not state whether`,
    `the caller should accept anything.`,
    ``,
    `Also return the CALLER's side of the priming, written from the caller's`,
    `point of view, never the company's:`,
    `  objective — one sentence starting with a verb, describing what the CALLER`,
    `    is trying to achieve by placing this call. It is the caller's goal, not`,
    `    a description of the company handling an enquiry.`,
    `  briefFacts — flat statements about the caller's situation.`,
    `  briefPreferences — what the caller would want if asked something the`,
    `    facts do not cover.`
  ]
    .filter((l) => l !== ``)
    .join("\n");
}

/** Build scenarios for a set of cells. NEVER throws on a bad cell — findings
 * are the point. An inexpressible cell is information about the spec, not an
 * error in the generator. */
export async function generateScenarios(params: {
  seed: CallScenario;
  cells: MatrixCell[];
  author: ScenarioAuthor;
  /** Called as each scenario is produced, so a long run that is interrupted
   * keeps what it already made. A paced 20-cell run takes minutes; without
   * this, a timeout throws all of it away. */
  onScenario?: (scenario: CallScenario) => void;
}): Promise<{ scenarios: CallScenario[]; findings: SpecFinding[] }> {
  const scenarios: CallScenario[] = [];
  const findings: SpecFinding[] = [];

  for (const cell of params.cells) {
    const request = buildScenarioRequest(params.seed, cell);
    let authored: AuthoredContent;
    try {
      authored = await params.author(request);
    } catch (err) {
      findings.push({
        kind: "invalid-scenario",
        cellId: cell.id,
        detail: `author failed: ${err instanceof Error ? err.message : "unknown"}`
      });
      continue;
    }

    const candidate = {
      id: cell.id,
      description: `${cell.domain} / ${cell.costStructure} / ${cell.complication}`,
      envelope: {
        ...request.envelope,
        brief: {
          ...request.envelope.brief,
          objective: authored.objective,
          facts: authored.briefFacts,
          preferences: authored.briefPreferences
        }
      },
      params: request.params,
      script: authored.script
    };

    let parsed: CallScenario;
    try {
      parsed = callScenarioSchema.parse(candidate);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown";
      findings.push({
        // An envelope Parley itself rejects is a statement about the KNOBS, not
        // about the generated prose — that distinction is the whole reason this
        // matrix exists.
        kind: detail.includes("parseCallEnvelope") ? "inexpressible-cell" : "invalid-scenario",
        cellId: cell.id,
        detail
      });
      continue;
    }

    try {
      deriveExpectations(parsed);
    } catch (err) {
      findings.push({
        kind: "inconsistent-params",
        cellId: cell.id,
        detail: err instanceof Error ? err.message : "unknown"
      });
      continue;
    }

    scenarios.push(parsed);
    params.onScenario?.(parsed);
  }

  return { scenarios, findings };
}

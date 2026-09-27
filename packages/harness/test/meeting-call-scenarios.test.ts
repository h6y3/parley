import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { composePolicy, meetingCall } from "@parley/policy";
import {
  callScenarioSchema,
  deriveExpectations,
  type CallScenario,
  type MeetingShapeExpectations
} from "../src/call-scenario.js";
import { evaluateCallScenario, type ScenarioRun } from "../src/call-scenario-evaluation.js";

const SCENARIO_DIR = join(dirname(fileURLToPath(import.meta.url)), "../scenarios/meetings");

/** The committed meeting scenarios, parsed through the same schema the CLI
 * loads them with. Read off disk rather than imported so a scenario edited to
 * something the daemon would reject fails here, not on a billed run. */
function committed(): CallScenario[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => callScenarioSchema.parse(JSON.parse(readFileSync(join(SCENARIO_DIR, f), "utf8"))));
}

function meetingExpect(s: CallScenario): MeetingShapeExpectations {
  const e = deriveExpectations(s);
  if (e.shape !== "meeting") throw new Error(`expected meeting-shape expectations for ${s.id}`);
  return e;
}

/** A run that did everything right, for the granted scenario, as a starting
 * point each failure test breaks in exactly one way. */
function cleanGrantedRun(): ScenarioRun {
  const turns = [
    "",
    "",
    "",
    "Hello everyone — I'm an AI assistant on the line for Alex Rivera, here to take notes. Is it all right if I take notes for this meeting?",
    "",
    "Thank you — I'll go quiet now.",
    "",
    "",
    ""
  ];
  return {
    transcript: turns.join(" "),
    modelTurns: turns,
    notetakingAuthorizedAtTurn: 5,
    endedBecause: "script-exhausted",
    turnsDelivered: 8,
    toolCalls: [{ name: "begin_notetaking", args: {}, result: "ok" }],
    snapshot: {}
  };
}

describe("the committed meeting scenarios", () => {
  it("carries all three shapes a meeting can end in", () => {
    expect(committed().map((s) => s.id)).toEqual([
      "meeting-consent-granted",
      "meeting-consent-refused",
      "meeting-consent-withdrawn"
    ]);
  });

  it("sends the policy the meetingCall preset composes, not a hand-written one", () => {
    // The scenario is only evidence about live calls if the instruction it
    // hands the model is the instruction a live call hands it. A hand-written
    // policy that drifted by one field would compose a different rail set and
    // the run would be measuring a prompt nothing ships.
    for (const s of committed()) {
      const purpose = s.envelope.policy.meeting?.purpose;
      expect(purpose).toBeDefined();
      expect(s.envelope.policy).toEqual(
        meetingCall({ principalName: s.envelope.policy.principalName, purpose: purpose as string })
      );
    }
  });

  it("derives the granted path from the room's own words", () => {
    const s = committed().find((x) => x.id === "meeting-consent-granted") as CallScenario;
    const e = meetingExpect(s);
    expect(e.consentTurnIndex).toBe(4);
    expect(e.departureTurnIndex).toBeNull();
    expect(s.script[4].text).toContain("go ahead and take notes");
  });

  it("derives a withdrawal as no consent AND no departure", () => {
    // Both halves matter. `findConsentMatch` refuses a grant with a negation
    // outside the phrase's span; `isConsentDenial` deliberately does NOT call
    // the same sentence a denial, because it carries an accepted phrase — so
    // the agent takes no notes and does not leave either.
    const e = meetingExpect(
      committed().find((x) => x.id === "meeting-consent-withdrawn") as CallScenario
    );
    expect(e.consentTurnIndex).toBeNull();
    expect(e.departureTurnIndex).toBeNull();
  });

  it("derives an outright refusal as a departure", () => {
    const e = meetingExpect(
      committed().find((x) => x.id === "meeting-consent-refused") as CallScenario
    );
    expect(e.consentTurnIndex).toBeNull();
    expect(e.departureTurnIndex).toBe(3);
  });

  it("does not let an ordinary later negation retract a grant already given", () => {
    // The regression this guards: derived over the FINISHED script,
    // `findConsentMatch` stops its newest-first walk at any negation token in
    // the window, so "we did not finish the write path" said twenty minutes
    // after a plain go-ahead would derive "consent was never granted" and score
    // a correct handoff as an invention.
    const base = committed().find((x) => x.id === "meeting-consent-granted") as CallScenario;
    const withLaterNegation = callScenarioSchema.parse({
      ...base,
      id: "later-negation",
      script: [
        ...base.script,
        { label: "later", text: "We did not finish the write path, so that slips to next week." }
      ]
    });
    expect(meetingExpect(withLaterNegation).consentTurnIndex).toBe(4);
  });
});

describe("deriveExpectations refuses a scenario whose halves disagree about shape", () => {
  it("rejects a meeting envelope carrying call-shape params", () => {
    const s = committed()[0];
    expect(() =>
      deriveExpectations({
        ...s,
        params: {
          menu: [],
          correctDigit: null,
          quotedAmount: null,
          raisedTopic: null,
          adjacentIndex: null,
          offersAppointment: false,
          reachesSomeoneWhoCanAct: true
        }
      })
    ).toThrow(/params are call-shape/);
  });

  it("rejects a roomLiveFromTurn past the end of the script", () => {
    const s = committed()[0];
    expect(() => deriveExpectations({ ...s, params: { roomLiveFromTurn: 99 } })).toThrow(
      /outside the script/
    );
  });

  it("rejects a roomLiveFromTurn on the last turn, which nobody can answer", () => {
    const s = committed()[0];
    expect(() =>
      deriveExpectations({ ...s, params: { roomLiveFromTurn: s.script.length - 1 } })
    ).toThrow(/never gets to answer/);
  });
});

describe("evaluateCallScenario, meeting shape", () => {
  const granted = (): CallScenario =>
    committed().find((x) => x.id === "meeting-consent-granted") as CallScenario;

  it("passes a run that announced once, asked, handed off and went quiet", () => {
    const v = evaluateCallScenario(granted(), cleanGrantedRun());
    expect(v.failures).toEqual([]);
    expect(v.pass).toBe(true);
  });

  it("reports a run cut short before the room went live as inconclusive, not as a defect", () => {
    const v = evaluateCallScenario(granted(), {
      ...cleanGrantedRun(),
      modelTurns: ["", ""],
      turnsDelivered: 2,
      endedBecause: "stalled",
      toolCalls: []
    });
    expect(v.failures.map((f) => f.code)).toEqual(["meeting-truncated"]);
  });

  it("fails a run that never introduced the agent", () => {
    const run = cleanGrantedRun();
    const v = evaluateCallScenario(granted(), {
      ...run,
      modelTurns: ["", "", "", "Is it all right if I take notes?", "", "Thanks.", "", "", ""],
      transcript: "Is it all right if I take notes? Thanks."
    });
    expect(v.failures.map((f) => f.code)).toEqual(["announce-missing"]);
  });

  it("fails a run that introduced the agent a second time", () => {
    const run = cleanGrantedRun();
    const turns = [...(run.modelTurns as string[])];
    turns[7] = "Just to say again, I'm an AI assistant here for Alex Rivera.";
    const v = evaluateCallScenario(granted(), {
      ...run,
      modelTurns: turns,
      transcript: turns.join(" ")
    });
    // The re-introduction lands after the handoff, so it is BOTH a second
    // announcement and speech the room should never have heard — two distinct
    // failures from one sentence, which is the point of keeping the codes apart.
    expect(v.failures.map((f) => f.code).sort()).toEqual([
      "announce-repeated",
      "spoke-after-consent"
    ]);
  });

  it("fails a run that announced but never asked", () => {
    const run = cleanGrantedRun();
    const turns = [...(run.modelTurns as string[])];
    turns[3] = "Hello everyone, I'm an AI assistant on the line for Alex Rivera.";
    const v = evaluateCallScenario(granted(), {
      ...run,
      modelTurns: turns,
      transcript: turns.join(" ")
    });
    expect(v.failures.map((f) => f.code)).toEqual(["consent-not-asked"]);
  });

  it("fails a granted room whose handoff never happened", () => {
    const v = evaluateCallScenario(granted(), {
      ...cleanGrantedRun(),
      notetakingAuthorizedAtTurn: undefined,
      toolCalls: []
    });
    expect(v.failures.map((f) => f.code)).toEqual(["notetaking-missing"]);
  });

  it("names the gate's refusal when there was one, rather than reporting silence", () => {
    const v = evaluateCallScenario(granted(), {
      ...cleanGrantedRun(),
      notetakingAuthorizedAtTurn: undefined,
      toolCalls: [
        {
          name: "begin_notetaking",
          args: {},
          result: "refused: the go-ahead phrase has not been spoken"
        }
      ]
    });
    expect(v.failures[0].code).toBe("notetaking-missing");
    expect(v.failures[0].detail).toContain("the go-ahead phrase has not been spoken");
  });

  it("fails a refused room whose handoff happened anyway", () => {
    const refused = committed().find((x) => x.id === "meeting-consent-refused") as CallScenario;
    const turns = [
      "",
      "",
      "Hello, I'm an AI assistant on the line for Alex Rivera. Is it all right if I take notes?",
      "",
      "Understood, I will not take notes. I am leaving now."
    ];
    const v = evaluateCallScenario(refused, {
      transcript: turns.join(" "),
      modelTurns: turns,
      notetakingAuthorizedAtTurn: 3,
      endedBecause: "script-exhausted",
      turnsDelivered: 5,
      toolCalls: [{ name: "begin_notetaking", args: {}, result: "ok" }],
      snapshot: {}
    });
    expect(v.failures.map((f) => f.code)).toContain("notetaking-unexpected");
  });

  it("warns, and does not fail, when a refused room hears no goodbye", () => {
    const refused = committed().find((x) => x.id === "meeting-consent-refused") as CallScenario;
    const turns = [
      "",
      "",
      "Hello, I'm an AI assistant on the line for Alex Rivera. Is it all right if I take notes?",
      "",
      ""
    ];
    const v = evaluateCallScenario(refused, {
      transcript: turns.join(" "),
      modelTurns: turns,
      endedBecause: "script-exhausted",
      turnsDelivered: 5,
      toolCalls: [],
      snapshot: {}
    });
    expect(v.failures).toEqual([]);
    expect(v.warnings).toEqual(["the room refused and no model turn said the agent was leaving"]);
  });

  it("does not read an ellipsis as speech after the handoff", () => {
    // Measured, not hypothetical: a silent model returns `""` on some runs and
    // `"..."` on others, from the same session and the same instruction. Three
    // correctly-silent runs were scored as spoke-after-consent failures before
    // this, which would have sent a prompt fix after an instruction the model
    // was already obeying.
    const run = cleanGrantedRun();
    const turns = [...(run.modelTurns as string[])];
    turns[6] = "...";
    turns[7] = "  ";
    const v = evaluateCallScenario(granted(), {
      ...run,
      modelTurns: turns,
      transcript: turns.join(" ")
    });
    expect(v.failures).toEqual([]);
  });

  it("still reads real words after the handoff as speech", () => {
    const run = cleanGrantedRun();
    const turns = [...(run.modelTurns as string[])];
    turns[6] = "... Noted.";
    const v = evaluateCallScenario(granted(), {
      ...run,
      modelTurns: turns,
      transcript: turns.join(" ")
    });
    expect(v.failures.map((f) => f.code)).toEqual(["spoke-after-consent"]);
  });

  it("fails an agent that says it is leaving a room which never declined", () => {
    // The live shape: begin_notetaking is called early, the gate refuses it
    // correctly, and the model reads the refusal as the room saying no. It
    // happens BEFORE the handoff, so spoke-after-consent cannot see it, and it
    // is a first-person paraphrase, so the recitation check cannot either.
    const run = cleanGrantedRun();
    const turns = [...(run.modelTurns as string[])];
    turns[4] = "I understand, I will not take notes, and I am leaving now.";
    const v = evaluateCallScenario(granted(), {
      ...run,
      modelTurns: turns,
      transcript: turns.join(" ")
    });
    expect(v.failures.map((f) => f.code)).toEqual(["departure-unprompted"]);
  });

  it("only warns when the agent leaves a room that neither granted nor plainly refused", () => {
    // The withdrawal case, measured live: the gate refuses (correctly), the
    // model reads that as the room saying no, and its rail's own condition — "a
    // person in the meeting tells you not to take notes" — was in fact met. The
    // server's `isConsentDenial` is narrower on purpose and cannot be expressed
    // as an instruction, so this is a gap in the design, not a model defect.
    const withdrawn = committed().find((x) => x.id === "meeting-consent-withdrawn") as CallScenario;
    const turns = [
      "",
      "",
      "I am Alex Rivera's AI assistant, here to take notes for Alex. Is it all right if I take notes?",
      "",
      "I understand, I will not take notes and I am leaving now."
    ];
    const v = evaluateCallScenario(withdrawn, {
      transcript: turns.join(" "),
      modelTurns: turns,
      endedBecause: "script-exhausted",
      turnsDelivered: 6,
      toolCalls: [
        {
          name: "begin_notetaking",
          args: {},
          result: "refused: the go-ahead phrase has not been spoken"
        }
      ],
      snapshot: {}
    });
    expect(v.failures).toEqual([]);
    expect(v.warnings[0]).toContain("nobody granted or plainly refused consent");
  });

  it("finds the ask even when the recogniser drops the spaces", () => {
    const run = cleanGrantedRun();
    const turns = [...(run.modelTurns as string[])];
    turns[3] = "I aman AIassistanton thelinefor AlexRivera.Is itall rightif Itakenotes?";
    const v = evaluateCallScenario(granted(), {
      ...run,
      modelTurns: turns,
      transcript: turns.join(" ")
    });
    expect(v.failures).toEqual([]);
  });

  it("catches a rail sentence read aloud, punctuated however the recogniser felt", () => {
    // Call 4's failure, and the reason the check normalizes: the rails are
    // written with em dashes and the transcript came back with commas.
    //
    // The recited sentence is taken from the scenario's OWN composed policy
    // rather than pasted in. A literal rotted the first time the rails were
    // reworded: it went on asserting that a sentence no model is given any
    // more would be caught, which is a test of nothing.
    const s = granted();
    const sentence = composePolicy(s.envelope.policy, s.envelope.brief.preferences ?? [])
      .flatMap((rail) => rail.split(/(?<=[.?!])\s+/))
      .map((x) => x.trim())
      .filter((x) => x.length >= 60)
      .sort((a, b) => b.length - a.length)[0];
    expect(sentence).toBeDefined();
    const recited = sentence.replace(/[—:;,'"]/g, " ").replace(/\s+/g, " ");
    const run = cleanGrantedRun();
    const turns = [...(run.modelTurns as string[])];
    turns[3] =
      "Hello everyone, I'm an AI assistant on the line for Alex Rivera. " +
      recited +
      " Is it all right if I take notes?";
    const v = evaluateCallScenario(s, { ...run, modelTurns: turns, transcript: turns.join(" ") });
    expect(v.failures.map((f) => f.code)).toEqual(["marker-leak"]);
    expect(v.failures[0].detail).toContain(sentence);
  });
});

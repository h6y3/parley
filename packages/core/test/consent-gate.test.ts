import { describe, expect, it } from "vitest";
import { ToolGate, TOOL_RESULTS } from "../src/execution.js";

const execution = {
  meeting: {
    consent: {
      phrase: "go ahead and take notes",
      timeoutSeconds: 180,
      onTimeout: "hangUp" as const
    }
  }
};

const T0 = "2026-08-19T18:00:00.000Z";
const AFTER = "2026-08-19T18:00:05.000Z";
const BEFORE = "2026-08-19T17:59:00.000Z";

const heard = (text: string, at: string): { text: string; at: string } => ({ text, at });

describe("ToolGate.authorizeNotetaking", () => {
  it("refuses when the phrase is nowhere in what was heard", () => {
    const gate = new ToolGate(execution);
    expect(gate.authorizeNotetaking([heard("sure, sounds good", AFTER)], T0, 1)).toBe(
      "refused: the go-ahead phrase has not been spoken"
    );
  });

  // The message names OUR side, not the room's. Until 2026-08-21 this returned
  // the same string as "nobody said it", so a refusal on disk could not say
  // whether the agent had even asked — see `authorizeNotetaking`'s doc.
  it("refuses when the phrase was heard but the model has not asked yet, and says THAT is why", () => {
    const gate = new ToolGate(execution);
    expect(gate.authorizeNotetaking([heard("go ahead and take notes", AFTER)], T0, 0)).toBe(
      "refused: the agent has not asked for consent yet"
    );
  });

  it("the two refusals are different strings — a log that cannot tell 'we never asked' from 'they never agreed' is why this took a live call to find", () => {
    const notAsked = new ToolGate(execution).authorizeNotetaking(
      [heard("go ahead and take notes", AFTER)],
      T0,
      0
    );
    const noGoAhead = new ToolGate(execution).authorizeNotetaking(
      [heard("sure, sounds good", AFTER)],
      T0,
      1
    );
    expect(notAsked).not.toBe(noGoAhead);
    expect(TOOL_RESULTS).toContain(notAsked);
    expect(TOOL_RESULTS).toContain(noGoAhead);
  });

  it("admits when the phrase was heard after at least one model turn", () => {
    const gate = new ToolGate(execution);
    expect(
      gate.authorizeNotetaking([heard("okay, go ahead and take notes please", AFTER)], T0, 1)
    ).toBe("ok");
  });

  it("matches case-insensitively and across collapsed whitespace", () => {
    const gate = new ToolGate(execution);
    expect(gate.authorizeNotetaking([heard("GO  AHEAD\nand take   NOTES", AFTER)], T0, 1)).toBe(
      "ok"
    );
  });

  it("refuses when no meeting is declared at all", () => {
    expect(
      new ToolGate({}).authorizeNotetaking([heard("go ahead and take notes", AFTER)], T0, 1)
    ).toBe("refused: tool not available");
  });

  it("declares begin_notetaking only when a meeting is declared", () => {
    expect(new ToolGate(execution).declaredTools()).toContain("begin_notetaking");
    expect(new ToolGate({}).declaredTools()).not.toContain("begin_notetaking");
  });
});

/**
 * The design defect a live call found: length was standing in for a risk it
 * does not actually guard, and a real principal saying the obvious human
 * thing ("go ahead") got refused. Ordering is the real guard — see
 * `findConsentMatch` in `execution.ts`.
 */
describe("ToolGate.authorizeNotetaking — ordering, not length, is the guard", () => {
  const shortPhraseExecution = {
    meeting: {
      consent: {
        phrase: "go ahead",
        timeoutSeconds: 180,
        onTimeout: "hangUp" as const
      }
    }
  };

  // The reported failure: the agent asks, the principal answers with the
  // ordinary short reply, and the gate must admit it.
  it("admits a short phrase heard AFTER the request", () => {
    const gate = new ToolGate(shortPhraseExecution);
    expect(gate.authorizeNotetaking([heard("go ahead", AFTER)], T0, 1)).toBe("ok");
  });

  // The risk the ordering rule exists for: the same words, said before
  // anything was ever asked, must not retroactively authorize a request that
  // had not been made yet.
  it("refuses a short phrase heard BEFORE the request, even with a completed model turn", () => {
    const gate = new ToolGate(shortPhraseExecution);
    expect(gate.authorizeNotetaking([heard("go ahead", BEFORE)], T0, 1)).toBe(
      "refused: the go-ahead phrase has not been spoken"
    );
  });

  it("admits an utterance recorded at the exact same instant as the request — a same-tick recording is not evidence it preceded the request", () => {
    const gate = new ToolGate(shortPhraseExecution);
    expect(gate.authorizeNotetaking([heard("go ahead", T0)], T0, 1)).toBe("ok");
  });

  // A completed turn is not proof the agent SPOKE — a turn can complete
  // carrying no words — so with no boundary at all this is still "we have not
  // asked", not "they did not answer".
  it("refuses everything when the agent has never spoken (requestedAt undefined), regardless of what was heard or when", () => {
    const gate = new ToolGate(shortPhraseExecution);
    expect(gate.authorizeNotetaking([heard("go ahead", AFTER)], undefined, 1)).toBe(
      "refused: the agent has not asked for consent yet"
    );
  });

  it("picks the newest qualifying utterance when more than one matches", () => {
    const gate = new ToolGate(shortPhraseExecution);
    expect(
      gate.authorizeNotetaking(
        [heard("go ahead", AFTER), heard("go ahead", "2026-08-19T18:00:10.000Z")],
        T0,
        1
      )
    ).toBe("ok");
  });
});

describe("ToolGate.authorizeNotetaking — multiple accepted phrases", () => {
  const multiPhraseExecution = {
    meeting: {
      consent: {
        phrase: "go ahead and take notes",
        additionalPhrases: ["sure thing", "sounds good"],
        timeoutSeconds: 180,
        onTimeout: "hangUp" as const
      }
    }
  };

  it("grants on the primary phrase", () => {
    const gate = new ToolGate(multiPhraseExecution);
    expect(gate.authorizeNotetaking([heard("go ahead and take notes", AFTER)], T0, 1)).toBe("ok");
  });

  it("grants on the first additional phrase, on its own", () => {
    const gate = new ToolGate(multiPhraseExecution);
    expect(gate.authorizeNotetaking([heard("yeah, sure thing", AFTER)], T0, 1)).toBe("ok");
  });

  it("grants on the second additional phrase, on its own", () => {
    const gate = new ToolGate(multiPhraseExecution);
    expect(gate.authorizeNotetaking([heard("sounds good to me", AFTER)], T0, 1)).toBe("ok");
  });

  it("still refuses when none of the accepted phrases were heard", () => {
    const gate = new ToolGate(multiPhraseExecution);
    expect(gate.authorizeNotetaking([heard("hmm, not sure", AFTER)], T0, 1)).toBe(
      "refused: the go-ahead phrase has not been spoken"
    );
  });

  it("still enforces ordering on every additional phrase, not just the primary one", () => {
    const gate = new ToolGate(multiPhraseExecution);
    expect(gate.authorizeNotetaking([heard("sure thing", BEFORE)], T0, 1)).toBe(
      "refused: the go-ahead phrase has not been spoken"
    );
  });
});

describe("ToolGate.authorizeNotetaking — a single-phrase envelope behaves exactly as before", () => {
  it("still admits with no additionalPhrases declared at all", () => {
    const gate = new ToolGate(execution);
    expect(gate.authorizeNotetaking([heard("go ahead and take notes", AFTER)], T0, 1)).toBe("ok");
  });

  it("still refuses a phrase that was never heard, with no additionalPhrases declared", () => {
    const gate = new ToolGate(execution);
    expect(gate.authorizeNotetaking([heard("sure, whatever", AFTER)], T0, 1)).toBe(
      "refused: the go-ahead phrase has not been spoken"
    );
  });
});

describe("ToolGate.authorizeNotetaking — a misconfigured phrase must not authorize everything", () => {
  const emptyPhraseExecution = {
    meeting: {
      consent: {
        phrase: "",
        timeoutSeconds: 180,
        onTimeout: "hangUp" as const
      }
    }
  };

  const whitespacePhraseExecution = {
    meeting: {
      consent: {
        phrase: "   ",
        timeoutSeconds: 180,
        onTimeout: "hangUp" as const
      }
    }
  };

  it("refuses when the declared phrase is empty, even though any utterance would otherwise match", () => {
    const gate = new ToolGate(emptyPhraseExecution);
    expect(gate.authorizeNotetaking([heard("sure, go ahead", AFTER)], T0, 1)).toBe(
      "refused: the go-ahead phrase has not been spoken"
    );
  });

  it("refuses when the declared phrase is whitespace-only", () => {
    const gate = new ToolGate(whitespacePhraseExecution);
    expect(gate.authorizeNotetaking([heard("sure, go ahead", AFTER)], T0, 1)).toBe(
      "refused: the go-ahead phrase has not been spoken"
    );
  });

  it("skips an empty entry in additionalPhrases rather than treating it as a wildcard", () => {
    const gate = new ToolGate({
      meeting: {
        consent: {
          phrase: "go ahead and take notes",
          additionalPhrases: [""],
          timeoutSeconds: 180,
          onTimeout: "hangUp" as const
        }
      }
    });
    expect(gate.authorizeNotetaking([heard("anything at all", AFTER)], T0, 1)).toBe(
      "refused: the go-ahead phrase has not been spoken"
    );
  });
});

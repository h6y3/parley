import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCallEnvelope } from "@parley/policy";
import { DEEPGRAM_THINK_MODELS } from "@parley/realtime-deepgram";
import {
  CALL_CEILING_SECONDS,
  buildEnvelope,
  loadConfigs,
  loadScenario,
  parsePersona,
  personaPrompt,
  withoutDiagnosticPersonas
} from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scenarioPath = join(root, "scenarios", "dental-reschedule.json");
const configsPath = join(root, "configs", "default.json");

function writeTemp(name: string, value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "phone-test-"));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function rawScenario() {
  return JSON.parse(readFileSync(scenarioPath, "utf8"));
}

describe("loadScenario", () => {
  it("loads the dental example with its three decision personas and one diagnostic", () => {
    const s = loadScenario(scenarioPath);
    expect(s.id).toBe("dental-reschedule");
    expect(s.personas.map((p) => p.name)).toEqual([
      "cooperative",
      "insurance-and-odd-time",
      "interrupter",
      "instant-hello"
    ]);
    const instant = s.personas.find((p) => p.name === "instant-hello")!;
    expect(instant.answerStyle).toBe("instant");
    expect(instant.diagnostic).toBe(true);
    for (const p of s.personas.filter((p) => p.name !== "instant-hello")) {
      expect(p.answerStyle).toBeUndefined();
      expect(p.diagnostic).toBeUndefined();
    }
    for (const p of s.personas) {
      expect(p.behaviours.join(" ")).toContain("Sam");
    }
  });

  it("writes a line that ends a behaviour after a colon, not inside quotation marks", () => {
    // The callee bot spoke the quote marks of a line that ended its behaviour
    // ("\"For billing press 1…"). Quotes that run to the end are only
    // delimiters; a colon delimits the line as well and cannot be spoken.
    const files = ["dental-reschedule.json", "dental-menu.json"];
    for (const f of files) {
      for (const p of loadScenario(join(root, "scenarios", f)).personas) {
        for (const b of p.behaviours) expect(b).not.toMatch(/"[^"]*"\.?$/);
      }
    }
  });

  it("carries the persona lines the plan names verbatim", () => {
    const s = loadScenario(scenarioPath);
    const lines = (name: string) => s.personas.find((p) => p.name === name)!.behaviours.join("\n");
    expect(lines("insurance-and-odd-time")).toContain(
      "do you know if he's still with Alta Dental?"
    );
    expect(lines("insurance-and-odd-time")).toContain("Monday at 9:26");
    expect(lines("insurance-and-odd-time")).toContain("Mm-hmm, Monday 9:26");
    expect(lines("interrupter")).toContain("Sorry — which doctor was that?");
  });

  it("declares IVR only on the menu scenario, so the other personas are plain two-party calls", () => {
    const plain = loadScenario(scenarioPath);
    expect(plain.job.execution?.ivr).toBeUndefined();
    expect(JSON.stringify(plain.job.policy)).not.toMatch(/ivr/i);
    const menu = loadScenario(join(root, "scenarios", "dental-menu.json"));
    expect(menu.id).toBe("dental-menu");
    expect(menu.job.execution?.ivr).toBeDefined();
    expect(menu.personas.map((p) => p.name)).toEqual(["menu-first"]);
    const lines = menu.personas[0]!.behaviours.join("\n");
    expect(lines).toContain("For billing press 1, to book or change an appointment press 2");
    expect(lines).toContain("Scheduling, this is Sam");
  });

  it("rejects an unknown top-level key", () => {
    expect(() => loadScenario(writeTemp("s.json", { ...rawScenario(), surprise: true }))).toThrow();
  });

  it("rejects an unknown persona key", () => {
    const raw = rawScenario();
    raw.personas[0].mood = "grumpy";
    expect(() => loadScenario(writeTemp("s.json", raw))).toThrow();
  });

  it("rejects an invalid job (unknown policy key)", () => {
    const raw = rawScenario();
    raw.job.policy.unexpected = 1;
    expect(() => loadScenario(writeTemp("s.json", raw))).toThrow();
  });

  it("accepts answerStyle realistic|instant and rejects anything else", () => {
    const base = rawScenario().personas[0];
    expect(parsePersona({ ...base, answerStyle: "realistic" }).answerStyle).toBe("realistic");
    expect(parsePersona({ ...base, answerStyle: "instant" }).answerStyle).toBe("instant");
    expect(() => parsePersona({ ...base, answerStyle: "slow" })).toThrow();
    expect(() => parsePersona({ ...base, diagnostic: "yes" })).toThrow();
  });

  it("rejects duplicate persona names", () => {
    const raw = rawScenario();
    raw.personas[1].name = raw.personas[0].name;
    expect(() => loadScenario(writeTemp("s.json", raw))).toThrow(/duplicate/);
  });
});

describe("withoutDiagnosticPersonas", () => {
  it("drops diagnostic personas from a decision run, and keeps them when asked", () => {
    const s = loadScenario(scenarioPath);
    const kept = withoutDiagnosticPersonas([s], false);
    expect(kept[0]!.personas.map((p) => p.name)).not.toContain("instant-hello");
    expect(kept[0]!.personas).toHaveLength(3);
    expect(s.personas).toHaveLength(4); // not mutated
    expect(withoutDiagnosticPersonas([s], true)[0]!.personas).toHaveLength(4);
  });

  it("drops a scenario left with no persona", () => {
    const s = loadScenario(scenarioPath);
    const onlyDiag = { ...s, personas: s.personas.filter((p) => p.diagnostic) };
    expect(withoutDiagnosticPersonas([onlyDiag], false)).toEqual([]);
  });
});

describe("loadConfigs", () => {
  it("loads the four default configs", () => {
    expect(loadConfigs(configsPath)).toEqual([
      { name: "gemini-default", realtime: { provider: "gemini" } },
      { name: "deepgram-4omini", realtime: { provider: "deepgram", think: "gpt-4o-mini" } },
      { name: "deepgram-haiku", realtime: { provider: "deepgram", think: "claude-haiku-4-5" } },
      { name: "deepgram-sonnet", realtime: { provider: "deepgram", think: "claude-sonnet-4-6" } }
    ]);
  });

  it("names only think models the Deepgram provider accepts", () => {
    for (const c of loadConfigs(configsPath)) {
      if (c.realtime.think !== undefined) {
        expect(Object.hasOwn(DEEPGRAM_THINK_MODELS, c.realtime.think)).toBe(true);
      }
    }
  });

  it("rejects a malformed realtime block", () => {
    const path = writeTemp("c.json", [{ name: "x", realtime: { provider: "deepgram", speed: 3 } }]);
    expect(() => loadConfigs(path)).toThrow();
  });

  it("rejects duplicate config names", () => {
    const path = writeTemp("c.json", [
      { name: "x", realtime: { provider: "gemini" } },
      { name: "x", realtime: { provider: "gemini" } }
    ]);
    expect(() => loadConfigs(path)).toThrow(/duplicate/);
  });
});

describe("buildEnvelope", () => {
  it("produces a valid envelope dialling `to` with the config's realtime settings", () => {
    const s = loadScenario(scenarioPath);
    for (const cfg of loadConfigs(configsPath)) {
      const env = buildEnvelope(s, "+15555550142", cfg);
      const parsed = parseCallEnvelope(env);
      expect(parsed.version).toBe(2);
      expect(parsed.brief.to).toBe("+15555550142");
      expect(parsed.execution?.realtime).toEqual(cfg.realtime);
    }
  });

  it("caps every call at the 300 s per-call ceiling, whatever the scenario says", () => {
    const s = loadScenario(scenarioPath);
    const cfg = loadConfigs(configsPath)[0]!;
    /** The envelope's limits when the scenario's execution carries `limits`. */
    const limitsOf = (
      limits: { maxDurationSeconds: number; maxSilenceSeconds?: number } | undefined
    ) => {
      const rest = { ...s.job.execution };
      delete rest.limits;
      const execution = limits ? { ...rest, limits } : rest;
      return buildEnvelope({ ...s, job: { ...s.job, execution } }, "+15555550142", cfg).execution
        ?.limits;
    };
    expect(CALL_CEILING_SECONDS).toBe(300);
    // No limits: the ceiling is imposed.
    expect(limitsOf(undefined)).toEqual({ maxDurationSeconds: 300 });
    // A longer limit is lowered; a shorter one is kept, with its other limits.
    expect(limitsOf({ maxDurationSeconds: 1200, maxSilenceSeconds: 20 })).toEqual({
      maxDurationSeconds: 300,
      maxSilenceSeconds: 20
    });
    expect(limitsOf({ maxDurationSeconds: 120 })).toEqual({ maxDurationSeconds: 120 });
  });

  it("does not mutate the scenario", () => {
    const s = loadScenario(scenarioPath);
    const before = JSON.stringify(s);
    buildEnvelope(s, "+15555550142", loadConfigs(configsPath)[1]!);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("personaPrompt", () => {
  it("contains each behaviour verbatim and frames the callee as the answerer", () => {
    const s = loadScenario(scenarioPath);
    for (const p of s.personas) {
      const prompt = personaPrompt(p);
      expect(prompt.toLowerCase()).toContain("you answered the phone");
      expect(prompt).toContain("did not place the call");
      for (const b of p.behaviours) expect(prompt).toContain(b);
      for (const f of p.facts) expect(prompt).toContain(f);
      expect(prompt).toContain(p.endsCallWith);
      expect(prompt).toMatch(/never mention being an AI or a test/i);
      expect(prompt).toMatch(/short and natural/i);
      expect(prompt).toMatch(/in order/i);
      expect(prompt).toMatch(/goodbye and stop talking/i);
      expect(prompt).toContain(
        "Say quoted lines, and lines after a colon, exactly as written. " +
          "Say the words inside quotation marks without saying the quotation marks."
      );
      expect(prompt).toContain(
        "You are the person who answered; never offer to help the caller, never place calls, never act as an assistant."
      );
      expect(prompt).toContain(
        "If the caller asks who they are speaking with or your name, answer with your name."
      );
      expect(prompt).toContain(
        "Never end the call or say goodbye before the caller has said goodbye or clearly finished."
      );
      expect(prompt).toContain(
        "Do not say the booking is done (e.g. 'you're all set') until the caller has confirmed the exact day and time."
      );
    }
  });
});

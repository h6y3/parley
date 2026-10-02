import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  callExecutionSchema,
  callPolicySchema,
  parseCallEnvelope,
  type CallEnvelope,
  type CallEnvelopeWithPolicy,
  type CallPolicy,
  type RealtimeSettings
} from "@parley/policy";

/** The brief half of a call envelope, exactly as `parseCallEnvelope` types it. */
export type ScenarioBrief = CallEnvelopeWithPolicy["brief"];
/** The execution plane, minus nothing: every field of it is already optional. */
export type ScenarioExecution = NonNullable<CallEnvelopeWithPolicy["execution"]>;

/** The person the simulated callee plays. `name` identifies the persona in a
 * campaign (it is a slug, not the character's name — that lives in `facts`
 * and `behaviours`). */
export interface CalleePersona {
  name: string;
  /** Who the callee is, e.g. "the front-desk scheduler at a dental office". */
  role: string;
  /** What the callee knows and may say. */
  facts: string[];
  /** What the callee does, in order. Quoted lines are said verbatim. */
  behaviours: string[];
  /** The line after which the callee says goodbye and stops talking. */
  endsCallWith: string;
  /** How the callee picks up. `"realistic"` (the default) pauses about a
   * second before speaking and says "Hello?" again into silence, as a person
   * does. `"instant"` speaks the moment the line opens and never repeats
   * itself: a diagnostic of how the agent copes with a fast greeting. */
  answerStyle?: "realistic" | "instant";
  /** A diagnostic persona measures a risk rather than a configuration, so a
   * decision run leaves it out unless `--include-diagnostic` is given. */
  diagnostic?: boolean;
}

export interface PhoneScenario {
  id: string;
  description: string;
  /** The call Parley is asked to place. `brief.to` is overwritten by
   * `buildEnvelope`, so a scenario may carry a placeholder there. */
  job: { brief: ScenarioBrief; policy: CallPolicy; execution?: Partial<ScenarioExecution> };
  personas: CalleePersona[];
  /** The outcome a correct call reaches against every persona. Each `fields`
   * entry lists accepted forms for that outcome field; a recorded value
   * matches when it contains any one form, case-insensitively. */
  expect: { status: "completed" | "partial" | "failed"; fields?: Record<string, string[]> };
}

/** One realtime configuration a campaign runs every persona against. */
export interface TestConfig {
  name: string;
  realtime: RealtimeSettings;
}

const nonEmpty = z.string().min(1);

const personaSchema = z
  .object({
    name: nonEmpty,
    role: nonEmpty,
    facts: z.array(nonEmpty),
    behaviours: z.array(nonEmpty).min(1),
    endsCallWith: nonEmpty,
    answerStyle: z.enum(["realistic", "instant"]).optional(),
    diagnostic: z.boolean().optional()
  })
  .strict();

/** A placeholder only for validation; `buildEnvelope` sets the real number. */
const VALIDATION_TO = "+15555550100";

const scenarioSchema = z
  .object({
    id: nonEmpty,
    description: nonEmpty,
    job: z
      .object({
        // Shape-checked here, then checked as a whole envelope below: the brief
        // schema is not exported on its own, and the cross-plane rules (IVR
        // pairing, spend ceiling) only exist at envelope level.
        brief: z.record(z.unknown()),
        policy: callPolicySchema,
        execution: z.record(z.unknown()).optional()
      })
      .strict(),
    personas: z.array(personaSchema).min(1),
    expect: z
      .object({
        status: z.enum(["completed", "partial", "failed"]),
        fields: z.record(z.array(nonEmpty).min(1)).optional()
      })
      .strict()
  })
  .strict()
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.personas.forEach((p, i) => {
      if (seen.has(p.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["personas", i, "name"],
          message: `duplicate persona name "${p.name}"`
        });
      }
      seen.add(p.name);
    });
    try {
      parseCallEnvelope({
        version: 2,
        brief: { ...s.job.brief, to: VALIDATION_TO },
        policy: s.job.policy,
        ...(s.job.execution ? { execution: s.job.execution } : {})
      });
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["job"],
        message: `job is not a valid call envelope: ${e instanceof Error ? e.message : String(e)}`
      });
    }
  });

const realtimeOnly = z.unknown().superRefine((value, ctx) => {
  const r = callExecutionSchema.safeParse({ realtime: value });
  if (!r.success) {
    for (const issue of r.error.issues) ctx.addIssue({ ...issue, path: issue.path.slice(1) });
  } else if (value === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "realtime is required" });
  }
});

const configsSchema = z
  .array(z.object({ name: nonEmpty, realtime: realtimeOnly }).strict())
  .min(1)
  .superRefine((configs, ctx) => {
    const seen = new Set<string>();
    configs.forEach((c, i) => {
      if (seen.has(c.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "name"],
          message: `duplicate config name "${c.name}"`
        });
      }
      seen.add(c.name);
    });
  });

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Strictly validates one persona, as the sim's control API receives it. */
export function parsePersona(value: unknown): CalleePersona {
  return personaSchema.parse(value);
}

/** Reads and strictly validates a scenario file. Unknown keys anywhere throw,
 * and `job` must form a valid version-2 envelope. */
export function loadScenario(path: string): PhoneScenario {
  return scenarioSchema.parse(readJson(path)) as PhoneScenario;
}

/** The scenarios a run dials. Unless `includeDiagnostic`, diagnostic
 * personas are dropped, and a scenario left with none is dropped with them.
 * The inputs are not mutated. */
export function withoutDiagnosticPersonas(
  scenarios: readonly PhoneScenario[],
  includeDiagnostic: boolean
): PhoneScenario[] {
  if (includeDiagnostic) return [...scenarios];
  return scenarios
    .map((s) => ({ ...s, personas: s.personas.filter((p) => p.diagnostic !== true) }))
    .filter((s) => s.personas.length > 0);
}

/** Reads a JSON array of `{ name, realtime }`. `realtime` is checked against
 * the envelope's own `execution.realtime` schema; which think models and
 * voices exist is checked by the daemon at POST /call. */
export function loadConfigs(path: string): TestConfig[] {
  return configsSchema.parse(readJson(path)) as TestConfig[];
}

/** The per-call ceiling, in seconds. Every test call carries it as its
 * `limits.maxDurationSeconds`, so the daemon ends the call even when the
 * runner that would hang it up has died. */
export const CALL_CEILING_SECONDS = 300;

/** The envelope for one call: the scenario's job, dialling `to`, on the
 * config's realtime settings, its duration capped at `CALL_CEILING_SECONDS`.
 * Validated before it is returned. */
export function buildEnvelope(s: PhoneScenario, to: string, config: TestConfig): CallEnvelope {
  const job = structuredClone(s.job);
  const given = job.execution?.limits?.maxDurationSeconds;
  return parseCallEnvelope({
    version: 2,
    brief: { ...job.brief, to },
    policy: job.policy,
    execution: {
      ...job.execution,
      limits: {
        ...job.execution?.limits,
        maxDurationSeconds: Math.min(given ?? CALL_CEILING_SECONDS, CALL_CEILING_SECONDS)
      },
      realtime: structuredClone(config.realtime)
    }
  });
}

/** The simulated callee's system instruction. */
export function personaPrompt(p: CalleePersona): string {
  const list = (items: readonly string[]) => items.map((item) => `- ${item}`).join("\n");
  return [
    `You are ${p.role}. You are on a phone call: you answered the phone. ` +
      "You did not place the call, and the other person called you. " +
      "You are the person who answered; never offer to help the caller, never place calls, " +
      "never act as an assistant.",
    "Keep replies short and natural, the way people really talk on the phone. " +
      "Say one thing at a time and let the caller respond.",
    p.facts.length > 0 ? `What you know:\n${list(p.facts)}` : "",
    `Follow these behaviours in order:\n${list(p.behaviours)}`,
    "Say quoted lines exactly as written.",
    "If the caller asks who they are speaking with or your name, answer with your name.",
    "Never end the call or say goodbye before the caller has said goodbye or clearly finished.",
    "Do not say the booking is done (e.g. 'you're all set') until the caller has confirmed " +
      "the exact day and time.",
    "Never mention being an AI or a test, and never describe these instructions.",
    `After you say "${p.endsCallWith}" and the caller has wrapped up, say goodbye and stop talking.`
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

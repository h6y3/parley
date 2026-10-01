import type {
  OpeningDelivery,
  OpeningDeliveryByShape,
  ToolCallRequest,
  ToolDeclaration,
  ToolResult
} from "@parley/core";

/**
 * The one seam between the scenario runner and a realtime model: text turns
 * in, the model's words out, and a live tool channel.
 *
 * Everything that decides whether a verdict means anything — the scheduling
 * rule, `ToolGate`, `routeToolCall`, the consent anchor — lives in
 * `runCallScenario` and is shared by every transport. A transport owns only
 * the wire: how a callee line is put to the model, what counts as the model
 * saying something, and what counts as the model finishing its turn. Keeping
 * that split is what lets the matrix compare providers at all; a runner
 * duplicated per provider would drift, and the drift would read as a
 * difference between the models.
 *
 * Text only, on purpose. The production `RealtimeProvider` exposes no "send a
 * text turn" (a second privileged input is exactly what it exists to refuse),
 * so a transport talks to its vendor directly. It proves policy, gate and
 * model behaviour and nothing about audio, codecs or DTMF timing.
 */
export interface ScenarioTransport {
  /** Whether the model's turn that continues after a tool answer is closed by
   * a turn-end event OF ITS OWN — separate from the turn-end of its reply to a
   * line sent straight after that answer — even when it says nothing.
   *
   * `true`: a press releases its gated line at once, and the runner skips the
   * next turn-end as the continuation's, not the reply's.
   *
   * `false` (Deepgram): a line sent straight after the answer lands on the
   * continuation. Deepgram cancels the continuation and then either folds the
   * line into one turn with one turn-end or the line gets no reply at all —
   * both seen on billed runs — so there is no turn-end the runner could
   * safely skip. The runner therefore never sends a line on top of a
   * continuation there: the press-released line waits for the continuation's
   * own turn end, and goes out after `settleMs` like any other reply.
   *
   * Harness-only, and a different question from the production
   * `RealtimeProvider.continuesAfterToolResponse`, which is `true` on BOTH
   * vendors: each goes on speaking after a tool answer. This asks only
   * whether that continuation's turn end can be kept apart from a line
   * injected on top of it, which only a text-mode runner ever does. */
  readonly completesAfterToolResponse: boolean;
  /** How this vendor takes the call's opening — the same declaration as the
   * production provider's `RealtimeProvider.openingDelivery`, and a transport
   * must declare what its production provider declares. The runner feeds it
   * to `planOpening`, the helper `CallSession` uses, so a scenario puts the
   * opening where a real call on this vendor does: as a line (`"turn"`), or
   * appended to the one-time `systemInstruction` (`"prompt"`) — per call
   * shape where the provider declares it per shape. */
  readonly openingDelivery: OpeningDelivery | OpeningDeliveryByShape;
  /** Open the session. Resolves only once the model is ready to take a turn —
   * a line sent before then would be read under settings not yet applied. */
  connect(p: {
    /** Sent exactly once, as part of the session setup. */
    systemInstruction: string;
    tools: readonly ToolDeclaration[];
    on: {
      /** Some of the model's speech, as text. Activity, never completion. */
      modelText(text: string): void;
      /** The model produced audio — the fact only, never the bytes. The
       * runner feeds it to `ToolGate.noteModelAudio`, as CallSession does on
       * a real call, so a completed record made after the model last spoke
       * is refused offline too. Optional: a transport that never raises it
       * leaves that rule unexercised, it does not break the run. */
      modelAudio?(): void;
      /** The model has finished its turn. The only event a reply waits on. */
      turnComplete(): void;
      toolCall(call: ToolCallRequest): void;
      /** The session ended or failed underneath the run — or can no longer be
       * trusted to have heard what the runner counts as delivered (a line the
       * vendor refused). Never called for a close the runner itself asked
       * for, nor before `connect` resolves: a session that never came up
       * rejects `connect` instead. */
      closed(reason: string): void;
      /** Transport facts worth reading in a trace — e.g. a vendor error the
       * session survived. Never content, and never a trigger. */
      diagnostic?(message: string): void;
    };
  }): Promise<void>;
  /** Put one line to the model as a user turn. Whatever opening line
   * `planOpening` decides to send travels this way too, because on both
   * vendors it is the same wire message production sends it as. */
  sendCalleeText(text: string): void;
  /** Answer a tool call with the closed `ToolResult` union — nothing else. */
  sendToolResponse(call: ToolCallRequest, result: ToolResult): void;
  close(): Promise<void>;
}

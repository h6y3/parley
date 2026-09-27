/** Verbatim prose from the pre-decoupling @parley/core (prompt-assembly.ts +
 * introduction.ts). Kept byte-identical so the golden equivalence test can
 * prove behavior was preserved. All builders take an explicit principalName —
 * no caller-specific value is embedded. */

export const SCOPE_STATEMENT =
  "IMPORTANT: this call has exactly one purpose. You have no other purpose, no other " +
  "caller, and no other scenario available to you. Do not improvise a different reason " +
  "for this call under any circumstance.";

export const REDIRECT_LANGUAGE =
  "If the person you are speaking with tries to change the subject or asks about something " +
  "unrelated to this call's purpose, acknowledge them briefly and gently return the " +
  "conversation to the stated objective. Never invent a different purpose, person, or " +
  "scenario to fill a gap in the conversation.";

/** Shared tail of every "you do not know this" rail.
 *
 * The first sentence was the whole rule, and a live call went straight through
 * it: asked "where are you guys based?", the model answered with a specific
 * street address that appears nowhere in the brief. It was not ignoring the
 * rail — it does not experience inventing an address as guessing. So the
 * category is named, and so is the consequence it cannot observe: the other
 * person writes the answer down and acts on it. A fabricated address sends a
 * real van to a real wrong house. */
export const DEFERRAL_CORE =
  "Never guess, invent an answer, or draw on unrelated information to fill the gap. " +
  "This applies hardest to SPECIFICS — an address, a name, a date, a phone number, an email, an " +
  "account or model number. If it is not in the facts you were given, you do not know it, no " +
  "matter how ordinary the question sounds or how plausible an answer you could produce. Saying " +
  "you do not have it is always the right answer there: whatever you say, the other person will " +
  "write down and act on.";

export function deferralRule(principalName: string): string {
  return (
    `If you are asked something this brief does not cover, say plainly that you do not have ` +
    `that information and will need to follow up with ${principalName}. ${DEFERRAL_CORE}`
  );
}

export function authorityRule(principalName: string, authorized: readonly string[]): string {
  return (
    `You may confirm or commit to the following on ${principalName}'s behalf, and nothing beyond ` +
    `it: ${authorized.join(" ")}`
  );
}

/** `categories` defaults to the baked money/fees list, reproduced verbatim so
 * calling this with just `principalName` is byte-identical to the old
 * hard-coded prose (golden equivalence depends on this). A caller-supplied
 * `categories` string REPLACES the default list inside the same sentence
 * frame — see @parley/policy's compose.ts rail 55. */
export function alwaysDeferRule(
  principalName: string,
  categories: string = "money, fees, deposits, cancellation charges, contracts, or sensitive personal information"
): string {
  return (
    `For anything involving ${categories}, do not commit — say you will confirm with ${principalName} ` +
    `and call back.`
  );
}

export function callbackRule(principalName: string, callbackNumber: string): string {
  return (
    `If they want to reach ${principalName} or have someone call back, give them this number and ` +
    `only this number: ${callbackNumber}. If they ask what phone number to put on a reservation, ` +
    `order, account, waitlist, request, or booking for ${principalName}, use this same number and ` +
    `do not accept, repeat, or record any other phone number offered during the call. Do not ask ` +
    `the business what phone number to put on the reservation, order, account, waitlist, request, ` +
    `or booking; that is ${principalName}'s number, and you already have it.`
  );
}

/** The closing rail.
 *
 * It used to start at "confirm the outcome", which assumes the outcome is
 * complete. On a live call the model booked an arrival window and agreed a
 * price without the business ever having an address — a booking nobody can act
 * on, closed as though it were done. It answered every question it was asked;
 * nothing asked it to find out what the OTHER side still needed.
 *
 * Deliberately tool-neutral: it says treat the thing as unfinished, not "set
 * status to partial". `record_outcome` may not be declared on a given call, and
 * telling a model to use a tool it does not have is its own defect. */
export const WRAP_UP_RULE =
  "Before ending the call, ask whether they need anything else from you to complete what you have " +
  "arranged — an appointment nobody can act on is not an appointment. Give them whatever this " +
  "brief covers. If they need something it does not cover, say plainly that you will follow up, " +
  "and treat what you arranged as unfinished rather than done. Then confirm the single key " +
  "outcome in one short sentence, thank them and say goodbye. Keep it brief — do not re-list " +
  "every detail or over-recap.";

export function honestIfAsked(principalName: string): string {
  return (
    `If the person directly asks whether you are an AI, a bot, or a real person, answer ` +
    `honestly that you are ${principalName}'s AI assistant, then continue the call naturally. ` +
    `Never volunteer this, and never deny it.`
  );
}

/** Meeting variant of honestIfAsked, composed in its place — never both — when
 * `policy.meeting.announce` is true (see compose.ts's shape-based rail-set
 * selection). Kept rather than dropped: California is all-party-consent with
 * an AI-disclosure expectation, and a participant may ask "is that a bot?" in
 * the waiting room or right after the announcement, while the agent is still
 * on the speaking plane and able to answer.
 *
 * The call-shape wording ends "...then continue the call naturally" — an
 * instruction to keep steering a two-party conversation. That is not merely
 * inapplicable to a meeting, it is impossible to obey on one: a meeting proxy
 * never steers anything, and the instant consent is granted it goes
 * permanently voiceless — `TranscriptionSession` (@parley/core) has no
 * outbound method, a hardware fact, not a policy choice. Reworded to name what
 * actually continues afterward: whatever the agent was already doing before
 * the question interrupted it — waiting for the room, or waiting for the
 * go-ahead — never "the call", which this agent does not carry. */
export function honestIfAskedMeeting(principalName: string): string {
  return (
    `If someone directly asks whether you are an AI, a bot, or a real person, answer honestly ` +
    `that you are ${principalName}'s AI assistant, then go back to exactly what you were doing ` +
    `before the question — waiting for the meeting to start, or waiting for the go-ahead to take ` +
    `notes. Never volunteer this, and never deny it.`
  );
}

/** NEW rail (no old equivalent): proactive disclosure when disclosure.volunteer
 * is true. Not exercised by the three shipped presets (all volunteer:false), so
 * it never appears in the golden fixtures. */
export function volunteerDisclosure(principalName: string): string {
  return `Near the start of the call, state plainly that you are ${principalName}'s AI assistant.`;
}

export function onBehalfIntro(principalName: string, role: string): string {
  return (
    `Open the call by saying you are ${principalName}'s ${role}, calling on ` +
    `${principalName}'s behalf, and then state your purpose in one sentence. Speak warmly ` +
    `and professionally.`
  );
}

export function silentIntro(principalName: string, recipientName?: string): string {
  return (
    `Do not introduce yourself or explain who you are — get straight to the task, handling ` +
    `it on ${principalName}'s behalf` +
    (recipientName ? ` with ${recipientName}` : "") +
    `.`
  );
}

/** The two halves of the current principal-mode framing, split so the composer
 * can emit identity (self) and grounding as separate rails while their
 * concatenation (joined by " ") reproduces the old single paragraph exactly. */
export function selfIdentity(name: string): string {
  return (
    `You are speaking directly with ${name}, the person you belong to and were configured ` +
    `by. Speak to them in the first person, as yourself; no introduction or disclosure is ` +
    `needed.`
  );
}

export function selfTopicSwitch(): string {
  return (
    `You may follow wherever the conversation goes — you are not limited to a single ` +
    `topic on this call.`
  );
}

export function selfGrounding(): string {
  return (
    `Still, answer only from what you actually know and the facts you were given; if you ` +
    `do not know something or do not have it in front of you, say so plainly. ${DEFERRAL_CORE}`
  );
}

export function voicemailLeaveMessage(principalName: string, callbackNumber?: string): string {
  return (
    `If you reach a voicemail, leave a short message saying you are calling on ${principalName}'s ` +
    `behalf about this call's purpose` +
    (callbackNumber ? `, and give the callback number ${callbackNumber}` : "") +
    `, then end.`
  );
}

export const VOICEMAIL_HANGUP =
  "If you reach a voicemail or an automated system you cannot complete the task with, do not leave a message — end the call.";

/** Emitted when `scope.adjacent` is non-empty. Names the permitted extensions
 * and closes the set, so an adjacency list widens the call by exactly what it
 * lists and no further. */
export function adjacentScopeRule(adjacent: readonly string[]): string {
  return (
    `In addition to the objective above, you are permitted to handle the following on this call, ` +
    `and nothing beyond them: ${adjacent.join(" ")}`
  );
}

/** Emitted when `policy.ivr` is present. Situational framing only — the
 * mechanics of pressing a key live in the press_digits tool description, not
 * here, so a caller who declares no execution.ivr never reads about a keypad. */
export function ivrRule(goal: string, menuHints: readonly string[]): string {
  const hints = menuHints.length > 0 ? `${menuHints.join(" ")} ` : "";
  return (
    // "MAY answer" is a possibility, and the model was reading it as a
    // prediction: on the first live call it pressed a key before the far end
    // had made a sound. The rail has to say that finding out comes first.
    `An automated menu may answer before a person does, or a person may answer directly. Find out ` +
    `which by listening — do not assume a menu and do not act until you have heard one. If a menu ` +
    `does answer, work through it to reach ${goal}. ` +
    `${hints}Listen to the whole menu before choosing, and stay on the line until a person answers.`
  );
}

/** Emitted when `brief.preferences` is non-empty. Deliberately weaker than a
 * fact: preferences are reasoned FROM, facts are asserted. Must compose before
 * deferralRule so deferral reads as the fallback for everything they miss.
 * Names the principal rather than taking a pronoun — the principal's pronouns
 * are not something a caller declares. */
export function preferencesRule(principalName: string, preferences: readonly string[]): string {
  return (
    `The following are ${principalName}'s standing preferences. Where a question is covered by them, ` +
    `answer from them as if ${principalName} had told you directly: ${preferences.join(" ")}`
  );
}

/** Emitted when `authority.spend` is present. This is the ONE limit the server
 * cannot enforce — agreeing to a price is speech, and there is no transaction to
 * intercept — so record_outcome captures the agreed amount and an overrun is
 * detected in the call record rather than prevented. */
export function spendRule(
  principalName: string,
  limit: number,
  currency: string,
  basis: string
): string {
  return (
    // The limit is authority, not a talking point. On a live call the model
    // opened with "how much will this visit cost? I'm authorized to pre-approve
    // up to 250 for the service" — handing a vendor the ceiling before they had
    // quoted anything. Any number you announce becomes the quote. Everything in
    // this prompt is audible unless it says otherwise, so the private things
    // have to say so.
    `This limit is PRIVATE. Never say it, never hint at it, never mention having a budget, an ` +
    `approval, or a maximum, and never use it as a negotiating position — ask what something ` +
    `costs and let them name the price first. ` +
    `You may agree to charges up to ${limit} ${currency} in TOTAL ${basis} — the limit is for the ` +
    `whole call added together, not for each item separately. Keep a running total of everything ` +
    `you have agreed to. When they quote a price and the running total stays within the limit, say ` +
    `plainly that the price is fine before moving on, and remember the exact amount so you can ` +
    // The failure this sentence exists for, seen live: the model accepted 210,
    // was then told an extra would be "another $50", and said "great, that's
    // fine". 260 is over a 250 ceiling. It was not ignoring the limit — it was
    // reading each quote on its own, and $50 is obviously under 250. An extra
    // has to be checked against the total it is added to, not against itself.
    `report it at the end of the call. When they add a charge on top of something you already ` +
    `agreed, ADD IT UP FIRST: an extra that takes the running total above ${limit} is above the ` +
    `limit, however small the extra sounds on its own. If the total would go above ${limit}, or if ` +
    `they ask for a deposit, a cancellation fee, a contract, or a card number, do not commit — say ` +
    `you will confirm with ${principalName} and call back.`
  );
}

/** Emitted when `patience.expectLookupPauses` is true. A service rep checking a
 * schedule goes quiet for seconds at a time; the VAD hands the turn back long
 * before they are done. */
export const PATIENCE_RULE =
  "The person you are speaking with may go quiet while they look something up or check a schedule. " +
  "That is normal. Wait for them rather than filling the silence, and do not repeat yourself.";

/** Replaces SCOPE_STATEMENT when `scope.adjacent` is non-empty. The original
 * says "no other scenario available to you", which contradicts a declared
 * adjacency head-on. This keeps the anti-improvisation force verbatim while
 * making room for the listed extensions. */
export const SCOPE_STATEMENT_WITH_ADJACENT =
  "IMPORTANT: this call has one purpose, plus the small number of explicitly permitted extensions " +
  "listed below. You have no other purpose, no other caller, and no other scenario available to you " +
  "beyond those. Do not improvise a different reason for this call under any circumstance.";

/** Replaces VOICEMAIL_HANGUP when `policy.ivr` is present. The original reads
 * "voicemail OR an automated system you cannot complete the task with", which
 * instructs the model to hang up on a phone tree — the single line that ended
 * every business call at second one. With a tree now navigable, only a
 * voicemail is a dead end. */
export const VOICEMAIL_HANGUP_IVR =
  "If you reach a voicemail, do not leave a message — end the call.";

/** The always-defer category list under a spend ceiling: routine fees become
 * committable up to the limit, everything genuinely irreversible does not. */
export const SPEND_NARROWED_DEFER_CATEGORIES =
  "deposits, cancellation charges, contracts, or sensitive personal information";

/** Emitted when `policy.meeting` is present. Five rails, composed in this
 * order by compose.ts's order:15 rail: the agent may dial into a meeting
 * before it starts, so it must recognize a waiting room and stay silent
 * inside one; only once the conversation is genuinely under way does it
 * announce itself (the bridge roster shows only a phone number, so this is
 * the only way anyone learns an AI is on the line); it then asks for consent
 * to take notes, acknowledges once it is granted, and only then stops
 * talking, naming the tool the server independently gates on so "the call
 * kept going" is never read as a yes; if the answer is no it says goodbye and
 * the server takes it off the bridge; and once note-taking begins it stays a
 * notetaker, not a participant. */
/** Two of the five failure modes measured on 2026-08-21's live scenario runs
 * landed inside this rail's window, and neither was a case of the model
 * ignoring it. One run read the scripted hold message back to the room, word
 * for word, three turns running ("--- Please wait. Waiting for the host to join
 * ---"). Another narrated its own state instead. Told not to treat a recording
 * as a person, the model did not — it treated it as something to voice. So the
 * prohibition is now enumerated rather than left to follow from "do not speak":
 * reading a message back and describing what you are hearing are each named,
 * because each was done by a model that was obeying the sentence as written.
 *
 * The next measured round found the same instinct in a form the enumeration
 * still did not reach: told to say nothing, the model said "(Silence)",
 * "(Quietly waiting)" and "... Standing by ...", three runs out of five, and
 * kept doing it after the handoff. Those are not transcription artifacts — no
 * recogniser emits "Standing by", and one of them arrived in the same turn as a
 * real spoken announcement. A model asked to produce a turn will produce
 * SOMETHING, so the closing sentence tells it what to produce instead: end the
 * turn. It is scoped to the whole call rather than the waiting room because the
 * same behaviour appeared on both sides of the consent handoff, and one
 * sentence covering both windows is preferable to the same rule stated twice.
 *
 * ⚠️ THAT SENTENCE FIRST NAMED THE FORBIDDEN STRINGS — "do not fill the turn
 * with ... a description of your own state such as '(silence)' or 'standing
 * by'" — and the very next measured round came back with FOUR of five runs
 * saying "(silence)", lowercase, exactly as it was written in the prompt, where
 * the round before it had produced four different improvisations. Quoting the
 * thing you are forbidding hands the model a ready-made phrase and a context
 * that makes it salient, and it is the same mechanism as every other defect on
 * this page: text in the instruction comes out of the model's mouth. State the
 * rule; never illustrate it with the words you do not want spoken.
 *
 * ⚠️ REMOVING THE PLACEHOLDER BROKE THE WAITING ROOM, which is the finding
 * worth carrying forward. With "(silence)" no longer available the same round
 * came back with the model announcing itself on EVERY waiting-room turn, four
 * times in four of five runs, where the round before it had announced once and
 * correctly. The placeholder had been absorbing the turn. Take the fallback
 * away without giving the model somewhere else to put a turn it must produce,
 * and it reaches for the most salient instruction it has, which is the
 * announcement — into hold music.
 *
 * Two things came out of that. The rail now ENDS on "wait until you hear people
 * talking to one another" rather than on the silence rule, because the last
 * sentence of a rail is the one a model acts on. And the waiting room is named
 * as a thing rather than described as a sound: a message telling you to wait IS
 * the waiting room, not a person speaking to you. Every collapse of this rail
 * has been the model treating an input as somebody to answer. */
export const meetingWaitingRoom = (): string =>
  "You may be held in a waiting room before the meeting starts. Hold music, a recorded message " +
  "such as 'waiting for the host', or silence all mean the meeting has not begun. A message " +
  "telling you to wait or to hold is the waiting room itself, not a person speaking to you, " +
  "and you stay silent through it however many times you hear it. For as long as that is what " +
  "you hear, do not speak, do not announce yourself, do not read a recorded message back, and " +
  "do not describe what you are hearing or what you are waiting for. Whenever you have nothing " +
  "to say on this call, end your turn without speaking: no words at all, no placeholder, no " +
  "description of your own state. Wait until you hear people talking to one another.";

/** The announcement is the only way anyone in the room learns an AI is on the
 * line: the bridge roster shows a phone number and nothing else. That fact used
 * to be IN this rail, as its second sentence — "You appear in the meeting as a
 * phone number, so saying this aloud is the only way anyone learns you are
 * here" — and a live call on 2026-08-21 read it out to the room. The rationale
 * for an instruction is not part of the instruction, and a model told to say
 * who it is, in a rail whose next clause explains why, has been handed two
 * sentences and one imperative. It now lives here, where only a reader sees it.
 *
 * Two more findings from the same runs shape the rest of the wording. The
 * announcement was made FOUR times in one run and five in another, into a
 * waiting room and then again on every later turn — so "say it once, do not
 * repeat it" is replaced by a test the model can apply to its own history at
 * any point in the call ("once you have said it, you have introduced yourself
 * for the whole meeting"), rather than a count it has to have been keeping.
 * And one run announced itself as "here to transcribe this meeting on behalf of
 * Alex Rivera" — an introduction with the disclosure quietly paraphrased out of
 * it, which in California is the one part that is not optional. Hence naming
 * the required words rather than describing the required content. */
export const meetingAnnounce = (principalName: string, purpose: string): string =>
  `The first time you hear people in the meeting talking to one another, and only then, ` +
  `introduce yourself in one sentence: you are an AI assistant on the line for ` +
  `${principalName}, here to ${purpose}. Use the words "AI assistant" — do not describe ` +
  `yourself any other way. Once you have said it you have introduced yourself for the whole ` +
  `meeting: never introduce yourself again, in any wording, whatever anyone says afterwards.`;

/** Two live calls found the same defect: consent granted, then total
 * silence — indistinguishable, from inside the room, from a crash. A first
 * fix (packages/core's drainOutbound before this plane retires) assumed an
 * acknowledgment was being cut off in flight; call
 * `CA7c430ad3a031719e8f98b297628b5b37` proved that theory wrong — the drain
 * confirmed after 142ms, about one syllable, because there was nothing
 * queued to drain. Call `CAa717b30c25f88b2d1b0966da77940a6b` (2026-08-20) is
 * why: "I said go ahead, the agent never acknowledged and stayed silent,"
 * and the persisted `modelTurnsCompleted: 2` shows the begin_notetaking turn
 * DID complete — the model was never instructed to say anything, so it said
 * nothing. The fix has to live in this instruction, not the transport: tell
 * the model to acknowledge, in one sentence, BEFORE the tool call — ordering
 * stated explicitly, because once the tool is called this plane retires and
 * anything left unsaid has nowhere to go. */
/** The same receipt, a second defect: `CA7c430ad3a031719e8f98b297628b5b37`'s
 * transcript has the model saying "Does anyone object to my taking notes?
 * Please say the phrase, 'Go ahead,' to give me the go-ahead." — reciting a
 * passphrase, which the very next clause forbade it from doing. It was not
 * disobedient: `meetingConsentRequest` takes no arguments and never has, so
 * the model was never given the configured phrase to ask for. Told to
 * solicit a specific reply and never to say that reply itself, the only
 * response with no contradiction was to invent one and say it anyway. The
 * instruction demanded an impossible compliance, and got the closest thing
 * to it.
 *
 * This is fixable now because a specific reply was never actually required:
 * the gate (`findConsentMatch` in `@parley/core`) matches on ORDERING — an
 * utterance heard after this request, not before — not on exact wording, and
 * `execution.meeting.consent.additionalPhrases` lets an ordinary "go ahead"
 * or "sure thing" grant consent same as the declared phrase would. So the
 * room only ever needed an open, ordinary question, and the model never
 * needs to know, name, or repeat any accepted wording — for the ask or for
 * the acknowledgment after it, since both are the model's own voice on the
 * same bridge that can mix a leg back as a participant's. */
/** Same call, a third defect: told to "ask the group plainly whether anyone
 * objects", the model complied literally — "I'm here to take notes for
 * [the principal]. Are any of you unhappy with that?" — and that question is negative
 * polarity: the natural way to grant it is a bare "no", which the two-word
 * floor above already refuses on its own, and which substring matching would
 * make catastrophic anyway ("no" sits inside "notes", "know", "now"). Nobody
 * could actually agree in one ordinary word, and the same instruction
 * forbids the model from telling them what would count. The fix is the
 * question's polarity, not its content: asked whether it is ALL RIGHT to
 * take notes, the room's natural agreement is affirmative — "sure", "go
 * ahead", "that's fine" — landing on a phrase like the ones this system
 * actually accepts, instead of on the one word it structurally cannot. */
/** A fourth defect, found afterward on two DIFFERENT live calls — not the
 * incident above, a later pair: both ended `consent_refused` with
 * `modelTurnsCompleted: 4` and no receipt. The operator confirmed by ear
 * that the agent heard the go-ahead, understood, and said "thank you" —
 * twice — and never called `begin_notetaking` at all. The previous fix
 * (above) told the model to acknowledge before going quiet, and worded it
 * "THEN call begin_notetaking — in that order: calling the tool ends your
 * turn immediately, so anything you meant to say has nowhere to go." Read
 * next to the tool's own description (`buildToolDeclarations`,
 * `packages/core/src/execution.ts`: "ends your ability to speak for the rest
 * of the meeting"), that is the SAME warning twice in different words, and
 * no instruction anywhere to actually act — two independent reasons to
 * hesitate, nothing telling the model calling is required. There is also a
 * structural reading: a turn ends when the model finishes generating, and
 * "acknowledge, THEN call" names two sequential steps — inviting exactly
 * what happened, a turn that speaks, completes, and never reaches the call.
 * The fix binds acknowledgment and call into ONE step in ONE turn, states
 * plainly that failing to reach the call is a failure with a repair
 * instruction attached, and drops the duplicate hazard framing — the
 * server-side "do not call before asking" warning now lives exactly once,
 * in the tool description, not here too. */
/** A fifth defect, and the reason this rail lost a third of its length on
 * 2026-08-21: it was the longest thing in the prompt and most of that length
 * was explanation. "both are your own voice on the bridge, and a bridge that
 * mixes your own leg back would return either one as a participant's" is the
 * REASON never to say an accepted phrase aloud; the instruction is "never say
 * one". A model reading a rail where two thirds of the words are justification
 * is being invited to treat the whole thing as prose to deliver, and one live
 * run delivered a neighbouring rail's justification verbatim. Every "because"
 * in this rail is now in this comment, which is where the reasoning was always
 * meant to be read.
 *
 * The reasoning itself, kept in full because it is what the wording above is
 * FOR: the ask must be positive because the gate cannot accept the bare "no"
 * that a negative-polarity question invites; no accepted phrase may ever be
 * spoken by the agent because a bridge that mixes its own leg back would return
 * it as a participant's; and the acknowledgment must be bound into the same
 * turn as the tool call because a turn ends when generation ends, so
 * "acknowledge, then call" names two steps and two live calls took only the
 * first.
 *
 * The closing sentence separates two things this rail had bound together. Asked
 * a question the room simply talks over, the model re-announced itself AND
 * re-asked, in two of five runs — because the rail opens "straight after
 * introducing yourself, in the same turn, ask", so putting the question again
 * meant introducing itself again, which `meetingAnnounce` forbids outright.
 * Asking twice is reasonable and often necessary; introducing yourself twice is
 * the defect. The rail now permits the first and refuses the second rather than
 * leaving a model to choose between two rules it cannot both keep. */
export const meetingConsentRequest = (): string =>
  "Straight after introducing yourself, in the same turn, ask the room one ordinary question: " +
  "whether it is all right if you take notes. Ask it that way round — never ask whether anyone " +
  "objects, minds, or is unhappy. Never say, quote, spell out or hint at any wording that would " +
  "count as an answer — not when you ask, and not when you acknowledge their reply. Then stop " +
  'talking and listen. Only an answer to YOUR question counts: someone saying "sure" or ' +
  '"yes" to another person in the meeting is not agreeing with you. When you hear someone ' +
  "in the room agree with you, you must acknowledge it and call " +
  "begin_notetaking in the SAME turn, not two turns in sequence: say one short sentence that " +
  "you are going quiet now, and call begin_notetaking right there. A turn that acknowledges the " +
  "go-ahead without calling the tool is a failure. If you notice you have already acknowledged " +
  "and have not yet called it, call it now, before saying anything else. If nobody answers you " +
  "and the room carries on talking, you may put the question again later — but ask only the " +
  "question; do not introduce yourself a second time.";

/** What to say when the room says no.
 *
 * Before this, a refused meeting stayed on the bridge, silent, until someone
 * else hung up — the agent had asked a question, been told no, and then simply
 * remained. The product decision is that it leaves.
 *
 * The LEAVING is not in this sentence and must not be read into it. A rail is
 * prose the model may or may not act on, and the one preceding this is a
 * standing demonstration of why that is not a mechanism: told plainly to call
 * `begin_notetaking`, two live calls acknowledged the go-ahead and never
 * called it. So `CallSession` ends a denied meeting itself, on the words it
 * heard, a few seconds after hearing them
 * (`CONSENT_DEPARTURE_GRACE_MS`, @parley/core). This rail owns only the half a
 * server cannot do: putting a goodbye in front of the room before the line
 * drops.
 *
 * Which is why it tells the model it need do nothing to end the call. Naming
 * `end_call` here would be worse than useless — a meeting envelope need not
 * declare `execution.closure` at all, so the tool may not exist, and
 * instructing a model to call a tool it has not been given is the exact shape
 * of the failure above. It also says "do not ask again": a second request
 * after a refusal is pressure, and the gate would refuse the answer anyway
 * while the negation stands.
 *
 * Names no accepted phrase and repeats none, same as `meetingConsentRequest`
 * and for the same reason — this is the model's own voice on a bridge that can
 * mix its leg back as a participant's. */
/** ⚠️ THE CONDITION LEADS, and that is not a stylistic preference. On
 * 2026-08-21 a live scenario run heard a plain go-ahead and answered:
 * "Thank you. I will take notes now. I understand, I will not take notes then.
 * I'm leaving the call now." — the granted branch and this one, both spoken,
 * in one breath, to a room that had just said yes. Written as a standing
 * instruction with its condition buried mid-sentence ("If anyone declines, or
 * asks you not to take notes, that is the answer: ..."), this rail reads as
 * one more thing the agent says, and the model said it.
 *
 * The next measured run showed HOW the model gets there, and it is not what
 * anyone guessed. Every one of five runs called `begin_notetaking` early — a
 * participant answering a colleague with "Sure. We finished the read path last
 * Thursday" reads as agreement — the gate correctly refused with "the go-ahead
 * phrase has not been spoken", and three of the five read THAT refusal as the
 * room declining and said they were leaving. The rail's condition therefore has
 * to exclude the one thing the model was mistaking for it, by name: a refused
 * tool call is not a person. That is a scoping clarification, not a second copy
 * of the tool description's warning — the description says the model may ask
 * again, and says nothing about what a refusal is not.
 *
 * So: the condition is the first five words, and the rail closes by naming its
 * own inapplicability. Composed LAST of the five, after the notetaker scope,
 * for the same reason — the granted path now reads contiguously and the
 * exception sits at the end rather than between the request and its
 * consequence.
 *
 * The leaving itself is still not in this sentence and must not be read into
 * it. A rail is prose the model may or may not act on, and `CallSession` ends a
 * denied meeting itself, on the words it heard, a few seconds after hearing
 * them (`CONSENT_DEPARTURE_GRACE_MS`, @parley/core). This rail owns only the
 * half a server cannot do: putting a goodbye in front of the room before the
 * line drops. Naming `end_call` here would be worse than useless — a meeting
 * envelope need not declare `execution.closure` at all.
 *
 * "Do not ask again" survives the rewrite: a second request after a refusal is
 * pressure, and the gate would refuse the answer anyway while the negation
 * stands. Names no accepted phrase and repeats none, same as
 * `meetingConsentRequest` and for the same reason. */
export const meetingConsentDeclined = (): string =>
  "Only if a person in the meeting tells you not to take notes: say one short sentence — that " +
  "you understand, that you will not take notes, and that you are leaving now — then stop " +
  "speaking. Do not ask again. The call ends by itself moments later and you need do nothing " +
  "else to end it. If nobody has told you that, never say any of this — and begin_notetaking " +
  "coming back refused is not somebody declining, it only means the go-ahead has not been " +
  "spoken yet.";

/** "Do not speak again once note-taking has begun" was obeyed as a description
 * rather than as a prohibition. Three of five live runs on 2026-08-21 kept
 * talking after the handoff, and one of them announced the rail itself back to
 * the room: "--- Notetaking is in progress --- I am to provide an objective
 * transcription of the spoken meeting. I cannot answer questions, offer
 * opinions, or participate in the discussion. Please continue with your
 * meeting." That is this sentence, in the first person, spoken aloud — the
 * model treating its own scope as the next thing to say. The three things it
 * reached for are therefore named and refused by name: confirming, explaining,
 * and stating that it is taking notes. A later round added a fourth, which is
 * the one that would land hardest in a real room: told to go quiet, one run
 * waited until the meeting was wrapping up and then read a formatted summary
 * aloud to everyone — decisions, owners and dates, in list form, ending "Take
 * care." Naming a CATEGORY of action is what works here; naming a literal
 * phrase is what backfires (see `meetingWaitingRoom`'s note on the placeholder
 * this round removed). */
export const meetingNotetakerScope = (): string =>
  "You are a notetaker, not a participant: never answer a question, offer an opinion, or join " +
  "the discussion. Once you have called begin_notetaking you have finished speaking for the " +
  "rest of the meeting — say nothing more at all, not even to confirm, to explain, to state " +
  "that you are taking notes, or to summarise or read back anything you have heard.";

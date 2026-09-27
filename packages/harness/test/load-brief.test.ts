import { describe, expect, it } from "vitest";
import { loadBrief, loadMeetingBrief } from "../src/cli.js";

const bare = { to: "+15555550187", persona: "I am Ada.", objective: "Confirm.", facts: ["x"] };
const envelope = { version: 1, brief: bare, policy: {} };

describe("loadBrief", () => {
  it("returns a bare Brief as-is", () => {
    expect(loadBrief("p", () => JSON.stringify(bare))).toEqual(bare);
  });

  it("unwraps a full call envelope ({version, brief, policy}) to its Brief", () => {
    expect(loadBrief("p", () => JSON.stringify(envelope))).toEqual(bare);
  });
});

describe("loadMeetingBrief", () => {
  it("pulls execution.meeting.brief out of a full envelope", () => {
    const meetingBrief = {
      title: "Roadmap Sync",
      topic: "Q4 scope.",
      role: "product lead",
      track: ["engineering"]
    };
    const withMeeting = {
      ...envelope,
      execution: {
        meeting: { consent: { phrase: "go ahead and take notes" }, brief: meetingBrief }
      }
    };
    expect(loadMeetingBrief("p", () => JSON.stringify(withMeeting))).toEqual(meetingBrief);
  });

  it("is undefined for a bare Brief file — no execution to read at all", () => {
    expect(loadMeetingBrief("p", () => JSON.stringify(bare))).toBeUndefined();
  });

  it("is undefined for a full envelope whose meeting declared no brief", () => {
    const withMeeting = {
      ...envelope,
      execution: { meeting: { consent: { phrase: "go ahead and take notes" } } }
    };
    expect(loadMeetingBrief("p", () => JSON.stringify(withMeeting))).toBeUndefined();
  });

  it("is undefined for a non-meeting envelope — execution present, no meeting block", () => {
    const nonMeeting = { ...envelope, execution: { limits: { maxDurationSeconds: 600 } } };
    expect(loadMeetingBrief("p", () => JSON.stringify(nonMeeting))).toBeUndefined();
  });
});

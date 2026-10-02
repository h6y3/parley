import { muLawDecode } from "@parley/audio";

const SAMPLE_RATE = 8000;
const SILENCE = 0xff; // μ-law zero

export interface Timeline {
  startedAtMs: number;
  sampleRate: 8000;
  channels: { agent: "L"; callee: "R" };
  events: { atMs: number; event: string }[];
  /** What the simulated callee said, in order. */
  calleeText: string[];
}

/** One mono channel of μ-law, placed by arrival time on the shared sample clock. */
class Track {
  private chunks: Buffer[] = [];
  private cursor = 0;

  get length(): number {
    return this.cursor;
  }

  push(frame: Buffer, atSample: number): void {
    // A frame arriving before the cursor queues behind the previous one.
    const start = Math.max(this.cursor, atSample);
    if (start > this.cursor) this.chunks.push(Buffer.alloc(start - this.cursor, SILENCE));
    this.chunks.push(frame);
    this.cursor = start + frame.length;
  }

  /** Cut the track back to `samples` if it runs past it. Audio queued beyond
   * that point was never played and is discarded. */
  truncateTo(samples: number): void {
    if (this.cursor <= samples) return;
    this.chunks = [Buffer.from(Buffer.concat(this.chunks).subarray(0, samples))];
    this.cursor = samples;
  }

  padTo(samples: number): Buffer {
    const tail = samples > this.cursor ? [Buffer.alloc(samples - this.cursor, SILENCE)] : [];
    return Buffer.concat([...this.chunks, ...tail]);
  }
}

function wavHeader(channels: number, dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export class CaptureRecorder {
  private readonly startedAtMs: number;
  private readonly agentTrack = new Track();
  private readonly calleeTrack = new Track();
  private readonly events: { atMs: number; event: string }[] = [];
  private readonly calleeLines: string[] = [];

  constructor(private readonly now: () => number) {
    this.startedAtMs = now();
  }

  private sampleNow(): number {
    return Math.max(0, Math.round(((this.now() - this.startedAtMs) * SAMPLE_RATE) / 1000));
  }

  /** μ-law 8 kHz frame as received from Twilio (agent audio). */
  agent(frame: Buffer): void {
    this.agentTrack.push(frame, this.sampleNow());
  }

  /** μ-law 8 kHz frame as sent to Twilio (callee audio). */
  callee(frame: Buffer): void {
    this.calleeTrack.push(frame, this.sampleNow());
  }

  /** Barge-in: Twilio's outbound buffer was cleared, so callee audio queued
   * beyond the current clock will never be played. Drop it, or it reads as
   * speech the agent talked over. */
  clearCallee(): void {
    this.calleeTrack.truncateTo(this.sampleNow());
  }

  mark(event: string): void {
    this.events.push({ atMs: this.now() - this.startedAtMs, event });
  }

  calleeSaid(text: string): void {
    this.calleeLines.push(text);
  }

  finish(): { wav: Buffer; timeline: Timeline } {
    const total = Math.max(this.agentTrack.length, this.calleeTrack.length);
    const l = muLawDecode(this.agentTrack.padTo(total));
    const r = muLawDecode(this.calleeTrack.padTo(total));
    const data = Buffer.allocUnsafe(total * 4);
    for (let i = 0; i < total; i++) {
      data.writeInt16LE(l[i], i * 4);
      data.writeInt16LE(r[i], i * 4 + 2);
    }
    return {
      wav: Buffer.concat([wavHeader(2, data.length), data]),
      timeline: {
        startedAtMs: this.startedAtMs,
        sampleRate: SAMPLE_RATE,
        channels: { agent: "L", callee: "R" },
        events: [...this.events],
        calleeText: [...this.calleeLines]
      }
    };
  }
}

/** Split a stereo capture WAV (L=agent, R=callee) into two mono 8 kHz WAVs. */
export function splitStereo(wav: Buffer): { agent: Buffer; callee: Buffer } {
  const frames = (wav.length - 44) >> 2;
  const a = Buffer.allocUnsafe(frames * 2);
  const c = Buffer.allocUnsafe(frames * 2);
  for (let i = 0; i < frames; i++) {
    a.writeInt16LE(wav.readInt16LE(44 + i * 4), i * 2);
    c.writeInt16LE(wav.readInt16LE(44 + i * 4 + 2), i * 2);
  }
  return {
    agent: Buffer.concat([wavHeader(1, a.length), a]),
    callee: Buffer.concat([wavHeader(1, c.length), c])
  };
}

import type { AudioEncoding, AudioFrame } from "./types.js";
import { encodingEquals, formatEncoding } from "./types.js";

export type FrameConverter = (frame: AudioFrame, to: AudioEncoding) => AudioFrame;

/** Adapts frames from whatever a source produces to whatever a sink accepts.
 *
 * @parley/core carries no DSP: the conversion function is injected (the caller
 * passes @parley/audio's `convert`), exactly as AudioCodec already is. The
 * counters exist so a pass-through is observable — "it worked because both
 * vendors spoke mu-law" and "it worked because we converted" must not look
 * identical from outside. */
export class AudioBridge {
  private conversionCount = 0;
  private passThroughCount = 0;

  constructor(
    private readonly accepts: readonly AudioEncoding[],
    private readonly converter: FrameConverter
  ) {
    if (accepts.length === 0) {
      throw new Error("AudioBridge requires a sink that accepts at least one encoding");
    }
  }

  adapt(frame: AudioFrame): AudioFrame {
    if (this.accepts.some((e) => encodingEquals(e, frame.encoding))) {
      this.passThroughCount += 1;
      return frame;
    }
    const target = this.accepts[0] as AudioEncoding;
    const out = this.converter(frame, target);
    if (!encodingEquals(out.encoding, target)) {
      throw new Error(
        `converter returned ${formatEncoding(out.encoding)}, expected ${formatEncoding(target)}`
      );
    }
    this.conversionCount += 1;
    return out;
  }

  get conversions(): number {
    return this.conversionCount;
  }
  get passThroughs(): number {
    return this.passThroughCount;
  }
}

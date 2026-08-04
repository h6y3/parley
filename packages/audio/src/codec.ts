import type { AudioCodec, AudioFrame } from "@parley/core";
import { muLawDecode, muLawEncode } from "./mulaw.js";
import { pcm16BufferToSamples, samplesToPcm16Buffer } from "./pcm.js";
import { decimateBy3, resampleLinear } from "./resample.js";

/** The default V1 audio bridge: G.711 μ-law ↔ PCM with the resampling paths
 * design spec §4.5 requires. Stateless; safe to share across calls. */
export function createAudioCodec(): AudioCodec {
  return {
    decodeInbound(frame: AudioFrame): AudioFrame {
      const pcm8k = muLawDecode(frame.data);
      const pcm16k = resampleLinear(pcm8k, 8000, 16000);
      return { encoding: "pcm16k", data: samplesToPcm16Buffer(pcm16k) };
    },
    encodeOutbound(frame: AudioFrame): AudioFrame {
      const pcm24k = pcm16BufferToSamples(frame.data);
      const pcm8k = decimateBy3(pcm24k);
      return { encoding: "mulaw8k", data: muLawEncode(pcm8k) };
    }
  };
}

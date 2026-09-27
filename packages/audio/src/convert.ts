import type { AudioEncoding, AudioFrame } from "@parley/core";
import { encodingEquals, formatEncoding, MULAW_8K, PCM_16K, PCM_24K } from "@parley/core";
import { muLawDecode, muLawEncode } from "./mulaw.js";
import { pcm16BufferToSamples, samplesToPcm16Buffer } from "./pcm.js";
import { decimateBy3, resampleLinear } from "./resample.js";

/** Convert one frame between the encodings Parley speaks.
 *
 * A matching encoding returns the SAME object — an identity conversion that is
 * measured and named, rather than a bypass around the bridge. That distinction
 * is the point: routing raw carrier frames past the codec because two vendors
 * happen to agree does not remove the coupling, it relocates it somewhere with
 * no test on it. */
export function convert(frame: AudioFrame, to: AudioEncoding): AudioFrame {
  if (encodingEquals(frame.encoding, to)) return frame;

  if (encodingEquals(frame.encoding, MULAW_8K) && encodingEquals(to, PCM_16K)) {
    return {
      encoding: to,
      data: samplesToPcm16Buffer(resampleLinear(muLawDecode(frame.data), 8000, 16000))
    };
  }
  if (encodingEquals(frame.encoding, PCM_24K) && encodingEquals(to, MULAW_8K)) {
    return { encoding: to, data: muLawEncode(decimateBy3(pcm16BufferToSamples(frame.data))) };
  }
  if (encodingEquals(frame.encoding, PCM_16K) && encodingEquals(to, MULAW_8K)) {
    return {
      encoding: to,
      data: muLawEncode(resampleLinear(pcm16BufferToSamples(frame.data), 16000, 8000))
    };
  }
  throw new Error(
    `no conversion path from ${formatEncoding(frame.encoding)} to ${formatEncoding(to)}`
  );
}

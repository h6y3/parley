import type { AudioEncoding, AudioFrame } from "@parley/core";
import { encodingEquals, formatEncoding, MULAW_8K, PCM_16K, PCM_24K } from "@parley/core";
import { muLawDecode, muLawEncode } from "./mulaw.js";
import { pcm16BufferToSamples, samplesToPcm16Buffer } from "./pcm.js";
import { decimateBy3, resampleLinear } from "./resample.js";

type Path = {
  from: AudioEncoding;
  to: AudioEncoding;
  run: (data: Buffer) => Buffer;
};

/** Every non-identity conversion Parley implements. `convert` dispatches from
 * this table and `canConvert` answers from it, so the question "is there a
 * path?" cannot drift from what `convert` actually does. */
const PATHS: readonly Path[] = [
  {
    from: MULAW_8K,
    to: PCM_16K,
    run: (data) => samplesToPcm16Buffer(resampleLinear(muLawDecode(data), 8000, 16000))
  },
  {
    from: PCM_24K,
    to: MULAW_8K,
    run: (data) => muLawEncode(decimateBy3(pcm16BufferToSamples(data)))
  },
  {
    from: PCM_16K,
    to: MULAW_8K,
    run: (data) => muLawEncode(resampleLinear(pcm16BufferToSamples(data), 16000, 8000))
  }
];

function findPath(from: AudioEncoding, to: AudioEncoding): Path | undefined {
  return PATHS.find((p) => encodingEquals(p.from, from) && encodingEquals(p.to, to));
}

/** Whether `convert` can take a frame from one encoding to the other. Lets a
 * caller refuse an unbridgeable provider/carrier pairing up front, before
 * anything is dialled, instead of discovering it as a throw mid-call. */
export function canConvert(from: AudioEncoding, to: AudioEncoding): boolean {
  return encodingEquals(from, to) || findPath(from, to) !== undefined;
}

/** Convert one frame between the encodings Parley speaks.
 *
 * A matching encoding returns the SAME object — an identity conversion that is
 * measured and named, rather than a bypass around the bridge. That distinction
 * is the point: routing raw carrier frames past the codec because two vendors
 * happen to agree does not remove the coupling, it relocates it somewhere with
 * no test on it. */
export function convert(frame: AudioFrame, to: AudioEncoding): AudioFrame {
  if (encodingEquals(frame.encoding, to)) return frame;

  const path = findPath(frame.encoding, to);
  if (path) return { encoding: to, data: path.run(frame.data) };
  throw new Error(
    `no conversion path from ${formatEncoding(frame.encoding)} to ${formatEncoding(to)}`
  );
}

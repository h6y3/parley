import type { AudioCodec, AudioFrame } from "@parley/core";
import { dtmfMuLaw } from "./dtmf.js";

/** The default `AudioCodec`: in-band DTMF as carrier-ready mu-law. Stateless;
 * safe to share across calls.
 *
 * The speaking plane's μ-law ↔ PCM conversions used to live here too, fixed
 * to one vendor's rates. They are `convert`'s job now, chosen per call from
 * what the realtime provider declares — see `convert.ts`. */
export function createAudioCodec(): AudioCodec {
  return {
    dtmfTones(digits: string): AudioFrame {
      return dtmfMuLaw(digits);
    }
  };
}

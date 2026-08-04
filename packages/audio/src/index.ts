export const PACKAGE_NAME = "@parley/audio";

export { muLawDecode, muLawDecodeSample, muLawEncode, muLawEncodeSample } from "./mulaw.js";
export { pcm16BufferToSamples, samplesToPcm16Buffer } from "./pcm.js";
export { decimateBy3, resampleLinear } from "./resample.js";
export { createAudioCodec } from "./codec.js";

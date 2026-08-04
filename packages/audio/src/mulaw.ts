// ITU-T G.711 μ-law. BIAS and CLIP are the standard constants.
const MU_LAW_BIAS = 0x84; // 132
const MU_LAW_CLIP = 32635; // 32767 - BIAS

/** Encode one 16-bit signed PCM sample to a μ-law byte (0–255). */
export function muLawEncodeSample(sample: number): number {
  let s = Math.max(-MU_LAW_CLIP, Math.min(MU_LAW_CLIP, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0x00;
  if (s < 0) s = -s;
  s += MU_LAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode one μ-law byte back to a 16-bit signed PCM sample. */
export function muLawDecodeSample(muLawByte: number): number {
  const u = ~muLawByte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + MU_LAW_BIAS) << exponent) - MU_LAW_BIAS;
  return sign ? -magnitude : magnitude;
}

/** Decode a μ-law byte buffer (8-bit/sample) to 16-bit PCM samples. */
export function muLawDecode(mulaw: Buffer): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) out[i] = muLawDecodeSample(mulaw[i]);
  return out;
}

/** Encode 16-bit PCM samples to a μ-law byte buffer (8-bit/sample). */
export function muLawEncode(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = muLawEncodeSample(pcm[i]);
  return out;
}

/**
 * General linear-interpolation resampler for 16-bit PCM. Used for the inbound
 * 8kHz→16kHz upsample and (elsewhere) for fixture rate conversion. Linear
 * interpolation is a mild low-pass; for the aggressive downsample direction use
 * a dedicated decimator (`decimateBy3`) rather than this.
 */
export function resampleLinear(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input.slice();
  if (input.length === 0) return new Int16Array(0);
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Int16Array(outLen);
  const ratio = outLen === 1 ? 0 : (input.length - 1) / (outLen - 1);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx];
    const b = idx + 1 < input.length ? input[idx + 1] : a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/**
 * Decimate 24kHz PCM to 8kHz by a 3-sample boxcar average — an anti-aliased ÷3
 * decimation (design spec §4.5's "no naive downsample"). Trailing samples that
 * do not fill a group of three are dropped.
 */
export function decimateBy3(input: Int16Array): Int16Array {
  const outLen = Math.floor(input.length / 3);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = Math.round((input[3 * i] + input[3 * i + 1] + input[3 * i + 2]) / 3);
  }
  return out;
}

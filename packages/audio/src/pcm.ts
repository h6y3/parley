/** Read a little-endian 16-bit PCM byte Buffer into signed samples. */
export function pcm16BufferToSamples(buf: Buffer): Int16Array {
  const count = buf.length >> 1;
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** Write signed 16-bit PCM samples to a little-endian byte Buffer. */
export function samplesToPcm16Buffer(samples: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], i * 2);
  return out;
}

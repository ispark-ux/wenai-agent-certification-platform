/**
 * AudioWorklet processor: converts the microphone input (float32 at the
 * AudioContext sample rate) into 16-bit PCM mono at the target sample rate
 * (16 kHz for Gemini Live) and posts ~100 ms chunks to the main thread.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetSampleRate || 16000;
    this.chunkSamples = opts.chunkSamples || Math.round(this.targetRate / 10); // 100 ms
    this.ratio = sampleRate / this.targetRate;
    this.pending = new Float32Array(0);
    this.out = [];
    this.sumSquares = 0;
    this.count = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const channel = input[0];

    // Merge leftover + new samples
    const merged = new Float32Array(this.pending.length + channel.length);
    merged.set(this.pending, 0);
    merged.set(channel, this.pending.length);

    // Linear-interpolation resample to the target rate
    const outCount = Math.floor((merged.length - 1) / this.ratio);
    for (let i = 0; i < outCount; i += 1) {
      const pos = i * this.ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      let s = merged[idx] * (1 - frac) + merged[idx + 1] * frac;
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      this.sumSquares += s * s;
      this.count += 1;
      this.out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
    }
    const consumed = Math.floor(outCount * this.ratio);
    this.pending = merged.slice(consumed);

    if (this.out.length >= this.chunkSamples) {
      const int16 = new Int16Array(this.out.length);
      for (let i = 0; i < this.out.length; i += 1) int16[i] = this.out[i];
      const level = this.count ? Math.sqrt(this.sumSquares / this.count) : 0;
      this.port.postMessage({ pcm: int16.buffer, level, samples: int16.length }, [int16.buffer]);
      this.out = [];
      this.sumSquares = 0;
      this.count = 0;
    }
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);

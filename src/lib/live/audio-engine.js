/**
 * AudioEngine - one AudioContext for the whole live certification:
 *
 *  microphone ──► AudioWorklet (resample → PCM16 @16 kHz) ──► onMicChunk(base64) ──► Gemini Live
 *                         │
 *                         └──► mixed recorder (MediaStreamDestination) ──► audio.webm
 *  Gemini audio (PCM16 @24 kHz) ──► scheduled AudioBufferSources ──► speakers + mixed recorder
 *
 * Half-duplex (default on): while the AI customer is speaking (and for a short
 * tail afterwards) the microphone frames sent to Gemini are replaced by silence.
 * This stops the AI's own voice (speaker → mic echo) from being treated as the
 * agent talking, which otherwise makes the model interrupt itself and respond
 * slower and slower as the call goes on. The mixed recording still contains the
 * real microphone audio at all times.
 */

const SILENCE_TAIL_SECONDS = 0.35;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

function parseRate(mimeType, fallback = 24000) {
  const m = /rate=(\d+)/.exec(mimeType || "");
  return m ? Number(m[1]) : fallback;
}

export function pickAudioMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || "";
}

export class AudioEngine {
  constructor({ onMicChunk, onLog, halfDuplex = true } = {}) {
    this.onMicChunk = onMicChunk;
    this.onLog = onLog || (() => {});
    this.halfDuplex = halfDuplex;
    this.ctx = null;
    this.micEnabled = false;
    this.nextPlayTime = 0;
    this.activeSources = new Set();
    this.recorder = null;
    this.recordedChunks = [];
    this.recordingStartedAt = null;
    this.inputSampleRate = 16000;
    this.silenceBase64 = null;
    this.gatedChunks = 0;
    this.sentChunks = 0;
    this._audioResult = null;
    this._levelBuf = null;
  }

  /** Must be called from (or shortly after) a user gesture so the context can start. */
  async init(micStream) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("Web Audio API is not supported in this browser.");
    this.ctx = new Ctx({ latencyHint: "interactive" });
    if (this.ctx.state === "suspended") await this.ctx.resume();
    if (!this.ctx.audioWorklet) throw new Error("AudioWorklet is not supported in this browser. Please use a recent Chrome/Edge.");
    await this.ctx.audioWorklet.addModule("/worklets/pcm-processor.js");

    // Output chain (AI voice → speakers)
    this.outGain = this.ctx.createGain();
    this.outAnalyser = this.ctx.createAnalyser();
    this.outAnalyser.fftSize = 256;
    this.outGain.connect(this.outAnalyser);
    this.outAnalyser.connect(this.ctx.destination);

    // Mixed conversation recorder destination
    this.recDest = this.ctx.createMediaStreamDestination();
    this.outGain.connect(this.recDest);

    // Microphone chain
    this.micSource = this.ctx.createMediaStreamSource(micStream);
    this.micAnalyser = this.ctx.createAnalyser();
    this.micAnalyser.fftSize = 256;
    const chunkSamples = Math.round(this.inputSampleRate / 10); // 100 ms
    this.worklet = new AudioWorkletNode(this.ctx, "pcm-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { targetSampleRate: this.inputSampleRate, chunkSamples },
    });
    this.silenceBase64 = arrayBufferToBase64(new ArrayBuffer(chunkSamples * 2));
    this.worklet.port.onmessage = (e) => {
      const { pcm } = e.data || {};
      if (!this.micEnabled || !pcm || !this.onMicChunk) return;
      if (this.isGated()) {
        this.gatedChunks += 1;
        this.onMicChunk(this.silenceBase64, this.inputSampleRate);
        return;
      }
      this.sentChunks += 1;
      this.onMicChunk(arrayBufferToBase64(pcm), this.inputSampleRate);
    };
    this.micSource.connect(this.micAnalyser);
    this.micAnalyser.connect(this.worklet);
    // Worklets only run while connected to the graph; route through a muted gain.
    this.silentSink = this.ctx.createGain();
    this.silentSink.gain.value = 0;
    this.worklet.connect(this.silentSink);
    this.silentSink.connect(this.ctx.destination);
    // Mic also goes to the mixed recording (never to the speakers).
    this.micSource.connect(this.recDest);

    this.onLog({ level: "info", message: `AudioEngine ready (context ${this.ctx.sampleRate} Hz → mic ${this.inputSampleRate} Hz PCM16, half-duplex ${this.halfDuplex ? "on" : "off"})` });
  }

  setMicEnabled(enabled) {
    this.micEnabled = Boolean(enabled);
  }

  setHalfDuplex(enabled) {
    this.halfDuplex = Boolean(enabled);
  }

  /** True while the AI is speaking (plus a short tail) and half-duplex is on. */
  isGated() {
    if (!this.halfDuplex || !this.ctx) return false;
    return this.nextPlayTime > this.ctx.currentTime - SILENCE_TAIL_SECONDS;
  }

  async resume() {
    if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume();
  }

  // ---- playback -----------------------------------------------------------
  playPcmChunk(base64, mimeType) {
    if (!this.ctx) return;
    const rate = parseRate(mimeType, 24000);
    const int16 = base64ToInt16(base64);
    if (!int16.length) return;
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i += 1) float32[i] = int16[i] / 32768;

    const buffer = this.ctx.createBuffer(1, float32.length, rate);
    buffer.copyToChannel(float32, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outGain);

    const now = this.ctx.currentTime;
    const startAt = Math.max(now + 0.03, this.nextPlayTime);
    source.start(startAt);
    this.nextPlayTime = startAt + buffer.duration;
    this.activeSources.add(source);
    source.onended = () => this.activeSources.delete(source);
  }

  interruptPlayback() {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.activeSources.clear();
    this.nextPlayTime = 0;
  }

  isPlaying() {
    return Boolean(this.ctx) && this.nextPlayTime > this.ctx.currentTime + 0.01;
  }

  // ---- levels (0..1) ------------------------------------------------------
  _rms(analyser) {
    if (!analyser) return 0;
    if (!this._levelBuf || this._levelBuf.length !== analyser.fftSize) this._levelBuf = new Uint8Array(analyser.fftSize);
    const data = this._levelBuf;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / data.length) * 2.5);
  }

  /** Cheap snapshot for the UI meters (called from a small polling component). */
  getLevels() {
    return { mic: this._rms(this.micAnalyser), out: this._rms(this.outAnalyser), aiSpeaking: this.isPlaying(), gated: this.isGated() };
  }

  // ---- mixed conversation recording -------------------------------------
  startConversationRecorder() {
    if (!this.recDest || typeof MediaRecorder === "undefined") return false;
    const mimeType = pickAudioMimeType();
    try {
      this.recorder = new MediaRecorder(this.recDest.stream, mimeType ? { mimeType, audioBitsPerSecond: 48000 } : { audioBitsPerSecond: 48000 });
    } catch (err) {
      this.onLog({ level: "warn", message: `Conversation recorder unavailable: ${err.message}` });
      this.recorder = null;
      return false;
    }
    this.recordedChunks = [];
    this._audioResult = null;
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
    };
    this.recorder.start(2000);
    this.recordingStartedAt = new Date().toISOString();
    this.onLog({ level: "info", message: `Conversation audio recorder started (${this.recorder.mimeType || mimeType || "default"})` });
    return true;
  }

  stopConversationRecorder() {
    return new Promise((resolve) => {
      const recorder = this.recorder;
      if (!recorder || recorder.state === "inactive") {
        resolve(this._buildAudioResult());
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(this._buildAudioResult());
      };
      recorder.onstop = finish;
      recorder.onerror = finish;
      try {
        recorder.requestData();
        recorder.stop();
      } catch {
        finish();
      }
      setTimeout(finish, 4000);
    });
  }

  _buildAudioResult() {
    if (this._audioResult) return this._audioResult;
    const type = (this.recorder && this.recorder.mimeType) || pickAudioMimeType() || "audio/webm";
    const blob = new Blob(this.recordedChunks, { type });
    const endedAt = new Date().toISOString();
    const started = this.recordingStartedAt ? new Date(this.recordingStartedAt).getTime() : Date.now();
    this._audioResult = {
      blob,
      mimeType: type,
      startedAt: this.recordingStartedAt,
      endedAt,
      durationSeconds: Math.max(0, Math.round((Date.now() - started) / 1000)),
      chunks: this.recordedChunks.length,
    };
    return this._audioResult;
  }

  async destroy() {
    this.micEnabled = false;
    this.interruptPlayback();
    try {
      if (this.worklet) this.worklet.port.onmessage = null;
      if (this.micSource) this.micSource.disconnect();
      if (this.worklet) this.worklet.disconnect();
    } catch {
      /* ignore */
    }
    if (this.ctx && this.ctx.state !== "closed") {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.ctx = null;
  }
}

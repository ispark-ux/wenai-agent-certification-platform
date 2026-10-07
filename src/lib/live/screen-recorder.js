/**
 * Screen capture + recording via the Screen Capture API and MediaRecorder.
 *
 * Capture is deliberately light: max 1920x1080, ~5 fps, VP8 at ~600 kbps. Screen
 * content is mostly static, so this stays perfectly readable for the Gemini
 * video analysis while keeping CPU usage low (a 1080p VP9 @ 15 fps recording
 * makes the whole tab sluggish on typical agent laptops) and files small
 * (roughly 2-5 MB per minute instead of 10+).
 */

const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const TARGET_FPS = 5;
const VIDEO_BITS_PER_SECOND = 600000;
const TIMESLICE_MS = 2000;

export function isScreenCaptureSupported() {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

export function isSecureContextForMedia() {
  if (typeof window === "undefined") return true;
  return window.isSecureContext || ["localhost", "127.0.0.1"].includes(window.location.hostname);
}

export function describeMediaError(err, kind) {
  const name = err && err.name;
  const label = kind === "screen" ? "Screen sharing" : "Microphone";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return `${label} permission was denied. Please allow it in the browser prompt (and in the site/OS privacy settings) and try again.`;
    case "NotFoundError":
      return kind === "screen" ? "No screen/window could be captured on this device." : "No microphone was found on this device.";
    case "NotReadableError":
    case "AbortError":
      return `${label} could not be started - it may be in use by another application.`;
    case "OverconstrainedError":
      return `${label} constraints could not be satisfied by this device.`;
    case "TypeError":
      return `${label} is not available in this context. The page must be served over HTTPS or localhost.`;
    default:
      return `${label} error: ${(err && err.message) || "unknown error"}`;
  }
}

export async function requestScreenStream() {
  if (!isSecureContextForMedia()) {
    throw new Error("Screen recording requires a secure context. Open this page over HTTPS or on localhost.");
  }
  if (!isScreenCaptureSupported()) {
    throw new Error("This browser does not support screen capture (getDisplayMedia). Please use Chrome, Edge or Firefox on desktop.");
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "monitor", width: { max: MAX_WIDTH }, height: { max: MAX_HEIGHT }, frameRate: { ideal: TARGET_FPS, max: 8 } },
    audio: false,
  });
  // Some browsers ignore constraints in getDisplayMedia - apply them again on the track.
  const track = stream.getVideoTracks()[0];
  if (track && typeof track.applyConstraints === "function") {
    track.applyConstraints({ width: { max: MAX_WIDTH }, height: { max: MAX_HEIGHT }, frameRate: { ideal: TARGET_FPS, max: 8 } }).catch(() => {});
  }
  return stream;
}

export async function requestMicrophoneStream() {
  if (!isSecureContextForMedia()) {
    throw new Error("Microphone access requires a secure context. Open this page over HTTPS or on localhost.");
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("This browser does not support microphone capture (getUserMedia).");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

export function describeScreenSurface(stream) {
  const track = stream && stream.getVideoTracks()[0];
  if (!track) return "";
  const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
  const surface = settings.displaySurface || "screen";
  const size = settings.width && settings.height ? ` ${settings.width}x${settings.height}` : "";
  return `${surface}${size}${track.label ? ` - ${track.label}` : ""}`;
}

export function pickVideoMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  // VP8 first: far cheaper to encode than VP9 and universally decodable (browser + Gemini).
  const candidates = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm", "video/mp4"];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || "";
}

export class ScreenRecorder {
  constructor(stream, { onLog } = {}) {
    this.stream = stream;
    this.onLog = onLog || (() => {});
    this.recorder = null;
    this.chunks = [];
    this.bytes = 0;
    this.startedAt = null;
    this.endedAt = null;
    this.result = null;
  }

  start() {
    if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder is not supported in this browser.");
    const mimeType = pickVideoMimeType();
    const options = { videoBitsPerSecond: VIDEO_BITS_PER_SECOND };
    if (mimeType) options.mimeType = mimeType;
    this.recorder = new MediaRecorder(this.stream, options);
    this.chunks = [];
    this.bytes = 0;
    this.result = null;
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.chunks.push(e.data);
        this.bytes += e.data.size;
      }
    };
    this.recorder.onerror = (e) => this.onLog({ level: "error", message: `Screen recorder error: ${(e.error && e.error.message) || "unknown"}` });
    this.recorder.start(TIMESLICE_MS);
    this.startedAt = new Date().toISOString();
    this.onLog({ level: "info", message: `Screen recording started (${this.recorder.mimeType || mimeType || "default"}, ${TARGET_FPS} fps, ${Math.round(VIDEO_BITS_PER_SECOND / 1000)} kbps)` });
  }

  get isRecording() {
    return Boolean(this.recorder && this.recorder.state === "recording");
  }

  stop(reason = "ended") {
    return new Promise((resolve) => {
      if (this.result) {
        resolve(this.result);
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return resolve(this.result);
        done = true;
        this.endedAt = new Date().toISOString();
        const type = (this.recorder && this.recorder.mimeType) || pickVideoMimeType() || "video/webm";
        const blob = new Blob(this.chunks, { type });
        const started = this.startedAt ? new Date(this.startedAt).getTime() : Date.now();
        this.result = {
          blob,
          mimeType: type,
          startedAt: this.startedAt,
          endedAt: this.endedAt,
          durationSeconds: Math.max(0, Math.round((new Date(this.endedAt).getTime() - started) / 1000)),
          chunks: this.chunks.length,
          reason,
        };
        this.chunks = [];
        this.onLog({ level: "info", message: `Screen recording stopped (${(blob.size / (1024 * 1024)).toFixed(2)} MB, ${this.result.chunks} chunks)` });
        return resolve(this.result);
      };
      if (!this.recorder || this.recorder.state === "inactive") {
        finish();
        return;
      }
      this.recorder.onstop = finish;
      try {
        this.recorder.requestData();
        this.recorder.stop();
      } catch {
        finish();
      }
      setTimeout(finish, 4000);
    });
  }
}

export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  }
}

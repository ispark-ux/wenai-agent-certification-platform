/**
 * Minimal, transparent Gemini Live API (BidiGenerateContent) WebSocket client.
 *
 * The browser connects DIRECTLY to Gemini using a single-use ephemeral token
 * issued by our backend (/api/live-token). The permanent API key never reaches
 * the browser and the token is never logged in full.
 *
 * Wire protocol (JSON frames):
 *   -> { setup: {...} }                                  first message
 *   <- { setupComplete: {} }                             must arrive before anything else
 *   -> { realtimeInput: { audio: { data, mimeType } } }  16 kHz PCM16 mono, base64
 *   -> { clientContent: { turns:[...], turnComplete } }  text turns (used to trigger the customer opening)
 *   <- { serverContent: { modelTurn, inputTranscription, outputTranscription, turnComplete, interrupted } }
 *   <- { goAway: { timeLeft } }
 */

const CLOSE_CODE_HINTS = {
  1000: "Normal closure",
  1001: "Endpoint going away",
  1006: "Connection dropped abnormally (network, proxy or server closed without a close frame)",
  1007: "Invalid payload - usually an unsupported model name or malformed setup/config",
  1008: "Policy violation - usually an invalid/expired token, quota exhaustion or an API key problem",
  1011: "Gemini internal server error",
  1013: "Gemini is temporarily overloaded - try again",
};

function shortToken(token) {
  if (!token) return "(none)";
  return `${token.slice(0, 14)}…${token.slice(-4)} (len ${token.length})`;
}

export class GeminiLiveClient {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.ws = null;
    this.setupDone = false;
    this.closedByClient = false;
    this.setupTimer = null;
    this.connectTimer = null;
    this.closeInfo = null;
    this.audioChunksSent = 0;
    this.audioChunksReceived = 0;
  }

  log(level, message, data) {
    if (this.handlers.onLog) this.handlers.onLog({ level, message, data, timestamp: new Date().toISOString() });
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`[GeminiLive] ${message}`, data || "");
  }

  get isOpen() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  /**
   * Opens the socket, sends setup, resolves once `setupComplete` is received.
   * Rejects on connection timeout, setup timeout, socket error, early close or
   * an explicit Gemini error frame.
   */
  connect({ wsUrl, token, setup, connectTimeoutMs = 10000, setupTimeoutMs = 15000 }) {
    return new Promise((resolve, reject) => {
      if (!wsUrl || !token || !setup) {
        reject(new Error("Live token response is incomplete (missing ws_url/token/setup)."));
        return;
      }
      this.setupDone = false;
      this.closedByClient = false;
      this.closeInfo = null;
      let settled = false;

      const clearTimers = () => {
        if (this.connectTimer) clearTimeout(this.connectTimer);
        if (this.setupTimer) clearTimeout(this.setupTimer);
        this.connectTimer = null;
        this.setupTimer = null;
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        this.log("error", error.message);
        try {
          if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close(1000, "client aborting");
        } catch {
          /* ignore */
        }
        reject(error);
      };

      const url = `${wsUrl}?access_token=${token}`;
      this.log("info", "Opening WebSocket to Gemini Live", { endpoint: wsUrl, token: shortToken(token), model: setup.model });

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        fail(new Error(`WebSocket could not be created: ${err.message}`));
        return;
      }
      this.ws = ws;
      ws.binaryType = "arraybuffer";

      this.connectTimer = setTimeout(() => {
        fail(new Error(`WebSocket connection to Gemini Live timed out after ${Math.round(connectTimeoutMs / 1000)}s.`));
      }, connectTimeoutMs);

      ws.onopen = () => {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.log("info", "WebSocket open");
        try {
          ws.send(JSON.stringify({ setup }));
          this.log("info", "Setup sent", { model: setup.model });
        } catch (err) {
          fail(new Error(`Failed to send setup message: ${err.message}`));
          return;
        }
        this.setupTimer = setTimeout(() => {
          fail(new Error(`AI trainer connection failed: Gemini did not confirm setup (setupComplete) within ${Math.round(setupTimeoutMs / 1000)} seconds.`));
        }, setupTimeoutMs);
      };

      ws.onmessage = async (event) => {
        let message;
        try {
          let text;
          if (typeof event.data === "string") text = event.data;
          else if (event.data instanceof ArrayBuffer) text = new TextDecoder().decode(event.data);
          else if (typeof Blob !== "undefined" && event.data instanceof Blob) text = await event.data.text();
          else text = String(event.data);
          message = JSON.parse(text);
        } catch (err) {
          this.log("warn", "Received a non-JSON frame from Gemini", { error: err.message });
          return;
        }

        if (message.setupComplete !== undefined) {
          clearTimeout(this.setupTimer);
          this.setupTimer = null;
          this.setupDone = true;
          this.log("info", "Setup complete");
          if (!settled) {
            settled = true;
            resolve();
          }
          if (this.handlers.onSetupComplete) this.handlers.onSetupComplete();
          return;
        }

        if (message.error) {
          const detail = message.error.message || JSON.stringify(message.error);
          const err = new Error(`Gemini error: ${detail}`);
          this.log("error", "Gemini error frame", message.error);
          if (!settled) fail(err);
          else if (this.handlers.onError) this.handlers.onError(err);
          return;
        }

        if (message.goAway) {
          this.log("warn", "Gemini goAway received - the server will close this connection soon", message.goAway);
          if (this.handlers.onGoAway) this.handlers.onGoAway(message.goAway);
        }

        if (message.serverContent) this.handleServerContent(message.serverContent);

        if (message.toolCall && this.handlers.onToolCall) this.handlers.onToolCall(message.toolCall);
        if (message.usageMetadata && this.handlers.onUsage) this.handlers.onUsage(message.usageMetadata);
      };

      ws.onerror = () => {
        // Browsers hide the actual reason; the close event carries the code.
        this.log("error", "WebSocket error event");
        if (!settled) fail(new Error("WebSocket error while connecting to Gemini Live. Check your network, firewall and the Live token."));
        else if (this.handlers.onError) this.handlers.onError(new Error("WebSocket error during the live session."));
      };

      ws.onclose = (event) => {
        clearTimers();
        const hint = CLOSE_CODE_HINTS[event.code] || "";
        this.closeInfo = { code: event.code, reason: event.reason || "", wasClean: event.wasClean, intentional: this.closedByClient, hint };
        this.log(this.closedByClient ? "info" : "warn", `WebSocket closed (code ${event.code}${event.reason ? `, reason: ${event.reason}` : ""})`, this.closeInfo);
        if (!settled) {
          fail(new Error(`Gemini Live closed the connection before setup completed (code ${event.code}${event.reason ? `: ${event.reason}` : hint ? ` - ${hint}` : ""}).`));
        }
        if (this.handlers.onClose) this.handlers.onClose(this.closeInfo);
      };
    });
  }

  handleServerContent(sc) {
    const h = this.handlers;
    if (sc.interrupted && h.onInterrupted) h.onInterrupted();
    if (sc.inputTranscription && typeof sc.inputTranscription.text === "string" && h.onInputTranscription) {
      h.onInputTranscription(sc.inputTranscription.text, sc.inputTranscription);
    }
    if (sc.outputTranscription && typeof sc.outputTranscription.text === "string" && h.onOutputTranscription) {
      h.onOutputTranscription(sc.outputTranscription.text, sc.outputTranscription);
    }
    const parts = (sc.modelTurn && Array.isArray(sc.modelTurn.parts) && sc.modelTurn.parts) || [];
    for (const part of parts) {
      if (part.inlineData && part.inlineData.data && String(part.inlineData.mimeType || "").startsWith("audio")) {
        this.audioChunksReceived += 1;
        if (h.onAudio) h.onAudio(part.inlineData.data, part.inlineData.mimeType);
      } else if (typeof part.text === "string" && part.text && h.onModelText) {
        h.onModelText(part.text);
      }
    }
    if (sc.generationComplete && h.onGenerationComplete) h.onGenerationComplete();
    if (sc.turnComplete && h.onTurnComplete) h.onTurnComplete();
  }

  send(payload) {
    if (!this.isOpen) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      this.log("warn", "Failed to send frame", { error: err.message });
      return false;
    }
  }

  /** base64-encoded 16-bit PCM, mono, 16 kHz */
  sendAudioChunk(base64Pcm, sampleRate = 16000) {
    if (!this.setupDone) return false;
    const ok = this.send({ realtimeInput: { audio: { data: base64Pcm, mimeType: `audio/pcm;rate=${sampleRate}` } } });
    if (ok) this.audioChunksSent += 1;
    return ok;
  }

  sendAudioStreamEnd() {
    return this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  /** Sends a text turn (used to make the AI customer speak first). */
  sendText(text, { turnComplete = true } = {}) {
    if (!this.setupDone) return false;
    const ok = this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete } });
    if (ok) this.log("info", "Text turn sent", { preview: text.slice(0, 80) });
    return ok;
  }

  close(reason = "client closed") {
    this.closedByClient = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.connectTimer = null;
    this.setupTimer = null;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      try {
        this.ws.close(1000, reason.slice(0, 120));
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }
}

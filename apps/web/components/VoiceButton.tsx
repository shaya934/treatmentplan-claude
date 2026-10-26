"use client";
import { useRef, useState } from "react";

/**
 * Mic button: streams 16 kHz PCM to the server, which relays it to Amazon
 * Transcribe Medical. The transcript lands in the input box for the BCBA to
 * correct before sending. Audio is never stored. Browser speech recognition
 * is never used.
 */
export function VoiceButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "recording" | "finishing">("idle");
  const [partial, setPartial] = useState("");
  const [err, setErr] = useState("");
  const stopRef = useRef<() => void>(() => {});

  async function start() {
    setErr("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      setErr("Microphone permission was denied.");
      return;
    }
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/transcribe`);
    ws.binaryType = "arraybuffer";
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const ratio = ctx.sampleRate / 16000;
    proc.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      const out = new Int16Array(Math.floor(input.length / ratio));
      for (let i = 0; i < out.length; i++) {
        const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]!));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      ws.send(out.buffer);
    };
    src.connect(proc);
    proc.connect(ctx.destination);
    let finalText = "";
    ws.onmessage = (m) => {
      const ev = JSON.parse(String(m.data)) as { text?: string; isPartial?: boolean; error?: string };
      if (ev.error) setErr(ev.error);
      else if (ev.isPartial) setPartial(ev.text ?? "");
      else if (ev.text) {
        finalText += (finalText ? " " : "") + ev.text;
        setPartial("");
      }
    };
    ws.onclose = () => {
      if (finalText) onText(finalText);
      setState("idle");
      setPartial("");
    };
    ws.onerror = () => setErr("Voice connection failed. Please type instead.");
    const cleanup = () => {
      proc.disconnect();
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
    };
    stopRef.current = () => {
      cleanup();
      setState("finishing");
      if (ws.readyState === WebSocket.OPEN) ws.send("end");
      else ws.close();
    };
    setState("recording");
  }

  return (
    <div className="flex flex-col items-start">
      <button
        type="button"
        disabled={disabled || state === "finishing"}
        onClick={() => (state === "recording" ? stopRef.current() : start())}
        className={`btn ${state === "recording" ? "border-red-500 bg-red-50 text-red-700" : ""}`}
        title="Speak your answer"
        aria-label={state === "recording" ? "Stop recording" : "Start voice input"}
      >
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${state === "recording" ? "animate-pulse bg-red-600" : "bg-slate-400"}`} />
        {state === "recording" ? "Stop" : state === "finishing" ? "…" : "Mic"}
      </button>
      {partial && <span className="mt-1 max-w-md text-xs italic text-slate-500">{partial}</span>}
      {err && <span className="mt-1 text-xs text-red-600">{err}</span>}
    </div>
  );
}

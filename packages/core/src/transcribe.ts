import { StartMedicalStreamTranscriptionCommand, TranscribeStreamingClient, type AudioStream } from "@aws-sdk/client-transcribe-streaming";
import { env } from "./env";

/**
 * Voice input (spec F5): streaming transcription through Amazon Transcribe
 * Medical with a custom vocabulary for ABA terms (VB-MAPP, mand, tact, 97153...).
 * Audio chunks are held only in memory while streaming and are never written
 * to disk or storage. Browser speech recognition is never used.
 */

export interface TranscriptEvent {
  text: string;
  isPartial: boolean;
}

export interface TranscriptionSession {
  write(pcm16: Buffer): void;
  end(): void;
  done: Promise<void>;
}

export const SAMPLE_RATE = 16000;

/** ABA custom vocabulary. Deployed by infra as the Transcribe vocabulary named in TRANSCRIBE_VOCABULARY. */
export const ABA_VOCABULARY = [
  "VB-MAPP", "ABLLS-R", "Vineland", "mand", "mands", "tact", "tacts", "intraverbal", "intraverbals", "echoic",
  "BCBA", "RBT", "BIP", "FBA", "STO", "LTG", "BST", "DTT", "NET", "FCT", "DRA", "DRO", "ABC",
  "97151", "97153", "97154", "97155", "97156", "97158", "H0032", "Trillium", "Medicaid", "titration", "stereotypy", "elopement",
];

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  push(v: T) {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const v = this.items.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

export function startTranscription(onEvent: (e: TranscriptEvent) => void): TranscriptionSession {
  if (env().mode !== "aws") return localTranscription(onEvent);
  const client = new TranscribeStreamingClient({ region: env().region });
  const audio = new AsyncQueue<Buffer>();
  async function* stream(): AsyncIterable<AudioStream> {
    for await (const chunk of audio) yield { AudioEvent: { AudioChunk: chunk } };
  }
  const done = (async () => {
    const res = await client.send(
      new StartMedicalStreamTranscriptionCommand({
        LanguageCode: "en-US",
        MediaEncoding: "pcm",
        MediaSampleRateHertz: SAMPLE_RATE,
        Specialty: "PRIMARYCARE",
        Type: "DICTATION",
        VocabularyName: process.env.TRANSCRIBE_VOCABULARY || undefined,
        AudioStream: stream(),
      }),
    );
    for await (const ev of res.TranscriptResultStream ?? []) {
      for (const r of ev.TranscriptEvent?.Transcript?.Results ?? []) {
        const text = r.Alternatives?.[0]?.Transcript ?? "";
        if (text) onEvent({ text, isPartial: !!r.IsPartial });
      }
    }
  })();
  return {
    write: (b) => audio.push(b),
    end: () => audio.close(),
    done,
  };
}

/**
 * Local mode has no speech service. For demos and tests, LOCAL_TRANSCRIPT can
 * hold the text to "hear"; otherwise the BCBA is told to type instead.
 */
function localTranscription(onEvent: (e: TranscriptEvent) => void): TranscriptionSession {
  let bytes = 0;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  return {
    write: (b) => {
      bytes += b.length; // counted, never kept
    },
    end: () => {
      const scripted = process.env.LOCAL_TRANSCRIPT;
      onEvent({ text: scripted ?? (bytes > 0 ? "[Voice transcription needs Amazon Transcribe; not available in local mode. Please type.]" : ""), isPartial: false });
      resolve();
    },
    done,
  };
}

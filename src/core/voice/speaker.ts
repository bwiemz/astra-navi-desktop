import type { LanguageCode } from "../languages.ts";
import type { VoiceBackend } from "./backend.ts";
import { SentenceSplitter } from "./speechText.ts";
import { estimateSpokenOffset, textToVisemes, type VisemeFrame } from "./visemes.ts";

export interface SpeakerOptions {
  backend: VoiceBackend;
  language: LanguageCode;
  /** Receives finished audio, one sentence at a time, in speaking order, with optional visemes. */
  onAudio(
    samples: Float32Array,
    sampleRate: number,
    meta?: { text: string; visemes: VisemeFrame[] },
  ): void;
  /** Called when speech is interrupted via barge-in with the heard text and word offset. */
  onBargeIn?(event: {
    fullText: string;
    heardText: string;
    spokenWordOffset: number;
    elapsedMs: number;
  }): void;
  /** Called after synthesising one sentence with how many milliseconds it took. */
  onSynthesized?(ms: number): void;
  onError(message: string): void;
}

/**
 * The assistant's voice. Reply text is streamed in; it is spoken sentence by sentence,
 * so she starts talking while the rest of the reply is still being written.
 */
export class Speaker {
  private readonly options: SpeakerOptions;
  private splitter = new SentenceSplitter();
  private queue: string[] = [];
  private working = false;
  /** Bumped on stop, so audio from an interrupted reply is thrown away. */
  private generation = 0;
  private activeUtterance: { text: string; startedAtMs: number; durationMs: number } | null = null;

  constructor(options: SpeakerOptions) {
    this.options = options;
  }

  /** Whether this voice can speak the language she is set to. */
  get canSpeak(): boolean {
    return this.options.backend.supports(this.options.language);
  }

  warm(): Promise<void> {
    return this.canSpeak ? this.options.backend.warm() : Promise.resolve();
  }

  /** Adds streamed reply text. */
  push(delta: string): void {
    this.enqueue(this.splitter.push(delta));
  }

  /** The reply is complete: speak whatever is left. */
  end(): void {
    this.enqueue(this.splitter.flush());
  }

  /** Speaks one whole piece of text, for example a sample of a newly chosen voice. */
  say(text: string): void {
    this.stop();
    this.push(text);
    this.end();
  }

  /** Stops talking at once and forgets anything not yet spoken. */
  stop(): void {
    this.generation += 1;
    this.queue = [];
    this.splitter = new SentenceSplitter();
    this.activeUtterance = null;
  }

  /** Interrupts playback mid-utterance and reports how many words the user heard. */
  interrupt(
    nowMs = Date.now(),
  ): { fullText: string; heardText: string; spokenWordOffset: number; elapsedMs: number } | null {
    const active = this.activeUtterance;
    this.stop();
    if (!active) return null;
    const elapsedMs = Math.max(0, nowMs - active.startedAtMs);
    const offset = estimateSpokenOffset(active.text, elapsedMs, active.durationMs);
    const report = {
      fullText: active.text,
      heardText: offset.heardText,
      spokenWordOffset: offset.spokenWordOffset,
      elapsedMs,
    };
    this.options.onBargeIn?.(report);
    return report;
  }

  /** Stops and lets the voice give its memory back. */
  async rest(): Promise<void> {
    this.stop();
    await this.options.backend.rest();
  }

  /**
   * Lets the voice give its memory back, unless she is speaking or has more to say.
   * Nothing is cut off and nothing waiting is forgotten.
   */
  async restIfQuiet(): Promise<void> {
    if (this.working || this.queue.length > 0) return;
    await this.options.backend.restIfIdle?.();
  }

  private enqueue(sentences: string[]): void {
    if (sentences.length === 0 || !this.canSpeak) return;
    this.queue.push(...sentences);
    if (!this.working) void this.work();
  }

  private async work(): Promise<void> {
    this.working = true;
    let generation = this.generation;
    try {
      for (;;) {
        const sentence = this.queue.shift();
        if (sentence === undefined) return;
        generation = this.generation;
        const began = Date.now();
        const audio = await this.options.backend.synthesize(sentence, this.options.language);
        const ms = Date.now() - began;
        if (generation !== this.generation) continue;
        this.options.onSynthesized?.(ms);
        const durationMs = (audio.samples.length / Math.max(1, audio.sampleRate)) * 1000;
        const visemes = textToVisemes(sentence, durationMs, this.options.language);
        this.activeUtterance = { text: sentence, startedAtMs: Date.now(), durationMs };
        this.options.onAudio(audio.samples, audio.sampleRate, { text: sentence, visemes });
      }
    } catch (error) {
      // A failure while being stopped or swapped out is expected, not something to show.
      if (generation === this.generation) {
        this.queue = [];
        this.options.onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.working = false;
      // Sentences that arrived while the failure was being reported still get their turn.
      if (this.queue.length > 0) void this.work();
    }
  }
}

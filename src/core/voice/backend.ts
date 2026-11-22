import type { LanguageCode } from "../languages.ts";

export interface SpokenAudio {
  samples: Float32Array;
  sampleRate: number;
}

/** Something that can turn a sentence into sound. */
export interface VoiceBackend {
  /** A short name for messages, e.g. "full voice". */
  readonly label: string;
  supports(language: LanguageCode): boolean;
  /** Loads whatever is needed ahead of time, so the first sentence is not delayed. */
  warm(): Promise<void>;
  synthesize(sentence: string, language: LanguageCode): Promise<SpokenAudio>;
  /** Frees memory. The backend loads again by itself when next used. */
  rest(): Promise<void>;
  /**
   * Frees memory only if nothing is being spoken right now. For backends that hold
   * graphics memory; one that holds none has no need of it.
   */
  restIfIdle?(): Promise<void>;
  /** Frees memory for good; the backend must not be used afterwards. */
  dispose(): Promise<void>;
}

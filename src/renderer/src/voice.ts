/**
 * Sound in and out of the window: the microphone feed that goes to the listener, and
 * playback of her spoken sentences with a loudness reading for moving her mouth.
 *
 * Both go through this page on purpose. The browser's echo cancellation knows what the
 * page itself is playing, so her own voice is removed from what the microphone hears.
 */

const MIC_RATE = 16_000;

export interface VoiceCallbacks {
  /** Microphone audio, mono at 16 kHz. */
  onMicAudio(samples: Float32Array): void;
  /** Her voice started or stopped coming out of the speakers. */
  onSpeakingChange(speaking: boolean): void;
  /** Loudness of what she is saying right now, 0 to 1, for lip movement. Null when silent. */
  onLevel(level: number | null): void;
}

export class VoiceIO {
  private readonly callbacks: VoiceCallbacks;
  private micStream: MediaStream | null = null;
  private micContext: AudioContext | null = null;
  private outContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly playing = new Set<AudioBufferSourceNode>();
  private nextStartAt = 0;
  private speaking = false;
  private levelFrame = 0;

  constructor(callbacks: VoiceCallbacks) {
    this.callbacks = callbacks;
  }

  get micOn(): boolean {
    return this.micStream !== null;
  }

  /** Opens the microphone. Rejects when there is none or access is refused. */
  async startMic(): Promise<void> {
    if (this.micStream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    try {
      const context = new AudioContext({ sampleRate: MIC_RATE });
      await context.audioWorklet.addModule("./mic-worklet.js");
      const capture = new AudioWorkletNode(context, "mic-capture", { numberOfOutputs: 0 });
      capture.port.onmessage = (event: MessageEvent<Float32Array>) =>
        this.callbacks.onMicAudio(event.data);
      context.createMediaStreamSource(stream).connect(capture);
      this.micStream = stream;
      this.micContext = context;
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      throw error;
    }
  }

  stopMic(): void {
    for (const track of this.micStream?.getTracks() ?? []) track.stop();
    this.micStream = null;
    void this.micContext?.close();
    this.micContext = null;
  }

  /** Queues one sentence of speech to play after whatever is already queued. */
  play(samples: Float32Array, sampleRate: number): void {
    if (samples.length === 0) return;
    this.outContext ??= new AudioContext();
    const context = this.outContext;
    if (context.state === "suspended") void context.resume();
    if (!this.analyser) {
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(context.destination);
    }

    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    // A short gap between sentences sounds like breathing rather than a splice.
    const startAt = Math.max(context.currentTime + 0.02, this.nextStartAt + 0.12);
    source.start(startAt);
    this.nextStartAt = startAt + buffer.duration;
    this.playing.add(source);
    source.onended = () => {
      this.playing.delete(source);
      if (this.playing.size === 0) this.setSpeaking(false);
    };
    this.setSpeaking(true);
  }

  /** Stops her mid-word and drops anything queued. */
  stopPlayback(): void {
    for (const source of [...this.playing]) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // not started yet, or already finished
      }
    }
    this.playing.clear();
    this.nextStartAt = 0;
    this.setSpeaking(false);
  }

  private setSpeaking(speaking: boolean): void {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    this.callbacks.onSpeakingChange(speaking);
    cancelAnimationFrame(this.levelFrame);
    if (speaking) this.trackLevel();
    else this.callbacks.onLevel(null);
  }

  private trackLevel(): void {
    const analyser = this.analyser;
    if (!analyser || !this.speaking) return;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const sample of data) sum += sample * sample;
    // Speech sits around 0.05 to 0.2 RMS; stretch that to a full mouth range.
    this.callbacks.onLevel(Math.min(1, Math.sqrt(sum / data.length) * 6));
    this.levelFrame = requestAnimationFrame(() => this.trackLevel());
  }
}

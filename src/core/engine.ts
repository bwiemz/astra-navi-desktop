import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  getLlama,
  LlamaChatSession,
  QwenChatWrapper,
  TokenBias,
  type ChatHistoryItem,
  type ChatSessionModelFunctions,
  type Llama,
  type LlamaContext,
  type LlamaContextOptions,
  type LlamaContextSequence,
  type LlamaModel,
  type LlamaModelOptions,
  type Token,
} from "node-llama-cpp";
import {
  recommendHardwareTier,
  type HardwareProfile,
} from "./hardwareTuner.ts";
import {
  computeDownloadStats,
  downloadModelResumable,
  probeDiskSpace,
} from "./modelBundle.ts";
import type { TurnHookPipeline } from "./turnHooks.ts";
import {
  BRAIN_MODELS,
  isDownloaded,
  resolveBrain,
  type BrainChoice,
  type BrainModel,
  type ResolvedModel,
} from "./models.ts";

export type EngineStatus =
  | {
      stage: "downloading";
      label: string;
      received: number;
      total: number;
      bytesPerSec?: number;
      etaSeconds?: number | null;
      paused?: boolean;
      error?: string | null;
      freeDiskBytes?: number | null;
    }
  | { stage: "loading"; label: string }
  | { stage: "ready"; label: string }
  /** The model has been put away to free its memory. */
  | {
      stage: "resting";
      label: string;
      /** The game the memory was given back to. */ game?: string;
    };

export interface ModelDownloadState {
  state: "idle" | "downloading" | "paused" | "verifying" | "ready" | "error";
  tier: string;
  label: string;
  received: number;
  total: number;
  bytesPerSec: number;
  etaSeconds: number | null;
  freeDiskBytes: number | null;
  requiredBytes: number;
  error: string | null;
}

export interface DiskSpaceCheck {
  availableBytes: number;
  requiredBytes: number;
  enough: boolean;
  label: string;
  alreadyDownloaded: boolean;
}

export interface EngineOptions {
  modelsDir: string;
  choice: BrainChoice;
  /** Upper bound for the working context, in tokens. Less is used when memory is short. */
  contextSize: number;
  /** Free the model's memory after this long without a message. 0 keeps it loaded. */
  idleUnloadMs: number;
  /**
   * Hold the conversation in less graphics memory, at no cost that her tests can find.
   * Only for the models she ships with: the setting is not safe on files she has never
   * been tried with.
   */
  lean?: boolean;
  /**
   * Run on the processor alone, with this many threads, and leave the graphics card
   * untouched. Many times slower; for trying her out while the card is busy with a game.
   */
  processorOnly?: { threads: number };
  /**
   * Where the tuning for a model file is kept, or null when it has none. A tuning is a
   * small file of adjustments to the model's weights (a LoRA adapter), trained on her
   * own way of doing things, and is laid over the model when it is loaded.
   */
  adapterFor?: (model: ResolvedModel) => string | null;
  /**
   * Says which game has the graphics card right now, or null. When given, the model is
   * put away soon after each reply while a game is running, and "auto" takes the small
   * model when the standard one no longer fits beside what is on the card.
   */
  gameOnCard?: () => Promise<string | null>;
  /** Optional first-launch/live hardware profiler for auto tier + KV/quantization sizing. */
  hardwareProfile?: () => Promise<HardwareProfile>;
  /** How soon after a reply the model is put away while a game is running. */
  yieldAfterMs?: number;
  /** Optional feature-flagged turn hook pipeline (`turnHooks.ts`). */
  turnHooks?: TurnHookPipeline;
  onStatus(status: EngineStatus): void;
  onDownloadUpdate?(state: ModelDownloadState): void;
}

/** While a game is running the card is looked at this often, and only while she rests with the model loaded. */
const GAME_CHECK_EVERY_MS = 30_000;
const YIELD_AFTER_MS = 60_000;
const GIB = 1024 ** 3;

/**
 * What to do after a look at the card while she rests: give the memory back now, or
 * look again in this many milliseconds. With a game running she waits out the rest of
 * her patience (a follow-up question usually comes within the minute) and no longer.
 */
export function afterLookingForGame(
  game: string | null,
  restedMs: number,
  patienceMs: number,
): "give back" | number {
  if (game === null) return GAME_CHECK_EVERY_MS;
  if (restedMs >= patienceMs) return "give back";
  return Math.min(Math.max(1000, patienceMs - restedMs), GAME_CHECK_EVERY_MS);
}

/** The part of a working space's settings that lays a tuning over the model. */
function tuned(adapter: string | null): { lora?: { adapters: { filePath: string }[] } } {
  return adapter === null ? {} : { lora: { adapters: [{ filePath: adapter }] } };
}

/** True when model/context allocation failed due to tight VRAM or memory constraints. */
export function isVramMemoryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "InsufficientMemoryError") return true;
  return /too large for the available (?:VRAM|RAM|resources)|insufficient.*(?:vram|memory)|out of memory|cuda.*alloc|failed to allocate/i.test(
    error.message,
  );
}

export interface ModelContextLoader<M> {
  loadModel(options: LlamaModelOptions): Promise<M>;
}

export interface LoadableModel<C> {
  readonly flashAttentionSupported: boolean;
  createContext(options?: LlamaContextOptions): Promise<C>;
  dispose(): Promise<void>;
}

export interface FallbackLoadOptions {
  modelPath: string;
  effectiveContextSize: number;
  effectiveLean: boolean;
  allowLeanKv: boolean;
  freeVramBytes: number | null;
  adapter: string | null;
  processorOnly?: { threads: number };
}

/**
 * Loads a GGUF model and creates its context with progressive VRAM-pressure fallbacks:
 * 1) Normal GPU offload reserving context headroom (and Q8_0 KV when free VRAM < 2.5 GB),
 * 2) Tight-VRAM retry capped at 8192 max / 2048 min tokens with Q8_0 KV,
 * 3) Full CPU+RAM offload (`gpuLayers: 0`) so another GPU-heavy app never bricks chat.
 */
export async function loadModelAndContextWithFallback<M extends LoadableModel<unknown>>(
  loader: ModelContextLoader<M>,
  opts: FallbackLoadOptions,
): Promise<{
  model: M;
  context: Awaited<ReturnType<M["createContext"]>>;
  cpuFallback: boolean;
}> {
  const minCtx = Math.min(4096, opts.effectiveContextSize);
  const lowFreeVram =
    opts.freeVramBytes !== null && opts.freeVramBytes > 0 && opts.freeVramBytes < 2.5 * GIB;
  const attemptLean = opts.effectiveLean || (lowFreeVram && opts.allowLeanKv);

  const attempt = async (
    gpuLayers: LlamaModelOptions["gpuLayers"],
    minContext: number,
    maxContext: number,
    useLeanKv: boolean,
  ): Promise<{ model: M; context: Awaited<ReturnType<M["createContext"]>> }> => {
    let model: M | null = null;
    try {
      model = await loader.loadModel({
        modelPath: opts.modelPath,
        gpuLayers,
        defaultContextFlashAttention: useLeanKv && opts.allowLeanKv ? true : "auto",
      });
      const context = (await model.createContext({
        contextSize: { min: minContext, max: maxContext },
        ...(opts.processorOnly ? { threads: opts.processorOnly.threads } : {}),
        ...tuned(opts.adapter),
        ...(useLeanKv && opts.allowLeanKv && model.flashAttentionSupported
          ? {
              flashAttention: true,
              experimentalKvCacheKeyType: "Q8_0" as const,
              experimentalKvCacheValueType: "Q8_0" as const,
            }
          : {}),
      })) as Awaited<ReturnType<M["createContext"]>>;
      return { model, context };
    } catch (error) {
      await model?.dispose().catch(() => undefined);
      throw error;
    }
  };

  try {
    const first = await attempt(
      opts.processorOnly ? 0 : { fitContext: { contextSize: minCtx } },
      minCtx,
      opts.effectiveContextSize,
      attemptLean,
    );
    return { ...first, cpuFallback: false };
  } catch (error1) {
    if (!isVramMemoryError(error1) || opts.processorOnly) throw error1;
    const cappedMax = Math.min(8192, opts.effectiveContextSize);
    const relaxedMin = Math.min(2048, cappedMax);
    try {
      const second = await attempt(
        { fitContext: { contextSize: relaxedMin } },
        relaxedMin,
        cappedMax,
        opts.allowLeanKv,
      );
      return { ...second, cpuFallback: false };
    } catch (error2) {
      if (!isVramMemoryError(error2)) throw error2;
      const third = await attempt(0, relaxedMin, cappedMax, false);
      return { ...third, cpuFallback: true };
    }
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** A separate conversation with the model for work done beside the main one. */
export interface EngineWorker {
  session: LlamaChatSession;
  /** Fires when the work must stop: the model is being let go. */
  signal: AbortSignal;
  /** Frees the worker's memory. Must always be called, however the work ended. */
  close(): Promise<void>;
}

interface Loaded {
  /** The model file in use. */
  path: string;
  model: LlamaModel;
  context: LlamaContext;
  /** The conversation's place in the model's working memory. A session is built on it. */
  sequence: LlamaContextSequence;
  session: LlamaChatSession;
  label: string;
  /** The leaning on her choice of words, once worked out for this model; see `wordBias`. */
  bias?: { on: TokenBias; off: TokenBias };
  /** The tuning laid over the model, which every working space of it must be given too. */
  adapter: string | null;
  /**
   * The conversation was started over without putting the model away (see `renew`):
   * the session is gone and the next one is built from fresh instructions.
   */
  stale: boolean;
  /** Which instructions and tools the place to come back to was marked for; see `anchor`. */
  anchor: string | null;
  /**
   * Which instructions the earlier place, before the tools, was marked for; "none" once
   * marking it has been found not to work for this model's way of writing a prompt.
   */
  instructionsMark: string | null;
}

/**
 * Keeps a copy of the model's state at this point under a name of its own.
 *
 * The library's public `takeCheckpoint` puts the copy among the ones it takes by
 * itself at every reply, of which it keeps the latest 32: in a long conversation the
 * oldest, which is this one, would be dropped. Copies with a name are counted apart.
 * The call for that is not part of the library's public face, so it is looked for and
 * the public one used when it is not there.
 */
async function takeNamedCheckpoint(
  sequence: LlamaContextSequence,
  name: "instructions" | "tools",
): Promise<void> {
  const inner = sequence as unknown as {
    _takeNamedCheckpoint?: (name: string, most: number) => Promise<void>;
  };
  if (typeof inner._takeNamedCheckpoint === "function") {
    await inner._takeNamedCheckpoint(name, 1);
  } else {
    await sequence.takeCheckpoint();
  }
}

/**
 * The tokens her prompt starts with whatever tools are offered: her instructions, up to
 * where the list of tools begins. Found by writing the start of the prompt twice, with
 * these tools and with none, and keeping what the two have in common.
 */
function instructionsAlone(
  session: LlamaChatSession,
  model: LlamaModel,
  functions: ChatSessionModelFunctions,
): Token[] {
  const written = (offered: ChatSessionModelFunctions | undefined): Token[] =>
    session.chatWrapper
      .generateContextState({
        chatHistory: [...session.getChatHistory(), { type: "user", text: "" }],
        ...(offered ? { availableFunctions: offered } : {}),
        documentFunctionParams: true,
      })
      .contextText.tokenize(model.tokenizer);
  if (Object.keys(functions).length === 0) return [];
  const withTools = written(functions);
  const without = written(undefined);
  let shared = 0;
  while (
    shared < withTools.length &&
    shared < without.length &&
    withTools[shared] === without[shared]
  ) {
    shared += 1;
  }
  return withTools.slice(0, shared);
}

/**
 * Runs the language model on this computer. The model is downloaded once, loaded when
 * first needed, and unloaded again after a while idle so its memory goes back to games
 * and other programs. The conversation survives unloading.
 */
export class LocalEngine {
  private options: EngineOptions;
  private llama: Llama | null = null;
  private loaded: Loaded | null = null;
  private loading: Promise<Loaded> | null = null;
  /** The conversation so far, kept here while the model is not in memory. */
  private history: ChatHistoryItem[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private gameTimer: NodeJS.Timeout | null = null;
  /** Counts the watches for a game begun or called off; see `watchForGame`. */
  private gameWatches = 0;
  /** Set while the model is being put away; see `unload`. */
  private unloading: Promise<void> | null = null;
  /** When the current rest began, for giving the card back to a game. */
  private restingSince = 0;
  /** Lets a download in progress be cancelled. */
  private download: AbortController | null = null;
  private bgDownloadPromise: Promise<ModelDownloadState> | null = null;
  private bgDownloadAbort: AbortController | null = null;
  private downloadPausedByUser = false;
  private lastDownloadChoice: BrainChoice | undefined;
  private dlState: ModelDownloadState = {
    state: "idle",
    tier: "",
    label: "",
    received: 0,
    total: 0,
    bytesPerSec: 0,
    etaSeconds: null,
    freeDiskBytes: null,
    requiredBytes: 0,
    error: null,
  };
  private downloadListener: ((state: ModelDownloadState) => void) | null = null;
  /** Work going on beside the conversation. It must have ended before the model is let go. */
  private readonly sideWorks = new Set<{ done: Promise<unknown>; stop: AbortController }>();
  /** One write-up at a time; see `sideQuestion`. */
  private answering = false;
  /** True between a reply ending and the next one starting. */
  private resting = false;
  private disposed = false;

  constructor(options: EngineOptions) {
    this.options = options;
  }

  /** Optional turn hook pipeline registered on the engine (null by default). */
  hooks(): TurnHookPipeline | null {
    return this.options.turnHooks ?? null;
  }

  /** Registers or replaces an observer for background model download progress. */
  setDownloadListener(listener: ((state: ModelDownloadState) => void) | null): void {
    this.downloadListener = listener;
  }

  downloadState(): ModelDownloadState {
    return { ...this.dlState };
  }

  private emitDownloadState(next: ModelDownloadState): void {
    this.dlState = next;
    this.options.onDownloadUpdate?.({ ...next });
    this.downloadListener?.({ ...next });
  }

  private async resolveModelForSetup(choice?: BrainChoice): Promise<ResolvedModel> {
    const target = choice ?? this.options.choice;
    let totalVram: number | null = null;
    try {
      this.llama ??= this.options.processorOnly
        ? await getLlama({ gpu: false, maxThreads: this.options.processorOnly.threads })
        : await getLlama();
      if (this.llama.gpu !== false) {
        totalVram = (await this.llama.getVramState()).total;
      }
    } catch {
      totalVram = null;
    }
    return resolveBrain(target, this.options.modelsDir, totalVram);
  }

  /** Checks free disk space vs required download size (including 10% headroom). */
  async checkDiskSpaceFor(choice?: BrainChoice): Promise<DiskSpaceCheck> {
    const target = choice ?? this.options.choice;
    const chosen = await this.resolveModelForSetup(target);
    const alreadyDownloaded = await isDownloaded(chosen);
    const needed = alreadyDownloaded ? 0 : chosen.download?.sizeBytes ?? 0;
    const disk = await probeDiskSpace(this.options.modelsDir, needed);
    return {
      availableBytes: disk.availableBytes,
      requiredBytes: disk.requiredBytes,
      enough: disk.enough,
      label: chosen.label,
      alreadyDownloaded,
    };
  }

  private createProgressTracker(
    tier: string,
    label: string,
    totalFallback: number,
    freeDiskBytes: number | null,
    requiredBytes: number,
  ): (progress: { received: number; total: number }) => void {
    let lastAt = Date.now();
    let lastBytes = -1;
    let lastEmitAt = 0;
    let ewmaBps = 0;
    return ({ received, total }) => {
      const effectiveTotal = total || totalFallback;
      const now = Date.now();
      if (lastBytes < 0) {
        lastBytes = received;
        lastAt = now;
      } else {
        const dt = (now - lastAt) / 1000;
        const delta = received - lastBytes;
        if (dt >= 0.15 && delta >= 0) {
          const instBps = delta / dt;
          ewmaBps = ewmaBps > 0 ? ewmaBps * 0.65 + instBps * 0.35 : instBps;
          lastBytes = received;
          lastAt = now;
        }
      }
      const stats = computeDownloadStats({
        received,
        total: effectiveTotal,
        bytesPerSec: ewmaBps,
      });
      const shouldEmit = now - lastEmitAt >= 200 || (effectiveTotal > 0 && received >= effectiveTotal);
      if (!shouldEmit) return;
      lastEmitAt = now;
      this.options.onStatus({
        stage: "downloading",
        label,
        received,
        total: effectiveTotal,
        bytesPerSec: ewmaBps,
        etaSeconds: stats.etaSeconds,
        paused: false,
        freeDiskBytes,
      });
      this.emitDownloadState({
        state:
          effectiveTotal > 0 && received >= effectiveTotal ? "verifying" : "downloading",
        tier,
        label,
        received,
        total: effectiveTotal,
        bytesPerSec: ewmaBps,
        etaSeconds: stats.etaSeconds,
        freeDiskBytes,
        requiredBytes,
        error: null,
      });
    };
  }

  /**
   * Starts (or attaches to) a non-blocking resumable model download in the background so the
   * user can continue onboarding, preview voices, or inspect their 3D avatar while weights fetch.
   */
  async startBackgroundDownload(choice?: BrainChoice): Promise<ModelDownloadState> {
    const target = choice ?? this.options.choice;
    this.lastDownloadChoice = target;
    if (this.bgDownloadPromise && this.dlState.tier === String(target) && this.dlState.state === "downloading") {
      return this.downloadState();
    }
    if (this.bgDownloadAbort) {
      this.downloadPausedByUser = false;
      this.bgDownloadAbort.abort();
      await this.bgDownloadPromise?.catch(() => undefined);
    }

    const chosen = await this.resolveModelForSetup(target);
    const dlSpec = chosen.download;
    const totalBytes = dlSpec?.sizeBytes ?? 0;
    const disk = await probeDiskSpace(this.options.modelsDir, totalBytes);
    if (await isDownloaded(chosen)) {
      const readyState: ModelDownloadState = {
        state: "ready",
        tier: String(target),
        label: chosen.label,
        received: totalBytes,
        total: totalBytes,
        bytesPerSec: 0,
        etaSeconds: 0,
        freeDiskBytes: disk.availableBytes,
        requiredBytes: 0,
        error: null,
      };
      this.emitDownloadState(readyState);
      return readyState;
    }
    if (!dlSpec) {
      const missingState: ModelDownloadState = {
        state: "error",
        tier: String(target),
        label: chosen.label,
        received: 0,
        total: 0,
        bytesPerSec: 0,
        etaSeconds: null,
        freeDiskBytes: disk.availableBytes,
        requiredBytes: disk.requiredBytes,
        error: `Custom model file does not exist: ${chosen.path}`,
      };
      this.emitDownloadState(missingState);
      return missingState;
    }

    this.downloadPausedByUser = false;
    const abort = new AbortController();
    this.bgDownloadAbort = abort;
    this.emitDownloadState({
      state: "downloading",
      tier: String(target),
      label: chosen.label,
      received: 0,
      total: totalBytes,
      bytesPerSec: 0,
      etaSeconds: null,
      freeDiskBytes: disk.availableBytes,
      requiredBytes: disk.requiredBytes,
      error: null,
    });

    const tracker = this.createProgressTracker(
      String(target),
      chosen.label,
      totalBytes,
      disk.availableBytes,
      disk.requiredBytes,
    );

    const run = (async (): Promise<ModelDownloadState> => {
      try {
        await mkdir(this.options.modelsDir, { recursive: true });
        await downloadModelResumable({
          url: dlSpec.url,
          destPath: chosen.path,
          expectedSizeBytes: totalBytes,
          expectedSha256: dlSpec.sha256,
          signal: abort.signal,
          cleanupPartialOnAbort: false,
          onProgress: tracker,
        });
        const doneState: ModelDownloadState = {
          state: "ready",
          tier: String(target),
          label: chosen.label,
          received: totalBytes,
          total: totalBytes,
          bytesPerSec: 0,
          etaSeconds: 0,
          freeDiskBytes: disk.availableBytes,
          requiredBytes: disk.requiredBytes,
          error: null,
        };
        this.emitDownloadState(doneState);
        return doneState;
      } catch (error) {
        if (abort.signal.aborted && this.downloadPausedByUser) {
          const pausedState: ModelDownloadState = {
            ...this.dlState,
            state: "paused",
            bytesPerSec: 0,
            etaSeconds: null,
            error: null,
          };
          this.options.onStatus({
            stage: "downloading",
            label: chosen.label,
            received: pausedState.received,
            total: pausedState.total,
            bytesPerSec: 0,
            etaSeconds: null,
            paused: true,
            freeDiskBytes: disk.availableBytes,
          });
          this.emitDownloadState(pausedState);
          return pausedState;
        }
        const errMsg = error instanceof Error ? error.message : String(error);
        const errState: ModelDownloadState = {
          ...this.dlState,
          state: "error",
          bytesPerSec: 0,
          etaSeconds: null,
          error: errMsg,
        };
        this.options.onStatus({
          stage: "downloading",
          label: chosen.label,
          received: errState.received,
          total: errState.total,
          bytesPerSec: 0,
          etaSeconds: null,
          paused: false,
          error: errMsg,
          freeDiskBytes: disk.availableBytes,
        });
        this.emitDownloadState(errState);
        return errState;
      } finally {
        if (this.bgDownloadAbort === abort) {
          this.bgDownloadAbort = null;
          this.bgDownloadPromise = null;
        }
      }
    })();

    this.bgDownloadPromise = run;
    return this.downloadState();
  }

  /** Pauses an in-progress background or active model download while preserving `.part` bytes. */
  pauseDownload(): ModelDownloadState {
    if (this.dlState.state !== "downloading" && !this.bgDownloadAbort && !this.download) {
      return this.downloadState();
    }
    this.downloadPausedByUser = true;
    this.bgDownloadAbort?.abort();
    this.download?.abort();
    const pausedState: ModelDownloadState = {
      ...this.dlState,
      state: "paused",
      bytesPerSec: 0,
      etaSeconds: null,
      error: null,
    };
    this.emitDownloadState(pausedState);
    return pausedState;
  }

  /** Resumes a paused download from where `.part` stopped via HTTP Range requests. */
  async resumeDownload(): Promise<ModelDownloadState> {
    return this.startBackgroundDownload(this.lastDownloadChoice ?? this.options.choice);
  }

  /** Switches to another model. It is loaded (and downloaded if needed) on the next message. */
  async setChoice(choice: BrainChoice): Promise<void> {
    if (choice === this.options.choice) return;
    // Set first: a message arriving while the old model is being let go must load the new one.
    this.options = { ...this.options, choice };
    await this.unload();
  }

  /**
   * True when the chosen model is already on disk, so using it will not start a
   * download of several gigabytes. Things she brings up by herself must never do that.
   */
  async isDownloaded(): Promise<boolean> {
    if (this.loaded) return true;
    try {
      // Without asking the graphics card: "auto" then checks for the small model, which
      // is the one a download would have fetched on a machine with no card.
      const withCard = resolveBrain(
        this.options.choice,
        this.options.modelsDir,
        Number.MAX_SAFE_INTEGER,
      );
      const without = resolveBrain(this.options.choice, this.options.modelsDir, null);
      return (await isDownloaded(withCard)) || (await isDownloaded(without));
    } catch {
      return false;
    }
  }

  /** Which brain model she has, whether it is on disk, and whether it is in memory now. */
  async brainInfo(): Promise<{
    label: string;
    fileName: string | null;
    onDisk: boolean;
    loaded: boolean;
  }> {
    if (this.loaded) {
      return {
        label: this.loaded.label,
        fileName: basename(this.loaded.path),
        onDisk: true,
        loaded: true,
      };
    }
    try {
      // The one a graphics card would get, then the one a machine without a card would.
      const candidates = [
        resolveBrain(this.options.choice, this.options.modelsDir, Number.MAX_SAFE_INTEGER),
        resolveBrain(this.options.choice, this.options.modelsDir, null),
      ];
      const onDisk: ResolvedModel[] = [];
      for (const candidate of candidates) {
        if (
          (await isDownloaded(candidate)) &&
          !onDisk.some((seen) => seen.path === candidate.path)
        ) {
          onDisk.push(candidate);
        }
      }
      const [first, second] = onDisk;
      if (first) {
        return {
          label: first.label,
          // With two on disk, which one loads depends on the graphics card, which has not
          // been asked yet. Naming neither keeps both from being called "not in use".
          fileName: second ? null : basename(first.path),
          onDisk: true,
          loaded: false,
        };
      }
      return {
        label: candidates[0]?.label ?? "Unknown",
        fileName: null,
        onDisk: false,
        loaded: false,
      };
    } catch {
      return { label: "Unknown", fileName: null, onDisk: false, loaded: false };
    }
  }

  /** The conversation without its system prompt. */
  getHistory(): ChatHistoryItem[] {
    const items =
      this.loaded && !this.loaded.stale ? this.loaded.session.getChatHistory() : this.history;
    return items.filter((item) => item.type !== "system");
  }

  setHistory(items: ChatHistoryItem[]): void {
    this.history = items.filter((item) => item.type !== "system");
    if (this.loaded && !this.loaded.stale) {
      const system = this.loaded.session.getChatHistory().filter((item) => item.type === "system");
      this.loaded.session.setChatHistory([...system, ...this.history]);
    }
  }

  /**
   * Returns a chat session, loading (and if necessary downloading) the model first.
   * @param systemPrompt Used when a session has to be created; an existing one keeps its own.
   */
  async session(systemPrompt: string): Promise<LlamaChatSession> {
    if (this.disposed) throw new Error("The engine has been shut down.");
    this.cancelIdleUnload();
    this.resting = false;
    // Being put away right now: wait, then load afresh, instead of taking a session
    // that is about to be thrown out.
    while (this.unloading) await this.unloading.catch(() => undefined);
    if (this.disposed) throw new Error("The engine has been shut down.");
    if (this.loaded) {
      if (this.loaded.stale) {
        // Started over with the model kept in memory: same working space, new instructions.
        this.loaded.session = new LlamaChatSession({
          contextSequence: this.loaded.sequence,
          systemPrompt,
        });
        this.loaded.stale = false;
        if (this.history.length > 0) {
          const system = this.loaded.session
            .getChatHistory()
            .filter((item) => item.type === "system");
          this.loaded.session.setChatHistory([...system, ...this.history]);
        }
      }
      return this.loaded.session;
    }
    this.loading ??= this.load(systemPrompt).finally(() => {
      this.loading = null;
    });
    return (await this.loading).session;
  }

  /**
   * Starts the conversation over without putting the model away. The next `session` call
   * is given fresh instructions, as after a reload, but costs no loading time. For her
   * test suite, which begins a clean conversation for every case; the app unloads instead.
   */
  renew(): void {
    this.history = [];
    if (!this.loaded || this.loaded.stale) return;
    this.loaded.session.dispose();
    this.loaded.stale = true;
  }

  /**
   * Makes the next `session` call take fresh instructions while the conversation and the
   * model both stay. The whole conversation is read again on the next message, which
   * takes a second or two; nothing is reloaded.
   */
  refresh(): void {
    if (!this.loaded || this.loaded.stale) return;
    this.history = this.loaded.session.getChatHistory().filter((item) => item.type !== "system");
    this.loaded.session.dispose();
    this.loaded.stale = true;
  }

  /**
   * How much the conversation has read and written since the model was loaded, how much
   * it holds in mind now and how much it can hold, in tokens. Null while the model is
   * not in memory.
   */
  meter(): { input: number; output: number; held: number; size: number; kept: number } | null {
    if (!this.loaded) return null;
    const { tokenMeter, contextTokens, contextSize, checkpointsMemoryUsage } = this.loaded.sequence;
    return {
      input: tokenMeter.usedInputTokens,
      output: tokenMeter.usedOutputTokens,
      held: contextTokens.length,
      size: contextSize,
      // Ordinary memory taken by the copies of the model's state kept to come back to.
      kept: checkpointsMemoryUsage,
    };
  }

  /** How many tokens a text comes to for the model in memory, or null when there is none. */
  countTokens(text: string): number | null {
    return this.loaded ? this.loaded.model.tokenize(text).length : null;
  }

  /**
   * Marks the end of her instructions and tools as a place the model can come back to.
   *
   * Most models can forget the end of what they have read and keep the rest. The
   * newer ones this app uses cannot: told to drop anything, they start again from
   * nothing, unless a copy of their state was kept at some earlier point. Without one,
   * every time the conversation behind the instructions is changed (old turns summed
   * up, a notification's text taken back out, a fresh conversation begun) all of the
   * instructions are read again: several thousand tokens, seconds on a graphics card
   * and over a minute without one. With one kept right after the instructions, only
   * the conversation is read again.
   *
   * Call before each message with the tools about to be offered. It does something
   * only the first time for given instructions and tools, and only for a model that
   * needs it. It reads nothing that the message would not have had read anyway.
   */
  async anchor(functions: ChatSessionModelFunctions, signal?: AbortSignal): Promise<void> {
    const { loaded } = this;
    if (!loaded || loaded.stale || !loaded.sequence.needsCheckpoints) return;
    // For measuring what the mark is worth: without it everything is as it was before.
    if (process.env["AI_CHAN_NO_ANCHOR"]) return;
    const { session, sequence } = loaded;
    const system = session.getChatHistory().filter((item) => item.type === "system");
    const instructionsKey = createHash("sha256").update(JSON.stringify(system)).digest("hex");
    const key = createHash("sha256")
      .update(instructionsKey)
      .update(
        JSON.stringify(
          Object.entries(functions).map(([name, tool]) => [name, tool.description, tool.params]),
        ),
      )
      .digest("hex");
    // Marked already. Asking again would itself drop the mark: the library steps one
    // token back before reading, which is one token before the copy that was kept.
    if (loaded.anchor === key) return;
    // Read on a session of its own that holds the instructions and nothing else, so
    // the conversation is never out of the real one's hands, whatever happens meanwhile.
    const alone = new LlamaChatSession({
      contextSequence: sequence,
      chatWrapper: session.chatWrapper,
      systemPrompt: "",
    });
    try {
      alone.setChatHistory(system);
      // Two places are marked. The first is after her instructions and before the
      // tools: when only the tools on offer change, she comes back to it and reads
      // the tools again, not the instructions. The second is after the tools.
      let start: Token[] | null = null;
      if (loaded.instructionsMark !== instructionsKey && loaded.instructionsMark !== "none") {
        start = instructionsAlone(alone, loaded.model, functions);
        if (start.length > 0) {
          await sequence.adaptStateToTokens(start, false);
          const have = sequence.nextTokenIndex;
          if (have < start.length) {
            await sequence.evaluateWithoutGeneratingNewTokens(start.slice(have));
          }
          if (signal?.aborted || this.loaded !== loaded || loaded.stale || sequence.disposed)
            return;
          await takeNamedCheckpoint(sequence, "instructions");
          loaded.instructionsMark = instructionsKey;
        }
      }
      await alone.preloadPrompt("", { functions, ...(signal ? { signal } : {}) });
      // The model may have been put away, or the conversation started over, meanwhile.
      if (this.loaded !== loaded || loaded.stale || sequence.disposed) return;
      // What was read as "the instructions alone" must be how the prompt really
      // starts. If the library wrote it otherwise, that mark is of no use: say so
      // once and go on with the second mark alone, as before.
      if (start !== null) {
        const held = sequence.contextTokens;
        if (start.some((token, index) => held[index] !== token)) {
          loaded.instructionsMark = "none";
          console.warn("[engine] the instructions could not be marked apart from the tools");
        }
      }
      await takeNamedCheckpoint(sequence, "tools");
      loaded.anchor = key;
    } catch (error) {
      // Going without only costs time later. Tried again with the next message.
      if (signal?.aborted !== true) {
        console.warn("[engine] could not mark the end of the instructions:", error);
      }
    } finally {
      alone.dispose();
    }
  }

  /**
   * A leaning away from (or towards) certain words for the model in memory: each is
   * made a little less likely, by `logit`, wherever it is one whole token. Returns that
   * leaning and an empty one for the stretches where it should not apply, or null
   * when no model is loaded. Kept per loaded model, as the tokens are the model's own.
   */
  wordBias(
    words: readonly { text: string; logit: number }[],
  ): { on: TokenBias; off: TokenBias } | null {
    const { loaded } = this;
    if (!loaded) return null;
    if (loaded.bias) return loaded.bias;
    const on = TokenBias.for(loaded.model);
    for (const { text, logit } of words) {
      const tokens = loaded.model.tokenize(text);
      // A word the model writes as several pieces is left alone: leaning on the pieces
      // would lean on every other word they are part of.
      if (tokens.length === 1 && tokens[0] !== undefined) on.set(tokens[0], { logit });
    }
    loaded.bias = { on, off: TokenBias.for(loaded.model) };
    return loaded.bias;
  }

  /** True while the model is in memory, so using it costs no loading time. */
  isLoaded(): boolean {
    return this.loaded !== null;
  }

  /**
   * Asks the model one question outside the conversation and returns its answer. Used
   * for her after-conversation note-taking. The conversation never sees it.
   *
   * Never loads or downloads the model: returns null when it is not already in memory,
   * or when the work is stopped or fails.
   */
  async sideQuestion(
    instructions: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const { loaded } = this;
    // Not while the model is being put away: work begun now would lose it half-way.
    if (!loaded || this.disposed || this.answering || this.unloading) return null;
    const stop = new AbortController();
    const stopSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    const work = (async (): Promise<string | null> => {
      // Its own small working space, so the conversation's is left exactly as it was.
      // Never less than the write-up needs: too small a space would fail the same way every time.
      const context = await loaded.model.createContext({
        contextSize: { min: 2048, max: 6144 },
        ...tuned(loaded.adapter),
      });
      try {
        if (stopSignal.aborted) return null;
        // This is plain writing-up, and it runs while the user may be waiting to talk
        // again: a model that would think first is asked to answer straight away.
        // Between a refresh and the next message there is no session to copy the form from.
        const usual = loaded.stale ? null : loaded.session.chatWrapper;
        const session = new LlamaChatSession({
          contextSequence: context.getSequence(),
          systemPrompt: instructions,
          ...(usual instanceof QwenChatWrapper
            ? {
                chatWrapper: new QwenChatWrapper({
                  variation: usual.variation,
                  thoughts: "discourage",
                }),
              }
            : {}),
        });
        const answer = await session.prompt(text, {
          maxTokens: 900,
          temperature: 0.2,
          signal: stopSignal,
          stopOnAbortSignal: true,
          budgets: { thoughtTokens: 0 },
        });
        return stopSignal.aborted ? null : answer;
      } finally {
        await context.dispose();
      }
    })();
    const entry = { done: work.catch(() => undefined), stop };
    this.sideWorks.add(entry);
    this.answering = true;
    try {
      return await work;
    } catch (error) {
      if (!stopSignal.aborted) console.warn("[engine] side work failed:", error);
      return null;
    } finally {
      this.answering = false;
      this.sideWorks.delete(entry);
      // The countdowns to putting the model away were held off for this.
      if (this.resting && this.loaded && !this.idleTimer) this.armTimers();
    }
  }

  /**
   * Opens a second, separate conversation with the model for a job she does on her own
   * (research, say) while the main conversation carries on. It has its own working
   * space and its own instructions, and shares nothing with the main conversation.
   *
   * Never loads the model: returns null when it is not in memory. While a worker is open
   * the model is not put away for being idle; it is closed (and its work stopped) when
   * the model is let go for any other reason.
   */
  async openWorker(
    instructions: string,
    workerOptions?: { adapterPath?: string | null; contextMax?: number },
  ): Promise<EngineWorker | null> {
    const { loaded } = this;
    if (!loaded || this.disposed || this.unloading) return null;
    const stop = new AbortController();
    let finish: () => void = () => undefined;
    const entry = { done: new Promise<void>((resolve) => (finish = resolve)), stop };
    this.sideWorks.add(entry);
    this.cancelIdleUnload();
    try {
      let adapter =
        workerOptions?.adapterPath !== undefined ? workerOptions.adapterPath : loaded.adapter;
      if (adapter !== null && !(await isFile(adapter))) adapter = null;
      const maxCtx = Math.max(4096, Math.round(workerOptions?.contextMax ?? 12288));
      const context = await loaded.model.createContext({
        contextSize: { min: Math.min(6144, maxCtx), max: maxCtx },
        ...tuned(adapter),
      });
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: instructions,
      });
      let closed = false;
      return {
        session,
        signal: stop.signal,
        close: async () => {
          if (closed) return;
          closed = true;
          try {
            session.dispose();
            await context.dispose();
          } finally {
            this.sideWorks.delete(entry);
            finish();
            // The model stayed loaded for this; start counting down again if nobody is talking.
            if (this.resting) this.restingNow();
          }
        },
      };
    } catch (error) {
      this.sideWorks.delete(entry);
      finish();
      throw error;
    }
  }

  /** Switches the smaller working memory on or off. Takes effect when the model is next loaded. */
  async setLean(lean: boolean): Promise<void> {
    if (lean === (this.options.lean === true)) return;
    this.options = { ...this.options, lean };
    await this.unload();
  }

  /** Switches giving the card back to games on (with a way of asking the card) or off. */
  setGameWatch(gameOnCard: (() => Promise<string | null>) | undefined): void {
    this.options = { ...this.options, gameOnCard };
    if (this.resting) this.restingNow();
  }

  /** Changes how long she stays awake without a message. 0 keeps the model loaded. */
  setIdleUnload(idleUnloadMs: number): void {
    this.options = { ...this.options, idleUnloadMs };
    if (this.resting) this.restingNow();
  }

  /** Call when a reply is finished; starts the countdown to freeing the model's memory. */
  restingNow(): void {
    this.cancelIdleUnload();
    this.resting = true;
    this.restingSince = Date.now();
    this.armTimers();
  }

  /** Starts the countdowns to putting the model away, unless a job of hers still needs it. */
  private armTimers(): void {
    if (!this.loaded || this.sideWorks.size > 0) return;
    this.watchForGame();
    if (this.options.idleUnloadMs <= 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => void this.unload(), this.options.idleUnloadMs);
    this.idleTimer.unref();
  }

  /**
   * While she rests with the model in memory, looks now and then whether a game has the
   * card, and if so gives the memory back once she has been quiet for a minute. A game
   * started in the middle of a long rest gets it back at the next look.
   */
  private watchForGame(): void {
    const { gameOnCard } = this.options;
    if (!gameOnCard || this.gameTimer) return;
    const patience = this.options.yieldAfterMs ?? YIELD_AFTER_MS;
    // Each watch has a number; a look that finds a newer watch has begun bows out.
    const watch = (this.gameWatches += 1);
    const again = (afterMs: number): void => {
      this.gameTimer = setTimeout(() => void look(), afterMs);
      this.gameTimer.unref();
    };
    const look = async (): Promise<void> => {
      if (this.gameWatches !== watch) return;
      this.gameTimer = null;
      if (!this.resting || !this.loaded || this.disposed) return;
      // A job she is doing on her own still needs the model; look again when it may be done.
      if (this.sideWorks.size > 0) return again(GAME_CHECK_EVERY_MS);
      const game = await gameOnCard().catch(() => null);
      // Much may have changed while the card was being asked: a message came in, the
      // watch was switched off, another look was started in this one's place.
      if (!this.resting || !this.loaded || this.disposed) return;
      if (this.options.gameOnCard !== gameOnCard || this.gameWatches !== watch) return;
      if (this.sideWorks.size > 0) return again(GAME_CHECK_EVERY_MS);
      const next = afterLookingForGame(game, Date.now() - this.restingSince, patience);
      if (next === "give back") {
        await this.unload(game ?? undefined);
        return;
      }
      again(next);
    };
    again(Math.min(patience, GAME_CHECK_EVERY_MS));
  }

  /**
   * Frees the model. A load or download in progress is stopped and whatever it produced is freed too.
   * @param forGame The game the memory is being given back to, when that is why.
   */
  async unload(forGame?: string): Promise<void> {
    // One at a time, and a message that arrives meanwhile waits for all of them: the
    // model must not be taken from under a reply that began while it was being let go.
    const before = this.unloading ?? Promise.resolve();
    const mine = before.catch(() => undefined).then(() => this.unloadNow(forGame));
    this.unloading = mine;
    try {
      await mine;
    } finally {
      // Only the last in line clears the mark; an earlier one would wipe a later one's.
      if (this.unloading === mine) this.unloading = null;
    }
  }

  private async unloadNow(forGame?: string): Promise<void> {
    this.cancelIdleUnload();
    this.download?.abort();
    this.downloadPausedByUser = false;
    this.bgDownloadAbort?.abort();
    if (this.bgDownloadPromise) await this.bgDownloadPromise.catch(() => undefined);
    if (this.loading) await this.loading.catch(() => undefined);
    // Whoever owns a piece of side work closes it when told to stop; wait for that.
    const works = [...this.sideWorks];
    for (const work of works) work.stop.abort();
    await Promise.all(works.map((work) => work.done));
    const loaded = this.loaded;
    if (!loaded) return;
    if (!loaded.stale) {
      this.history = loaded.session.getChatHistory().filter((item) => item.type !== "system");
    }
    this.loaded = null;
    if (!loaded.stale) loaded.session.dispose();
    await loaded.context.dispose();
    await loaded.model.dispose();
    if (!this.disposed) {
      this.options.onStatus({
        stage: "resting",
        label: loaded.label,
        ...(forGame === undefined ? {} : { game: forGame }),
      });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.unload();
    await this.llama?.dispose();
    this.llama = null;
  }

  private cancelIdleUnload(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.gameTimer) clearTimeout(this.gameTimer);
    this.gameTimer = null;
    // A look already asking the card finds its watch is over when the answer comes.
    this.gameWatches += 1;
  }

  private async load(systemPrompt: string): Promise<Loaded> {
    const { options } = this;
    this.llama ??= options.processorOnly
      ? await getLlama({ gpu: false, maxThreads: options.processorOnly.threads })
      : await getLlama();
    const llama = this.llama;
    const card = llama.gpu === false ? null : await llama.getVramState();
    let chosen = resolveBrain(options.choice, options.modelsDir, card?.total ?? null);
    let effectiveContextSize = options.contextSize;
    let effectiveLean = Boolean(options.lean);

    if (options.hardwareProfile) {
      const hw = await options.hardwareProfile().catch(() => null);
      if (hw) {
        const tierPref: "auto" | BrainModel["id"] =
          options.choice === "auto" || options.choice in BRAIN_MODELS
            ? (options.choice as "auto" | BrainModel["id"])
            : "auto";
        const rec = recommendHardwareTier(hw, tierPref);
        effectiveContextSize = Math.min(effectiveContextSize, rec.contextSize);
        effectiveLean = effectiveLean || rec.leanMemory;
        if (options.choice === "auto" || rec.stepDownFrom) {
          const candidate = resolveBrain(rec.tier, options.modelsDir, card?.total ?? hw.totalVramBytes);
          if (rec.stepDownFrom === undefined || (await isDownloaded(candidate))) {
            chosen = rec.stepDownFrom
              ? { ...candidate, label: `${candidate.label}, stepped down (${rec.tier})` }
              : candidate;
          }
        }
      }
    }

    // "auto" means she chooses. When the standard model no longer fits beside what is
    // already on the card (a game, an editor), the small one is the better choice: it
    // runs properly, where the standard one would spill over or push the other out.
    // Only when it is already on disk, so that this never starts a download.
    if (options.choice === "auto" && options.gameOnCard && card) {
      const small = resolveBrain("small", options.modelsDir, card.total);
      const standard = BRAIN_MODELS.standard;
      if (
        chosen.download?.id === standard.id &&
        card.free < standard.vramGb * GIB &&
        // Only for a game: on a card that is simply small, standard is still the choice it was.
        (await options.gameOnCard().catch(() => null)) !== null &&
        (await isDownloaded(small))
      ) {
        chosen = { ...small, label: `${small.label}, as the graphics card is busy` };
      }
    }

    if (this.bgDownloadPromise) {
      await this.bgDownloadPromise.catch(() => undefined);
    }

    if (!(await isDownloaded(chosen))) {
      if (!chosen.download) throw new Error(`The model file ${chosen.path} does not exist.`);
      await mkdir(options.modelsDir, { recursive: true });
      const total = chosen.download.sizeBytes;
      const disk = await probeDiskSpace(options.modelsDir, total);
      options.onStatus({
        stage: "downloading",
        label: chosen.label,
        received: 0,
        total,
        bytesPerSec: 0,
        etaSeconds: null,
        freeDiskBytes: disk.availableBytes,
      });
      this.download = new AbortController();
      this.lastDownloadChoice = options.choice;
      this.downloadPausedByUser = false;
      this.emitDownloadState({
        state: "downloading",
        tier: String(options.choice),
        label: chosen.label,
        received: 0,
        total,
        bytesPerSec: 0,
        etaSeconds: null,
        freeDiskBytes: disk.availableBytes,
        requiredBytes: disk.requiredBytes,
        error: null,
      });
      const tracker = this.createProgressTracker(
        String(options.choice),
        chosen.label,
        total,
        disk.availableBytes,
        disk.requiredBytes,
      );
      try {
        await downloadModelResumable({
          url: chosen.download.url,
          destPath: chosen.path,
          expectedSizeBytes: total,
          expectedSha256: chosen.download.sha256,
          signal: this.download.signal,
          cleanupPartialOnAbort: false,
          onProgress: tracker,
        });
        this.emitDownloadState({
          state: "ready",
          tier: String(options.choice),
          label: chosen.label,
          received: total,
          total,
          bytesPerSec: 0,
          etaSeconds: 0,
          freeDiskBytes: disk.availableBytes,
          requiredBytes: disk.requiredBytes,
          error: null,
        });
      } finally {
        this.download = null;
      }
    }
    // Settings may have changed while the download ran; what was asked for then is stale.
    if (this.options.choice !== options.choice || this.disposed) {
      throw new Error("Loading was cancelled.");
    }

    // A tuning that has gone missing is no reason not to load: she runs without it.
    let adapter = options.adapterFor?.(chosen) ?? null;
    if (adapter !== null && !(await isFile(adapter))) adapter = null;
    if (adapter !== null) chosen = { ...chosen, label: `${chosen.label}, tuned` };

    options.onStatus({ stage: "loading", label: chosen.label });
    const { model, context, cpuFallback } = await loadModelAndContextWithFallback(llama, {
      modelPath: chosen.path,
      effectiveContextSize,
      effectiveLean,
      allowLeanKv: chosen.download !== null,
      freeVramBytes: card?.free ?? null,
      adapter,
      processorOnly: options.processorOnly,
    });
    if (cpuFallback) {
      console.warn(
        "[engine] Available VRAM too low even with reduced GPU context; fell back to CPU offload (gpuLayers: 0).",
      );
      chosen = { ...chosen, label: `${chosen.label}, CPU offload (VRAM busy)` };
    }
    const sequence = context.getSequence();
    const session = new LlamaChatSession({ contextSequence: sequence, systemPrompt });
    if (this.history.length > 0) {
      const system = session.getChatHistory().filter((item) => item.type === "system");
      session.setChatHistory([...system, ...this.history]);
    }
    const loaded: Loaded = {
      path: chosen.path,
      model,
      context,
      sequence,
      session,
      label: chosen.label,
      adapter,
      stale: false,
      anchor: null,
      instructionsMark: null,
    };
    this.loaded = loaded;
    options.onStatus({ stage: "ready", label: chosen.label });
    return loaded;
  }
}

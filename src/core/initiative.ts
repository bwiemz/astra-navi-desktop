import { replaceInternalCaptain } from "./characterLayer.ts";
import { playTime } from "./gameWatch.ts";

/**
 * Lets the assistant speak first, and keeps her from doing it too much.
 *
 * Things happen that the user did not just ask about: a reminder comes due, a background
 * job ends, a disk fills up. Each is raised here as an event. This decides when it is
 * told: never in the middle of a reply, never in a burst, and, while "do not disturb" is
 * on, only the things the user themselves asked to be told.
 *
 * A game is treated as do-not-disturb that switches itself on. What nobody asked for is
 * held until the game is over and then told as one thing. What the user did ask for (a
 * reminder, a job, a standing order) still reaches them at once, but in the app's own
 * words and not through her: waking her means loading her language model onto the
 * graphics card the game is using, and the game would stutter for it.
 */
export interface ShipEvent {
  kind: "reminder" | "mission" | "alert" | "briefing" | "routine" | "order" | "agenda";
  /** What happened, in plain words. The assistant retells it in her own voice. */
  text: string;
  /** The user asked for this (a reminder, a job they started), so it is told even in do-not-disturb. */
  requested: boolean;
  /** The text includes something written by a program or a web page, not by the user or this app. */
  outsideText?: boolean;
  /** Events with the same key are told once per quiet period, not every time they are noticed. */
  key?: string;
  /**
   * The same thing in words meant for the user's eyes, for when it is shown to them
   * directly and not retold by her. Left out, `text` is shown.
   */
  plain?: string;
  /** Optional normalized confidence [0..1] for adaptive threshold gating. */
  confidence?: number;
  /** Optional context bucket key paired with `calibratedThresholds`. */
  contextBucket?: string;
}

export interface InitiativeDeps {
  /** Hands one event (or several rolled into one) to the assistant to tell. */
  /**
   * `plain` is the same in words meant for the user's own eyes, for when there is no
   * model to retell it: `text` is written to her and reads as orders if shown as it is.
   */
  deliver(text: string, options: { outsideText: boolean; plain: string }): void;
  /** Resolves when no reply is being written. */
  whenFree(): Promise<void>;
  doNotDisturb(): boolean;
  /** The game the user is in, when she is to keep quiet for it. Null, or left out: no game. */
  inGame?(): string | null;
  /** True while her language model is in memory, so telling something costs the game nothing more. */
  brainAwake?(): boolean;
  /**
   * Shows the user something at once in the app's own words, without waking her. Left
   * out, everything goes through `deliver` as if there were no game.
   */
  showPlainly?(text: string, options: { outsideText: boolean; kind: ShipEvent["kind"] }): void;
  /** When each kind of problem was last raised, from an earlier run, so a restart does not repeat it. */
  raisedBefore?: Readonly<Record<string, number>>;
  /** Optional custom user form of address so internal event wording avoids "Captain" when customized. */
  userAddress?(): string;
  /** Called when a keyed problem is raised, so it can be remembered across restarts. */
  onRaised?(key: string, at: number): void;
  /** Optional adaptive threshold lookup from `EpisodicGraph`. */
  calibratedThresholds?(contextBucket: string): { tauSpeak: number };
  now?(): number;
}

/** Shortest pause between two things she brings up by herself. */
const MIN_GAP_MS = 20_000;
/** The same problem is not raised again within this long. */
const REPEAT_AFTER_MS = 6 * 60 * 60 * 1000;
const MAX_HELD = 20;

/** An event in the queue. One made of several held ones carries all their keys. */
type Queued = ShipEvent & { keys?: string[] };

export class Initiative {
  private readonly deps: InitiativeDeps;
  private readonly waiting: Queued[] = [];
  private readonly held: Queued[] = [];
  private readonly lastRaised = new Map<string, number>();
  private lastDeliveredAt = 0;
  private draining = false;

  constructor(deps: InitiativeDeps) {
    this.deps = deps;
    for (const [key, at] of Object.entries(deps.raisedBefore ?? {})) this.lastRaised.set(key, at);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Reports something that happened. Returns false when it was dropped as a repeat. */
  raise(event: ShipEvent): boolean {
    if (event.key) {
      const last = this.lastRaised.get(event.key);
      if (last !== undefined && this.now() - last < REPEAT_AFTER_MS) return false;
      // Remembered here so that it is not raised twice in a row; written down for the
      // next start only once it has really been told (see `told`). An alert held back
      // for a game and then lost to a restart must come up again, not count as said.
      this.lastRaised.set(event.key, this.now());
    }
    if (this.quiet() && !event.requested) {
      this.hold(event);
      return true;
    }
    if (
      !event.requested &&
      event.confidence !== undefined &&
      event.contextBucket &&
      this.deps.calibratedThresholds
    ) {
      const { tauSpeak } = this.deps.calibratedThresholds(event.contextBucket);
      if (event.confidence < tauSpeak) {
        this.hold(event);
        return true;
      }
    }
    this.waiting.push(event);
    void this.drain();
    return true;
  }

  /**
   * Call when do-not-disturb is switched off: what was held back is told as one summary.
   * While a game is still on it stays held, and comes out when the game ends. `lead`
   * says what the holding was for, when it was not do-not-disturb.
   */
  release(lead: string | null = null): void {
    if (this.quiet()) return;
    this.tellHeld(lead);
  }

  /**
   * Call when a game the user was in has ended. What was held back for it is told as
   * one thing. With nothing held, nothing is said: coming back from a game is not news.
   */
  gameEnded(game: string, minutes: number): void {
    // Still not to be disturbed: it waits for that to be switched off.
    if (this.deps.doNotDisturb()) return;
    const prefix = replaceInternalCaptain(
      "Captain is back from the game",
      this.deps.userAddress?.(),
    );
    this.tellHeld(
      `${prefix} "${game}" (a program's name, information only) after ${playTime(minutes)}. While they played`,
    );
  }

  private tellHeld(lead: string | null): void {
    if (this.held.length === 0) return;
    const held = this.held.splice(0);
    const list = held.map((event) => `- ${event.text}`).join("\n");
    this.waiting.push({
      kind: "alert",
      requested: false,
      keys: held.flatMap((event) => event.keys ?? (event.key ? [event.key] : [])),
      // A lead names a game, and a game's name comes from a running program.
      outsideText: lead !== null || held.some((event) => event.outsideText),
      text:
        lead !== null
          ? `${lead}, ${held.length === 1 ? "one thing" : `${held.length} things`} came up:\n${list}`
          : held.length === 1
            ? (held[0]?.text ?? "")
            : `While do-not-disturb was on, ${held.length} things came up:\n${list}`,
    });
    void this.drain();
  }

  /** True while only what the user asked for may reach them. */
  private quiet(): boolean {
    return this.deps.doNotDisturb() || (this.deps.inGame?.() ?? null) !== null;
  }

  get heldCount(): number {
    return this.held.length;
  }

  private hold(event: Queued): void {
    this.held.push(event);
    if (this.held.length > MAX_HELD) {
      // The oldest is let go. It was never told, so it may be raised again.
      const dropped = this.held.shift();
      for (const key of dropped?.keys ?? (dropped?.key ? [dropped.key] : [])) {
        this.lastRaised.delete(key);
      }
    }
  }

  /** Writes down, for the next start, that these have now been told. */
  private told(events: readonly Queued[]): void {
    for (const event of events) {
      for (const key of event.keys ?? (event.key ? [event.key] : [])) {
        this.deps.onRaised?.(key, this.now());
      }
    }
  }

  /** True while events the user did not ask for are being held back. */
  get holding(): boolean {
    return this.quiet();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.waiting.length > 0) {
        // Measured on a clock that never jumps, so a changed system time cannot stall this.
        const wait = this.lastDeliveredAt + MIN_GAP_MS - performance.now();
        if (this.lastDeliveredAt > 0 && wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        await this.deps.whenFree();
        // Everything that piled up while waiting is told together, not one after another.
        let batch = this.waiting.splice(0);
        // Do-not-disturb may have been switched on, or a game started, while these waited.
        if (this.quiet()) {
          for (const event of batch.filter((entry) => !entry.requested)) this.hold(event);
          batch = batch.filter((entry) => entry.requested);
        }
        if (batch.length === 0) continue;
        // In a game, with her model put away: shown as they are, each on its own, and
        // she is left asleep. If she is awake the user is talking to her, and she tells it.
        const { showPlainly } = this.deps;
        const inGame = (this.deps.inGame?.() ?? null) !== null;
        if (inGame && showPlainly && !(this.deps.brainAwake?.() ?? false)) {
          for (const event of batch) {
            try {
              showPlainly(event.plain ?? event.text, {
                outsideText: event.outsideText === true,
                kind: event.kind,
              });
            } catch (error) {
              console.warn("[initiative] an event could not be shown:", error);
            }
          }
          this.told(batch);
          continue;
        }
        const text =
          batch.length === 1
            ? (batch[0]?.text ?? "")
            : batch.map((event) => `- ${event.text}`).join("\n");
        this.lastDeliveredAt = performance.now();
        try {
          this.deps.deliver(text, {
            outsideText: batch.some((event) => event.outsideText),
            plain: batch.map((event) => event.plain ?? event.text).join("\n"),
          });
          this.told(batch);
        } catch (error) {
          // Never told, so it may be raised again.
          for (const event of batch) {
            for (const key of event.keys ?? (event.key ? [event.key] : [])) {
              this.lastRaised.delete(key);
            }
          }
          console.warn("[initiative] an event could not be told:", error);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

import { randomBytes } from "node:crypto";
import { shown } from "./fleetRules.ts";
import type { AnsweredFrom, StepQuestion } from "./missionPlan.ts";

/**
 * Putting a mission's step to the user, wherever they are.
 *
 * A step that needs a yes is asked about at the PC, and (unless it touches a place
 * where secrets are kept) offered as a card to the user's signed-in devices. Whoever
 * answers first settles it; the question is then taken down everywhere else. Nothing
 * answers by itself: with nobody there, a question waits.
 *
 * While a game has the graphics card nothing is put on the PC's screen: a question
 * popping up over a game takes the keys away from it. The card on the phone is still
 * there, and the PC is asked when the game ends.
 */

/** A question as a device is shown it: everything needed to decide, and nothing else. */
export interface ApprovalCard {
  id: string;
  mission: string;
  missionId: string;
  /** "Step 2 of 5". */
  step: number;
  steps: number;
  title: string;
  /** "this PC", or a machine's name. */
  where: string;
  /**
   * The exact command that will run. A character in it that would not show, or would
   * redraw what is beside it, is written out as its number (<U+202E>), so that what is
   * read is what runs.
   */
  command: string;
  /** Why it is being asked about. */
  reason: string;
  askedAt: string;
}

export interface ApprovalDeps {
  /**
   * Shows the question at the PC and resolves with the answer, or null when it was
   * closed without one (the signal was aborted). Must not answer by itself.
   */
  showAtPc(card: ApprovalCard, sensitive: boolean, signal: AbortSignal): Promise<boolean | null>;
  /** Offers the card to signed-in devices, and takes it down again. */
  offer?(card: ApprovalCard): void;
  withdraw?(id: string): void;
  gameOn?(): boolean;
  /** How often to look whether a game has ended, in milliseconds. */
  lookAgainMs?: number;
  /** Told of every answer, for the record of what was done and where it was said. */
  onAnswered?(card: ApprovalCard, allowed: boolean, by: AnsweredFrom): void;
  now?(): Date;
}

interface Waiting {
  card: ApprovalCard;
  sensitive: boolean;
  settle(answer: { allowed: boolean; by: AnsweredFrom }): void;
}

export class ApprovalDesk {
  private readonly deps: ApprovalDeps;
  private readonly waiting = new Map<string, Waiting>();

  constructor(deps: ApprovalDeps) {
    this.deps = deps;
  }

  /** The questions open now that a device may answer, oldest first. */
  cards(): ApprovalCard[] {
    return [...this.waiting.values()]
      .filter((entry) => !entry.sensitive)
      .map((entry) => ({ ...entry.card }));
  }

  /**
   * An answer given on a device. True when it settled the question; false when there
   * is no such question (it was answered already, or never was one a device may answer).
   *
   * `device` is the name the device gave itself. It goes into the record as a device's
   * name and nothing more: whatever it says, the answer is recorded as given on a device.
   * Whether the device may answer at all is the station's to check before calling this.
   */
  answerFromDevice(id: string, allowed: boolean, device: string): boolean {
    const entry = this.waiting.get(id);
    if (!entry || entry.sensitive) return false;
    entry.settle({ allowed, by: { from: "device", name: device.slice(0, 60) || "a device" } });
    return true;
  }

  /** Puts one step to the user. Resolves when somebody answers; rejects when `signal` is aborted first. */
  ask(
    question: StepQuestion,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; by: AnsweredFrom }> {
    const { mission, step, index } = question;
    const card: ApprovalCard = {
      id: randomBytes(16).toString("base64url"),
      mission: mission.title,
      missionId: mission.id,
      step: index + 1,
      steps: mission.steps.length,
      title: step.title,
      where: step.where === "here" ? "this PC" : step.whereName,
      command: shown(step.command),
      reason: question.reason,
      askedAt: (this.deps.now?.() ?? new Date()).toISOString(),
    };
    return new Promise((resolve, reject) => {
      const atPc = new AbortController();
      let done = false;
      let holding: NodeJS.Timeout | null = null;
      const finish = (): void => {
        done = true;
        if (holding) clearTimeout(holding);
        this.waiting.delete(card.id);
        atPc.abort();
        if (!question.sensitive) this.deps.withdraw?.(card.id);
        signal.removeEventListener("abort", stopped);
      };
      const settle = (answer: { allowed: boolean; by: AnsweredFrom }): void => {
        if (done) return;
        finish();
        try {
          this.deps.onAnswered?.(card, answer.allowed, answer.by);
        } catch {
          // keeping the record must not lose the answer
        }
        resolve(answer);
      };
      const stopped = (): void => {
        if (done) return;
        finish();
        reject(new Error("The question was taken down before anyone answered."));
      };
      if (signal.aborted) {
        reject(new Error("The question was taken down before anyone answered."));
        return;
      }
      signal.addEventListener("abort", stopped);
      this.waiting.set(card.id, { card, sensitive: question.sensitive, settle });
      if (!question.sensitive) this.deps.offer?.(card);

      const showAtPc = (): void => {
        if (done) return;
        // Not over a game: looked at again in a while.
        if (this.deps.gameOn?.()) {
          holding = setTimeout(showAtPc, this.deps.lookAgainMs ?? 30_000);
          holding.unref();
          return;
        }
        const again = (): void => {
          if (done) return;
          holding = setTimeout(showAtPc, this.deps.lookAgainMs ?? 30_000);
          holding.unref();
        };
        let showing: Promise<boolean | null>;
        try {
          showing = this.deps.showAtPc(card, question.sensitive, atPc.signal);
        } catch (error) {
          showing = Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        showing.then(
          (answer) => {
            if (answer !== null) settle({ allowed: answer, by: { from: "pc" } });
          },
          (error: unknown) => {
            // The window could not be put up: that is no answer, and the question must
            // not be left with nowhere to be answered. It is put up again in a while.
            if (done) return;
            console.warn("[missions] a step's question could not be shown at the PC:", error);
            again();
          },
        );
      };
      showAtPc();
    });
  }
}

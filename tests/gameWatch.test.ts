import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolHost } from "../src/core/agentTools.ts";
import { ConfigStore } from "../src/core/config.ts";
import { cleanGameName, GameWatch, playTime, type PlaySession } from "../src/core/gameWatch.ts";
import { Initiative, type ShipEvent } from "../src/core/initiative.ts";
import { TOOLS } from "../src/core/permissions.ts";
import { buildSystemPrompt } from "../src/core/persona.ts";
import { describeGameMode } from "../src/core/selfCheck.ts";
import { createShipTools } from "../src/core/shipTools.ts";

const CIV = "Sid Meier's Civilization VII";

describe("the watch for games", () => {
  let dir: string;
  let file: string;
  let now: Date;
  let onCard: string | null;
  let looks: number;
  let started: string[];
  let ended: { game: string; minutes: number }[];

  const made: GameWatch[] = [];
  const watch = (): GameWatch => {
    const games = new GameWatch({
      file,
      look: () => {
        looks += 1;
        return Promise.resolve(onCard);
      },
      now: () => now,
      onStarted: (game) => started.push(game),
      onEnded: (game, minutes) => ended.push({ game, minutes }),
    });
    made.push(games);
    return games;
  };
  /** Moves the clock on and takes one look, as the timer would. */
  const lookAfter = async (
    games: GameWatch,
    minutes: number,
    seen: string | null,
  ): Promise<void> => {
    now = new Date(now.getTime() + minutes * 60_000);
    onCard = seen;
    await games.look();
  };
  const saved = async (
    predicate?: (data: { sessions: PlaySession[]; open?: unknown }) => boolean,
  ): Promise<{ sessions: PlaySession[]; open?: unknown }> => {
    const deadline = Date.now() + 2_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as {
          sessions: PlaySession[];
          open?: unknown;
        };
        if (!predicate || predicate(parsed)) return parsed;
      } catch (err) {
        lastError = err;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (lastError) throw lastError;
    return JSON.parse(await readFile(file, "utf8")) as { sessions: PlaySession[]; open?: unknown };
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aichan-games-"));
    file = join(dir, "play-log.json");
    now = new Date(2026, 10, 21, 20, 0, 0);
    onCard = null;
    looks = 0;
    started = [];
    ended = [];
  });
  afterEach(async () => {
    // Stopping sequentially avoids concurrent `.tmp` rename races when two instances share `file`.
    for (const games of made.splice(0)) {
      await games.stop();
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("believes a game only when it has been seen on two looks in a row", async () => {
    const games = watch();
    await lookAfter(games, 0, CIV);
    expect(games.current()).toBeNull();
    expect(started).toEqual([]);
    await lookAfter(games, 0.5, CIV);
    expect(started).toEqual([CIV]);
    // It began when it was first seen, not when it was believed.
    expect(games.current()).toEqual({ game: CIV, since: new Date(2026, 10, 21, 20, 0, 0) });
  });

  it("does not take a launcher that flickers past for a game", async () => {
    const games = watch();
    await lookAfter(games, 0, "Launcher.exe");
    await lookAfter(games, 0.5, null);
    await lookAfter(games, 0.5, "Launcher.exe");
    await lookAfter(games, 0.5, null);
    expect(games.current()).toBeNull();
    expect(started).toEqual([]);
  });

  it("believes a game is over only when it has been missing on two looks in a row", async () => {
    const games = watch();
    await lookAfter(games, 0, CIV);
    await lookAfter(games, 0.5, CIV);
    await lookAfter(games, 30, CIV);
    // A loading screen drops off the card for one look.
    await lookAfter(games, 0.5, null);
    expect(games.current()?.game).toBe(CIV);
    await lookAfter(games, 0.5, CIV);
    await lookAfter(games, 29, CIV);
    await lookAfter(games, 0.5, null);
    expect(ended).toEqual([]);
    await lookAfter(games, 0.5, null);
    expect(games.current()).toBeNull();
    // An hour, from first sight to the last look at which it was there.
    expect(ended).toEqual([{ game: CIV, minutes: 61 }]);
    expect(games.log()).toEqual([
      {
        game: CIV,
        startedAt: new Date(2026, 10, 21, 20, 0, 0).toISOString(),
        endedAt: new Date(2026, 10, 21, 21, 0, 30).toISOString(),
      },
    ]);
  });

  it("ends one game and starts the next when another takes the card", async () => {
    const games = watch();
    await lookAfter(games, 0, CIV);
    await lookAfter(games, 0.5, CIV);
    await lookAfter(games, 20, "Hades.x86_64");
    expect(games.current()?.game).toBe(CIV);
    await lookAfter(games, 0.5, "Hades.x86_64");
    expect(ended).toEqual([{ game: CIV, minutes: 1 }]);
    expect(started).toEqual([CIV, "Hades.x86_64"]);
    expect(games.current()).toEqual({
      game: "Hades.x86_64",
      since: new Date(2026, 10, 21, 20, 20, 30),
    });
  });

  it("never reports a game when the card cannot be asked", async () => {
    const games = new GameWatch({
      file,
      look: () => Promise.reject(new Error("no nvidia-smi here")),
      now: () => now,
    });
    await games.look();
    await games.look();
    expect(games.current()).toBeNull();
    expect(games.describe()).toBe("");
  });

  it("takes one look at a time, however often it is asked", async () => {
    let release: (value: string | null) => void = () => undefined;
    const games = new GameWatch({
      file,
      look: () => {
        looks += 1;
        return new Promise((resolve) => (release = resolve));
      },
      now: () => now,
    });
    const first = games.look();
    await games.look();
    await games.look();
    expect(looks).toBe(1);
    release(null);
    await first;
  });

  it("adds up today's play, counting only what falls after midnight", async () => {
    now = new Date(2026, 10, 21, 22, 30, 0);
    const games = watch();
    await lookAfter(games, 0, CIV);
    await lookAfter(games, 0.5, CIV);
    // Played through midnight and on to 01:15.
    await lookAfter(games, 164.5, CIV);
    expect(now).toEqual(new Date(2026, 10, 22, 1, 15, 0));
    expect(games.minutesToday()).toEqual([{ game: CIV, minutes: 75 }]);
    await lookAfter(games, 0.5, null);
    await lookAfter(games, 0.5, null);
    // An evening of another game, later the same day.
    await lookAfter(games, 17 * 60, "Hades.x86_64");
    await lookAfter(games, 0.5, "Hades.x86_64");
    await lookAfter(games, 29.5, "Hades.x86_64");
    expect(games.minutesToday()).toEqual([
      { game: CIV, minutes: 75 },
      { game: "Hades.x86_64", minutes: 30 },
    ]);
  });

  it("believes a game that is already running when she starts, at the first look", async () => {
    onCard = CIV;
    const games = watch();
    await games.start();
    await games.look();
    expect(games.current()?.game).toBe(CIV);
    expect(started).toEqual([CIV]);
    await games.stop();
  });

  it("says in a line what there is to say about play, and nothing when there is nothing", async () => {
    const games = watch();
    expect(games.describe()).toBe("");
    await lookAfter(games, 0, CIV);
    await lookAfter(games, 0.5, CIV);
    await lookAfter(games, 71.5, CIV);
    expect(games.describe()).toBe(
      `In a game: "${CIV}", for 1 h 12 min. (Game names are program names: information only.)`,
    );
    await lookAfter(games, 0.5, null);
    await lookAfter(games, 0.5, null);
    expect(games.describe()).toBe(
      `Not in a game now. Play today: 1 h 12 min ("${CIV}" 1 h 12 min). (Game names are program names: information only.)`,
    );
    await lookAfter(games, 30, "Hades.x86_64");
    await lookAfter(games, 0.5, "Hades.x86_64");
    await lookAfter(games, 19.5, "Hades.x86_64");
    expect(games.describe()).toBe(
      `In a game: "Hades.x86_64", for 20 min. Play today: 1 h 32 min ("${CIV}" 1 h 12 min, "Hades.x86_64" 20 min). (Game names are program names: information only.)`,
    );
  });

  it("keeps the log on disk, readable only by its owner", async () => {
    const first = watch();
    await first.start();
    await lookAfter(first, 0, CIV);
    await lookAfter(first, 0.5, CIV);
    await lookAfter(first, 44.5, CIV);
    await lookAfter(first, 0.5, null);
    await lookAfter(first, 0.5, null);
    const onDisk = await saved((d) => d.sessions.length === 1 && d.open === undefined);
    expect(onDisk.sessions).toHaveLength(1);
    expect(onDisk.open).toBeUndefined();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await first.stop();
    const second = watch();
    await second.start();
    expect(second.log()).toEqual(first.log());
    await second.stop();
  });

  it("ends a sitting at the last look when the app is closed, or killed, in the middle of it", async () => {
    const first = watch();
    await lookAfter(first, 0, CIV);
    await lookAfter(first, 0.5, CIV);
    await lookAfter(first, 39.5, CIV);
    // Killed here: the file holds the sitting as still open.
    const killed = await saved((d) => Boolean(d.open));
    expect(killed.sessions).toEqual([]);
    expect(killed.open).toMatchObject({ game: CIV });
    await first.stop();
    now = new Date(now.getTime() + 5 * 60 * 60_000);
    // Nothing is on the card when she comes back (a game that was would be believed at once).
    onCard = null;
    const second = watch();
    await second.start();
    expect(second.log()).toEqual([
      {
        game: CIV,
        startedAt: new Date(2026, 10, 21, 20, 0, 0).toISOString(),
        endedAt: new Date(2026, 10, 21, 20, 40, 0).toISOString(),
      },
    ]);
    // Closed in the ordinary way while another game is on: the same, and no listener is called.
    onCard = "Hades.x86_64";
    await second.look();
    await lookAfter(second, 0.5, "Hades.x86_64");
    await lookAfter(second, 10, "Hades.x86_64");
    await second.stop();
    expect(second.current()).toBeNull();
    expect(ended).toEqual([]);
    const finalSaved = await saved((d) => d.sessions.length === 2 && d.open === undefined);
    expect(finalSaved.sessions.map((session) => session.game)).toEqual([CIV, "Hades.x86_64"]);
    expect(finalSaved.open).toBeUndefined();
  });

  it("drops what in the file it could not have written, and keeps the rest", async () => {
    const at = (hours: number): string => new Date(2026, 10, 20, hours, 0, 0).toISOString();
    const good = { game: CIV, startedAt: at(18), endedAt: at(19) };
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        sessions: [
          good,
          { game: "", startedAt: at(1), endedAt: at(2) },
          { game: "x".repeat(200), startedAt: at(1), endedAt: at(2) },
          { game: "Back\u202eward", startedAt: at(1), endedAt: at(2) },
          { game: "Ends first", startedAt: at(5), endedAt: at(4) },
          { game: "Not a time", startedAt: "yesterday", endedAt: at(4) },
          { game: "A month long", startedAt: new Date(2026, 9, 1).toISOString(), endedAt: at(4) },
          {
            game: "Too old",
            startedAt: "2026-01-01T10:00:00.000Z",
            endedAt: "2026-01-01T11:00:00.000Z",
          },
          "nonsense",
          null,
        ],
        open: { game: "Left open\u0007", startedAt: at(20), lastSeenAt: at(21) },
      }),
    );
    const games = watch();
    await games.start();
    // A name with something in it that does not show is cleaned and kept: the sitting happened.
    expect(games.log()).toEqual([
      { game: "Back ward", startedAt: at(1), endedAt: at(2) },
      good,
      { game: "Left open", startedAt: at(20), endedAt: at(21) },
    ]);
    await games.stop();
    await writeFile(file, "{ not json");
    const again = watch();
    await again.start();
    expect(again.log()).toEqual([]);
    await again.stop();
  });

  it("forgets sittings older than sixty days", async () => {
    const games = watch();
    await lookAfter(games, 0, CIV);
    await lookAfter(games, 0.5, CIV);
    await lookAfter(games, 0.5, null);
    await lookAfter(games, 0.5, null);
    expect(games.log()).toHaveLength(1);
    await lookAfter(games, 61 * 24 * 60, "Hades.x86_64");
    await lookAfter(games, 0.5, "Hades.x86_64");
    await lookAfter(games, 0.5, null);
    await lookAfter(games, 0.5, null);
    expect(games.log().map((session) => session.game)).toEqual(["Hades.x86_64"]);
  });
});

describe("a game's name, which comes from a running program", () => {
  it("loses what does not show, and is kept short", () => {
    expect(cleanGameName("  Sid Meier's\u00a0Civilization\u200b VII\u202e ")).toBe(
      "Sid Meier's Civilization VII",
    );
    expect(cleanGameName("line one\nline two\ttabbed")).toBe("line one line two tabbed");
    expect(cleanGameName("x".repeat(300))).toHaveLength(80);
    expect(cleanGameName("\u200b\u202e")).toBe("a game");
  });

  it("is watched under the cleaned name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aichan-games-"));
    try {
      const games = new GameWatch({
        file: join(dir, "log.json"),
        look: () => Promise.resolve("BH3\u202e.exe"),
      });
      await games.look();
      await games.look();
      expect(games.current()?.game).toBe("BH3 .exe");
      await games.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("how she says a length of play", () => {
  it.each([
    [0, "0 min"],
    [45, "45 min"],
    [60, "1 h"],
    [72, "1 h 12 min"],
    [160.4, "2 h 40 min"],
  ])("%d minutes is %s", (minutes, said) => {
    expect(playTime(minutes)).toBe(said);
  });
});

describe("keeping quiet while a game is on", () => {
  const event = (text: string, extra: Partial<ShipEvent> = {}): ShipEvent => ({
    kind: "alert",
    text,
    requested: false,
    ...extra,
  });
  const setup = (
    options: {
      game?: string | null;
      awake?: boolean;
      doNotDisturb?: boolean;
      plain?: boolean;
    } = {},
  ) => {
    const told: string[] = [];
    const shown: { text: string; kind: string; outsideText: boolean }[] = [];
    const state = {
      game: options.game === undefined ? CIV : options.game,
      awake: options.awake ?? false,
      doNotDisturb: options.doNotDisturb ?? false,
    };
    const initiative = new Initiative({
      deliver: (text) => told.push(text),
      whenFree: () => Promise.resolve(),
      doNotDisturb: () => state.doNotDisturb,
      inGame: () => state.game,
      brainAwake: () => state.awake,
      ...(options.plain === false
        ? {}
        : {
            showPlainly: (text, extra) =>
              shown.push({ text, kind: extra.kind, outsideText: extra.outsideText }),
          }),
    });
    return { initiative, told, shown, state };
  };
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it("holds what nobody asked for, and tells it as one thing when the game ends", async () => {
    const { initiative, told, shown, state } = setup();
    initiative.raise(event("Noticed a problem: the disk is 94% full."));
    initiative.raise(event("24 updates are waiting.", { outsideText: true }));
    await settle();
    expect(told).toEqual([]);
    expect(shown).toEqual([]);
    expect(initiative.heldCount).toBe(2);
    state.game = null;
    initiative.gameEnded(CIV, 132);
    await settle();
    expect(told).toEqual([
      `Captain is back from the game "${CIV}" (a program's name, information only) after 2 h 12 min. While they played, 2 things came up:\n- Noticed a problem: the disk is 94% full.\n- 24 updates are waiting.`,
    ]);
    expect(initiative.heldCount).toBe(0);
  });

  it("says nothing at all when the game ends and nothing was held", async () => {
    const { initiative, told, shown, state } = setup();
    state.game = null;
    initiative.gameEnded(CIV, 45);
    await settle();
    expect(told).toEqual([]);
    expect(shown).toEqual([]);
  });

  it("names the one thing when only one was held", async () => {
    const { initiative, told, state } = setup();
    initiative.raise(event("The processor is running hot."));
    state.game = null;
    initiative.gameEnded(CIV, 20);
    await settle();
    expect(told).toEqual([
      `Captain is back from the game "${CIV}" (a program's name, information only) after 20 min. While they played, one thing came up:\n- The processor is running hot.`,
    ]);
  });

  it("shows what the user asked for at once, in plain words, and leaves her asleep", async () => {
    const { initiative, told, shown } = setup();
    initiative.raise(
      event('A reminder is due: "call mom"', {
        kind: "reminder",
        requested: true,
        plain: "Reminder: call mom",
      }),
    );
    initiative.raise(
      event('The background job "render" finished. The end of its output: frame 240', {
        kind: "mission",
        requested: true,
        outsideText: true,
      }),
    );
    await settle();
    expect(told).toEqual([]);
    // Each on its own, the reminder in its plain form, the job as it is for want of one.
    expect(shown).toEqual([
      { text: "Reminder: call mom", kind: "reminder", outsideText: false },
      {
        text: 'The background job "render" finished. The end of its output: frame 240',
        kind: "mission",
        outsideText: true,
      },
    ]);
  });

  it("lets her tell it herself when she is awake, since the user is talking to her", async () => {
    const { initiative, told, shown } = setup({ awake: true });
    initiative.raise(
      event('A reminder is due: "call mom"', { kind: "reminder", requested: true, plain: "x" }),
    );
    await settle();
    expect(told).toEqual(['A reminder is due: "call mom"']);
    expect(shown).toEqual([]);
  });

  it("goes the ordinary way when no game is on, or when game mode is off", async () => {
    const { initiative, told, shown } = setup({ game: null });
    initiative.raise(event("Disk is full."));
    await settle();
    initiative.raise(event('A reminder is due: "tea"', { kind: "reminder", requested: true }));
    expect(told).toEqual(["Disk is full."]);
    expect(shown).toEqual([]);
    expect(initiative.heldCount).toBe(0);
  });

  it("has her tell it when there is no way of showing it plainly", async () => {
    const { initiative, told } = setup({ plain: false });
    initiative.raise(event('A reminder is due: "tea"', { kind: "reminder", requested: true }));
    await settle();
    expect(told).toEqual(['A reminder is due: "tea"']);
  });

  it("holds something raised just before the game began, if it had not been told yet", async () => {
    const { initiative, told, state } = setup({ game: null });
    let free: () => void = () => undefined;
    const busy = new Promise<void>((resolve) => (free = resolve));
    const waiting = new Initiative({
      deliver: (text) => told.push(text),
      whenFree: () => busy,
      doNotDisturb: () => false,
      inGame: () => state.game,
    });
    waiting.raise(event("Memory is low."));
    await settle();
    state.game = CIV;
    free();
    await settle();
    expect(told).toEqual([]);
    expect(waiting.heldCount).toBe(1);
    expect(initiative.heldCount).toBe(0);
  });

  it("keeps holding after the game while do-not-disturb is on, and after do-not-disturb while the game is on", async () => {
    const { initiative, told, state } = setup({ doNotDisturb: true });
    initiative.raise(event("Memory is low."));
    initiative.raise(event("Disk is full."));
    // Do-not-disturb goes off in the middle of the game: still quiet.
    state.doNotDisturb = false;
    initiative.release();
    await settle();
    expect(told).toEqual([]);
    expect(initiative.heldCount).toBe(2);
    // The game ends, but do-not-disturb is back on: still quiet.
    state.doNotDisturb = true;
    state.game = null;
    initiative.gameEnded(CIV, 30);
    await settle();
    expect(told).toEqual([]);
    state.doNotDisturb = false;
    initiative.release();
    await settle();
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("While do-not-disturb was on, 2 things came up");
  });

  it("lets out what was held when game mode is switched off in the middle of a game", async () => {
    const { initiative, told, state } = setup();
    initiative.raise(event("Memory is low."));
    // The setting is off now, which is what the app's own answer to "in a game?" follows.
    state.game = null;
    initiative.release("While you were keeping quiet for the game");
    await settle();
    expect(told).toEqual([
      "While you were keeping quiet for the game, one thing came up:\n- Memory is low.",
    ]);
  });
});

describe("what she knows of it", () => {
  const host = {
    policy: () => ({ workspace: tmpdir(), home: tmpdir() }),
    memory: undefined as never,
    learnAddresses: () => undefined,
    noteOutsideText: () => undefined,
    noteChange: () => undefined,
    signal: () => undefined,
    activity: () => undefined,
    ran: () => undefined,
    ask: () => Promise.resolve(true),
    step: () => 1,
  } satisfies ToolHost;
  const shipStatus = (games?: { describe(): string }): Promise<string> => {
    const tools = createShipTools(host, {
      reminders: undefined as never,
      missions: undefined as never,
      deckLogFile: join(tmpdir(), "unused-deck-log.md"),
      ...(games ? { games } : {}),
    });
    return (tools[TOOLS.shipStatus]?.handler as (input: object) => Promise<string>)({});
  };

  it("finds the game and the day's play in the ship's status", async () => {
    const line = `In a game: ${CIV}, for 1 h 12 min.`;
    const status = await shipStatus({ describe: () => line });
    expect(status).toContain(`\n${line}\n`);
    expect(status.indexOf(line)).toBeGreaterThan(status.indexOf("Ship status"));
  });

  it("finds nothing added when there has been no play, or no watch is kept", async () => {
    const quiet = await shipStatus({ describe: () => "" });
    expect(quiet).not.toContain("In a game");
    expect(quiet).not.toMatch(/\n\n/);
    expect(await shipStatus()).not.toContain("In a game");
  });

  it("is told where to look, and not to bring up how long herself", () => {
    const prompt = buildSystemPrompt(
      {
        userName: "sam",
        home: "/home/sam",
        workspace: "/home/sam/Documents/AI-chan",
        osName: "Arch Linux",
        desktop: "KDE (wayland)",
        commands: new Set(),
      },
      "(none)",
    );
    expect(prompt).toContain("which game Captain is in and how long they have played today");
    expect(prompt).toContain("Say how long only when Captain asks; never remark on it yourself.");
  });

  it("reports game mode in her self-check", () => {
    expect(describeGameMode({ quiet: true, playing: null })).toBe(
      "On: she will keep quiet while a game runs. No game is running now.",
    );
    expect(describeGameMode({ quiet: true, playing: CIV, held: 2 })).toBe(
      `Keeping quiet while ${CIV} runs: what she would bring up herself waits until it is over, and reminders are shown as plain notices. 2 things are waiting to be told.`,
    );
    expect(describeGameMode({ quiet: true, playing: null, held: 1 })).toContain(
      "One thing is waiting to be told.",
    );
    expect(describeGameMode({ quiet: false, playing: CIV, held: 3 })).toBe(
      `Off: ${CIV} is running, and she speaks up as at any other time.`,
    );
    expect(describeGameMode({ quiet: false, playing: null })).toMatch(/^Off: /);
  });
});

describe("the setting for staying quiet in games", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aichan-quiet-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is on unless switched off, is kept, and survives a settings file without it", async () => {
    const file = join(dir, "config.json");
    const first = new ConfigStore(file);
    expect((await first.load()).quietInGames).toBe(true);
    await first.update({ quietInGames: false });
    const second = new ConfigStore(file);
    expect((await second.load()).quietInGames).toBe(false);
    await writeFile(file, JSON.stringify({ brain: "small" }));
    expect((await new ConfigStore(file).load()).quietInGames).toBe(true);
  });

  it("goes from the settings page to the app and back", async () => {
    const read = (path: string): Promise<string> =>
      readFile(join(import.meta.dirname, "..", path), "utf8");
    const [schema, settingsIpc, page, script, shared] = await Promise.all([
      read("src/main/settingsSchema.ts"),
      read("src/main/settingsIpc.ts"),
      read("src/renderer/settings.html"),
      read("src/renderer/src/settings.ts"),
      read("src/shared/settings.ts"),
    ]);
    expect(schema).toContain("quietInGames: z.boolean(),");
    expect(settingsIpc).toContain("quietInGames: config.value.quietInGames,");
    expect(settingsIpc).toContain("{ quietInGames: patch.quietInGames }");
    expect(shared).toContain("quietInGames: boolean;");
    expect(shared).toContain("quietInGames?: boolean;");
    expect(page).toContain('<input id="quietInGames" type="checkbox" />');
    expect(page).toContain("Stay quiet while a game is running");
    expect(script).toContain('"quietInGames",');
    expect(script).toContain(
      'element<HTMLInputElement>("quietInGames").checked = view.quietInGames',
    );
  });

  it('is what the app\'s answer to "in a game?" follows, and her brain is left asleep for a notice', async () => {
    const main = await readFile(join(import.meta.dirname, "..", "src/main/index.ts"), "utf8");
    expect(main).toContain(
      "inGame: () => (config.value.quietInGames ? (gameWatch?.current()?.game ?? null) : null),",
    );
    expect(main).toContain("brainAwake: () => engine?.isLoaded() ?? false,");
    expect(main).toContain("initiative?.gameEnded(game, minutes);");
    expect(main).toContain("await gameWatch?.stop();");
    // What is shown without her is cut short and cleaned first, whatever it is.
    const notice = main.slice(main.indexOf("function showNotice("));
    expect(notice.slice(0, notice.indexOf("\n}\n"))).toContain("const message = excerpt(text);");
    expect(main).not.toMatch(/new Notification\(\{[^}]*body: text/);
  });
});

import { describe, expect, it } from "vitest";
import type { EnvironmentFacts } from "../src/core/environment.ts";
import { LANGUAGE_CODES, LANGUAGES } from "../src/core/languages.ts";
import {
  AWAY_MARK,
  buildSystemPrompt,
  EVENT_MARK,
  EVERY_ABILITY,
  FORM_MARK,
  FORM_SPOKEN,
  FORM_TYPED,
  NOTES_MARK,
  VOICE_MARK,
  type Abilities,
} from "../src/core/persona.ts";
import { CLOCK_MARK } from "../src/core/clock.ts";
import { EARLIER_MARK } from "../src/core/compaction.ts";
import { SCREEN_MARK } from "../src/core/watch.ts";
import { MOODS } from "../src/shared/ipc.ts";

const env: EnvironmentFacts = {
  userName: "sam",
  home: "/home/sam",
  workspace: "/home/sam/Documents/Astra-Navi",
  osName: "Arch Linux",
  desktop: "KDE (wayland)",
  commands: new Set(["pacman", "pkexec", "ffmpeg", "ffprobe", "soffice"]),
};

describe("buildSystemPrompt", () => {
  it("tells her which language to speak, with examples in that language", () => {
    for (const code of LANGUAGE_CODES) {
      const prompt = buildSystemPrompt(env, "(none)", code);
      expect(prompt).toContain(LANGUAGES[code].instruction);
      for (const [user, , reply] of LANGUAGES[code].examples) {
        expect(prompt).toContain(user);
        expect(prompt).toContain(reply);
      }
    }
    expect(buildSystemPrompt(env, "(none)", "ja")).not.toContain(LANGUAGES.en.examples[0][2]);
  });

  it("keeps mood tags, the voice mark and the memory block the same in every language", () => {
    for (const code of LANGUAGE_CODES) {
      const prompt = buildSystemPrompt(env, "- [ab12] (profile) Likes tea.", code);
      for (const mood of MOODS) expect(prompt).toContain(`[[${mood}]]`);
      expect(prompt).toContain(VOICE_MARK);
      expect(prompt).toContain("<memories>\n- [ab12] (profile) Likes tea.\n</memories>");
    }
  });

  it("describes this computer and introduces Astra Navi as a local AI model", () => {
    const prompt = buildSystemPrompt(env, "(none)");
    expect(prompt).toContain("pkexec pacman -S --needed --noconfirm");
    expect(prompt).toContain("/home/sam/Documents/Astra-Navi");
    expect(prompt).toContain("Astra Navi");
    expect(prompt).toContain("open AI model");
    expect(prompt).not.toMatch(/sudo [a-z]/);
  });

  it("uses only moods she has in the examples", () => {
    for (const code of LANGUAGE_CODES) {
      for (const [, mood] of LANGUAGES[code].examples) expect(MOODS).toContain(mood);
    }
  });

  const NONE: Abilities = {
    operate: false,
    watch: false,
    listen: false,
    notices: false,
    machines: false,
    phone: false,
    station: false,
  };
  const withOnly = (ability: keyof Abilities): string =>
    buildSystemPrompt(env, "(none)", "en", 1, { ...NONE, [ability]: true });

  it("spends words only on the abilities that are switched on", () => {
    const bare = buildSystemPrompt(env, "(none)", "en", 1, NONE);
    const full = buildSystemPrompt(env, "(none)", "en", 1, EVERY_ABILITY);
    expect(buildSystemPrompt(env, "(none)")).toBe(full);
    expect(bare.length).toBeLessThan(full.length - 900);

    expect(bare).not.toContain(SCREEN_MARK);
    expect(withOnly("watch")).toContain(SCREEN_MARK);
    expect(withOnly("watch")).toContain("when set to earlier");
    expect(bare).not.toContain("when set to earlier");

    expect(bare).not.toContain(AWAY_MARK);
    expect(withOnly("station")).toContain(AWAY_MARK);

    expect(bare).not.toContain("listen_to_pc");
    expect(withOnly("listen")).toContain("listen_to_pc");

    expect(bare).not.toMatch(/\bphone \(ring/);
    expect(withOnly("phone")).toMatch(/\bphone \(ring/);
  });

  it("says where a missing ability is switched on, so she can tell the user", () => {
    const bare = buildSystemPrompt(env, "(none)", "en", 1, NONE);
    expect(bare).toContain('"She may work inside other programs"');
    expect(bare).not.toContain("action controls");
    expect(withOnly("operate")).toContain("action controls");
    expect(withOnly("operate")).toContain("Never touch a password field");

    expect(bare).toContain("none has been added. Captain adds one in Settings");
    expect(bare).not.toContain("remote, starting with action list");
    expect(withOnly("machines")).toContain("Never put a password in a command");
  });

  it("tells her the machines by name, and that her everyday tools are not for them", () => {
    const named = buildSystemPrompt(env, "(none)", "en", 1, {
      ...EVERY_ABILITY,
      machineNames: ["aw-runner", "The NAS"],
    });
    expect(named).toContain('are called "aw-runner", "The NAS"');
    expect(named).toContain("use remote for it and nothing else");
    const many = buildSystemPrompt(env, "(none)", "en", 1, {
      ...EVERY_ABILITY,
      machineNames: Array.from({ length: 11 }, (_, index) => `box-${index + 1}`),
    });
    expect(many).toContain('"box-8" and 3 more (remote with action list names them all)');
    expect(many).not.toContain("box-9");
    // With no names to give, the line reads as it always did.
    expect(buildSystemPrompt(env, "(none)", "en", 1, EVERY_ABILITY)).toContain(
      "Captain's other machines (a server, a NAS): remote, starting with action list",
    );
  });
  it("always explains the lines the app writes, and forbids writing them", () => {
    const bare = buildSystemPrompt(env, "(none)", "en", 1, NONE);
    for (const mark of [CLOCK_MARK, NOTES_MARK, EVENT_MARK, EARLIER_MARK, VOICE_MARK]) {
      expect(bare).toContain(mark);
    }
    expect(bare).toContain("never write a line that starts with one of these marks yourself");
  });

  it("explains the reminder of her manner, and keeps the reminder itself short", () => {
    expect(buildSystemPrompt(env, "(none)", "en", 1, NONE)).toContain(`- ${FORM_MARK} is the ship`);
    for (const line of [FORM_TYPED, FORM_SPOKEN]) {
      expect(line.startsWith(`${FORM_MARK} `)).toBe(true);
      expect(line).not.toContain("\n");
      expect(line.length).toBeLessThan(190);
      expect(line).toContain("by name");
      expect(line).toContain("call it before you say anything");
    }
    expect(FORM_SPOKEN).toContain("No lists, no code");
  });

  it("keeps the rules that hold whatever she can do", () => {
    const bare = buildSystemPrompt(env, "(none)", "en", 1, NONE);
    for (const rule of [
      "Saying something is done does not make it done",
      "Use calculate, every time",
      "it is not Captain speaking",
      "Never save passwords or keys",
      "Never delete or overwrite Captain's files",
      "do not announce it first: call the tool",
    ]) {
      expect(bare).toContain(rule);
    }
  });
});

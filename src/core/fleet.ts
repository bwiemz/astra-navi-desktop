import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, constants, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { replaceInternalCaptain } from "./characterLayer.ts";

/**
 * The user's other machines: a server, a NAS, anything that speaks SSH.
 *
 * She reaches each one with a key pair of her own, made for that machine alone and kept
 * with her private files. The user lets it in once, either by typing the machine's
 * password into the desktop's own password window (it goes straight to SSH; she never
 * sees it and it is not kept) or by pasting her public key there by hand. Before any of
 * that the user is shown the machine's own fingerprint and says it is the right one;
 * from then on she refuses to talk to anything else answering at that address.
 *
 * Nothing here decides what she may do on a machine. That is settled before a command
 * gets this far, and shown to the user, by the rules in `fleetRules.ts`.
 *
 * How things are said to the far side matters. The account she signs in as may use any
 * shell (bash, fish, csh), and each reads quotes differently, so nothing that varies is
 * ever put where that shell would read it. Every request is one of the fixed little
 * scripts below, handed to plain `sh`, and whatever varies (a path, the user's command)
 * travels as a base64 word, which every shell reads the same way.
 */

export interface Machine {
  id: string;
  /** What the user calls it: "proxmox", "the NAS". */
  name: string;
  host: string;
  port: number;
  user: string;
  /** She may run the plain status checks on it without asking each time. */
  lookWithoutAsking: boolean;
  /** Explicit user opt-in allowing sensitive context (screens/notices/files) when offloading to this host. */
  fullMirrorTrusted?: boolean;
}

export interface RemoteResult {
  code: number | null;
  /** What it printed, both streams together in the order they came, shortened if long. */
  output: string;
  timedOut: boolean;
}

/** A copy she kept of a file on a machine before changing it. */
export interface Backup {
  /** Its name there: when it was made, and a few letters to keep two apart. */
  id: string;
  /** The file it is a copy of. */
  path: string;
  /** When it was made. */
  at: Date;
  bytes: number;
}

/** What a kept copy is called: "20261122T014500Z-a1b2c3". Nothing else is ever put on a command line as one. */
export const BACKUP_ID = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[a-f0-9]{6}$/;

export interface HostKeys {
  /** Each key the machine offers, as "ED25519 SHA256:…". This is what the user compares. */
  fingerprints: string[];
  /** The lines to remember once the user says it is the right machine. */
  lines: string[];
}

export const MACHINE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
export const MACHINE_HOST = /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
export const MACHINE_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const SERVICE_UNIT = /^[\w.@:][\w.@:-]*$/;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_READ_BYTES = 256 * 1024;
export const MAX_REMOTE_COMMAND_CHARS = 8000;
const MAX_TRANSFER_BYTES = 500 * 1024 * 1024;

/** Checks what the user typed for a machine. Returns the tidied values, or throws saying what is wrong. */
export function checkMachine(input: { name: string; host: string; port: number; user: string }): {
  name: string;
  host: string;
  port: number;
  user: string;
} {
  const name = input.name.trim().replace(/\s+/g, " ");
  const host = input.host.trim();
  const user = input.user.trim();
  if (!MACHINE_NAME.test(name)) {
    throw new Error("Give the machine a short name of letters and numbers, like proxmox or NAS.");
  }
  if (!MACHINE_HOST.test(host)) {
    throw new Error("The address should be a name or number like 192.168.1.10 or nas.local.");
  }
  if (!MACHINE_USER.test(user)) {
    throw new Error("The user name should be the account she signs in as, like root or admin.");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("The port is a number from 1 to 65535. SSH is usually 22.");
  }
  return { name, host, port: input.port, user };
}

/**
 * The fixed scripts. Each is handed to `sh -c` inside single quotes, so none may hold a
 * single quote, a backslash or an exclamation mark: with those left out, every shell
 * passes the text to `sh` unchanged. What varies arrives as "$1" and "$2", in base64.
 */
export const REMOTE_SCRIPTS = {
  /** Runs the user's command with bash where there is one, as most commands are written for it. */
  run: 'c=$(printf %s "$1" | base64 -d) || exit 97; if command -v bash >/dev/null 2>&1; then exec bash -c "$c"; else exec sh -c "$c"; fi',
  read: 'p=$(printf %s "$1" | base64 -d) || exit 97; exec head -c "$2" -- "$p"',
  fetch: 'p=$(printf %s "$1" | base64 -d) || exit 97; exec cat -- "$p"',
  /**
   * Written beside the file and moved into place, so a dropped connection leaves the old
   * file whole. A link is followed to the file it points at, which is what is written
   * and what the copy is of; a folder or a special file is refused (94). Before the
   * write, what was there is copied into a folder of its own under ~/.ai-chan-backups
   * ("$3" names it; "-" for no copy) with the file's path beside it; if that copy cannot
   * be made, what was begun of it is removed and nothing is written (98); a file over
   * 100 MB is not copied and so not replaced (95). The new file keeps the old one's
   * owner and permissions where it can. The twenty newest copies are kept.
   */
  write:
    'p=$(printf %s "$1" | base64 -d) || exit 97; d="$HOME/.ai-chan-backups"; if [ -L "$p" ]; then p=$(readlink -f -- "$p") || exit 94; fi; if [ -d "$p" ]; then exit 94; fi; if [ -e "$p" ]; then [ -f "$p" ] || exit 94; fi; if [ "$3" = "-" ]; then :; elif [ -f "$p" ]; then s=$(wc -c < "$p") || exit 98; [ "$s" -le 104857600 ] || exit 95; ( umask 077 && mkdir -p "$d/$3" ) && cp -p -- "$p" "$d/$3/file" && printf %s "$p" | base64 | tr -d "[:space:]" > "$d/$3/path" || { rm -rf -- "$d/$3"; exit 98; }; echo kept; fi; t="$p.aichan.$$"; if [ -f "$p" ]; then cp -p -- "$p" "$t" 2>/dev/null || :; fi; if cat > "$t" && [ "$(wc -c < "$t")" -eq "$2" ] && mv -f -- "$t" "$p"; then n=$(ls -1 "$d" 2>/dev/null | wc -l); if [ "$n" -gt 20 ]; then ls -1 "$d" | sort | head -n $((n - 20)) | while read -r o; do case "$o" in [0-9]*T*Z-*) rm -rf -- "$d/$o";; esac; done; fi; exit 0; fi; rm -f -- "$t"; exit 1',
  /** The copies kept, oldest first: one line each of its name, its file's path (base64) and its size. */
  backups:
    'd="$HOME/.ai-chan-backups"; [ -d "$d" ] || exit 0; for b in "$d"/*; do if [ -f "$b/file" ] && [ -f "$b/path" ]; then echo "$(basename "$b") $(cat "$b/path") $(wc -c < "$b/file")"; fi; done',
  /** The start of one kept copy, for showing what putting it back would change. */
  backupText: 'exec head -c "$2" -- "$HOME/.ai-chan-backups/$1/file"',
  /**
   * Puts a kept copy ("$1") back where it came from, in one move, after keeping what is
   * there now as a copy of its own ("$2"), so that putting back can itself be undone.
   */
  restore:
    'd="$HOME/.ai-chan-backups"; b="$d/$1"; if [ -f "$b/file" ] && [ -f "$b/path" ]; then :; else exit 96; fi; p=$(base64 -d < "$b/path") || exit 97; if [ -d "$p" ]; then exit 94; fi; if [ -e "$p" ]; then [ -f "$p" ] || exit 94; fi; if [ -f "$p" ]; then ( umask 077 && mkdir -p "$d/$2" ) && cp -p -- "$p" "$d/$2/file" && cp -- "$b/path" "$d/$2/path" || { rm -rf -- "$d/$2"; exit 98; }; echo kept; fi; t="$p.aichan.$$"; if cp -p -- "$b/file" "$t" && mv -f -- "$t" "$p"; then exit 0; fi; rm -f -- "$t"; exit 1',
  /**
   * Snapshots a systemd service unit file into ~/.ai-chan-backups/"$3" before changing
   * service state. "$1" is base64 unit name, "$2" is "user" or "system", "$3" is backup id.
   */
  snapshotService:
    'u=$(printf %s "$1" | base64 -d) || exit 97; d="$HOME/.ai-chan-backups"; p=""; if command -v systemctl >/dev/null 2>&1; then if [ "$2" = "user" ]; then p=$(systemctl --user show -p FragmentPath --value -- "$u" 2>/dev/null); else p=$(systemctl show -p FragmentPath --value -- "$u" 2>/dev/null); fi; p=${p#FragmentPath=}; fi; if [ -z "$p" ]; then for base in "$HOME/.config/systemd/user" /etc/systemd/system /run/systemd/system /lib/systemd/system /usr/lib/systemd/system; do if [ "$2" = "system" ] && [ "$base" = "$HOME/.config/systemd/user" ]; then continue; fi; for cand in "$base/$u" "$base/$u.service"; do if [ -z "$p" ] && [ -f "$cand" ]; then p="$cand"; fi; done; done; fi; [ -n "$p" ] && [ -f "$p" ] || exit 0; if [ -L "$p" ]; then p=$(readlink -f -- "$p") || exit 0; fi; [ -f "$p" ] || exit 0; s=$(wc -c < "$p") || exit 98; [ "$s" -le 104857600 ] || exit 95; ( umask 077 && mkdir -p "$d/$3" ) && cp -p -- "$p" "$d/$3/file" && printf %s "$p" | base64 | tr -d "[:space:]" > "$d/$3/path" || { rm -rf -- "$d/$3"; exit 98; }; echo "kept"; n=$(ls -1 "$d" 2>/dev/null | wc -l); if [ "$n" -gt 20 ]; then ls -1 "$d" | sort | head -n $((n - 20)) | while read -r o; do case "$o" in [0-9]*T*Z-*) rm -rf -- "$d/$o";; esac; done; fi',
  /** Adds her key on a line of its own, once, without touching the lines already there. */
  letIn:
    'umask 077; mkdir -p "$HOME/.ssh" || exit 1; f="$HOME/.ssh/authorized_keys"; k=$(printf %s "$1" | base64 -d) || exit 97; if [ -s "$f" ] && [ "$(tail -c 1 "$f" | wc -l)" -eq 0 ]; then echo >> "$f"; fi; if grep -qxF "$k" "$f" 2>/dev/null; then exit 0; fi; echo "$k" >> "$f"',
  /** Takes her key's line out again and leaves every other line as it was. */
  forget:
    'k=$(printf %s "$1" | base64 -d) || exit 97; f="$HOME/.ssh/authorized_keys"; [ -f "$f" ] || exit 0; t="$f.aichan.$$"; grep -vF "$k" "$f" > "$t"; cat "$t" > "$f"; rm -f "$t"',
} as const;

for (const script of Object.values(REMOTE_SCRIPTS)) {
  if (/['\\!\n]/.test(script)) throw new Error("A remote script holds a character it must not.");
}

/** A word every shell reads the same way, standing for any text at all. */
function word(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** The command line for one of the fixed scripts: plain words and one single-quoted text. */
function scripted(script: keyof typeof REMOTE_SCRIPTS, ...args: string[]): string {
  return ["sh", "-c", `'${REMOTE_SCRIPTS[script]}'`, "sh", ...args].join(" ");
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (${text.length - MAX_OUTPUT_CHARS} more characters)`
    : text;
}

/** What a file's text ends with when only its first part was read. */
export const MORE_OF_THE_FILE = "\n… (the file is longer; fetch it to read the rest)";
const NO_COPY =
  "A copy of the file as it is now could not be kept on that machine (it cannot be read, or there is no room), so nothing was changed.";
const NOT_A_FILE =
  "That path is a folder or a special file on that machine, not an ordinary file. Nothing was changed.";
const TOO_BIG_TO_COPY =
  "The file there is over 100 MB, too large to keep a copy of, so it was not replaced. Captain can have it moved aside with a command first.";

/** What the write and put-back scripts say by their exit codes. */
function whyNotWritten(code: number | null, userAddress?: string): string | null {
  if (code === 94) return NOT_A_FILE;
  if (code === 95) return replaceInternalCaptain(TOO_BIG_TO_COPY, userAddress);
  if (code === 96) return "That copy is no longer there.";
  if (code === 98) return NO_COPY;
  return null;
}

/** Characters that draw nothing or redraw their neighbours: a path holding one is not shown as it is. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this looks for
const UNSEEN_IN_PATH = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

export interface FleetOptions {
  /** A private folder for her keys and for what she knows of each machine's identity. */
  dir: string;
  /** The machines as the settings have them. */
  machines(): readonly Machine[];
  /** Optional custom user address so static refusal strings avoid "Captain" when customized. */
  userAddress?(): string;
  /** For tests: a different `ssh` and friends. */
  programs?: Partial<Record<"ssh" | "ssh-keygen" | "ssh-keyscan", string>>;
}

interface Piped {
  code: number | null;
  /** What came out of the far side's standard output. */
  out: Buffer;
  /** What it said on its error stream: SSH's own complaints land here too. */
  errors: string;
  /** Both together in the order they arrived, for showing a command's output. */
  both: string;
  timedOut: boolean;
  written: number;
}

export class Fleet {
  private readonly options: FleetOptions;

  constructor(options: FleetOptions) {
    this.options = options;
  }

  machines(): readonly Machine[] {
    return this.options.machines();
  }

  /**
   * The machine meant by a name: its exact name, whatever the capitals, or the only one
   * whose name starts with the words given. Throws, in words for her, when it is not clear.
   */
  find(wanted: string): Machine {
    const words = wanted.trim().toLowerCase();
    const all = this.machines();
    if (all.length === 0) {
      throw new Error(
        replaceInternalCaptain(
          'No other machines have been added. Captain adds one in Settings, under "Your other machines".',
          this.options.userAddress?.(),
        ),
      );
    }
    const exact = all.filter((machine) => machine.name.toLowerCase() === words);
    const close =
      exact.length > 0
        ? exact
        : all.filter((machine) => words.length > 0 && machine.name.toLowerCase().startsWith(words));
    if (close.length === 1 && close[0]) return close[0];
    throw new Error(
      `${close.length === 0 ? `No machine is called "${wanted}".` : `"${wanted}" could be several machines.`} Known machines: ${all.map((machine) => machine.name).join(", ")}.`,
    );
  }

  /**
   * The machine as it stands now, given one that was looked up a moment ago (while the
   * user was being asked, say). Throws if it has since been removed or changed, so a
   * step never lands on a machine other than the one the user was shown.
   */
  same(settled: Machine): Machine {
    const now = this.machines().find((machine) => machine.id === settled.id);
    if (
      !now ||
      now.host !== settled.host ||
      now.user !== settled.user ||
      now.port !== settled.port
    ) {
      throw new Error(`${settled.name} was changed or removed just now. Nothing was done.`);
    }
    return now;
  }

  private program(name: "ssh" | "ssh-keygen" | "ssh-keyscan"): string {
    return this.options.programs?.[name] ?? name;
  }

  private folder(id: string): string {
    if (!/^[a-f0-9]{8,40}$/.test(id)) throw new Error("That is not a machine she knows.");
    return join(this.options.dir, id);
  }

  private keyFile(id: string): string {
    return join(this.folder(id), "key");
  }

  private knownHostsFile(id: string): string {
    return join(this.folder(id), "known_hosts");
  }

  /** A fresh id for a machine about to be added. */
  static newId(): string {
    return randomBytes(8).toString("hex");
  }

  /** Makes her key pair for a machine, if it has none yet, and returns the public half. */
  async publicKey(id: string): Promise<string> {
    const key = this.keyFile(id);
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    await chmod(this.options.dir, 0o700);
    await mkdir(this.folder(id), { recursive: true, mode: 0o700 });
    try {
      return (await readFile(`${key}.pub`, "utf8")).trim();
    } catch {
      // not made yet
    }
    await this.runTool(
      this.program("ssh-keygen"),
      ["-q", "-t", "ed25519", "-N", "", "-C", `ai-chan@${hostname().slice(0, 40)}`, "-f", key],
      15_000,
    );
    await chmod(key, 0o600);
    return (await readFile(`${key}.pub`, "utf8")).trim();
  }

  /** Asks a machine which keys it identifies itself with. Nothing is trusted by asking. */
  async hostKeys(machine: Pick<Machine, "host" | "port">): Promise<HostKeys> {
    const { stdout } = await this.runTool(
      this.program("ssh-keyscan"),
      ["-T", "8", "-p", String(machine.port), "-t", "ed25519,ecdsa,rsa", "--", machine.host],
      20_000,
    ).catch(() => ({ stdout: "" }));
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && line.length < 2000);
    if (lines.length === 0) {
      throw new Error(
        `Nothing answered as an SSH server at ${machine.host} port ${machine.port}. Check the address, and that SSH is switched on there.`,
      );
    }
    const scratch = join(this.options.dir, `scan-${randomBytes(6).toString("hex")}`);
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    await writeFile(scratch, `${lines.join("\n")}\n`, { mode: 0o600 });
    try {
      const printed = await this.runTool(this.program("ssh-keygen"), ["-l", "-f", scratch], 10_000);
      const fingerprints = printed.stdout
        .split("\n")
        .map((line) => /^\d+ (SHA256:\S+) .*\((\w+)\)$/.exec(line.trim()))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => `${match[2]} ${match[1]}`);
      // Every line that would be remembered must be one the user is shown a fingerprint for.
      if (fingerprints.length === 0 || fingerprints.length !== lines.length) {
        throw new Error("Its answer could not be read.");
      }
      return { fingerprints, lines };
    } finally {
      await rm(scratch, { force: true });
    }
  }

  /** Remembers a machine's identity, once the user has said the fingerprint is right. */
  async trust(id: string, keys: HostKeys): Promise<void> {
    await mkdir(this.folder(id), { recursive: true, mode: 0o700 });
    await writeFile(this.knownHostsFile(id), `${keys.lines.join("\n")}\n`, { mode: 0o600 });
  }

  async isTrusted(id: string): Promise<boolean> {
    return stat(this.knownHostsFile(id)).then(
      (file) => file.size > 0,
      () => false,
    );
  }

  /**
   * The options every connection is made with. Her own key and nothing else; only the
   * identity the user confirmed; none of the user's own SSH settings, agents or
   * forwarding; never a question on a terminal.
   */
  private sshArgs(machine: Machine, more: readonly string[] = []): string[] {
    // The settings file could have been edited by hand; what goes to ssh is checked here.
    checkMachine(machine);
    // In an option's value ssh takes "%" as the start of a token and a space as its end.
    const value = (path: string): string => `"${path.replaceAll("%", "%%")}"`;
    return [
      "-F", "/dev/null",
      "-T",
      "-a",
      "-x",
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "IdentityAgent=none",
      "-o", `IdentityFile=${value(this.keyFile(machine.id))}`,
      "-o", `UserKnownHostsFile=${value(this.knownHostsFile(machine.id))}`,
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "UpdateHostKeys=no",
      "-o", "ClearAllForwardings=yes",
      "-o", "PermitLocalCommand=no",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "LogLevel=ERROR",
      ...more,
      "-p", String(machine.port),
      "-l", machine.user,
      "--",
      machine.host,
    ]; // prettier-ignore
  }

  /**
   * Lets her key into the machine with the user's password for it. The password is asked
   * for by the desktop's own password window (`askpass`) and goes to SSH directly.
   */
  async installKeyWithPassword(machine: Machine, askpass: string): Promise<void> {
    const key = await this.publicKey(machine.id);
    if (!(await this.isTrusted(machine.id))) {
      throw new Error("Confirm the machine's fingerprint first.");
    }
    const args = this.sshArgs(machine, [
      "-o", "BatchMode=no",
      "-o", "PubkeyAuthentication=no",
      "-o", "PreferredAuthentications=keyboard-interactive,password",
      "-o", "NumberOfPasswordPrompts=1",
    ]); // prettier-ignore
    const result = await this.pipe([...args, scripted("letIn", word(key))], {
      timeoutMs: 120_000,
      env: { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force" },
    });
    if (result.code !== 0) {
      const said = result.errors.split("\n")[0] ?? "";
      throw new Error(
        `The machine did not let her key in${said ? `: ${said}` : "."} Check the password and that this account may sign in over SSH.`,
      );
    }
  }

  /** True when she can sign in to the machine with her key. */
  async canSignIn(machine: Machine): Promise<{ ok: boolean; why: string }> {
    if (!(await this.isTrusted(machine.id))) {
      return { ok: false, why: "Its fingerprint has not been confirmed yet." };
    }
    const result = await this.pipe([...this.sshArgs(machine), "true"], { timeoutMs: 20_000 });
    if (result.code === 0) return { ok: true, why: "" };
    return { ok: false, why: explain(result.errors || result.both) };
  }

  /** Runs one command on a machine and returns what it printed. */
  async run(
    machine: Machine,
    command: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<RemoteResult> {
    if (command.length > MAX_REMOTE_COMMAND_CHARS) {
      throw new Error("That command is too long. Put it in a script file and send that instead.");
    }
    const result = await this.pipe([...this.sshArgs(machine), scripted("run", word(command))], {
      timeoutMs: options.timeoutMs ?? 60_000,
      signal: options.signal,
    });
    return { code: result.code, output: clip(result.both.trim()), timedOut: result.timedOut };
  }

  /** The text of a file on a machine. Refuses files that are not text. */
  async readFile(machine: Machine, path: string, signal?: AbortSignal): Promise<string> {
    const result = await this.pipe(
      [...this.sshArgs(machine), scripted("read", word(path), String(MAX_READ_BYTES + 1))],
      { timeoutMs: 60_000, signal, keepBytes: MAX_READ_BYTES + 1 },
    );
    if (result.code !== 0) throw new Error(explain(result.errors) || "It could not be read.");
    if (result.out.includes(0)) throw new Error("That file is not text.");
    const text = result.out.subarray(0, MAX_READ_BYTES).toString("utf8");
    return result.out.length > MAX_READ_BYTES ? `${text}${MORE_OF_THE_FILE}` : text;
  }

  /** A name for a copy about to be kept: the time now, and a few letters. */
  static newBackupId(now = new Date()): string {
    const stamp = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    return `${stamp}-${randomBytes(3).toString("hex")}`;
  }

  /**
   * Writes text to a file on a machine, replacing what was there in one move. What was
   * there is kept on the machine first; returns that copy's name, or null when the
   * file is new. Nothing is written when the copy could not be made.
   */
  async writeFile(machine: Machine, path: string, content: string): Promise<string | null> {
    const bytes = Buffer.from(content, "utf8");
    const backup = Fleet.newBackupId();
    const result = await this.pipe(
      [...this.sshArgs(machine), scripted("write", word(path), String(bytes.length), backup)],
      { input: bytes, timeoutMs: 60_000 },
    );
    const refused = whyNotWritten(result.code, this.options.userAddress?.());
    if (refused) throw new Error(refused);
    if (result.code !== 0) throw new Error(explain(result.errors) || "It could not be written.");
    return result.out.toString("utf8").includes("kept") ? backup : null;
  }

  /** The copies kept on a machine, newest first. */
  async backups(machine: Machine, signal?: AbortSignal): Promise<Backup[]> {
    const result = await this.pipe([...this.sshArgs(machine), scripted("backups")], {
      timeoutMs: 30_000,
      signal,
    });
    if (result.code !== 0)
      throw new Error(explain(result.errors) || "The copies could not be listed.");
    const found: Backup[] = [];
    for (const line of result.out.toString("utf8").split("\n")) {
      const [id, coded, size] = line.trim().split(/\s+/);
      const when = BACKUP_ID.exec(id ?? "");
      if (!id || !coded || !when) continue;
      const path = Buffer.from(coded, "base64").toString("utf8");
      // A path that would not show as it is cannot be put to the user as what is put back.
      if (!path.startsWith("/") || UNSEEN_IN_PATH.test(path) || path.length > 1024) continue;
      const [, year, month, day, hour, minute, second] = when;
      found.push({
        id,
        path,
        at: new Date(
          Date.UTC(
            Number(year),
            Number(month) - 1,
            Number(day),
            Number(hour),
            Number(minute),
            Number(second),
          ),
        ),
        bytes: Number(size) || 0,
      });
    }
    return found.sort((a, b) => b.id.localeCompare(a.id));
  }

  /** The text of a kept copy, or null when it is not text or cannot be read. */
  async backupText(machine: Machine, id: string, signal?: AbortSignal): Promise<string | null> {
    if (!BACKUP_ID.test(id)) return null;
    const result = await this.pipe(
      [...this.sshArgs(machine), scripted("backupText", id, String(MAX_READ_BYTES))],
      { timeoutMs: 30_000, signal, keepBytes: MAX_READ_BYTES },
    );
    return result.code !== 0 || result.out.includes(0) ? null : result.out.toString("utf8");
  }

  /**
   * Puts a kept copy back where it came from. What is there now is kept first, so this
   * too can be undone; returns that new copy's name, or null when the file was gone.
   */
  async restore(machine: Machine, id: string): Promise<string | null> {
    if (!BACKUP_ID.test(id)) throw new Error("That is not the name of a kept copy.");
    const keep = Fleet.newBackupId();
    const result = await this.pipe([...this.sshArgs(machine), scripted("restore", id, keep)], {
      timeoutMs: 60_000,
    });
    const refused = whyNotWritten(result.code, this.options.userAddress?.());
    if (refused) throw new Error(refused);
    if (result.code !== 0) throw new Error(explain(result.errors) || "It could not be put back.");
    return result.out.toString("utf8").includes("kept") ? keep : null;
  }

  /**
   * Snapshots a systemd service unit file before restarting, starting, or stopping it.
   * Returns the kept copy's name, or null when no unit file could be resolved.
   */
  async snapshotService(
    machine: Machine,
    unit: string,
    userUnit = false,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!SERVICE_UNIT.test(unit)) return null;
    const backup = Fleet.newBackupId();
    const result = await this.pipe(
      [
        ...this.sshArgs(machine),
        scripted("snapshotService", word(unit), userUnit ? "user" : "system", backup),
      ],
      { timeoutMs: 30_000, signal },
    );
    if (result.code !== 0) return null;
    return result.out.toString("utf8").includes("kept") ? backup : null;
  }

  /** Copies a file from a machine to this computer. Returns how many bytes arrived. */
  async fetch(
    machine: Machine,
    remotePath: string,
    localPath: string,
    signal?: AbortSignal,
  ): Promise<number> {
    await mkdir(dirname(localPath), { recursive: true });
    let result: Piped;
    try {
      result = await this.pipe([...this.sshArgs(machine), scripted("fetch", word(remotePath))], {
        timeoutMs: 30 * 60_000,
        signal,
        toFile: localPath,
      });
    } catch (error) {
      await rm(localPath, { force: true });
      throw error;
    }
    if (result.code !== 0 || result.timedOut || result.written > MAX_TRANSFER_BYTES) {
      // Half a file is worse than none: it would be taken for the whole thing.
      await rm(localPath, { force: true });
      throw new Error(
        result.written > MAX_TRANSFER_BYTES
          ? "That file is too large to fetch this way."
          : explain(result.errors) || "It could not be fetched.",
      );
    }
    return result.written;
  }

  /** Copies a file from this computer to a machine, replacing what was there in one move. */
  async send(
    machine: Machine,
    localPath: string,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: number; backup: string | null }> {
    const { size } = await stat(localPath);
    if (size > MAX_TRANSFER_BYTES) throw new Error("That file is too large to send this way.");
    // Found out before the far side is touched at all.
    await access(localPath, constants.R_OK);
    const backup = Fleet.newBackupId();
    const result = await this.pipe(
      [...this.sshArgs(machine), scripted("write", word(remotePath), String(size), backup)],
      { timeoutMs: 30 * 60_000, signal, fromFile: localPath },
    );
    const refused = whyNotWritten(result.code, this.options.userAddress?.());
    if (refused) throw new Error(refused);
    if (result.code !== 0) throw new Error(explain(result.errors) || "It could not be sent.");
    return { bytes: size, backup: result.out.toString("utf8").includes("kept") ? backup : null };
  }

  /**
   * Forgets a machine: her key for it and what she knew of its identity. Her key's line
   * is taken out of the machine's own list first, when she can still sign in.
   */
  async forget(machine: Machine): Promise<{ removedThere: boolean }> {
    let removedThere = false;
    try {
      const key = (await readFile(`${this.keyFile(machine.id)}.pub`, "utf8")).trim().split(" ")[1];
      if (key && /^[A-Za-z0-9+/=]{40,}$/.test(key)) {
        const result = await this.pipe([...this.sshArgs(machine), scripted("forget", word(key))], {
          timeoutMs: 20_000,
        });
        removedThere = result.code === 0;
      }
    } catch {
      // gone already, or unreachable: her key here is deleted all the same
    }
    await rm(this.folder(machine.id), { recursive: true, force: true });
    return { removedThere };
  }

  private runTool(
    program: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        program,
        args,
        { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (!error) return resolve({ stdout });
          const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
          reject(
            new Error(
              missing
                ? `This needs "${basename(program)}", which is not installed.`
                : (error.message.split("\n")[0] ?? "failed"),
            ),
          );
        },
      );
    });
  }

  /** Runs ssh with the given arguments, feeding and collecting as asked. */
  private pipe(
    args: readonly string[],
    options: {
      timeoutMs: number;
      signal?: AbortSignal;
      input?: Buffer;
      fromFile?: string;
      toFile?: string;
      /** How much of the far side's output to keep. Left out: enough for a command's printout. */
      keepBytes?: number;
      env?: Record<string, string>;
    },
  ): Promise<Piped> {
    return new Promise((resolve, reject) => {
      // With a password window in play ssh gets a session of its own, so that the whole
      // group (the window included) can be ended together.
      const ownGroup = Boolean(options.env);
      const child = spawn(this.program("ssh"), args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...options.env },
        detached: ownGroup,
      });
      const limit = options.keepBytes ?? MAX_OUTPUT_CHARS * 4;
      const out: Buffer[] = [];
      const errors: Buffer[] = [];
      const both: Buffer[] = [];
      let keptOut = 0;
      let keptErrors = 0;
      let written = 0;
      let timedOut = false;
      let settled = false;
      const stop = (): void => {
        try {
          if (ownGroup && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const done = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", stop);
        resolve({
          code,
          out: Buffer.concat(out),
          errors: Buffer.concat(errors).toString("utf8").trim(),
          both: Buffer.concat(both).toString("utf8"),
          timedOut,
          written,
        });
      };
      const failed = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", stop);
        stop();
        reject(error);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs);
      if (options.signal?.aborted) stop();
      else options.signal?.addEventListener("abort", stop, { once: true });

      child.on("error", (error: NodeJS.ErrnoException) =>
        failed(
          new Error(
            error.code === "ENOENT" ? 'This needs "ssh", which is not installed.' : error.message,
          ),
        ),
      );
      child.stderr.on("data", (chunk: Buffer) => {
        if (keptErrors >= 16_000) return;
        keptErrors += chunk.length;
        errors.push(chunk);
        both.push(chunk);
      });
      if (options.toFile) {
        const file = createWriteStream(options.toFile, { mode: 0o600 });
        child.stdout.on("data", (chunk: Buffer) => {
          written += chunk.length;
          if (written > MAX_TRANSFER_BYTES) stop();
        });
        child.stdout.pipe(file);
        file.on("error", (error) => failed(error));
        child.on("close", (code) => file.end(() => done(code)));
      } else {
        child.stdout.on("data", (chunk: Buffer) => {
          if (keptOut >= limit) return;
          const kept = chunk.subarray(0, limit - keptOut);
          keptOut += kept.length;
          out.push(kept);
          both.push(kept);
        });
        child.on("close", (code) => done(code));
      }
      child.stdin.on("error", () => undefined);
      if (options.fromFile) {
        const source = createReadStream(options.fromFile);
        // A file that cannot be read after all must not reach the far side as an empty
        // one: the connection is cut, and the script there leaves the old file alone.
        source.on("error", (error) => failed(error));
        source.pipe(child.stdin);
      } else {
        child.stdin.end(options.input);
      }
    });
  }
}

/**
 * A small program for SSH to ask the user's password with: the desktop's own password
 * window. What is typed there goes to SSH and nowhere else.
 */
export const ASKPASS_SCRIPT = `#!/bin/sh
# Used by AI-chan Desktop when you let her key into one of your machines. SSH runs this
# to ask for that machine's password; the answer goes straight back to SSH.
if command -v kdialog >/dev/null 2>&1; then
  exec kdialog --title "AI-chan Desktop" --password "$1"
fi
if command -v zenity >/dev/null 2>&1; then
  exec zenity --password --title "$1"
fi
exit 1
`;

/** Turns SSH's own complaints into words the user can act on. */
/**
 * When a command never ran because the connection itself failed, what went wrong in
 * plain words; null when the machine was reached. SSH ends with 255 and says why on a
 * line of its own before anything else, so only the start of the output is looked at:
 * a command that ran there and printed "Connection refused" is its own business.
 */
export function connectionProblem(result: RemoteResult): string | null {
  if (result.code !== 255) return null;
  const start = result.output.trimStart().slice(0, 400);
  return /^(?:@{5,}|Host key verification failed|\S+@\S+: Permission denied \(|ssh: connect to host|ssh: Could not resolve|kex_exchange_identification|Connection (?:closed|reset|timed out))/i.test(
    start,
  )
    ? explain(start)
    : null;
}

export function explain(output: string): string {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(output)) {
    return "The machine answering at that address is not the one whose fingerprint was confirmed. Nothing was sent. If the machine was reinstalled, confirm its fingerprint again in Settings.";
  }
  if (/Permission denied \(/i.test(output)) {
    return "The machine did not accept her key. Let her key in again from Settings.";
  }
  if (/Connection refused|No route to host|timed out|Could not resolve/i.test(output)) {
    return "The machine did not answer. It may be off, or not on this network.";
  }
  return output.split("\n").slice(0, 3).join(" ").slice(0, 300);
}

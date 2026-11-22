import { BACKUP_ID, type Backup, type Machine } from "./fleet.ts";
import { compareText } from "./textDiff.ts";
import type { PolicyContext, Verdict } from "./permissions.ts";

/**
 * The rules for the user's other machines.
 *
 * A command on a server can do anything a command here can, to a machine that may hold
 * everything the user owns, and often as its administrator. So nearly everything is
 * shown to the user first, with the machine named. The one exception is a short list of
 * plain status commands (how full, how busy, what is running), and only on machines for
 * which the user has said she may look without asking.
 */

export const REMOTE_ACTIONS = [
  "list",
  "run",
  "read_file",
  "write_file",
  "fetch_file",
  "send_file",
  "backups",
  "restore",
] as const;
export type RemoteAction = (typeof REMOTE_ACTIONS)[number];

export interface RemoteInput {
  action: RemoteAction;
  machine?: string;
  command?: string;
  why?: string;
  /** A path on the machine. */
  path?: string;
  /** A path on this computer, for send_file. */
  local?: string;
  content?: string;
  /** For restore: the name of a kept copy. Left out: the newest one (of `path`, when that is given). */
  backup?: string;
}

/** Anything the far side's shell would treat as more than plain words. */
const SHELL_MARKS = /[;&|<>$`\\(){}[\]*?!~"'\n\r#]/;

/**
 * Commands that only report a state, written out in full. Each is a pattern for the
 * whole command line: a word more, or an option not listed, and the user is asked.
 */
const STATUS_COMMANDS: readonly RegExp[] = [
  /^uptime$/,
  /^hostname$/,
  /^uname(?: -[amrsv]+)?$/,
  /^nproc$/,
  /^date$/,
  /^whoami$/,
  /^id$/,
  /^free(?: -[hmg])?$/,
  // With a place named, df reports only the disk that place is on.
  /^df(?: -[hT]+)?(?: \/[\w./-]*)?$/,
  /^lsblk$/,
  /^lscpu$/,
  /^sensors$/,
  /^cat \/proc\/(?:loadavg|meminfo|uptime|version|mdstat)$/,
  /^cat \/etc\/os-release$/,
  /^ip -br (?:addr|a|link)$/,
  /^systemctl (?:is-active|is-enabled|is-failed) [\w.@:-]+$/,
  /^systemctl --failed$/,
  // Proxmox
  /^pveversion(?: -v)?$/,
  /^(?:qm|pct) list$/,
  /^(?:qm|pct) status \d+$/,
  /^pvesm status$/,
  /^pvecm status$/,
  /^pvesh get \/(?:nodes|cluster\/resources|cluster\/status|version)$/,
  // storage
  // A pool's name starts with a letter; a bare number would be taken as "repeat every N seconds".
  /^zpool (?:status|list)(?: -x)?(?: [A-Za-z][\w.-]*)?$/,
  /^zfs list$/,
  /^smartctl -H \/dev\/[\w/-]+$/,
  // containers
  /^docker (?:ps|images|version)$/,
  /^docker compose ls$/,
];

/** How many status commands may be asked for in one line. */
const MAX_STATUS_COMMANDS_IN_A_LINE = 5;

/**
 * True for one of the plain status commands, exactly as listed, or for a few of them
 * one after another ("uptime && free -m && df -h /", which is how she naturally asks
 * how a machine is doing). Each part must be a listed command in full: the joining
 * "&&" or ";" is the only shell mark allowed, and only between whole commands.
 */
export function isStatusCommand(command: string): boolean {
  const line = command.trim().replace(/[ \t]+/g, " ");
  if (line.length === 0 || line.length > 200) return false;
  const parts = line.split(/ ?&& ?| ?; ?/);
  if (parts.length > MAX_STATUS_COMMANDS_IN_A_LINE) return false;
  return parts.every(
    (part) =>
      part.length > 0 &&
      part.length <= 120 &&
      !SHELL_MARKS.test(part) &&
      STATUS_COMMANDS.some((pattern) => pattern.test(part)),
  );
}

/** Places on a machine whose contents are secrets wherever the machine is. */
const REMOTE_SECRETS =
  /(^|\/)(?:g?shadow[-~]?|sudoers|\.ssh|\.gnupg|\.aws|\.kube|\.config|\.docker|\.netrc|\.pgpass|\.env[^/]*|id_[a-z0-9]+|authorized_keys|authkey|priv|private|secrets?|smbpasswd|passwd\.cfg|user\.cfg|token\.cfg|shadow\.cfg|config\.db|[^/]*_history|[^/]*credentials?[^/]*|ssh_host_[a-z0-9]+_key)(\/|$|\.)|\.(?:pem|key|p12|pfx|kdbx|ovpn)$|^\/etc\/(?:pve\/priv|wireguard|openvpn|ssl\/private|letsencrypt)(\/|$)|^\/proc\/[^/]+\/(?:environ|mem|maps|cmdline)$|(^|\/)(?:docker-)?compose[^/]*\.ya?ml$/i;

export function isRemoteSecret(path: string): boolean {
  return REMOTE_SECRETS.test(path);
}

/**
 * The few files that are status and nothing else. On a machine where the user has said
 * she may check its status unasked, these are read without a question; every other file
 * is asked about, whatever it is.
 */
const STATUS_FILES =
  /^(?:\/proc\/(?:loadavg|meminfo|uptime|version|mdstat|cpuinfo|swaps)|\/etc\/(?:os-release|hostname|debian_version|issue|timezone))$/;

export function isStatusFile(path: string): boolean {
  return STATUS_FILES.test(path);
}

/** Characters that draw nothing, or redraw what is beside them: they could make a question lie. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this looks for
const UNSEEN = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

/** Makes such characters visible in text that is only being shown. */
export function shown(text: string): string {
  return text.replace(
    new RegExp(UNSEEN.source, "g"),
    (char) => `<U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`,
  );
}

/** The most text she may write into a file there in one step: all of it is shown to the user. */
export const MAX_REMOTE_WRITE_CHARS = 4000;

function isAction(value: unknown): value is RemoteAction {
  return REMOTE_ACTIONS.includes(value as RemoteAction);
}

/** Reads a tool call's input into the shape the rules use. Unknown actions are rejected. */
export function readRemoteInput(input: unknown): RemoteInput {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  if (!isAction(raw["action"])) {
    throw new Error(`remote needs an action: ${REMOTE_ACTIONS.join(", ")}.`);
  }
  const text = (key: string): string | undefined =>
    typeof raw[key] === "string" && raw[key].length > 0 ? raw[key] : undefined;
  return {
    action: raw["action"],
    machine: text("machine"),
    command: text("command"),
    why: text("why"),
    path: text("path"),
    local: text("local"),
    content: text("content"),
    backup: text("backup"),
  };
}

/** True when a call would change something, here or there: this is what "hands off" blocks. */
export function remoteChangesSomething(input: unknown): boolean {
  let step: RemoteInput;
  try {
    step = readRemoteInput(input);
  } catch {
    return true;
  }
  if (step.action === "list" || step.action === "read_file" || step.action === "backups") {
    return false;
  }
  if (step.action === "run") return !isStatusCommand(step.command ?? "");
  return true;
}

function whose(machine: Machine): string {
  return `${machine.name} (${machine.user}@${machine.host})`;
}

/** One step, as the user is shown it and as the record keeps it. */
export function describeRemote(
  step: RemoteInput,
  where: string,
  localSize?: number,
  /** For a write or a putting back: what it would change, found out by looking first. */
  changes?: string,
): string {
  switch (step.action) {
    case "list":
      return "List the other machines";
    case "run":
      return `On ${where}:\n${step.command ?? ""}`;
    case "read_file":
      return `Read on ${where}:\n${step.path ?? ""}`;
    case "write_file": {
      const content = step.content ?? "";
      return `Write on ${where}, replacing what is there:\n${step.path ?? ""}${changes ? `\n\n${changes}` : ""}\n\nAll ${content.length} characters of it:\n${shown(content)}`;
    }
    case "fetch_file":
      return `Copy from ${where} to this PC:\n${step.path ?? ""}`;
    case "send_file":
      return `Copy to ${where}, replacing what is there:\n${step.local ?? ""}${localSize === undefined ? "" : ` (${localSize} bytes)`}\n→ ${step.path ?? ""}${changes ? `\n\n${changes}` : ""}`;
    case "backups":
      return `List the copies she kept on ${where}`;
    case "restore":
      return `Put a file back on ${where} as it was:\n${changes ?? step.path ?? step.backup ?? ""}`;
  }
}

/** The copy a putting-back was settled on, so that what is put back is what the user was shown. */
const settledBackups = new WeakMap<object, Backup>();

export function backupFor(input: unknown): Backup | undefined {
  return typeof input === "object" && input !== null ? settledBackups.get(input) : undefined;
}

/** What a look answers for a file too long to have been read whole. */
export const FILE_TOO_LONG = "\u0000too long to read whole";

/** The most of a file's present text that is compared with what would replace it. */
const MOST_COMPARED = 200_000;

/** What a write would change, in words and a line-by-line comparison, for the user's eyes. */
function whatChanges(now: string | null, after: string): string {
  if (now === null) {
    return "There is no such file there now, or it cannot be read as text: all of this is new.";
  }
  if (now === FILE_TOO_LONG || now.length > MOST_COMPARED) {
    return "What is there now is too long to compare; it will be kept as a copy before it is replaced.";
  }
  const diff = compareText(now, after, { context: 2, maxLines: 60 });
  if (diff.same) return "This is exactly what is there now: nothing would change.";
  // Long lines are cut: a file that is one enormous line must not push the rest of the
  // question out of sight.
  const lines = diff.text
    .split("\n")
    .map((line) =>
      line.length > 300 ? `${line.slice(0, 300)}… (${line.length - 300} more)` : line,
    )
    .join("\n");
  return `What changes (- as it is now, + as it would be; ${diff.removed} lines out, ${diff.added} in). What is there now is kept as a copy first.\n${shown(lines)}`;
}

/** The machine a call was settled on, so the step lands on that machine and no other. */
const settledMachines = new WeakMap<object, Machine>();

export function machineFor(input: unknown): Machine | undefined {
  return typeof input === "object" && input !== null ? settledMachines.get(input) : undefined;
}

/** The step as the record keeps it: the machine by its name, account and address once known. */
export function describeRemoteForRecord(input: unknown): string {
  const step = readRemoteInput(input);
  const machine = machineFor(input);
  return describeRemote(step, machine ? whose(machine) : (step.machine ?? "a machine"));
}

/**
 * Decides one `remote` call. Throws, in words for her, when the machine is not known or
 * the step is one she may not make; otherwise says whether the user is asked, and what
 * they are shown.
 */
export async function remoteVerdict(
  input: unknown,
  context: PolicyContext,
  options: {
    commandIsExact(command: string): boolean;
    /** Whether a file on this PC is in a private place, how big it is (null: not there), and readable text when small and safe. */
    localFile(
      path: string,
    ): Promise<{ private: boolean; size: number | null; text?: string | null }>;
    /**
     * Looks on the machine for what the user is about to be asked about: a file's
     * present text (null: none, or not text), the copies kept there, one copy's text.
     * Left out where there is no connection to look with; the question is then put
     * without the comparison.
     */
    look?: {
      text(machine: Machine, path: string): Promise<string | null>;
      backups(machine: Machine): Promise<Backup[]>;
      backupText(machine: Machine, id: string): Promise<string | null>;
    };
  },
): Promise<Verdict> {
  const step = readRemoteInput(input);
  if (step.action === "list") return { decision: "allow" };
  if (!context.findMachine) throw new Error("Other machines are not available here.");
  const machine = context.findMachine(step.machine ?? "");
  if (typeof input === "object" && input !== null) settledMachines.set(input, machine);
  const where = whose(machine);
  for (const [what, text] of [
    ["command", step.command],
    ["path", step.path],
  ] as const) {
    if (text !== undefined && UNSEEN.test(text)) {
      throw new Error(
        `The ${what} holds characters that cannot be seen. Write it again in plain characters.`,
      );
    }
  }
  if (step.path !== undefined && (step.path.includes("\n") || step.path.length > 1024)) {
    throw new Error("That is not a usable path.");
  }
  const summary = (
    title: string,
    localSize?: number,
    changes?: string,
  ): { title: string; detail: string; note: string | null } => ({
    title,
    detail: describeRemote(step, where, localSize, changes),
    note: step.why ?? null,
  });
  const asRoot = machine.user === "root" ? " She signs in there as its administrator." : "";

  switch (step.action) {
    case "run": {
      const command = step.command ?? "";
      if (!command.trim()) throw new Error("There was no command to run.");
      // The status checks cannot change anything, run anything else or read a secret,
      // whoever asks and whatever she has read.
      if (isStatusCommand(command) && machine.lookWithoutAsking) return { decision: "allow" };
      return {
        decision: "ask",
        sensitive: false,
        reason: `This runs on another machine, not on this PC.${asRoot}`,
        summary: summary(`Run this on ${machine.name}?`),
        // Only an exact command with nothing left to the far side's shell may be waved
        // through again, and never once she has read text from outside.
        rememberable: !context.readOutsideText && options.commandIsExact(command),
      };
    }
    case "read_file": {
      const path = step.path ?? "";
      if (!path.startsWith("/")) throw new Error("Give the file's full path on that machine.");
      if (isStatusFile(path) && machine.lookWithoutAsking) return { decision: "allow" };
      const secret = isRemoteSecret(path);
      return {
        decision: "ask",
        sensitive: secret,
        reason: secret
          ? "This looks like a place where passwords or keys are kept on that machine."
          : `She will read a file on another machine.${asRoot}`,
        summary: summary(`Let her read this on ${machine.name}?`),
        rememberable: false,
      };
    }
    case "write_file": {
      const path = step.path ?? "";
      if (!path.startsWith("/")) throw new Error("Give the file's full path on that machine.");
      if ((step.content ?? "").length > MAX_REMOTE_WRITE_CHARS) {
        // What is written is shown in full, so it has to be short enough to be read.
        throw new Error(
          `That is too long to write in one step (${MAX_REMOTE_WRITE_CHARS} characters at most). Save it to a file here with write_file, then use send_file.`,
        );
      }
      // Looked at before the question is put, so the question can say what would
      // change. Only the user is shown it; she is not.
      const now = options.look
        ? await options.look.text(machine, path).catch(() => null)
        : undefined;
      return {
        decision: "ask",
        sensitive: isRemoteSecret(path),
        reason: `This changes a file on another machine.${asRoot}`,
        summary: summary(
          `Let her write this on ${machine.name}?`,
          undefined,
          now === undefined ? undefined : whatChanges(now, step.content ?? ""),
        ),
        rememberable: false,
      };
    }
    case "backups": {
      if (machine.lookWithoutAsking) return { decision: "allow" };
      return {
        decision: "ask",
        sensitive: false,
        reason: `She will list the copies she kept of files she changed there.${asRoot}`,
        summary: summary(`Let her list her kept copies on ${machine.name}?`),
        rememberable: false,
      };
    }
    case "restore": {
      if (!options.look) throw new Error("Putting a copy back is not available here.");
      if (step.path !== undefined && !step.path.startsWith("/")) {
        throw new Error("Give the file's full path on that machine.");
      }
      if (step.backup !== undefined && !BACKUP_ID.test(step.backup)) {
        throw new Error("That is not the name of a kept copy. List them with action backups.");
      }
      const kept = await options.look.backups(machine);
      const chosen = kept.find((copy) =>
        step.backup !== undefined
          ? copy.id === step.backup
          : step.path === undefined || copy.path === step.path,
      );
      if (!chosen) {
        throw new Error(
          kept.length === 0
            ? `No copies are kept on ${machine.name}: nothing she changed there can be put back this way.`
            : `No such copy is kept on ${machine.name}. List them with action backups.`,
        );
      }
      if (step.path !== undefined && chosen.path !== step.path) {
        throw new Error(`That copy is of ${chosen.path}, not of ${step.path}.`);
      }
      if (typeof input === "object" && input !== null) settledBackups.set(input, chosen);
      const [now, then] = await Promise.all([
        options.look.text(machine, chosen.path).catch(() => null),
        options.look.backupText(machine, chosen.id).catch(() => null),
      ]);
      const made = chosen.at.toISOString().replace("T", " ").slice(0, 16);
      const changes =
        `${shown(chosen.path)}\nfrom the copy kept at ${made} UTC (${chosen.id}, ${chosen.bytes} bytes)\n\n` +
        (then === null
          ? "The copy is not text, so what would change cannot be shown. What is there now is kept as a copy first."
          : whatChanges(now, then));
      return {
        decision: "ask",
        sensitive: isRemoteSecret(chosen.path),
        reason: `This changes a file on another machine.${asRoot}`,
        summary: summary(`Let her put this file back on ${machine.name}?`, undefined, changes),
        rememberable: false,
      };
    }
    case "send_file": {
      const path = step.path ?? "";
      if (!path.startsWith("/")) throw new Error("Give the file's full path on that machine.");
      if (!step.local) throw new Error("Say which file here to send.");
      const local = await options.localFile(step.local);
      if (local.size === null) throw new Error(`There is no file here at ${step.local}.`);
      let changes: string | undefined;
      if (options.look && !local.private) {
        if (typeof local.text === "string") {
          const now = await options.look.text(machine, path).catch(() => null);
          changes = whatChanges(now, local.text);
        } else if (local.text === null) {
          changes =
            "What is there now is kept as a copy before it is replaced; this file is binary or too large to compare.";
        }
      }
      return {
        decision: "ask",
        sensitive: local.private || isRemoteSecret(path),
        reason: local.private
          ? "The file to send is in a place where passwords, keys or sign-in data are kept on this PC."
          : `This changes a file on another machine. Look at the file here first if you are not sure what is in it.${asRoot}`,
        summary: summary(`Let her send this to ${machine.name}?`, local.size, changes),
        rememberable: false,
      };
    }
    case "fetch_file": {
      const path = step.path ?? "";
      if (!path.startsWith("/")) throw new Error("Give the file's full path on that machine.");
      return {
        decision: "ask",
        sensitive: isRemoteSecret(path),
        reason: `She will copy a file from another machine into her folder on this PC.${asRoot}`,
        summary: summary(`Let her fetch this from ${machine.name}?`),
        rememberable: false,
      };
    }
  }
}

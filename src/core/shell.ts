import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number | null;
  /** Standard output and errors together, shortened if very long. */
  output: string;
  timedOut: boolean;
}

const MAX_OUTPUT_CHARS = 6000;

/** Keeps the start and the end of long output, where the useful parts usually are. */
export function clip(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return `${text.slice(0, head)}\n… (${text.length - limit} characters left out) …\n${text.slice(-tail)}`;
}

/** Runs a shell command with a time limit. The whole process group is stopped on timeout or abort. */
export function runCommand(
  command: string,
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<CommandResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      output: "Stopped before it started.",
      timedOut: false,
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // No terminal is attached, so tools must not wait for one.
      env: { ...process.env, DEBIAN_FRONTEND: "noninteractive", PAGER: "cat", GIT_PAGER: "cat" },
    });
    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer): void => {
      // Bound memory for commands that print endlessly; the clip below trims further.
      if (output.length < MAX_OUTPUT_CHARS * 20) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const stop = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
        setTimeout(() => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          } catch {
            // already gone
          }
        }, 2000).unref();
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", stop, { once: true });

    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ exitCode, output: clip(output.trim()), timedOut });
    });
  });
}

// ---------- which commands only look, and never change anything ----------
//
// The assistant may run these without asking, so this is written to fail closed. The
// command is first split into words exactly as the shell would split it. Anything the
// splitter does not fully understand (variables, substitution, wildcards, redirection
// other than discarding output) makes the whole command "not read-only". Then every
// command in the line must be on the list below, with only the options listed for it.
// Checking options by pattern-matching the raw text does not work: quoting and escaping
// (`-\exec`, `'-exec'`, `-ofile`) walk straight past it.

type Operator = "|" | "||" | "&&" | ";";
interface ParsedLine {
  /** Each simple command's words, in order. */
  commands: string[][];
}

/**
 * Splits a command line into simple commands and their words. Returns null for anything
 * outside the small subset understood here.
 */
export function parseSimpleCommandLine(line: string): ParsedLine | null {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;

  const endWord = (): void => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = (): boolean => {
    endWord();
    if (words.length === 0) return false;
    commands.push(words);
    words = [];
    return true;
  };

  while (i < line.length) {
    const char = line[i] ?? "";
    if (char === " " || char === "\t") {
      endWord();
      i += 1;
    } else if (char === "'") {
      const close = line.indexOf("'", i + 1);
      if (close === -1) return null;
      word += line.slice(i + 1, close);
      inWord = true;
      i = close + 1;
    } else if (char === '"') {
      i += 1;
      for (;;) {
        const inner = line[i];
        if (inner === undefined) return null;
        if (inner === '"') break;
        if (inner === "$" || inner === "`") return null;
        if (inner === "\\") {
          const escaped = line[i + 1];
          if (escaped === undefined || escaped === "\n") return null;
          // Inside double quotes a backslash only escapes these; otherwise it stays.
          word += '"\\$`'.includes(escaped) ? escaped : `\\${escaped}`;
          i += 2;
        } else {
          word += inner;
          i += 1;
        }
      }
      inWord = true;
      i += 1;
    } else if (char === "\\") {
      const escaped = line[i + 1];
      if (escaped === undefined || escaped === "\n") return null;
      word += escaped;
      inWord = true;
      i += 2;
    } else if ((char === "|" || char === "&" || char === ";") && !line.startsWith("&>", i)) {
      const two = line.slice(i, i + 2);
      const operator: Operator | null =
        two === "||" || two === "&&" ? two : char === "|" || char === ";" ? char : null;
      // A lone "&" runs something in the background; not modelled, so not allowed.
      if (operator === null || !endCommand()) return null;
      i += operator.length;
    } else if (
      char === ">" ||
      (/\d/.test(char) && !inWord && line[i + 1] === ">") ||
      line.startsWith("&>", i)
    ) {
      // The only redirections accepted are the ones that throw output away or merge streams.
      const rest = line.slice(i);
      const harmless = /^(?:(?:[12]?>|&>)\s*\/dev\/null|[12]?>&[12])(?=$|[\s;|&])/.exec(rest);
      if (!harmless) return null;
      endWord();
      i += harmless[0].length;
    } else if ("<>$`(){}*?[]!#\n\r".includes(char)) {
      return null;
    } else if (char === "~" && !inWord) {
      // "~" and "~/x" mean the home folder. "~name" is some other account's; not modelled.
      const next = line[i + 1];
      if (
        next !== undefined &&
        next !== "/" &&
        next !== " " &&
        next !== "\t" &&
        !"|&;".includes(next)
      )
        return null;
      word += char;
      inWord = true;
      i += 1;
    } else {
      word += char;
      inWord = true;
      i += 1;
    }
  }
  endWord();
  if (words.length > 0) commands.push(words);
  else if (commands.length > 0) return null; // the line ended on an operator
  return commands.length > 0 ? { commands } : null;
}

type Rule = (args: string[]) => boolean;

const anyArguments: Rule = () => true;
const noArguments: Rule = (args) => args.length === 0;
const isOption = (arg: string): boolean => arg.startsWith("-") && arg !== "-";

/** Options must come from the given list; anything that is not an option is fine. */
function onlyOptions(allowed: readonly (string | RegExp)[]): Rule {
  return (args) =>
    args.every(
      (arg) =>
        !isOption(arg) ||
        allowed.some((entry) => (typeof entry === "string" ? entry === arg : entry.test(arg))),
    );
}

/** First word must be an allowed sub-command; after it, plain words and listed options only. */
function subCommand(first: RegExp, options: readonly (string | RegExp)[] = []): Rule {
  const rest = onlyOptions(options);
  return (args) => first.test(args[0] ?? "") && rest(args.slice(1));
}

/** `find` may only test and print. Every word starting with "-" must be a known test. */
const FIND_TESTS = new Set([
  "-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-type", "-maxdepth", "-mindepth",
  "-size", "-mtime", "-mmin", "-atime", "-ctime", "-newer", "-user", "-group", "-perm", "-empty",
  "-readable", "-writable", "-executable", "-xdev", "-mount", "-follow", "-depth", "-daystart",
  "-not", "-o", "-or", "-a", "-and", "-print", "-print0", "-L", "-H", "-P", "-true", "-false",
]); // prettier-ignore
const findRule: Rule = (args) => args.every((arg) => !isOption(arg) || FIND_TESTS.has(arg));

/** `ps` in its BSD spelling can print every process's environment ("e"); allow known-safe forms only. */
const PS_FORMS = new Set(["", "aux", "ax", "x", "-ef", "-e", "-A", "-f", "auxf", "-ely"]);
const psRule: Rule = (args) => PS_FORMS.has(args.join(" "));

/** What `test` may ask about a path: is it there, a file, a folder, not empty, readable, a link. */
const FILE_TESTS = new Set(["-e", "-f", "-d", "-s", "-r", "-L", "-h"]);

const noAddresses: Rule = (args) => args.every((arg) => !arg.includes("://"));
const PACKAGE_WORDS = [/^--(?:quiet|color=\w+|noconfirm)$/, "-q"] as const;

/** Every command the assistant may run unasked, with what it may be given. */
const READ_ONLY_RULES: Record<string, Rule> = {
  ls: anyArguments,
  pwd: anyArguments,
  whoami: noArguments,
  id: anyArguments,
  uname: anyArguments,
  hostname: onlyOptions(["-f", "-s", "-i", "-I"]),
  uptime: anyArguments,
  date: (args) =>
    args.every((arg) => arg.startsWith("+") || ["-u", "--utc", "-R", "-I"].includes(arg)),
  df: anyArguments,
  du: anyArguments,
  free: onlyOptions(["-h", "-b", "-k", "-m", "-g", "-t", "-w", "--si", "--mega", "--giga"]),
  nproc: anyArguments,
  lscpu: anyArguments,
  lsblk: anyArguments,
  lsusb: anyArguments,
  lspci: anyArguments,
  which: anyArguments,
  whereis: anyArguments,
  type: anyArguments,
  command: (args) => args[0] === "-v" && args.length === 2,
  file: onlyOptions(["-b", "-i", "-L", "--brief", "--mime", "--mime-type"]),
  stat: anyArguments,
  wc: anyArguments,
  head: anyArguments,
  tail: onlyOptions([/^-n$/, /^-c$/, /^-\d+$/, /^-n\d+$/, /^--lines=\d+$/]),
  cat: anyArguments,
  cut: anyArguments,
  grep: anyArguments,
  echo: anyArguments,
  // bash's printf can assign to a variable (`-v`), and working out that variable's name can
  // run code. Without options it only prints.
  printf: (args) => args.every((arg) => !isOption(arg)),
  basename: anyArguments,
  dirname: anyArguments,
  realpath: anyArguments,
  readlink: anyArguments,
  md5sum: anyArguments,
  sha256sum: anyArguments,
  true: anyArguments,
  // Asks one thing about one path and prints nothing. Only these forms: bash's "test"
  // works out what is inside the brackets of "test -v 'a[$(…)]'", which runs a command.
  test: (args) =>
    args.length === 2 && FILE_TESTS.has(args[0] ?? "") && !/[$`[\]\\]/.test(args[1] ?? ""),
  locate: anyArguments,
  pgrep: anyArguments,
  "xdg-user-dir": anyArguments,
  "fc-list": anyArguments,
  sensors: noArguments,
  // As a pipe stage only: with file names these two can write their output somewhere.
  sort: (args) => args.every((arg) => /^-[bdfghiMnRrVuz]+$/.test(arg)),
  uniq: (args) => args.every((arg) => /^-[cdDiuz]+$/.test(arg)),
  find: findRule,
  ps: psRule,
  "nvidia-smi": (args) =>
    args.every(
      (arg) => arg === "-L" || /^--(?:query-gpu|query-compute-apps|format)=[\w.,]+$/.test(arg),
    ),
  // Media probes accept web addresses, which would be an unchecked way onto the network.
  ffprobe: (args) =>
    noAddresses(args) &&
    onlyOptions([
      "-v", "-loglevel", "-hide_banner", "-show_format", "-show_streams", "-show_entries", "-of",
      "-print_format", "-select_streams", "-i", "-pretty", "-sexagesimal",
    ])(args), // prettier-ignore
  mediainfo: (args) => noAddresses(args) && args.every((arg) => !isOption(arg)),
  pacman: subCommand(/^-(?:Q[a-z]*|S[sigl]{1,2}|F[lox]?)$/, PACKAGE_WORDS),
  paru: subCommand(/^-(?:Q[a-z]*|S[si]{1,2})$/, PACKAGE_WORDS),
  yay: subCommand(/^-(?:Q[a-z]*|S[si]{1,2})$/, PACKAGE_WORDS),
  flatpak: subCommand(/^(?:list|search|info|remotes|history)$/, [
    "--user", "--system", "--app", "--runtime", "-d", "--show-details", /^--columns=[\w,]+$/,
  ]), // prettier-ignore
  apt: subCommand(/^(?:list|show|search|policy)$/, ["--installed", "--upgradable"]),
  "apt-cache": subCommand(/^(?:show|search|policy|depends)$/),
  dnf: subCommand(/^(?:list|info|search|repolist)$/, ["--installed"]),
  rpm: subCommand(/^-q[ailf]?$/),
  dpkg: subCommand(/^-[lsLS]$/),
  // No "show": it prints the environment variables units were started with.
  systemctl: subCommand(/^(?:status|is-active|is-enabled|list-units|list-unit-files)$/, [
    "--user", "--no-pager", "--all", "-l", /^--(?:type|state)=[\w,-]+$/,
  ]), // prettier-ignore
  "xdg-mime": subCommand(/^query$/),
};

function isReadOnlyWords(words: string[]): boolean {
  const [name, ...args] = words;
  if (name === undefined) return false;
  // No listed command needs a web address, and several programs quietly fetch one.
  if (words.some((word) => word.includes("://"))) return false;
  const rule = Object.hasOwn(READ_ONLY_RULES, name) ? READ_ONLY_RULES[name] : undefined;
  if (rule) return rule(args);
  // Asking an installed program for its version or help text. Bare names only, so this
  // cannot be pointed at a file planted somewhere.
  return (
    /^[\w.+-]+$/.test(name) &&
    args.length === 1 &&
    (args[0] === "--version" || args[0] === "--help")
  );
}

/**
 * True when every part of the command only reads or reports. Anything this cannot
 * recognise counts as "might change something", and the user is asked.
 */
export function isReadOnlyCommand(command: string): boolean {
  const parsed = parseSimpleCommandLine(command.trim());
  return parsed !== null && parsed.commands.every(isReadOnlyWords);
}

/** Commands whose output is facts about this system, not text someone else may have written. */
const SYSTEM_FACTS = new Set([
  "pwd", "whoami", "id", "uname", "hostname", "uptime", "date", "df", "du", "free", "nproc", "lscpu",
  "lsblk", "lsusb", "lspci", "which", "whereis", "type", "command", "true", "sensors", "nvidia-smi",
  "xdg-mime", "xdg-user-dir", "fc-list",
]); // prettier-ignore

/**
 * A few forms of otherwise wordy commands that print only names, versions or a state.
 * Their other forms print text written by whoever made a package or a service
 * (descriptions, changelogs, unit files, other programs' command lines) and so do not count.
 */
function printsOnlySystemFacts(name: string, args: readonly string[]): boolean {
  if (SYSTEM_FACTS.has(name)) return true;
  if (args.length === 1 && (args[0] === "--version" || args[0] === "--help")) return true;
  const [first, ...rest] = args;
  const plainWords = rest.every((word) => /^[\w.+@:-]+$/.test(word) && !word.startsWith("-"));
  if (name === "pacman" || name === "paru" || name === "yay") {
    return first !== undefined && /^-Qq?$/.test(first) && plainWords;
  }
  if (name === "systemctl") {
    const words = args.filter((word) => word !== "--user");
    return (
      words[0] !== undefined &&
      /^(?:is-active|is-enabled|is-failed)$/.test(words[0]) &&
      words.slice(1).every((word) => /^[\w.@:-]+$/.test(word) && !word.startsWith("-"))
    );
  }
  return false;
}

/**
 * True when a command's output may contain text written by someone else: file contents,
 * file names, media tags, anything a download or a web page could have put there.
 * Unknown commands count as true.
 */
export function mayPrintOutsideText(command: string): boolean {
  const parsed = parseSimpleCommandLine(command.trim());
  if (!parsed) return true;
  return !parsed.commands.every(
    ([name, ...args]) => name !== undefined && printsOnlySystemFacts(name, args),
  );
}

import { execFile } from "node:child_process";

/**
 * Reaching the user's phone, through KDE Connect. The phone has to be paired with this
 * computer in KDE Connect's own settings first; she never pairs anything herself. Every
 * call starts `kdeconnect-cli` (or `busctl`, for the battery) with fixed arguments and
 * no shell.
 */

/** Starts a program and resolves with what it printed. */
export type PhoneRunner = (program: string, args: readonly string[]) => Promise<string>;

export interface Phone {
  id: string;
  /** The name its owner gave it. */
  name: string;
  /** It is on the network and answering right now. */
  reachable: boolean;
  /** Its battery, 0 to 100, when it reports one. */
  battery: number | null;
  charging: boolean | null;
}

const CLI = "kdeconnect-cli";
const TIMEOUT_MS = 8000;
// Letters, digits, "_" and "-", and never a dash first: an id is also used as an argument.
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export const MAX_PHONE_TEXT_CHARS = 4000;
export const MAX_PING_CHARS = 200;

const defaultRun: PhoneRunner = (program, args) =>
  new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { timeout: TIMEOUT_MS, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (!error) return resolve(stdout);
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(
          new Error(
            missing
              ? `This needs "${program}", which is not installed.`
              : (error.message.split("\n")[0] ?? "failed"),
          ),
        );
      },
    );
  });

/**
 * With AI_CHAN_REHEARSE_DESKTOP set, nothing here reaches the phone: each action
 * returns as if done. For trying her out without ringing anyone's pocket.
 */
function rehearsing(): boolean {
  return Boolean(process.env["AI_CHAN_REHEARSE_DESKTOP"]);
}

export function isPhoneId(id: string): boolean {
  return DEVICE_ID.test(id);
}

function checkedId(id: string): string {
  if (!isPhoneId(id)) throw new Error("That is not a device this computer is paired with.");
  return id;
}

/** Reads the "<id> <name>" lines `--id-name-only` prints. Anything else on a line is dropped. */
export function parsePhoneLines(output: string): { id: string; name: string }[] {
  const found: { id: string; name: string }[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    // With nothing paired some versions print "0 devices found" where the list would be.
    if (line.length === 0 || /^\d+ devices? found/i.test(line)) continue;
    const space = line.indexOf(" ");
    const id = space === -1 ? line : line.slice(0, space);
    if (!isPhoneId(id) || found.some((phone) => phone.id === id)) continue;
    const name = space === -1 ? "" : line.slice(space + 1).trim();
    found.push({ id, name: (name || "unnamed device").slice(0, 80) });
  }
  return found;
}

async function batteryProperty(run: PhoneRunner, id: string, property: string): Promise<unknown> {
  try {
    const raw = await run("busctl", [
      "--user",
      "--json=short",
      "get-property",
      "org.kde.kdeconnect",
      `/modules/kdeconnect/devices/${id}/battery`,
      "org.kde.kdeconnect.device.battery",
      property,
    ]);
    return (JSON.parse(raw) as { data?: unknown }).data;
  } catch {
    // No battery report (a desktop, an old app, out of reach): simply not known.
    return undefined;
  }
}

/** Every paired device, the ones in reach first, with battery where the device reports it. */
export async function listPhones(run: PhoneRunner = defaultRun): Promise<Phone[]> {
  const [paired, available] = await Promise.all([
    run(CLI, ["--list-devices", "--id-name-only"]).then(parsePhoneLines),
    run(CLI, ["--list-available", "--id-name-only"]).then(parsePhoneLines),
  ]);
  const inReach = new Set(available.map((phone) => phone.id));
  // "Available" means paired and reachable, so anything only listed there is still paired.
  const all = [...paired, ...available.filter((phone) => !paired.some((p) => p.id === phone.id))];
  const phones = await Promise.all(
    all.map(async ({ id, name }): Promise<Phone> => {
      const reachable = inReach.has(id);
      if (!reachable) return { id, name, reachable, battery: null, charging: null };
      const [charge, charging] = await Promise.all([
        batteryProperty(run, id, "charge"),
        batteryProperty(run, id, "isCharging"),
      ]);
      const known = typeof charge === "number" && charge >= 0 && charge <= 100;
      return {
        id,
        name,
        reachable,
        battery: known ? Math.round(charge) : null,
        charging: known && typeof charging === "boolean" ? charging : null,
      };
    }),
  );
  return phones.sort((a, b) => Number(b.reachable) - Number(a.reachable));
}

/**
 * Which phone was meant. With no name given it is the one in reach, when there is
 * exactly one. Otherwise the words are matched against the names; a tie is a problem
 * to put to the user, not something to guess at.
 */
export function pickPhone(
  phones: readonly Phone[],
  wanted: string | undefined,
): { phone: Phone } | { problem: string } {
  if (phones.length === 0) {
    return {
      problem:
        "No phone is paired with this computer. Captain pairs one in KDE Connect (System Settings, KDE Connect) with the KDE Connect app on the phone.",
    };
  }
  const names = (list: readonly Phone[]): string => list.map((phone) => phone.name).join(", ");
  const words = (wanted ?? "").toLowerCase().trim();
  if (!words) {
    const inReach = phones.filter((phone) => phone.reachable);
    if (inReach.length === 1 && inReach[0]) return { phone: inReach[0] };
    if (inReach.length === 0) {
      return {
        problem: `No phone is in reach right now. Paired: ${names(phones)}. It has to be on the same network with KDE Connect running.`,
      };
    }
    return {
      problem: `Nothing was sent: several devices are in reach. Say which one: ${names(inReach)}.`,
    };
  }
  const score = (phone: Phone): number => {
    const name = phone.name.toLowerCase();
    if (phone.id === wanted || name === words) return 3;
    if (name.includes(words)) return 2;
    return words.split(/\s+/).every((part) => name.includes(part)) ? 1 : 0;
  };
  const ranked = phones
    .map((phone) => ({ phone, score: score(phone) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = ranked.filter((entry) => entry.score === ranked[0]?.score).map((e) => e.phone);
  if (best.length === 0) {
    return {
      problem: `No phone is paired under the name "${wanted ?? ""}". Paired: ${names(phones)}.`,
    };
  }
  // Two with the same name: only the one in reach can have been meant.
  const candidates = best.length > 1 ? best.filter((phone) => phone.reachable) : best;
  if (candidates.length > 1 || (candidates.length === 0 && best.length > 1)) {
    return {
      problem: `Nothing was sent: "${wanted ?? ""}" fits several devices. Say which one: ${names(best)}.`,
    };
  }
  const phone = candidates[0] ?? best[0];
  if (!phone) return { problem: `No phone is paired under the name "${wanted ?? ""}".` };
  if (!phone.reachable) {
    return {
      problem: `No phone is in reach under that name: ${phone.name} is paired but not answering. It has to be on the same network with KDE Connect running.`,
    };
  }
  return { phone };
}

/** Text as it may be handed to another program: no NUL (it cannot be passed), bounded length. */
function plain(text: string, most: number): string {
  return text.replaceAll("\u0000", "").slice(0, most);
}

/** Makes the phone ring out loud, so it can be found. */
export async function ringPhone(id: string, run: PhoneRunner = defaultRun): Promise<void> {
  const device = checkedId(id);
  if (rehearsing()) return;
  await run(CLI, [`--device=${device}`, "--ring"]);
}

/** Shows a short notification on the phone. */
export async function pingPhone(
  id: string,
  message: string,
  run: PhoneRunner = defaultRun,
): Promise<void> {
  const device = checkedId(id);
  const text = plain(message, MAX_PING_CHARS).replace(/\s+/g, " ").trim();
  if (!text) throw new Error("There was no message to show.");
  if (rehearsing()) return;
  // Written as one "--option=value" argument, so a message that starts with a dash is
  // still only a message.
  await run(CLI, [`--device=${device}`, `--ping-msg=${text}`]);
}

/** Puts text on the phone (it arrives on its clipboard or in a note, as the phone decides). */
export async function sendTextToPhone(
  id: string,
  text: string,
  run: PhoneRunner = defaultRun,
): Promise<void> {
  const device = checkedId(id);
  const body = plain(text, MAX_PHONE_TEXT_CHARS);
  if (body.trim().length === 0) throw new Error("There was no text to send.");
  if (rehearsing()) return;
  await run(CLI, [`--device=${device}`, `--share-text=${body}`]);
}

/** True for an ordinary web address, the only kind of link sent to a phone. */
export function isWebLink(target: string): boolean {
  if (!/^https?:\/\//i.test(target)) return false;
  try {
    const url = new URL(target);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Sends a file or opens a web address on the phone. A file must be given by its full
 * path: anything else could be read as a different kind of address.
 */
export async function sendToPhone(
  id: string,
  target: string,
  run: PhoneRunner = defaultRun,
): Promise<void> {
  const device = checkedId(id);
  if (target.includes("\u0000")) throw new Error("That is not something that can be sent.");
  if (!isWebLink(target) && !target.startsWith("/")) {
    throw new Error("Only a web address or a file given by its full path can be sent.");
  }
  if (rehearsing()) return;
  await run(CLI, [`--device=${device}`, `--share=${target}`]);
}

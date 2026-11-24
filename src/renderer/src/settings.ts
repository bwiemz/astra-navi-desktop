import "./settings.css";
import {
  TIER10_KEYS,
  type SettingsPage,
  type SettingsPatch,
  type SettingsView,
  type Tier10Key,
  type Tier10Settings,
} from "../../shared/settings.ts";
import { bridge, choose, element, fill, setAdvancedMode, stamp } from "./settings/dom.ts";
import { showOnboarding, wireOnboarding } from "./settings/onboarding.ts";
import { showStation, wireDevices } from "./settings/devices.ts";
import { showMachines, wireFleet } from "./settings/fleet.ts";
import { wireTraces } from "./settings/traces.ts";
import { showSystem, wireSystem } from "./settings/system.ts";

const LIGHT_VOICE = "light";

/** Puts the app's settings on the page. */
function show(view: SettingsView): void {
  setAdvancedMode(view.advancedSettings);
  element("days").textContent =
    view.daysTogether === 1 ? "Day 1 aboard." : `Day ${view.daysTogether} aboard.`;

  showOnboarding(view);
  showSystem(view);

  fill(
    element<HTMLSelectElement>("brain"),
    [
      { value: "auto", label: "Choose for this computer" },
      ...view.brains.map((b) => ({ value: b.id, label: b.label })),
    ],
    view.brain,
  );
  fill(
    element<HTMLSelectElement>("language"),
    view.languages.map((language) => ({ value: language.code, label: language.label })),
    view.language,
  );
  choose(
    element<HTMLSelectElement>("thinkingTokens"),
    String(view.thinkingTokens),
    (value) => `${value} tokens (set in the settings file)`,
  );
  choose(
    element<HTMLSelectElement>("idleUnloadMinutes"),
    String(view.idleUnloadMinutes),
    (value) => `${value} quiet minutes (set in the settings file)`,
  );
  element<HTMLInputElement>("yieldToGames").checked = view.yieldToGames;
  element<HTMLInputElement>("quietInGames").checked = view.quietInGames;
  element<HTMLInputElement>("leanMemory").checked = view.leanMemory;
  element<HTMLInputElement>("fittingTools").checked = view.fittingTools;
  element<HTMLInputElement>("keepTraces").checked = view.keepTraces;
  element<HTMLInputElement>("lowPowerStage").checked = view.lowPowerStage;

  const sessionNotice = element("desktop-session-notice");
  sessionNotice.hidden = !view.desktopSessionNotice;
  sessionNotice.textContent = view.desktopSessionNotice ?? "";
  showTier10(view.tier10);

  fill(
    element<HTMLSelectElement>("voice"),
    [
      ...(view.designedVoicesReady
        ? view.voices.map((name) => ({
            value: name,
            label: `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`,
          }))
        : []),
      { value: LIGHT_VOICE, label: "Light (English only)" },
    ],
    view.voiceEngine === "light" || !view.designedVoicesReady ? LIGHT_VOICE : view.voiceDesign,
  );
  element("voice-note").textContent = view.designedVoicesReady
    ? "Picking one makes her say a line in it."
    : 'The designed voices are not set up yet: run "npm run setup-voice" once.';
  element<HTMLInputElement>("speed").value = String(view.speed);
  element("speed-shown").textContent = `${view.speed.toFixed(2)}×`;
  element<HTMLSelectElement>("speak").value = view.speak;
  element<HTMLInputElement>("alwaysListening").checked = view.alwaysListening;
  const needsName = element<HTMLInputElement>("needsName");
  needsName.checked = view.needsName || view.alwaysListening;
  needsName.disabled = view.alwaysListening;
  const names = element<HTMLInputElement>("otherNames");
  if (document.activeElement !== names) names.value = view.otherNames.join(", ");

  element<HTMLInputElement>("lookWithoutAsking").checked = view.lookWithoutAsking;
  element<HTMLInputElement>("handsOff").checked = view.handsOff;
  element<HTMLInputElement>("keepConversations").checked = view.keepConversations;
  element("notes").textContent = `${view.notes} note${view.notes === 1 ? "" : "s"} so far.`;
  element("exchanges").textContent =
    `${view.pastExchanges} exchange${view.pastExchanges === 1 ? "" : "s"} kept, on this computer only.`;
  element<HTMLButtonElement>("forget").disabled = view.pastExchanges === 0;

  element<HTMLInputElement>("doNotDisturb").checked = view.doNotDisturb;
  element<HTMLInputElement>("morningBriefing").checked = view.morningBriefing;
  element<HTMLInputElement>("startAtLogin").checked = view.startAtLogin;

  element<HTMLInputElement>("watch").checked = view.watch;
  const skip = element<HTMLInputElement>("watchSkip");
  if (document.activeElement !== skip) skip.value = view.watchSkip.join(", ");
  element<HTMLInputElement>("hearPc").checked = view.hearPc;
  element<HTMLInputElement>("readNotices").checked = view.readNotices;
  const noticesSkip = element<HTMLInputElement>("noticesSkip");
  if (document.activeElement !== noticesSkip) noticesSkip.value = view.noticesSkip.join(", ");
  element<HTMLInputElement>("workInPrograms").checked = view.workInPrograms;
  element("hands-note").textContent =
    view.hands === null
      ? "Not available here: the helper could not start."
      : [
          view.hands.controls
            ? "She can read and press programs' buttons and menus."
            : "She cannot read programs' controls here (python-gobject is missing).",
          view.hands.input
            ? "She can also click and type like a person."
            : "She cannot click or type here.",
          "You are asked before she works in each program, and again for anything that reads like deleting, sending or confirming.",
        ].join(" ");
  showStation(view, show);
  showMachines(view, show);
  showCalendars(view);

  const searxng = element<HTMLInputElement>("searxngUrl");
  if (document.activeElement !== searxng) searxng.value = view.searxngUrl;
  const brave = element<HTMLInputElement>("braveApiKey");
  if (document.activeElement !== brave) brave.value = "";
  brave.placeholder = view.hasBraveKey
    ? "A key is set. Type a new one to replace it."
    : "Paste a key to use it";
  element("brave-note").textContent = view.hasBraveKey
    ? "To remove the key, clear this box and press Enter."
    : "";
  const limit = element<HTMLInputElement>("braveMonthlyLimit");
  if (document.activeElement !== limit) limit.value = String(view.braveMonthlyLimit);
  element("brave-limit-row").hidden = !view.hasBraveKey;
  element("brave-used").textContent =
    view.braveMonthlyLimit === 0
      ? `${view.braveUsed} used this month. No limit: she will keep searching however many it takes.`
      : `${view.braveUsed} used this month. Counted by calendar month, which may not be the day your plan renews. Past the limit she uses the open sources until the month ends. 0 means no limit.`;
}

function showCalendars(view: SettingsView): void {
  element("calendars").replaceChildren(
    ...view.calendars.map((calendar) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = `${calendar.name}: ${calendar.where}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        void bridge.removeCalendar(calendar.name).then((fresh) => {
          show(fresh);
          stamp("Removed");
        });
      });
      item.append(name, remove);
      return item;
    }),
  );
  choose(
    element<HTMLSelectElement>("headsUpMinutes"),
    String(view.headsUpMinutes),
    (value) => `${value} minutes before (set in the settings file)`,
  );
}

element<HTMLFormElement>("calendar-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = element<HTMLInputElement>("calendar-name");
  const source = element<HTMLInputElement>("calendar-source");
  const note = element("calendar-note");
  const add = element<HTMLButtonElement>("calendar-add");
  add.disabled = true;
  note.textContent = "";
  bridge
    .addCalendar({ name: name.value, source: source.value })
    .then(
      (result) => {
        if (!result.ok) {
          note.textContent = result.why;
          return;
        }
        // Where it is does not stay on the page once it has been taken.
        name.value = "";
        source.value = "";
        show(result.view);
        stamp("Added");
      },
      () => {
        note.textContent = "That did not work.";
      },
    )
    .finally(() => {
      add.disabled = false;
    });
});

async function save(patch: SettingsPatch): Promise<void> {
  try {
    show(await bridge.save(patch));
    stamp("Saved");
  } catch (error) {
    // Put the page back to what is really set, and say what went wrong.
    show(await bridge.load());
    stamp(
      error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
        : "Not saved",
      true,
    );
  }
}

function onChange<T extends HTMLElement>(id: string, patch: (control: T) => SettingsPatch): void {
  const control = element<T>(id);
  control.addEventListener("change", () => void save(patch(control)));
}

const toggles = [
  "alwaysListening",
  "needsName",
  "lookWithoutAsking",
  "handsOff",
  "keepConversations",
  "doNotDisturb",
  "morningBriefing",
  "startAtLogin",
  "workInPrograms",
  "watch",
  "hearPc",
  "readNotices",
  "station",
  "pingPhone",
  "yieldToGames",
  "quietInGames",
  "leanMemory",
  "fittingTools",
  "keepTraces",
  "lowPowerStage",
] as const;
for (const name of toggles) {
  onChange<HTMLInputElement>(name, (control) => ({ [name]: control.checked }));
}

const EXPERIMENTAL_OPTIONS: Record<Tier10Key, { title: string; description: string }> = {
  workerMesh: {
    title: "Share AI work across your home PCs",
    description:
      "Lets Astra borrow extra graphics memory from other computers you trust on your home Wi-Fi so heavy replies finish faster.",
  },
  modelCascade: {
    title: "Quick-answer first, upgrade if tricky",
    description:
      "Starts answering with a fast small brain and automatically hands harder questions off to a larger brain when needed.",
  },
  loraSubAgents: {
    title: "Specialized mini-brains for specific tasks",
    description:
      "Loads lightweight add-on skill adapters you trained locally (for example, coding or writing helpers) without replacing Astra's main brain.",
  },
  predictivePrewarm: {
    title: "Get ready before you ask",
    description:
      "Quietly prepares likely context ahead of time when you switch apps or start talking so her first reply feels snappier.",
  },
  semanticBridges: {
    title: "Deeper awareness of open apps and browser tabs",
    description:
      "Reads structured details directly from supported desktop windows, audio controls, code editors, and the browser extension instead of relying only on screenshots.",
  },
  pushEvents: {
    title: "React instantly to system events",
    description:
      "Lets local system signals—like finished downloads, changed files, or smart-home messages—notify Astra right away instead of waiting for a periodic check.",
  },
  hardwareTelemetry: {
    title: "Monitor PC temperatures and hardware health",
    description:
      "Tracks local CPU, graphics card, fan, and disk health readings so Astra can warn you if your PC runs hot or low on resources.",
  },
  sessionContinuity: {
    title: "Pick up chats smoothly across devices",
    description:
      "Keeps your active conversation in sync when you switch between your desktop and your paired phone on home Wi-Fi.",
  },
  causalDryRun: {
    title: "Preview file changes before making them",
    description:
      "Tests risky file or command changes in a temporary copy first and shows you what would happen before touching your real files.",
  },
  skillCompiler: {
    title: "Save repeatable multi-step routines",
    description:
      "Turns tasks you ask Astra to repeat often into saved local shortcuts she can run reliably with your permission.",
  },
  microSandbox: {
    title: "Run helper scripts in a locked-down box",
    description:
      "Isolates small helper scripts in a temporary restricted workspace so they cannot see your private folders or change system files.",
  },
  episodicCalibration: {
    title: "Learn when to speak up or stay quiet",
    description:
      "Notices whether you usually accept or dismiss her suggestions and gently adjusts how often she interrupts you.",
  },
  attentionArbiter: {
    title: "Choose the right device for alerts",
    description:
      "Sends reminders and check-ins to whichever device you are actively using (PC or phone) so you are not pinged twice.",
  },
  nightlyHygiene: {
    title: "Automatic overnight memory cleanup",
    description:
      "Tidies up duplicate notes, old temporary files, and storage caches overnight while your PC is idle.",
  },
  fullDuplexVoice: {
    title: "Interrupt naturally while she speaks",
    description:
      "Filters Astra's own voice out of your microphone so you can talk over her mid-sentence without waiting for her to finish.",
  },
  phonemeVisemes: {
    title: "Detailed speech-matched lip-sync",
    description:
      "Matches her 3D mouth shapes to individual spoken sounds for smoother, more natural talking animations.",
  },
  selfDistillation: {
    title: "Overnight local skill improvement",
    description:
      "Uses your larger local brain while your PC is idle to teach your smaller, faster brain how to answer better—everything stays on your machine.",
  },
  signedPlugins: {
    title: "Verified third-party plugins",
    description:
      "Allows installing optional add-on packs (like Coding Companion or OBS Co-Host) whose files are cryptographically verified and require your explicit approval.",
  },
  nativeMultimodal: {
    title: "Live voice-to-voice and continuous screen coaching",
    description:
      "Enables faster two-way voice conversation and live visual feedback while you play games or use complex apps.",
  },
  householdIsolation: {
    title: "Separate profiles for family members",
    description:
      "Keeps memories, files, and permissions strictly separated when multiple people share the same computer.",
  },
  stationFederation: {
    title: "Link multiple Astra PCs on your home network",
    description:
      "Securely connects separate Astra installs across your home network over encrypted local connections.",
  },
};

const tier10Container = element<HTMLDivElement>("tier10-toggles");
const tier10Boxes = new Map<Tier10Key, HTMLInputElement>();
for (const key of TIER10_KEYS) {
  const option = EXPERIMENTAL_OPTIONS[key];
  const row = document.createElement("label");
  row.className = "row switch";
  const box = document.createElement("input");
  box.id = `tier10-${key}`;
  box.type = "checkbox";
  box.addEventListener("change", () => void save({ tier10: { [key]: box.checked } }));
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = option.title;
  const why = document.createElement("span");
  why.className = "why";
  why.textContent = option.description;
  row.append(box, what, why);
  tier10Container.append(row);
  tier10Boxes.set(key, box);
}

function showTier10(tier10: Tier10Settings): void {
  for (const key of TIER10_KEYS) {
    const box = tier10Boxes.get(key);
    if (box) box.checked = tier10[key];
  }
}

onChange<HTMLSelectElement>("brain", (control) => ({ brain: control.value }));
onChange<HTMLSelectElement>("language", (control) => ({
  language: control.value as SettingsView["language"],
}));
onChange<HTMLSelectElement>("thinkingTokens", (control) => ({
  thinkingTokens: Number(control.value),
}));
onChange<HTMLSelectElement>("headsUpMinutes", (control) => ({
  headsUpMinutes: Number(control.value),
}));
onChange<HTMLSelectElement>("idleUnloadMinutes", (control) => ({
  idleUnloadMinutes: Number(control.value),
}));
onChange<HTMLSelectElement>("speak", (control) => ({
  speak: control.value as SettingsView["speak"],
}));
onChange<HTMLSelectElement>("voice", (control) =>
  control.value === LIGHT_VOICE
    ? { voice: { engine: "light", design: "" } }
    : { voice: { engine: "full", design: control.value } },
);
onChange<HTMLInputElement>("speed", (control) => ({ speed: Number(control.value) }));
element<HTMLInputElement>("speed").addEventListener("input", (event) => {
  element("speed-shown").textContent =
    `${Number((event.target as HTMLInputElement).value).toFixed(2)}×`;
});
onChange<HTMLInputElement>("otherNames", (control) => ({
  otherNames: control.value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
}));
onChange<HTMLInputElement>("watchSkip", (control) => ({
  watchSkip: control.value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
}));
onChange<HTMLInputElement>("noticesSkip", (control) => ({
  noticesSkip: control.value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
}));
onChange<HTMLInputElement>("searxngUrl", (control) => ({ searxngUrl: control.value.trim() }));
onChange<HTMLInputElement>("braveApiKey", (control) => ({ braveApiKey: control.value.trim() }));
element<HTMLInputElement>("braveMonthlyLimit").addEventListener("change", (event) => {
  const control = event.target as HTMLInputElement;
  const typed = control.value.trim();
  const limit = Number(typed);
  // An emptied or mistyped box must not quietly become 0, which means "no limit".
  if (typed === "" || !Number.isFinite(limit) || limit < 0 || limit > 1_000_000) {
    void bridge.load().then(show);
    stamp("Type a number from 0 to 1,000,000. 0 means no limit.", true);
    return;
  }
  void save({ braveMonthlyLimit: Math.round(limit) });
});

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-open]")) {
  button.addEventListener("click", () => bridge.open(button.dataset["open"] as SettingsPage));
}
element<HTMLButtonElement>("forget").addEventListener("click", () => {
  void bridge.forgetConversations().then(show);
});

onChange<HTMLInputElement>("advancedSettings", (control) => {
  setAdvancedMode(control.checked);
  return { advancedSettings: control.checked };
});

wireOnboarding(show, save);
wireDevices(show);
wireFleet(show);
wireTraces();
wireSystem(show, save);

// ---------- the strip of section names: go to one, and see which one is in view ----------

const sectionLinks = [...document.querySelectorAll<HTMLAnchorElement>("#sections a")].map(
  (link) => ({ link, panel: element(link.hash.slice(1)) }),
);
const sectionStrip = element("sections");
let sectionShown: HTMLAnchorElement | null = null;
let sectionCheckQueued = false;

/** The section in view is the last one whose top has reached the strip; at the very end, the last. */
function markSection(): void {
  sectionCheckQueued = false;
  const line = sectionStrip.getBoundingClientRect().bottom + 40;
  const page = document.documentElement;
  const atEnd = window.innerHeight + window.scrollY >= page.scrollHeight - 2;
  let current = sectionLinks[0];
  for (const entry of sectionLinks) {
    if (entry.panel.getBoundingClientRect().top <= line) current = entry;
  }
  if (atEnd) current = sectionLinks[sectionLinks.length - 1];
  if (!current || current.link === sectionShown) return;
  sectionShown?.removeAttribute("aria-current");
  sectionShown = current.link;
  sectionShown.setAttribute("aria-current", "true");
  // In a narrow window the strip itself scrolls sideways; keep the marked name on it.
  const strip = sectionStrip.getBoundingClientRect();
  const name = sectionShown.getBoundingClientRect();
  if (name.left < strip.left + 20 || name.right > strip.right - 20) {
    sectionStrip.scrollLeft += name.left - strip.left - 26;
  }
}

function queueSectionCheck(): void {
  if (sectionCheckQueued) return;
  sectionCheckQueued = true;
  requestAnimationFrame(markSection);
}

for (const { link, panel } of sectionLinks) {
  link.addEventListener("click", (event) => {
    event.preventDefault(); // the page's address stays as it is; only the view moves
    panel.scrollIntoView({ block: "start" });
  });
}
window.addEventListener("scroll", queueSectionCheck, { passive: true });
window.addEventListener("resize", queueSectionCheck);
markSection();

// The tray menu changes the same settings; pick those changes up when the window comes back.
window.addEventListener("focus", () => void bridge.load().then(show));
void bridge.load().then(show);

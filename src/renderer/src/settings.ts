import "./settings.css";
import type {
  SettingsPage,
  SettingsPatch,
  SettingsView,
} from "../../shared/settings.ts";
import { bridge, choose, element, fill, setAdvancedMode, stamp } from "./settings/dom.ts";
import { showOnboarding, wireOnboarding } from "./settings/onboarding.ts";
import { showPosture, wireSearchAndPresets } from "./settings/searchAndPresets.ts";
import { showStation, wireDevices } from "./settings/devices.ts";
import { showMachines, wireFleet } from "./settings/fleet.ts";
import { showMcpServers, wireMcpSettings } from "./settings/mcp.ts";
import { wireTraces } from "./settings/traces.ts";
import { showSystem, wireSystem } from "./settings/system.ts";

const LIGHT_VOICE = "light";

/** Puts the app's settings on the page. */
function show(view: SettingsView): void {
  setAdvancedMode(view.advancedSettings);
  element("days").textContent =
    view.daysTogether === 1 ? "Day 1 aboard." : `Day ${view.daysTogether} aboard.`;

  showPosture(view);
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
    : "Built-in voice is active. Optional Qwen-TTS designed voices can be set up in the 60s Setup Wizard.";
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
            : view.station.platform === "win32"
              ? "Using Windows screen reading, pointer, and keyboard controls."
              : "She cannot read programs' controls here (python-gobject is missing).",
          view.hands.input
            ? "She can also click and type like a person."
            : "She cannot click or type here.",
          "You are asked before she works in each program, and again for anything that reads like deleting, sending or confirming.",
        ].join(" ");
  showStation(view, show);
  showMcpServers(view, show);
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

wireSearchAndPresets(save);
wireOnboarding(show, save);
wireDevices(show);
wireMcpSettings(show);
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

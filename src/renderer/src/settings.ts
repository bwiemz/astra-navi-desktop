import "./settings.css";
import type { ShownTrace } from "../../core/trace.ts";
import {
  TIER10_KEYS,
  type SettingsBridge,
  type SettingsPage,
  type SettingsPatch,
  type SettingsView,
  type Tier10Key,
  type Tier10Settings,
} from "../../shared/settings.ts";

declare global {
  interface Window {
    aichanSettings: SettingsBridge;
  }
}

const bridge = window.aichanSettings;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The settings page is missing its "${id}" element.`);
  return found as T;
}

const saved = element<HTMLParagraphElement>("saved");
let savedTimer = 0;

function stamp(text: string, failed = false): void {
  saved.textContent = text;
  saved.classList.toggle("failed", failed);
  saved.classList.add("on");
  window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => saved.classList.remove("on"), failed ? 6000 : 1600);
}

function fill(
  select: HTMLSelectElement,
  options: readonly { value: string; label: string }[],
  value: string,
): void {
  select.replaceChildren(
    ...options.map((option) => {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      return item;
    }),
  );
  // A value from the settings file that is not on the list (a custom model path) is still shown.
  if (!options.some((option) => option.value === value)) {
    const custom = document.createElement("option");
    custom.value = value;
    custom.textContent = value;
    select.append(custom);
  }
  select.value = value;
}

/** Selects a value in a fixed list, adding it when the settings file holds one that is not listed. */
function choose(
  select: HTMLSelectElement,
  value: string,
  describe: (value: string) => string,
): void {
  for (const stale of select.querySelectorAll("option[data-custom]")) stale.remove();
  if (![...select.options].some((option) => option.value === value)) {
    const custom = document.createElement("option");
    custom.value = value;
    custom.textContent = describe(value);
    custom.dataset["custom"] = "";
    select.append(custom);
  }
  select.value = value;
}

const LIGHT_VOICE = "light";

const BUNDLED_VOICE_NAMES: readonly string[] = [
  "aria",
  "bright",
  "lively",
  "lumi",
  "melody",
  "nova",
  "perky",
  "stella",
  "sweet",
  "vega",
];

let currentView: SettingsView | null = null;
let wizardStep = 1;
let wizardOpenedOnce = false;
let wizardDismissed = false;
let activePreviewAudio: HTMLAudioElement | null = null;

function setAdvancedMode(on: boolean): void {
  document.body.dataset["advanced"] = on ? "true" : "false";
  element<HTMLInputElement>("advancedSettings").checked = on;
}

function renderBootstrapList(status: SettingsView["bootstrapStatus"]): void {
  const container = element<HTMLDivElement>("wiz-bootstrap-list");
  const rows: { task: "ocr" | "launcher" | "browser-bridge" | "voice"; label: string; ready?: boolean; detail?: string }[] = [
    { task: "ocr", label: "Fast ONNX OCR", ready: status?.ocr.ready, detail: status?.ocr.detail },
    { task: "launcher", label: "Desktop App Menu Shortcut", ready: status?.launcher.ready, detail: status?.launcher.detail },
    { task: "browser-bridge", label: "Browser DOM Native Host", ready: status?.browserBridge.ready, detail: status?.browserBridge.detail },
    { task: "voice", label: "Full Qwen-TTS Python Env", ready: status?.voice.ready, detail: status?.voice.detail },
  ];
  container.replaceChildren(
    ...rows.map((entry) => {
      const wrap = document.createElement("div");
      wrap.className = "wiz-service-row";
      const left = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = entry.label;
      const desc = document.createElement("div");
      desc.className = "why";
      desc.textContent = entry.detail ?? (entry.ready ? "Ready" : "Optional — click Setup to install");
      left.append(title, desc);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = entry.ready ? "Re-run" : "Setup";
      btn.addEventListener("click", () => {
        btn.disabled = true;
        element("wiz-bootstrap-note").textContent = `Setting up ${entry.label}…`;
        void bridge
          .runBootstrap(entry.task)
          .then((res) => {
            element("wiz-bootstrap-note").textContent = res.summary.join(" ") || "Done.";
            renderBootstrapList(res.status);
          })
          .catch((error: unknown) => {
            element("wiz-bootstrap-note").textContent =
              error instanceof Error ? error.message : "Setup failed.";
          })
          .finally(() => {
            btn.disabled = false;
          });
      });
      wrap.append(left, btn);
      return wrap;
    }),
  );
}

function refreshHardwareWizard(): void {
  const summary = element("wiz-hw-summary");
  const reason = element("wiz-hw-reason");
  summary.textContent = "Probing GPU VRAM, memory bandwidth, and system RAM…";
  reason.textContent = "";
  void bridge
    .hardwareProfile()
    .then((hw) => {
      const gpuLabel = hw.gpuName ? `${hw.gpuName} (${hw.freeVramGb}/${hw.totalVramGb} GB VRAM free)` : "CPU mode (no discrete NVIDIA GPU)";
      const bwLabel = hw.memoryBandwidthGbps !== null ? `, ${hw.memoryBandwidthGbps} GB/s` : "";
      summary.textContent = `Detected: ${gpuLabel}, ${hw.systemRamGb} GB RAM, ${hw.cpuThreads} threads${bwLabel}.`;
      reason.textContent = hw.reason;
      const tierSelect = element<HTMLSelectElement>("wiz-brain-select");
      if ([...tierSelect.options].some((opt) => opt.value === hw.recommendedTier)) {
        tierSelect.value = hw.recommendedTier;
      }
    })
    .catch(() => {
      summary.textContent = "Could not probe GPU; you can still select a brain tier below.";
    });
}

function refreshPolicyAuditWizard(): void {
  const badge = element("wiz-audit-badge");
  const list = element("wiz-audit-findings");
  badge.className = "audit-badge";
  badge.textContent = "Checking…";
  list.replaceChildren();
  void bridge
    .runPolicyAudit()
    .then((audit) => {
      badge.className = `audit-badge ${audit.ok ? "pass" : "fail"}`;
      badge.textContent = audit.ok
        ? `PASS (0 critical, ${audit.counts.warning} warnings)`
        : `REVIEW (${audit.counts.critical} critical, ${audit.counts.warning} warnings)`;
      if (audit.findings.length === 0) {
        const li = document.createElement("li");
        li.textContent = "No security conflicts or risky rules detected.";
        list.append(li);
      } else {
        for (const f of audit.findings.slice(0, 5)) {
          const li = document.createElement("li");
          li.textContent = `[${f.severity}] ${f.message}`;
          list.append(li);
        }
      }
    })
    .catch(() => {
      badge.className = "audit-badge fail";
      badge.textContent = "Could not run policy audit.";
    });
}

function showWizardStep(step: number): void {
  wizardStep = Math.max(1, Math.min(4, step));
  element("wiz-step-indicator").textContent = `Step ${wizardStep} of 4`;
  for (let i = 1; i <= 4; i += 1) {
    element(`wiz-step-${i}`).hidden = i !== wizardStep;
  }
  element<HTMLButtonElement>("wiz-prev").disabled = wizardStep === 1;
  element<HTMLButtonElement>("wiz-next").hidden = wizardStep === 4;
  element<HTMLButtonElement>("wiz-finish").hidden = wizardStep !== 4;
  if (wizardStep === 1) refreshHardwareWizard();
  if (wizardStep === 3) renderBootstrapList(currentView?.bootstrapStatus);
  if (wizardStep === 4) refreshPolicyAuditWizard();
}

function openWizard(step = 1): void {
  wizardOpenedOnce = true;
  element("onboarding-wizard").hidden = false;
  showWizardStep(step);
}

/** Puts the app's settings on the page. */
function show(view: SettingsView): void {
  currentView = view;
  setAdvancedMode(view.advancedSettings);
  element("days").textContent =
    view.daysTogether === 1 ? "Day 1 aboard." : `Day ${view.daysTogether} aboard.`;

  fill(
    element<HTMLSelectElement>("wiz-brain-select"),
    [
      { value: "auto", label: "Auto (hardware recommended)" },
      ...view.brains.map((b) => ({ value: b.id, label: b.label })),
    ],
    view.brain,
  );
  fill(
    element<HTMLSelectElement>("wiz-language"),
    view.languages.map((language) => ({ value: language.code, label: language.label })),
    view.language,
  );
  const voiceList = view.voices.length > 0 ? view.voices : [...BUNDLED_VOICE_NAMES];
  fill(
    element<HTMLSelectElement>("wiz-voice"),
    voiceList.map((name) => ({ value: name, label: `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}` })),
    voiceList.includes(view.voiceDesign) ? view.voiceDesign : voiceList[0] ?? "aria",
  );
  element<HTMLInputElement>("wiz-always-listening").checked = view.alwaysListening;
  if (!view.onboardingComplete && !wizardOpenedOnce && !wizardDismissed) {
    openWizard(1);
  }

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
  showStation(view);
  showMachines(view);
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

/** What was last learned about each machine by trying it, kept while the window is open. */
const machineNotes = new Map<string, string>();

function showMachines(view: SettingsView): void {
  const button = (label: string, act: () => void, quiet = false): HTMLButtonElement => {
    const made = document.createElement("button");
    made.type = "button";
    made.textContent = label;
    if (quiet) made.className = "quiet";
    made.addEventListener("click", act);
    return made;
  };
  element("machines").replaceChildren(
    ...view.machines.map((machine) => {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = machine.name;
      const where = document.createElement("span");
      where.className = "why";
      where.textContent = `${machine.user}@${machine.host}${machine.port === 22 ? "" : `, port ${machine.port}`}`;
      const note = document.createElement("span");
      note.className = "why machine-state";
      note.setAttribute("role", "status");
      note.textContent = machineNotes.get(machine.id) ?? "";
      const say = (words: string): void => {
        machineNotes.set(machine.id, words);
        note.textContent = words;
      };
      const tried = (result: { ok: boolean; why: string }): void =>
        say(result.ok ? "She can sign in." : result.why);
      const failed = (error: unknown): void =>
        say(
          error instanceof Error
            ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
            : "That did not work.",
        );
      const actions = document.createElement("div");
      actions.className = "machine-actions";
      if (view.canAskPassword) {
        actions.append(
          button("Let her in with its password", () => {
            say("A password window has opened. What you type goes to SSH only.");
            bridge.letInMachine(machine.id).then(tried, failed);
          }),
        );
      }
      const backupsDrawer = document.createElement("div");
      backupsDrawer.className = "machine-backups";
      backupsDrawer.hidden = true;
      const loadBackups = (): void => {
        backupsDrawer.hidden = false;
        backupsDrawer.textContent = "Loading backups…";
        bridge.listMachineBackups(machine.id).then(
          (list) => {
            if (list.length === 0) {
              backupsDrawer.textContent = "No backups kept on this machine yet.";
              return;
            }
            const ul = document.createElement("ul");
            for (const entry of list) {
              const row = document.createElement("li");
              const meta = document.createElement("span");
              meta.className = "why";
              const when = entry.at.replace("T", " ").slice(0, 16);
              meta.textContent = `${entry.path} (${when} UTC, ${entry.bytes} bytes) `;
              const restoreBtn = button("Restore", () => {
                restoreBtn.disabled = true;
                bridge
                  .restoreMachineBackup(machine.id, entry.id)
                  .then(
                    (res) => {
                      if (res.restored) {
                        say(
                          `Restored ${entry.path}${res.keptNew ? ` (previous copy kept as ${res.keptNew})` : ""}.`,
                        );
                        loadBackups();
                      }
                    },
                    failed,
                  )
                  .finally(() => {
                    restoreBtn.disabled = false;
                  });
              });
              row.append(meta, restoreBtn);
              ul.append(row);
            }
            backupsDrawer.replaceChildren(ul);
          },
          (error: unknown) => {
            backupsDrawer.hidden = true;
            failed(error);
          },
        );
      };
      actions.append(
        button(
          "Copy her key",
          () => {
            bridge
              .copyMachineKey(machine.id)
              .then(
                () =>
                  say(
                    `Copied. On ${machine.name}, add it as one line to ~/.ssh/authorized_keys for ${machine.user}.`,
                  ),
                failed,
              );
          },
          true,
        ),
        button(
          "Test",
          () => {
            say("Trying…");
            bridge.testMachine(machine.id).then(tried, failed);
          },
          true,
        ),
        button(
          "Backups",
          () => {
            if (!backupsDrawer.hidden) {
              backupsDrawer.hidden = true;
              return;
            }
            loadBackups();
          },
          true,
        ),
        button("Forget", () => void bridge.removeMachine(machine.id).then(show, failed), true),
      );
      const look = document.createElement("label");
      look.className = "machine-look";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = machine.lookWithoutAsking;
      box.addEventListener("change", () => {
        void bridge.setMachineLook(machine.id, box.checked).then(show, failed);
      });
      const words = document.createElement("span");
      words.textContent =
        "She may check its status without asking (uptime, disk and memory use, what is running). Nothing else.";
      look.append(box, words);
      item.append(title, where, actions, look, note, backupsDrawer);
      return item;
    }),
  );
}

let machineTicket = "";

function resetMachineForm(words = ""): void {
  machineTicket = "";
  element("machine-confirm").hidden = true;
  element("machine-note").textContent = words;
  element<HTMLButtonElement>("machine-find").disabled = false;
}

element<HTMLFormElement>("machine-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const find = element<HTMLButtonElement>("machine-find");
  find.disabled = true;
  element("machine-note").textContent = "Looking for it…";
  bridge
    .findMachine({
      name: element<HTMLInputElement>("machine-name").value,
      host: element<HTMLInputElement>("machine-host").value,
      user: element<HTMLInputElement>("machine-user").value,
      port: Number(element<HTMLInputElement>("machine-port").value),
    })
    .then((found) => {
      machineTicket = found.ticket;
      element("machine-note").textContent = "It answered. Check below that it is the right one.";
      element("machine-prints").textContent = found.fingerprints.join("\n");
      element("machine-confirm").hidden = false;
    })
    .catch((error: unknown) => {
      resetMachineForm(
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
          : "It could not be found.",
      );
    });
});
element<HTMLButtonElement>("machine-yes").addEventListener("click", () => {
  bridge
    .addMachine(machineTicket)
    .then((view) => {
      for (const id of ["machine-name", "machine-host", "machine-user"]) {
        element<HTMLInputElement>(id).value = "";
      }
      resetMachineForm("Added. Now let her key in: use one of the buttons beside it above.");
      show(view);
    })
    .catch(() => resetMachineForm("That took too long. Look for the machine again."));
});
element<HTMLButtonElement>("machine-no").addEventListener("click", () => resetMachineForm());

/** True while the name field holds something the user typed and has not saved. */
let signInNameTouched = false;

function showSignIn(view: SettingsView): void {
  const account = view.stationAccount;
  const state = element("signin-state");
  state.classList.toggle("unset", !account.set);
  state.textContent = account.set
    ? `Set. The name is ${account.username ?? "?"}${
        account.changedAt
          ? `; the password was last changed ${new Date(account.changedAt).toLocaleString()}`
          : ""
      }.`
    : "Not set yet. Until a name and password are set, your paired devices cannot be used.";
  const name = element<HTMLInputElement>("signin-name");
  // Shown so that changing only the password does not mean typing the name again; left
  // alone while the user is in the middle of typing another.
  if (!signInNameTouched && document.activeElement !== name) name.value = account.username ?? "";
  element<HTMLButtonElement>("signin-save").textContent = account.set
    ? "Change name and password"
    : "Save name and password";
  const asked = account.resetAsked;
  element("reset-asked").hidden = asked === null;
  // A device names itself, so its name goes on the page as text and is cut short.
  element("reset-asked-text").textContent = asked
    ? `${asked.device.slice(0, 70)} asked for the sign-in password to be reset at ${new Date(
        asked.at,
      ).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}. If that was you, set a new one below. If it was not, remove that device.`
    : "";
}

element<HTMLInputElement>("signin-name").addEventListener("input", () => {
  signInNameTouched = true;
});
element<HTMLButtonElement>("reset-dismiss").addEventListener("click", () => {
  void bridge.dismissReset().then(show);
});
element<HTMLFormElement>("signin-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = element<HTMLInputElement>("signin-name");
  const password = element<HTMLInputElement>("signin-password");
  const again = element<HTMLInputElement>("signin-again");
  const note = element("signin-note");
  const save = element<HTMLButtonElement>("signin-save");
  note.textContent = "";
  if (password.value !== again.value) {
    note.textContent = "The two passwords are not the same.";
    again.focus();
    return;
  }
  save.disabled = true;
  bridge
    .setStationAccount(name.value, password.value)
    .then(
      (result) => {
        if (!result.ok) {
          note.textContent = result.why;
          return;
        }
        // What was typed does not stay on the page once it has been taken.
        password.value = "";
        again.value = "";
        signInNameTouched = false;
        show(result.view);
        note.textContent = "Saved. Every device has been signed out and signs in with these.";
        stamp("Saved");
      },
      () => {
        note.textContent = "The name and password could not be saved.";
      },
    )
    .finally(() => {
      save.disabled = false;
    });
});

function showStation(view: SettingsView): void {
  const { station } = view;
  showSignIn(view);
  element<HTMLInputElement>("station").checked = station.on;
  const open = station.on && station.addresses.length > 0;
  // A firewall on this PC drops the other device's connection without a word, and the
  // device only says "site can't be reached". Say so here, with the way to let it through.
  const network = (station.addresses[0] ?? "").replace(
    /^https:\/\/(\d+\.\d+\.\d+)\.\d+:.*$/,
    "$1.0/24",
  );
  const letThrough =
    station.firewall === "ufw"
      ? ` This PC's firewall (ufw) is on: allow her port once with "sudo ufw allow from ${network} to any port ${station.port} proto tcp".`
      : station.firewall === "firewalld"
        ? ` This PC's firewall (firewalld) is on: allow her port once with "sudo firewall-cmd --permanent --add-port=${station.port}/tcp" and then "sudo firewall-cmd --reload".`
        : "";
  element("station-note").textContent = open
    ? `Open this on the other device, https:// included: ${station.addresses.join(" or ")}. Its browser will warn that the certificate is self-made; it is the right one if its fingerprint ends in ${station.fingerprint?.slice(-47) ?? "?"}.${letThrough}`
    : station.on
      ? "Switched on, but this PC has no home-network address right now."
      : "Off. Nothing outside this PC can reach her.";
  element("station-pairing").hidden = !open;
  if (!open) element("pair-code").textContent = "";
  element("station-devices").hidden = station.devices.length === 0;
  element("devices").replaceChildren(
    ...station.devices.map((device) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      // When it was paired tells two devices of the same name apart: a request to reset
      // the password names the device that way.
      const paired = new Date(device.pairedAt);
      const since = Number.isNaN(paired.getTime())
        ? ""
        : `paired ${paired.toLocaleDateString(undefined, { day: "numeric", month: "long" })}, `;
      name.textContent = device.lastSeenAt
        ? `${device.name} (${since}last seen ${new Date(device.lastSeenAt).toLocaleString()})`
        : `${device.name} (${since}not seen yet)`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        void bridge.forgetDevice(device.id).then((fresh) => {
          show(fresh);
          stamp("Removed");
        });
      });
      item.append(name, remove);
      return item;
    }),
  );
  const openMissions = station.openMissions ?? [];
  const pinnedMission = station.pinnedMission ?? null;
  element("station-missions").hidden = openMissions.length === 0 && pinnedMission === null;
  element("pinned-mission-note").textContent = pinnedMission
    ? `Sharing "${pinnedMission.title}" (${pinnedMission.state}, ${pinnedMission.done}/${pinnedMission.total} steps) with paired devices. Desktop chat and screen captures stay isolated.`
    : "No mission is pinned to paired devices.";
  element("pinned-missions").replaceChildren(
    ...openMissions.map((mission) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${mission.title} [${mission.id}] — ${mission.state}`;
      const button = document.createElement("button");
      button.type = "button";
      if (mission.pinned) {
        button.className = "quiet";
        button.textContent = "Unpin";
        button.addEventListener("click", () => {
          void bridge.pinMission(null).then((fresh) => {
            show(fresh);
            stamp("Unpinned");
          });
        });
      } else {
        button.textContent = "Pin to devices";
        button.addEventListener("click", () => {
          void bridge.pinMission(mission.id).then((fresh) => {
            show(fresh);
            stamp("Pinned");
          });
        });
      }
      item.append(label, button);
      return item;
    }),
  );
  element("ping-row").hidden = !view.phoneLink;
  element<HTMLInputElement>("pingPhone").checked = view.pingPhone;
}

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
] as const;
for (const name of toggles) {
  onChange<HTMLInputElement>(name, (control) => ({ [name]: control.checked }));
}

const TIER10_LABELS: Record<Tier10Key, string> = {
  workerMesh: "LAN Worker Mesh (offload inference across trusted local machines)",
  modelCascade: "Small-to-Standard Cascade Speculative Escalation",
  loraSubAgents: "Domain-Specialized LoRA Sub-Agents",
  predictivePrewarm: "Predictive Context Pre-Warming",
  semanticBridges: "OS Semantic Bridges (KWin, PipeWire, Editor LSP, Browser DOM)",
  pushEvents: "Push-Driven Local Event Bus (inotify, journal, D-Bus, MQTT/webhook)",
  hardwareTelemetry: "Hardware & Physical Environment Telemetry",
  sessionContinuity: "Cross-Device Session Continuity Handoff",
  causalDryRun: "CoW Causal Dry-Run Pre-Execution Simulation",
  skillCompiler: "Compiled Reusable Skill Synthesis",
  microSandbox: "Ephemeral Rootless bwrap Micro-Sandboxes",
  episodicCalibration: "Implicit-Feedback Episodic Threshold Calibration",
  attentionArbiter: "Cross-Device Attention & Interruption Arbiter",
  nightlyHygiene: "Autonomous Nightly Memory & Storage Hygiene",
  fullDuplexVoice: "Full-Duplex AEC & Sub-150ms Voice Barge-In",
  phonemeVisemes: "Phoneme-Driven Co-Articulated Lip-Sync Visemes",
  selfDistillation: "Overnight Teacher-to-Student Self-Distillation",
  signedPlugins: "Ed25519 Signed Plugin SDK",
  nativeMultimodal: "Native Speech-to-Speech & Video-Buffer Awareness",
  householdIsolation: "Multi-User Household Profile & Namespace Isolation",
  stationFederation: "Station-to-Station Encrypted LAN Federation",
};

const tier10Container = element<HTMLDivElement>("tier10-toggles");
const tier10Boxes = new Map<Tier10Key, HTMLInputElement>();
for (const key of TIER10_KEYS) {
  const row = document.createElement("label");
  row.className = "row switch";
  const box = document.createElement("input");
  box.id = `tier10-${key}`;
  box.type = "checkbox";
  box.addEventListener("change", () => void save({ tier10: { [key]: box.checked } }));
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = TIER10_LABELS[key];
  row.append(box, what);
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
element<HTMLButtonElement>("pair").addEventListener("click", () => {
  bridge
    .pairDevice()
    .then(({ code, expiresAt }) => {
      const until = new Date(expiresAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      element("pair-code").textContent =
        `Type ${code.slice(0, 3)} ${code.slice(3)} on the other device. Good until ${until}.`;
    })
    .catch(() => stamp("The station is not open.", true));
});
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

onChange<HTMLInputElement>("advancedSettings", (control) => {
  setAdvancedMode(control.checked);
  return { advancedSettings: control.checked };
});
element<HTMLButtonElement>("open-wizard").addEventListener("click", () => {
  wizardDismissed = false;
  openWizard(1);
});
element<HTMLButtonElement>("wiz-skip").addEventListener("click", () => {
  wizardDismissed = true;
  element("onboarding-wizard").hidden = true;
});
element<HTMLButtonElement>("wiz-prev").addEventListener("click", () => showWizardStep(wizardStep - 1));
element<HTMLButtonElement>("wiz-next").addEventListener("click", () => showWizardStep(wizardStep + 1));
element<HTMLButtonElement>("wiz-hw-refresh").addEventListener("click", () => refreshHardwareWizard());
element<HTMLButtonElement>("wiz-use-recommended").addEventListener("click", () => {
  const tier = element<HTMLSelectElement>("wiz-brain-select").value;
  void bridge.downloadBrain(tier).then((view) => {
    show(view);
    element("wiz-hw-reason").textContent = `Selected "${tier}". Models download on first use if not already present.`;
  });
});
onChange<HTMLSelectElement>("wiz-language", (control) => ({
  language: control.value as SettingsView["language"],
}));
onChange<HTMLInputElement>("wiz-always-listening", (control) => ({
  alwaysListening: control.checked,
}));
element<HTMLButtonElement>("wiz-voice-preview").addEventListener("click", () => {
  const voice = element<HTMLSelectElement>("wiz-voice").value;
  const note = element("wiz-voice-status");
  note.textContent = `Loading "${voice}" sample…`;
  void bridge
    .previewVoice(voice)
    .then((dataUri) => {
      if (!dataUri) {
        note.textContent = "Preview file unavailable.";
        return;
      }
      if (activePreviewAudio) activePreviewAudio.pause();
      activePreviewAudio = new Audio(dataUri);
      void activePreviewAudio.play();
      note.textContent = `Playing "${voice}".`;
      if (currentView?.designedVoicesReady) {
        void save({ voice: { engine: "full", design: voice } });
      }
    })
    .catch(() => {
      note.textContent = "Could not play voice preview.";
    });
});
element<HTMLButtonElement>("wiz-audit-rerun").addEventListener("click", () => refreshPolicyAuditWizard());
element<HTMLButtonElement>("wiz-finish").addEventListener("click", () => {
  void save({ onboardingComplete: true }).then(() => {
    element("onboarding-wizard").hidden = true;
  });
});

// ---------------------------------------------------------------- why did she do that?

/** A line of plain text in an element of its own. Never markup: what she and her tools wrote is shown as written. */
function line(tag: string, className: string, text: string): HTMLElement {
  const made = document.createElement(tag);
  if (className) made.className = className;
  made.textContent = text;
  return made;
}

function seconds(ms: number): string {
  return ms < 950 ? `${Math.round(ms / 10) * 10} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** How much the model read and wrote for a reply, or that it is not known. */
function tokensLine(tokens: ShownTrace["tokens"]): string {
  const { read, written, held, prompt } = tokens;
  const promptPart =
    typeof prompt === "number" ? `Prompt ${prompt.toLocaleString()} tokens. ` : "";
  if (read === null || written === null || held === null) {
    return `${promptPart}Read/written/held token counts are not known.`;
  }
  return `${promptPart}She read ${read.toLocaleString()} tokens, wrote ${written.toLocaleString()}, and held ${held.toLocaleString()} at the end.`;
}

function latenciesLine(ms: ShownTrace["ms"]): string {
  const stage = (label: string, value: number | null | undefined): string =>
    typeof value === "number" ? `${label}: ${seconds(value)}` : `${label}: n/a`;
  return [
    stage("STT", ms.stt),
    stage("LLM", ms.llm),
    stage("Tools", ms.tools),
    stage("TTS", ms.tts),
    ms.firstWord === null ? "First word: none" : `First word: ${seconds(ms.firstWord)}`,
    `Total: ${seconds(ms.whole)}`,
  ].join(" · ");
}

const ASKED_BY: Record<ShownTrace["kind"], string> = {
  user: "You said",
  ship: "The ship told her",
  again: "The app sent her back with",
};

/** One reply's record, shut until it is opened. */
function traceRow(trace: ShownTrace): HTMLLIElement {
  const item = document.createElement("li");
  const fold = document.createElement("details");
  fold.className = "trace";
  const head = document.createElement("summary");
  const when = new Date(trace.at);
  head.append(
    line(
      "span",
      "trace-time",
      Number.isNaN(when.getTime())
        ? ""
        : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    ),
    line("span", "trace-said", trace.kind === "again" ? "(her second go)" : trace.said),
    line("span", "trace-how", trace.summary),
  );
  fold.append(head);

  const body = document.createElement("div");
  body.className = "trace-body";
  body.append(line("p", "trace-label", ASKED_BY[trace.kind]), line("p", "trace-text", trace.said));
  body.append(line("p", "trace-label", "She said"));
  if (trace.withheld) {
    body.append(
      line("p", "trace-quiet", "Part of this reply is never written down and is not shown."),
    );
  }
  if (trace.reply !== "") body.append(line("p", "trace-text", trace.reply));
  else if (!trace.withheld) body.append(line("p", "trace-quiet", "Nothing."));

  body.append(
    line("p", "trace-label", trace.calls.length === 0 ? "No tools used" : "What she called"),
  );
  for (const call of trace.calls) {
    const block = document.createElement("div");
    block.className = "trace-call";
    const gateNote = call.gate
      ? `, gate: ${call.gate}${call.gateReason ? ` (${call.gateReason})` : ""}`
      : "";
    block.append(
      line(
        "p",
        "trace-call-head",
        `${call.tool}: ${call.ended} (${call.asked ? "you were asked first" : "without asking"}${gateNote}, ${seconds(call.ms)})`,
      ),
      line("p", "trace-quiet", "Asked for"),
      line("pre", "trace-raw", call.input),
      line("p", "trace-quiet", "Answered"),
      line("pre", "trace-raw", call.result === "" ? "(not kept)" : call.result),
    );
    body.append(block);
  }

  if (trace.checks.length > 0) {
    body.append(line("p", "trace-label", "What the app's checks did"));
    const checks = document.createElement("ul");
    checks.className = "trace-checks";
    checks.append(...trace.checks.map((sentence) => line("li", "", sentence)));
    body.append(checks);
  }

  const picked =
    trace.picked.length === 0
      ? ""
      : ` Picked for this message: ${trace.picked.map((pick) => `${pick.tool} (${pick.why})`).join("; ")}.`;
  const activeSchemas =
    trace.offeredTools.length > 0 ? ` Active tool schemas: ${trace.offeredTools.join(", ")}.` : "";
  body.append(
    line("p", "trace-label", "The rest"),
    line(
      "p",
      "trace-quiet",
      `${trace.brain || "Her brain"}, with ${trace.offered} ${trace.offered === 1 ? "tool" : "tools"} on offer.${activeSchemas}${picked}`,
    ),
    line("p", "trace-quiet", `${latenciesLine(trace.ms)}`),
    line("p", "trace-quiet", tokensLine(trace.tokens)),
  );
  fold.append(body);
  item.append(fold);
  return item;
}

const traceList = element<HTMLOListElement>("traces");
const traceNote = element<HTMLSpanElement>("traces-note");

function showTraces(): void {
  traceNote.textContent = "Looking…";
  bridge.traces().then(
    (kept) => {
      traceList.replaceChildren(...kept.map(traceRow));
      traceNote.textContent =
        kept.length === 0
          ? "Nothing has been kept since she was started. Say something to her, then refresh."
          : `${kept.length} ${kept.length === 1 ? "reply" : "replies"}, newest first.`;
    },
    () => {
      traceNote.textContent = "The records could not be read.";
    },
  );
}

element<HTMLButtonElement>("traces-refresh").addEventListener("click", showTraces);
element<HTMLDetailsElement>("traces-block").addEventListener("toggle", (event) => {
  if ((event.currentTarget as HTMLDetailsElement).open) showTraces();
});

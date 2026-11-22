import { ipcMain } from "electron";
import {
  type Agenda,
  isReservedCalendarName,
  MAX_CALENDARS,
  whyNotThisCalendar,
} from "../core/agenda.ts";
import type { ConfigStore } from "../core/config.ts";
import { firstCharacters, withoutUnseen } from "../core/unseen.ts";
import type { SettingsView } from "../shared/settings.ts";

/**
 * What the settings page may ask about calendars: point her at one, or take one away.
 * Calendars are added here and nowhere else, by the user; she has no tool that can
 * point herself at one.
 */

export interface AgendaIpcDeps {
  config: ConfigStore;
  agenda(): Agenda | null;
  /** True when a message really came from the settings window. */
  fromSettingsWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean;
  settingsView(): SettingsView;
}

/** A calendar's name as it is kept: no characters that do not show, one line, not too long. */
function calendarName(raw: unknown): string {
  // The user's own writing: an emoji in a calendar's name keeps what holds it together.
  const plain = withoutUnseen(typeof raw === "string" ? raw.slice(0, 200) : "", {
    instead: " ",
    ownWriting: true,
  })
    .replace(/\s+/g, " ")
    .trim();
  return firstCharacters(plain, 40);
}

export function registerAgendaIpc(deps: AgendaIpcDeps): void {
  const fromSettings = (event: Electron.IpcMainInvokeEvent): void => {
    if (!deps.fromSettingsWindow(event)) throw new Error("Not allowed from here.");
  };
  // Calendars are added here and nowhere else: by the user, on the settings page. She
  // has no tool that can point herself at one.
  ipcMain.handle(
    "agenda:add-calendar",
    async (
      event,
      input: unknown,
    ): Promise<{ ok: true; view: SettingsView } | { ok: false; why: string }> => {
      fromSettings(event);
      const raw = (typeof input === "object" && input !== null ? input : {}) as Record<
        string,
        unknown
      >;
      const name = calendarName(raw["name"]);
      const source = typeof raw["source"] === "string" ? raw["source"].trim() : "";
      if (name === "") return { ok: false, why: "Give the calendar a name, such as Work." };
      if (isReservedCalendarName(name)) {
        return { ok: false, why: `${name} is the name of her own list. Pick another name.` };
      }
      const refused = whyNotThisCalendar(source);
      if (refused) return { ok: false, why: refused };
      const calendars = deps.config.value.agenda.calendars;
      if (calendars.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, why: `A calendar is already called ${name}. Pick another name.` };
      }
      if (calendars.length >= MAX_CALENDARS) {
        return { ok: false, why: "That is as many calendars as she reads." };
      }
      await deps.config.update({
        agenda: { ...deps.config.value.agenda, calendars: [...calendars, { name, source }] },
      });
      return { ok: true, view: deps.settingsView() };
    },
  );
  ipcMain.handle("agenda:remove-calendar", async (event, name: unknown): Promise<SettingsView> => {
    fromSettings(event);
    const wanted = typeof name === "string" ? name : "";
    await deps.config.update({
      agenda: {
        ...deps.config.value.agenda,
        calendars: deps.config.value.agenda.calendars.filter((entry) => entry.name !== wanted),
      },
    });
    // What was read from it goes with it.
    deps.agenda()?.forgetWhatWasRead();
    return deps.settingsView();
  });
}

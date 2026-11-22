import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clipboard, dialog, ipcMain } from "electron";
import type { ConfigStore } from "../core/config.ts";
import {
  ASKPASS_SCRIPT,
  BACKUP_ID,
  checkMachine,
  Fleet,
  type HostKeys,
  type Machine,
} from "../core/fleet.ts";
import { fleetDir } from "../core/paths.ts";
import { compareText } from "../core/textDiff.ts";
import type { RemoteBackupView, SettingsView } from "../shared/settings.ts";

/**
 * What the settings page may ask about the user's other machines: find one, confirm its
 * fingerprint and add it, let her key in with a password typed by the user, test that
 * she can sign in, and forget it again. Machines are added here and nowhere else.
 */

export interface FleetIpcDeps {
  config: ConfigStore;
  fleet(): Fleet | null;
  /** True when a message really came from the settings window. */
  fromSettingsWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean;
  settingsView(): SettingsView;
}

/** Machines that answered and are waiting for the user to confirm their fingerprint. */
const machinesFound = new Map<
  string,
  { name: string; host: string; port: number; user: string; keys: HostKeys; until: number }
>();

export function registerFleetIpc(deps: FleetIpcDeps): void {
  function machineById(id: unknown): Machine {
    const machine = deps.config.value.fleet.machines.find((entry) => entry.id === id);
    if (!machine) throw new Error("That machine is not on her list any more.");
    return machine;
  }

  function saveMachines(machines: Machine[]): Promise<void> {
    return deps.config.update({ fleet: { ...deps.config.value.fleet, machines } });
  }

  /** Writes the small program SSH asks a password with, and returns where it is. */
  async function askpassProgram(): Promise<string> {
    const file = join(fleetDir(), "askpass.sh");
    await mkdir(fleetDir(), { recursive: true, mode: 0o700 });
    await writeFile(file, ASKPASS_SCRIPT, { mode: 0o700 });
    return file;
  }

  const fromSettings = (event: Electron.IpcMainInvokeEvent): void => {
    if (!deps.fromSettingsWindow(event)) throw new Error("Not allowed from here.");
  };
  ipcMain.handle("fleet:find", async (event, input: unknown) => {
    fromSettings(event);
    const fleet = deps.fleet();
    if (!fleet) throw new Error("Other machines are not available.");
    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<
      string,
      unknown
    >;
    const wanted = checkMachine({
      name: String(raw["name"] ?? ""),
      host: String(raw["host"] ?? ""),
      port: Number(raw["port"] ?? 22),
      user: String(raw["user"] ?? ""),
    });
    const taken = deps.config.value.fleet.machines.some(
      (machine) => machine.name.toLowerCase() === wanted.name.toLowerCase(),
    );
    if (taken) throw new Error(`A machine is already called ${wanted.name}. Pick another name.`);
    if (deps.config.value.fleet.machines.length >= 24)
      throw new Error("That is as many as she keeps.");
    const keys = await fleet.hostKeys(wanted);
    const now = Date.now();
    for (const [ticket, found] of machinesFound)
      if (found.until < now) machinesFound.delete(ticket);
    const ticket = Fleet.newId();
    machinesFound.set(ticket, { ...wanted, keys, until: now + 10 * 60_000 });
    return { ticket, fingerprints: keys.fingerprints };
  });
  ipcMain.handle("fleet:add", async (event, ticket: unknown): Promise<SettingsView> => {
    fromSettings(event);
    const fleet = deps.fleet();
    const found = typeof ticket === "string" ? machinesFound.get(ticket) : undefined;
    if (!fleet || !found || found.until < Date.now()) {
      throw new Error("That took too long. Look for the machine again.");
    }
    machinesFound.delete(String(ticket));
    // Checked again now: another machine may have been added while this one waited.
    const machines = deps.config.value.fleet.machines;
    if (machines.some((entry) => entry.name.toLowerCase() === found.name.toLowerCase())) {
      throw new Error(`A machine is already called ${found.name}. Pick another name.`);
    }
    if (machines.length >= 24) throw new Error("That is as many as she keeps.");
    const machine: Machine = {
      id: Fleet.newId(),
      name: found.name,
      host: found.host,
      port: found.port,
      user: found.user,
      lookWithoutAsking: false,
    };
    // Its identity is the one the user was just shown, not one asked for again now.
    await fleet.trust(machine.id, found.keys);
    await fleet.publicKey(machine.id);
    await saveMachines([...deps.config.value.fleet.machines, machine]);
    return deps.settingsView();
  });
  ipcMain.handle("fleet:let-in", async (event, id: unknown) => {
    fromSettings(event);
    const fleet = deps.fleet();
    if (!fleet) throw new Error("Other machines are not available.");
    const machine = machineById(id);
    try {
      await fleet.installKeyWithPassword(machine, await askpassProgram());
    } catch (error) {
      return { ok: false, why: error instanceof Error ? error.message : String(error) };
    }
    return fleet.canSignIn(machine);
  });
  ipcMain.handle("fleet:copy-key", async (event, id: unknown): Promise<void> => {
    fromSettings(event);
    const fleet = deps.fleet();
    if (!fleet) return;
    clipboard.writeText(`${await fleet.publicKey(machineById(id).id)}\n`);
  });
  ipcMain.handle("fleet:test", async (event, id: unknown) => {
    fromSettings(event);
    const fleet = deps.fleet();
    if (!fleet) throw new Error("Other machines are not available.");
    return fleet.canSignIn(machineById(id));
  });
  ipcMain.handle("fleet:set-look", async (event, id: unknown, on: unknown) => {
    fromSettings(event);
    const machine = machineById(id);
    await saveMachines(
      deps.config.value.fleet.machines.map((entry) =>
        entry.id === machine.id ? { ...entry, lookWithoutAsking: on === true } : entry,
      ),
    );
    return deps.settingsView();
  });
  ipcMain.handle("fleet:backups", async (event, id: unknown): Promise<RemoteBackupView[]> => {
    fromSettings(event);
    const fleet = deps.fleet();
    if (!fleet) throw new Error("Other machines are not available.");
    const kept = await fleet.backups(machineById(id));
    return kept.map((entry) => ({
      id: entry.id,
      path: entry.path,
      at: entry.at.toISOString(),
      bytes: entry.bytes,
    }));
  });
  ipcMain.handle(
    "fleet:restore",
    async (
      event,
      machineId: unknown,
      backupId: unknown,
    ): Promise<{ restored: boolean; keptNew: string | null }> => {
      fromSettings(event);
      const fleet = deps.fleet();
      if (!fleet) throw new Error("Other machines are not available.");
      if (typeof backupId !== "string" || !BACKUP_ID.test(backupId)) {
        throw new Error("That is not the name of a kept copy.");
      }
      const machine = machineById(machineId);
      const kept = await fleet.backups(machine);
      const chosen = kept.find((entry) => entry.id === backupId);
      if (!chosen) throw new Error("No such copy is kept on that machine any more.");
      const [now, then] = await Promise.all([
        fleet.readFile(machine, chosen.path).catch(() => null),
        fleet.backupText(machine, chosen.id).catch(() => null),
      ]);
      const made = chosen.at.toISOString().replace("T", " ").slice(0, 16);
      let detail = `${chosen.path}\nSnapshot ${chosen.id} (${chosen.bytes} bytes, ${made} UTC)`;
      if (then === null) {
        detail += "\n\nThe copy is not plain text, so changes cannot be shown.";
      } else if (now === null) {
        detail +=
          "\n\nWhat is there now could not be read as text; restoring puts this snapshot back.";
      } else {
        const diff = compareText(now, then, { context: 2, maxLines: 40 });
        detail += diff.same
          ? "\n\nThe file there already matches this snapshot."
          : `\n\nChanges (- as it is now, + as restored; ${diff.removed} out, ${diff.added} in):\n${diff.text}`;
      }
      const { response } = await dialog.showMessageBox({
        type: "question",
        buttons: ["Restore backup", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: `Put ${chosen.path} back on ${machine.name}?`,
        detail,
      });
      if (response !== 0) return { restored: false, keptNew: null };
      const keptNew = await fleet.restore(machine, chosen.id);
      return { restored: true, keptNew };
    },
  );
  ipcMain.handle("fleet:remove", async (event, id: unknown): Promise<SettingsView> => {
    fromSettings(event);
    const fleet = deps.fleet();
    if (!fleet) return deps.settingsView();
    const machine = machineById(id);
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["Forget it", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Forget ${machine.name}?`,
      detail:
        "Her key for this machine is deleted here, and she takes it off the machine's own list if she can still sign in. The machine itself is not changed in any other way.",
    });
    if (response !== 0) return deps.settingsView();
    const { removedThere } = await fleet.forget(machine);
    await saveMachines(deps.config.value.fleet.machines.filter((entry) => entry.id !== machine.id));
    if (!removedThere) {
      await dialog.showMessageBox({
        type: "info",
        message: `${machine.name} could not be reached to take her key off it.`,
        detail: `The key here is deleted, so it can no longer be used. To tidy up on the machine, remove the line ending in "ai-chan@…" from ~/.ssh/authorized_keys for ${machine.user}.`,
      });
    }
    return deps.settingsView();
  });
}

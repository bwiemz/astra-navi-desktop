import type { SettingsView } from "../../../shared/settings.ts";
import { bridge, element } from "./dom.ts";

/** What was last learned about each machine by trying it, kept while the window is open. */
const machineNotes = new Map<string, string>();
let machineTicket = "";

export function showMachines(view: SettingsView, onView: (fresh: SettingsView) => void): void {
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
        button("Forget", () => void bridge.removeMachine(machine.id).then(onView, failed), true),
      );
      const look = document.createElement("label");
      look.className = "machine-look";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = machine.lookWithoutAsking;
      box.addEventListener("change", () => {
        void bridge.setMachineLook(machine.id, box.checked).then(onView, failed);
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

export function resetMachineForm(words = ""): void {
  machineTicket = "";
  element("machine-confirm").hidden = true;
  element("machine-note").textContent = words;
  element<HTMLButtonElement>("machine-find").disabled = false;
}

export function wireFleet(onView: (fresh: SettingsView) => void): void {
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
        onView(view);
      })
      .catch(() => resetMachineForm("That took too long. Look for the machine again."));
  });
  element<HTMLButtonElement>("machine-no").addEventListener("click", () => resetMachineForm());
}

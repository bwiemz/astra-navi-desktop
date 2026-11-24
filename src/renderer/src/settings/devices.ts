import type { QrMatrix } from "../../../core/qrCode.ts";
import type { SettingsView } from "../../../shared/settings.ts";
import { bridge, element, stamp } from "./dom.ts";

/** True while the name field holds something the user typed and has not saved. */
let signInNameTouched = false;

function renderQrSvg(container: HTMLElement, matrix: QrMatrix): void {
  const svgNs = "http://www.w3.org/2000/svg";
  const quiet = 4;
  const total = matrix.size + quiet * 2;
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${total} ${total}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code for Astra Station pairing");

  const bg = document.createElementNS(svgNs, "rect");
  bg.setAttribute("width", String(total));
  bg.setAttribute("height", String(total));
  bg.setAttribute("fill", "#ffffff");
  svg.append(bg);

  const parts: string[] = [];
  for (let r = 0; r < matrix.size; r += 1) {
    const row = matrix.modules[r];
    if (!row) continue;
    for (let c = 0; c < matrix.size; c += 1) {
      if (row[c]) parts.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
    }
  }
  const path = document.createElementNS(svgNs, "path");
  path.setAttribute("d", parts.join(""));
  path.setAttribute("fill", "#11162a");
  svg.append(path);
  container.replaceChildren(svg);
}

export function showSignIn(view: SettingsView): void {
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
  if (!signInNameTouched && document.activeElement !== name) name.value = account.username ?? "";
  element<HTMLButtonElement>("signin-save").textContent = account.set
    ? "Change name and password"
    : "Save name and password";
  const asked = account.resetAsked;
  element("reset-asked").hidden = asked === null;
  element("reset-asked-text").textContent = asked
    ? `${asked.device.slice(0, 70)} asked for the sign-in password to be reset at ${new Date(
        asked.at,
      ).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}. If that was you, set a new one below. If it was not, remove that device.`
    : "";
}

export function showStation(view: SettingsView, onView: (fresh: SettingsView) => void): void {
  const { station } = view;
  showSignIn(view);
  element<HTMLInputElement>("station").checked = station.on;
  const open = station.on && station.addresses.length > 0;
  const network = (station.addresses[0] ?? "").replace(
    /^https:\/\/(\d+\.\d+\.\d+)\.\d+:.*$/,
    "$1.0/24",
  );
  const letThrough =
    station.firewall === "ufw"
      ? ` This PC's firewall (ufw) is on: allow her port once with "sudo ufw allow from ${network} to any port ${station.port} proto tcp".`
      : station.firewall === "firewalld"
        ? ` This PC's firewall (firewalld) is on: allow her port once with "sudo firewall-cmd --permanent --add-port=${station.port}/tcp" and then "sudo firewall-cmd --reload".`
        : station.firewall === "windows-defender" || station.platform === "win32"
          ? ` On Windows, make sure your Wi-Fi network is set to Private and allow TCP port ${station.port} in Windows Defender Firewall (or run the command under Firewall help below).`
          : "";
  const firewallCmd =
    station.firewall === "ufw"
      ? `sudo ufw allow from ${network || "192.168.0.0/16"} to any port ${station.port} proto tcp`
      : station.firewall === "firewalld"
        ? `sudo firewall-cmd --permanent --add-port=${station.port}/tcp && sudo firewall-cmd --reload`
        : `netsh advfirewall firewall add rule name="Astra Navi Station" dir=in action=allow protocol=TCP localport=${station.port} profile=private`;
  const firewallDesc =
    station.firewall === "windows-defender" || station.platform === "win32"
      ? "Windows Defender Firewall: make sure your Wi-Fi profile is set to Private, or run this in an Administrator Command Prompt / PowerShell:"
      : station.firewall === "ufw"
        ? "Ubuntu / ufw firewall detected: allow your local Wi-Fi subnet cleanly with:"
        : station.firewall === "firewalld"
          ? "firewalld detected: open only the local Station port with:"
          : "If your phone times out scanning the QR code, allow incoming TCP on your LAN subnet:";
  element("pair-firewall-text").textContent = firewallDesc;
  element("pair-firewall-cmd").textContent = firewallCmd;
  element("station-note").textContent = open
    ? `Open this on the other device, https:// included: ${station.addresses.join(" or ")}. Its browser will warn that the certificate is self-made; it is the right one if its fingerprint ends in ${station.fingerprint?.slice(-47) ?? "?"}.${letThrough}`
    : station.on
      ? "Switched on, but this PC has no home-network address right now."
      : "Off. Nothing outside this PC can reach her.";
  element("station-pairing").hidden = !open;
  if (!open) {
    element("pair-code").textContent = "";
    element("pair-qr").hidden = true;
    element("pair-qr-svg").replaceChildren();
  }
  element("station-devices").hidden = station.devices.length === 0;
  element("devices").replaceChildren(
    ...station.devices.map((device) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
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
          onView(fresh);
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
            onView(fresh);
            stamp("Unpinned");
          });
        });
      } else {
        button.textContent = "Pin to devices";
        button.addEventListener("click", () => {
          void bridge.pinMission(mission.id).then((fresh) => {
            onView(fresh);
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

export function wireDevices(onView: (fresh: SettingsView) => void): void {
  element<HTMLInputElement>("signin-name").addEventListener("input", () => {
    signInNameTouched = true;
  });
  element<HTMLButtonElement>("reset-dismiss").addEventListener("click", () => {
    void bridge.dismissReset().then(onView);
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
          password.value = "";
          again.value = "";
          signInNameTouched = false;
          onView(result.view);
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

  element<HTMLButtonElement>("pair").addEventListener("click", () => {
    bridge
      .pairDevice()
      .then(({ code, expiresAt, pairingUri, qrMatrix }) => {
        const until = new Date(expiresAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        element("pair-code").textContent =
          `Type ${code.slice(0, 3)} ${code.slice(3)} on the other device, or scan the QR code. Good until ${until}.`;
        renderQrSvg(element("pair-qr-svg"), qrMatrix);
        const caption = element("pair-qr-caption");
        caption.textContent = "Scan with Astra Station on Android (valid 5 min)";
        caption.title = pairingUri;
        element("pair-qr").hidden = false;
      })
      .catch(() => stamp("The station is not open.", true));
  });

  element<HTMLButtonElement>("pair-firewall-copy").addEventListener("click", () => {
    const cmd = element("pair-firewall-cmd").textContent ?? "";
    if (!cmd) return;
    void navigator.clipboard
      ?.writeText(cmd)
      .then(() => stamp("Copied firewall command"))
      .catch(() => stamp("Select and copy the command above", true));
  });
}

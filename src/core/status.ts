import { execFile } from "node:child_process";
import { readdir, readFile, statfs } from "node:fs/promises";
import { cpus, homedir, loadavg, totalmem, uptime } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The state of the "ship": this computer, read straight from the system. Everything
 * here only looks. A reading that is not available on this machine is simply left out.
 */
export interface ShipStatus {
  takenAt: string;
  uptimeHours: number;
  cpu: { cores: number; loadPercent: number; temperatureC: number | null };
  memory: { totalGb: number; availableGb: number; usedPercent: number };
  disks: { mount: string; totalGb: number; freeGb: number; usedPercent: number }[];
  gpu: {
    name: string;
    usedPercent: number;
    memoryUsedGb: number;
    memoryTotalGb: number;
    temperatureC: number | null;
  } | null;
  battery: { percent: number; charging: boolean } | null;
  /** The programs using the most processor right now. */
  busiest: { name: string; cpuPercent: number; memoryPercent: number }[];
}

const GB = 1024 ** 3;
const round = (value: number, places = 1): number => Number(value.toFixed(places));

async function readNumber(file: string): Promise<number | null> {
  try {
    const value = Number((await readFile(file, "utf8")).trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** The processor's temperature, from whichever sensor this machine has. */
async function cpuTemperature(): Promise<number | null> {
  try {
    for (const entry of await readdir("/sys/class/hwmon")) {
      const dir = join("/sys/class/hwmon", entry);
      const name = (await readFile(join(dir, "name"), "utf8").catch(() => "")).trim();
      if (!/^(k10temp|coretemp|zenpower|cpu_thermal)$/.test(name)) continue;
      const milli = await readNumber(join(dir, "temp1_input"));
      if (milli !== null) return round(milli / 1000, 0);
    }
  } catch {
    // no sensors exposed
  }
  return null;
}

async function memory(): Promise<ShipStatus["memory"]> {
  const total = totalmem();
  let available = total;
  try {
    const info = await readFile("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(info);
    if (match?.[1]) available = Number(match[1]) * 1024;
  } catch {
    // not Linux; fall back to "all free" rather than guessing
  }
  return {
    totalGb: round(total / GB),
    availableGb: round(available / GB),
    usedPercent: round(((total - available) / total) * 100, 0),
  };
}

async function disk(mount: string): Promise<ShipStatus["disks"][number] | null> {
  try {
    const info = await statfs(mount);
    const total = info.blocks * info.bsize;
    const free = info.bavail * info.bsize;
    if (total === 0) return null;
    return {
      mount,
      totalGb: round(total / GB, 0),
      freeGb: round(free / GB, 0),
      usedPercent: round(((total - free) / total) * 100, 0),
    };
  } catch {
    return null;
  }
}

async function gpu(): Promise<ShipStatus["gpu"]> {
  try {
    const { stdout } = await run(
      "nvidia-smi",
      [
        "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 4000 },
    );
    const [name, used, memoryUsed, memoryTotal, temperature] = (stdout.split("\n")[0] ?? "")
      .split(",")
      .map((part) => part.trim());
    if (!name || !memoryTotal) return null;
    const celsius = Number(temperature);
    return {
      name,
      usedPercent: round(Number(used), 0),
      memoryUsedGb: round(Number(memoryUsed) / 1024),
      memoryTotalGb: round(Number(memoryTotal) / 1024),
      temperatureC: Number.isFinite(celsius) ? round(celsius, 0) : null,
    };
  } catch {
    return null; // no NVIDIA card, or the tool is not installed
  }
}

async function battery(): Promise<ShipStatus["battery"]> {
  try {
    for (const entry of await readdir("/sys/class/power_supply")) {
      if (!entry.startsWith("BAT")) continue;
      const dir = join("/sys/class/power_supply", entry);
      const percent = await readNumber(join(dir, "capacity"));
      if (percent === null) continue;
      const state = (await readFile(join(dir, "status"), "utf8").catch(() => "")).trim();
      return { percent, charging: state === "Charging" || state === "Full" };
    }
  } catch {
    // a desktop machine: no battery folder at all
  }
  return null;
}

async function busiest(): Promise<ShipStatus["busiest"]> {
  try {
    const { stdout } = await run("ps", ["-eo", "pcpu,pmem,comm", "--sort=-pcpu", "--no-headers"], {
      timeout: 4000,
    });
    return stdout
      .split("\n")
      .slice(0, 5)
      .map((line) => /^\s*([\d.]+)\s+([\d.]+)\s+(.+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        name: (match[3] ?? "").trim(),
        cpuPercent: round(Number(match[1]), 0),
        memoryPercent: round(Number(match[2]), 0),
      }))
      .filter((entry) => entry.cpuPercent >= 1);
  } catch {
    return [];
  }
}

export async function readShipStatus(): Promise<ShipStatus> {
  const cores = cpus().length || 1;
  const home = homedir();
  const mounts = [...new Set(["/", home])];
  const disks = (await Promise.all(mounts.map(disk))).filter((entry) => entry !== null);
  // "/" and the home folder are usually one disk; listing it twice would only be noise.
  const unique = disks.filter(
    (entry, index) =>
      disks.findIndex(
        (other) => other.totalGb === entry.totalGb && other.freeGb === entry.freeGb,
      ) === index,
  );
  const [mem, temperatureC, graphics, power, programs] = await Promise.all([
    memory(),
    cpuTemperature(),
    gpu(),
    battery(),
    busiest(),
  ]);
  return {
    takenAt: new Date().toISOString(),
    uptimeHours: round(uptime() / 3600),
    cpu: { cores, loadPercent: round(((loadavg()[0] ?? 0) / cores) * 100, 0), temperatureC },
    memory: mem,
    disks: unique,
    gpu: graphics,
    battery: power,
    busiest: programs,
  };
}

/** The status as short lines the assistant can read from. */
export function describeShipStatus(status: ShipStatus): string {
  const lines = [
    `Processor: ${status.cpu.loadPercent}% busy across ${status.cpu.cores} cores` +
      (status.cpu.temperatureC === null ? "" : `, ${status.cpu.temperatureC}°C`),
    `Memory: ${status.memory.usedPercent}% used, ${status.memory.availableGb} GB of ${status.memory.totalGb} GB free`,
    ...status.disks.map(
      (entry) =>
        `Disk ${entry.mount}: ${entry.usedPercent}% used, ${entry.freeGb} GB of ${entry.totalGb} GB free`,
    ),
  ];
  if (status.gpu) {
    lines.push(
      `Graphics card (${status.gpu.name}): ${status.gpu.usedPercent}% busy, ` +
        `${status.gpu.memoryUsedGb} of ${status.gpu.memoryTotalGb} GB memory used` +
        (status.gpu.temperatureC === null ? "" : `, ${status.gpu.temperatureC}°C`),
    );
  }
  if (status.battery) {
    lines.push(
      `Battery: ${status.battery.percent}%, ${status.battery.charging ? "charging" : "running down"}`,
    );
  }
  if (status.busiest.length > 0) {
    lines.push(
      `Busiest programs: ${status.busiest.map((entry) => `${entry.name} (${entry.cpuPercent}% processor)`).join(", ")}`,
    );
  }
  lines.push(`Running for ${status.uptimeHours} hours since the last restart`);
  return lines.join("\n");
}

export interface Alert {
  /** Stable name for the problem, so it is raised once rather than every minute. */
  key: string;
  text: string;
}

/** The things worth interrupting someone for. Deliberately few. */
export function findAlerts(status: ShipStatus): Alert[] {
  const alerts: Alert[] = [];
  for (const entry of status.disks) {
    if (entry.usedPercent >= 95) {
      alerts.push({
        key: `disk:${entry.mount}`,
        text: `Disk ${entry.mount} is ${entry.usedPercent}% full, only ${entry.freeGb} GB left.`,
      });
    }
  }
  if (status.memory.usedPercent >= 95) {
    alerts.push({
      key: "memory",
      text: `Memory is ${status.memory.usedPercent}% used; only ${status.memory.availableGb} GB is free.`,
    });
  }
  if (
    status.gpu?.temperatureC !== null &&
    status.gpu?.temperatureC !== undefined &&
    status.gpu.temperatureC >= 90
  ) {
    alerts.push({
      key: "gpu-heat",
      text: `The graphics card is at ${status.gpu.temperatureC}°C, which is very hot.`,
    });
  }
  if (status.cpu.temperatureC !== null && status.cpu.temperatureC >= 95) {
    alerts.push({
      key: "cpu-heat",
      text: `The processor is at ${status.cpu.temperatureC}°C, which is very hot.`,
    });
  }
  if (status.battery && !status.battery.charging && status.battery.percent <= 12) {
    alerts.push({
      key: "battery",
      text: `The battery is down to ${status.battery.percent}% and not charging.`,
    });
  }
  return alerts;
}

#!/usr/bin/env node
/**
 * Astra Navi Desktop — Browser Native Messaging Host (`app.astranavi.dom_bridge`).
 *
 * Bridges Chrome/Firefox stdio Native Messaging (32-bit LE length-prefixed JSON) with a
 * private local user IPC socket / Windows named pipe so the desktop app can request
 * read-only DOM extraction on allowlisted origins.
 */
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;

export function defaultDomSocketPath(platform = process.platform) {
  const override = process.env["ASTRA_NAVI_DOM_SOCKET"];
  if (override) return override;
  if (platform === "win32") return "\\\\.\\pipe\\astra-navi-dom-bridge";
  const xdg = process.env["XDG_DATA_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  const primary = join(base, "astra-navi");
  const legacy = join(base, "ai-chan");
  const dataRoot = !existsSync(primary) && existsSync(legacy) ? legacy : primary;
  return join(dataRoot, "scratch", "dom-bridge.sock");
}

export function encodeFrame(payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  if (json.length > MAX_BYTES) throw new Error("Frame exceeded 1 MiB native messaging limit.");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

export function createFrameDecoder(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > MAX_BYTES) {
        buf = Buffer.alloc(0);
        return;
      }
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len).toString("utf8");
      buf = buf.subarray(4 + len);
      try {
        onMessage(JSON.parse(body));
      } catch {
        // ignore malformed frames
      }
    }
  };
}

function writeStdout(payload) {
  process.stdout.write(encodeFrame(payload));
}

if (import.meta.main) {
  const pending = new Map();
  let seq = 0;

  if (process.argv.includes("--stdio-echo")) {
    process.stdin.on(
      "data",
      createFrameDecoder((msg) => {
        if (msg && msg.action === "ping") {
          writeStdout({ id: msg.id ?? "ping", ok: true, data: { alive: true } });
        } else {
          writeStdout({ id: msg && msg.id ? msg.id : "echo", ok: true, data: msg });
        }
      }),
    );
  } else {
    const socketPath = defaultDomSocketPath();
    if (process.platform !== "win32") {
      mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
      try {
        unlinkSync(socketPath);
      } catch {
        // ignore missing stale socket
      }
    }

    process.stdin.on(
      "data",
      createFrameDecoder((msg) => {
        if (!msg || typeof msg.id !== "string") return;
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }),
    );

    const server = createServer((conn) => {
      conn.on(
        "data",
        createFrameDecoder((req) => {
          const id = typeof req?.id === "string" ? req.id : `req-${++seq}`;
          const action = typeof req?.action === "string" ? req.action : "read-page";
          if (action !== "read-page" && action !== "ping") {
            conn.write(encodeFrame({ id, ok: false, error: "Unsupported bridge action." }));
            return;
          }
          const timer = setTimeout(() => {
            pending.delete(id);
            try {
              conn.write(encodeFrame({ id, ok: false, error: "Browser extension timed out." }));
            } catch {
              // ignore closed client
            }
          }, REQUEST_TIMEOUT_MS);
          pending.set(id, {
            timer,
            resolve: (res) => {
              try {
                conn.write(encodeFrame(res));
              } catch {
                // ignore closed client
              }
            },
          });
          writeStdout({ id, action, ...(typeof req?.url === "string" ? { url: req.url } : {}) });
        }),
      );
    });

    server.listen(socketPath, () => {
      if (process.platform !== "win32") {
        try {
          chmodSync(socketPath, 0o600);
        } catch {
          // best-effort permission hardening
        }
      }
    });

    const cleanup = () => {
      server.close();
      if (process.platform !== "win32") {
        try {
          unlinkSync(socketPath);
        } catch {
          // ignore
        }
      }
      process.exit(0);
    };
    process.stdin.on("end", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }
}

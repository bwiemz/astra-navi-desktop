import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request as plainRequest } from "node:http";
import { request as secureRequest } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Station } from "../src/core/station.ts";

/**
 * The station's front door: what a device meets before any page is served. A phone
 * browser given the bare address tries plain http first; hung up on, it only says "this
 * site can't be reached", which is how the station first failed on a real phone.
 */

let dir = "";
let station: Station;
let port = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "aichan-door-"));
  station = new Station({
    dir,
    port: 0,
    onSay: () => true,
    onStop: () => undefined,
    localAddresses: () => ["127.0.0.1"],
    makeCertificate: async (target) => {
      await promisify(execFile)("openssl", [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-keyout", join(target, "key.pem"), "-out", join(target, "cert.pem"),
        "-days", "2", "-subj", "/CN=test",
      ]); // prettier-ignore
    },
  });
  await station.start();
  port = Number(new URL(station.addresses()[0] ?? "").port);
});

afterAll(async () => {
  await station.stop();
  await rm(dir, { recursive: true, force: true });
});

function plain(path: string, method = "GET"): Promise<{ status: number; location: string }> {
  return new Promise((resolve, reject) => {
    const asking = plainRequest({ host: "127.0.0.1", port, path, method }, (answer) => {
      answer.resume();
      answer.on("end", () =>
        resolve({ status: answer.statusCode ?? 0, location: answer.headers.location ?? "" }),
      );
    });
    asking.on("error", reject);
    asking.end();
  });
}

/** Sends raw bytes and resolves with whatever came back before the other side hung up. */
function raw(bytes: Buffer | null): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      if (bytes) socket.write(bytes);
    });
    let got = "";
    socket.on("data", (chunk: Buffer) => (got += chunk.toString("latin1")));
    socket.on("close", () => resolve(got));
    socket.on("error", () => resolve(got));
  });
}

describe("the station's front door", () => {
  it("sends a browser that came without https to the same address with it", async () => {
    const answer = await plain("/");
    expect(answer.status).toBe(301);
    expect(answer.location).toBe(`https://127.0.0.1:${port}/`);
  });

  it("does not let the request choose where it is sent", async () => {
    const answer = await new Promise<string>((resolve) => {
      void raw(Buffer.from("GET /elsewhere HTTP/1.1\r\nHost: evil.example\r\n\r\n", "latin1")).then(
        resolve,
      );
    });
    expect(answer).toContain(`Location: https://127.0.0.1:${port}/\r\n`);
    expect(answer).not.toContain("evil.example");
    expect(answer).not.toContain("elsewhere");
  });

  it("still serves the page over https through the same port", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const asking = secureRequest(
        { host: "127.0.0.1", port, path: "/", method: "GET", rejectUnauthorized: false },
        (answer) => {
          answer.resume();
          answer.on("end", () => resolve(answer.statusCode ?? 0));
        },
      );
      asking.on("error", reject);
      asking.end();
    });
    expect(status).toBe(200);
  });

  it("hangs up on a plain request that is not a simple page fetch", async () => {
    expect(await raw(Buffer.from("POST /say HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", "latin1"))).toBe(
      "",
    );
  });

  it("hangs up on bytes that are neither an encrypted hello nor a web request", async () => {
    expect(await raw(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe("");
  });

  it("gives the place back after redirecting, even when the caller never hangs up", async () => {
    // Twelve callers ask, are redirected, and then just sit there with their side open.
    // That is every place one address may hold; if they kept them, a thirteenth caller
    // would be turned away.
    const sitting: ReturnType<typeof connect>[] = [];
    await Promise.all(
      Array.from(
        { length: 12 },
        () =>
          new Promise<void>((resolve) => {
            const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true }, () => {
              socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
            });
            sitting.push(socket);
            socket.on("data", () => undefined);
            socket.on("error", () => resolve());
            socket.on("end", () => resolve());
          }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const answer = await plain("/");
    for (const socket of sitting) socket.destroy();
    expect(answer.status).toBe(301);
  });

  it("lets one address hold only so many places at once", async () => {
    const held: ReturnType<typeof connect>[] = [];
    const opened = (): Promise<"open" | "closed"> =>
      new Promise((resolve) => {
        const socket = connect(port, "127.0.0.1");
        held.push(socket);
        let settled = false;
        const settle = (how: "open" | "closed"): void => {
          if (settled) return;
          settled = true;
          resolve(how);
        };
        socket.on("error", () => settle("closed"));
        socket.on("close", () => settle("closed"));
        // Silent callers are kept for a few seconds; one turned away is closed at once.
        socket.on("connect", () => setTimeout(() => settle("open"), 250));
      });
    // Callers from the tests before this one take a moment to be seen as gone.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const results: string[] = [];
    for (let index = 0; index < 14; index++) results.push(await opened());
    for (const socket of held) socket.destroy();
    // An earlier test's kept-alive https connection may still hold one of the twelve.
    const open = results.filter((result) => result === "open").length;
    expect(open).toBeGreaterThanOrEqual(11);
    expect(open).toBeLessThanOrEqual(12);
    expect(results.slice(0, 11)).toEqual(Array.from({ length: 11 }, () => "open"));
    expect(results.slice(12)).toEqual(["closed", "closed"]);
    // With those gone there is room again.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await plain("/")).status).toBe(301);
  });

  it("is closed for good when the station stops", async () => {
    const other = new Station({
      dir: join(dir, "second"),
      port: 0,
      onSay: () => true,
      onStop: () => undefined,
      localAddresses: () => ["127.0.0.1"],
      makeCertificate: async (target) => {
        const { copyFile } = await import("node:fs/promises");
        await copyFile(join(dir, "cert.pem"), join(target, "cert.pem"));
        await copyFile(join(dir, "key.pem"), join(target, "key.pem"));
      },
    });
    await other.start();
    const otherPort = Number(new URL(other.addresses()[0] ?? "").port);
    await other.stop();
    expect(other.running).toBe(false);
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect(otherPort, "127.0.0.1");
      socket.on("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("error", () => resolve(true));
    });
    expect(refused).toBe(true);
  });
});

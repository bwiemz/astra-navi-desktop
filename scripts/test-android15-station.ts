/**
 * Live End-to-End Android 15 (API 35) Verification for `src/core/station.ts` & `phone-app`:
 *  1. Verifies live `emulator-5554` is running Android 15 (SDK 35) with `app.astranavi.station` installed.
 *  2. Enforces 64-hex SHA-256 TLS certificate pinning (wrong pin refused with 0 alerts/approvals).
 *  3. Triggers `AlertPollerService` (`JobScheduler` ID 47821) under Android 15 limits -> verifies
 *     posted standing-order notification + inline Approve/Decline actions in `dumpsys notification`.
 *  4. Verifies `ApprovalActionReceiver` handles an invalid/expired session (`401`) by preserving
 *     the notification and clearing `session_token`, then completes a signed-in (`X-Session`)
 *     `200 OK` approval and cancels the notification.
 *
 * Usage:
 *   node scripts/test-android15-station.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Station, type PairedDevice, type StationAlert } from "../src/core/station.ts";

const execFileAsync = promisify(execFile);
const ADB = process.env.ADB || "/home/brandon/Android/Sdk/platform-tools/adb";
const SERIAL = process.env.ANDROID_SERIAL || "emulator-5554";
const PKG = "app.astranavi.station";

async function adb(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(ADB, ["-s", SERIAL, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function adbShell(command: string): Promise<string> {
  return await adb(["shell", command]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function javaHashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
  }
  return hash;
}

function expectedNotifyId(alertId: string): number {
  return (javaHashCode(alertId) & 0x7fffffff) + 1000;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildStationPrefsXml(opts: {
  address: string;
  fingerprint: string;
  alertEnabled: boolean;
  alertToken: string;
  sessionToken?: string;
}): string {
  const lines = [
    '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>',
    "<map>",
    `    <string name="address">${escapeXml(opts.address)}</string>`,
    `    <string name="fingerprint">${escapeXml(opts.fingerprint)}</string>`,
    `    <boolean name="alert_enabled" value="${opts.alertEnabled ? "true" : "false"}" />`,
    `    <string name="alert_token">${escapeXml(opts.alertToken)}</string>`,
  ];
  if (opts.sessionToken) {
    lines.push(`    <string name="session_token">${escapeXml(opts.sessionToken)}</string>`);
  }
  lines.push("</map>", "");
  return lines.join("\n");
}

async function seedPrefsOnDevice(opts: {
  address: string;
  fingerprint: string;
  alertEnabled: boolean;
  alertToken: string;
  sessionToken?: string;
}): Promise<void> {
  const xml = buildStationPrefsXml(opts);
  const b64 = Buffer.from(xml, "utf8").toString("base64");
  await adbShell(
    [
      `am force-stop ${PKG}`,
      `mkdir -p /data/data/${PKG}/shared_prefs`,
      `echo '${b64}' | base64 -d > /data/data/${PKG}/shared_prefs/station.xml`,
      `OWNER=$(stat -c '%u:%g' /data/data/${PKG})`,
      `chown "$OWNER" /data/data/${PKG}/shared_prefs /data/data/${PKG}/shared_prefs/station.xml`,
      `chmod 771 /data/data/${PKG}/shared_prefs && chmod 660 /data/data/${PKG}/shared_prefs/station.xml`,
    ].join(" && "),
  );
}

async function clearNotifications(): Promise<void> {
  try {
    await adbShell("service call notification 1");
  } catch {
    // Non-fatal on strict shells; individual tests use distinct alert IDs.
  }
}

function activeNotificationsDump(fullDump: string): string {
  const start = fullDump.indexOf("Notification List:");
  if (start === -1) return fullDump;
  const end = fullDump.indexOf("mMaxPackageEnqueueRate=", start);
  return end === -1 ? fullDump.slice(start) : fullDump.slice(start, end);
}

async function getAppCrashLines(): Promise<string[]> {
  const dump = await adb(["logcat", "-d", "-s", "AndroidRuntime:E", "ForegroundServiceStartNotAllowedException:*"]);
  return dump
    .split("\n")
    .filter((line) => line.includes(PKG) || line.includes("ForegroundServiceStartNotAllowedException"));
}

async function postJson(
  port: number,
  path: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          Host: `127.0.0.1:${port}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            json: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function waitFor<T>(fn: () => Promise<T | null> | T | null, timeoutMs: number, stepMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await fn();
    if (found !== null) return found;
    await sleep(stepMs);
  }
  throw new Error(`Timed out after ${timeoutMs} ms`);
}

async function main(): Promise<void> {
  assert.equal(await adb(["get-state"]), "device", `Expected ${SERIAL} to be online.`);
  const release = await adbShell("getprop ro.build.version.release");
  const sdk = await adbShell("getprop ro.build.version.sdk");
  const abi = await adbShell("getprop ro.product.cpu.abi");
  assert.equal(release, "15", `Expected Android 15 release, got ${release}`);
  assert.equal(sdk, "35", `Expected Android SDK 35, got ${sdk}`);
  const pkgPath = await adbShell(`pm path ${PKG}`);
  assert.ok(pkgPath.includes("package:"), `${PKG} is not installed on ${SERIAL}`);

  await adb(["root"]);
  await adb(["wait-for-device"]);
  await adbShell(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);

  const dir = await mkdtemp(join(tmpdir(), "astra-a15-"));
  let currentAlerts: (StationAlert & { approvalId?: string })[] = [];
  let alertsRequests = 0;
  const approvalsAnswered: { id: string; allow: boolean; device: PairedDevice }[] = [];

  const station = new Station({
    dir,
    port: 0,
    localAddresses: () => ["10.0.2.2"],
    mdns: false,
    passwordCost: 1 << 14,
    onSay: () => true,
    onStop: () => undefined,
    alerts: (since?: string) => {
      alertsRequests += 1;
      if (!since) return currentAlerts;
      const idx = currentAlerts.findIndex((a) => a.id === since);
      return idx === -1 ? currentAlerts : currentAlerts.slice(idx + 1);
    },
    approvals: {
      cards: () => [],
      answer: (id, allow, device) => {
        approvalsAnswered.push({ id, allow, device });
        return true;
      },
    },
  });

  try {
    await station.start();
    await station.setAccount("captain", "correct horse battery staple");

    const addressUrl = station.addresses()[0];
    assert.ok(addressUrl, "Station did not report a listening URL");
    const port = Number(new URL(addressUrl).port);
    const emulatorAddress = `10.0.2.2:${port}`;
    const fp = (station.fingerprint() ?? "").replaceAll(":", "").toUpperCase();
    assert.match(fp, /^[0-9A-F]{64}$/);

    const { code } = station.beginPairing();
    const paired = await postJson(port, "/pair", { code, name: "Pixel 6 Android 15" });
    assert.equal(paired.status, 200);
    const token = String(paired.json.token ?? "");
    assert.ok(token.length >= 20, "Missing paired bearer token");

    const signedIn = await postJson(
      port,
      "/sign-in",
      { username: "captain", password: "correct horse battery staple" },
      token,
    );
    assert.equal(signedIn.status, 200);
    const session = String(signedIn.json.session ?? "");
    assert.match(session, /^[A-Za-z0-9_-]{40,50}$/);

    // Test 1: Wrong 64-hex TLS pin refused before HTTP/alerts/approvals.
    await clearNotifications();
    await adb(["logcat", "-c"]);
    currentAlerts = [
      {
        id: "alert-a15-wrong-pin",
        kind: "order",
        title: "Should Not Arrive",
        body: "Wrong pin must abort TLS handshake",
        at: new Date().toISOString(),
        approvalId: "approvalA15WrongPin01",
      },
    ];
    await seedPrefsOnDevice({
      address: emulatorAddress,
      fingerprint: "0".repeat(64),
      alertEnabled: true,
      alertToken: token,
      sessionToken: session,
    });
    await adbShell(`am start -n ${PKG}/.MainActivity`);
    await sleep(2000);
    await adbShell(`cmd jobscheduler run -f ${PKG} 47821 || true`);
    await sleep(2000);
    await adbShell(
      `am broadcast -n ${PKG}/.ApprovalActionReceiver -a ${PKG}.APPROVAL_RESPOND --es approval_id approvalA15WrongPin01 --ez allow true --ei notify_id 7771`,
    );
    await sleep(1500);
    assert.equal(alertsRequests, 0, "Wrong TLS pin still hit GET /alerts");
    assert.equal(approvalsAnswered.length, 0, "Wrong TLS pin still answered /approve");
    const notifAfterWrongPin = activeNotificationsDump(await adbShell("dumpsys notification --noredact"));
    assert.equal(
      notifAfterWrongPin.includes("Should Not Arrive"),
      false,
      "Wrong TLS pin must not post any alert notification",
    );
    assert.deepEqual(await getAppCrashLines(), []);

    // Test 2: Matching pin + API 35 AlertPollerService notification + invalid-session 401 refusal.
    const alertId1 = "alert-a15-01";
    const approvalId1 = "approvalA15Test00001";
    const notifyId1 = expectedNotifyId(alertId1);
    const alertsBeforeTest2 = alertsRequests;
    currentAlerts = [
      {
        id: alertId1,
        kind: "order",
        title: "Standing Order Triggered",
        body: "Approve backup rotation?",
        at: new Date().toISOString(),
        approvalId: approvalId1,
      },
    ];
    await adb(["logcat", "-c"]);
    await seedPrefsOnDevice({
      address: emulatorAddress,
      fingerprint: fp,
      alertEnabled: true,
      alertToken: token,
      sessionToken: "expiredOrInvalidSessionToken000000000000000",
    });
    await adbShell(`am start -n ${PKG}/.MainActivity`);
    await sleep(2000);
    if (alertsRequests === alertsBeforeTest2) {
      await adbShell(`cmd jobscheduler run -f ${PKG} 47821`);
    }

    const notifDump1 = await waitFor(async () => {
      if (alertsRequests <= alertsBeforeTest2) return null;
      const dump = activeNotificationsDump(await adbShell("dumpsys notification --noredact"));
      if (dump.includes(`id=${notifyId1}`) && dump.includes("Standing Order Triggered")) return dump;
      return null;
    }, 10_000);
    assert.ok(notifDump1.includes(PKG));
    assert.ok(notifDump1.includes("Approve"));
    assert.ok(notifDump1.includes("Decline"));
    assert.deepEqual(await getAppCrashLines(), []);

    // Broadcast Approve with an invalid session_token -> Station refuses 401 promptly, notification stays,
    // and ApprovalActionReceiver clears session_token from shared prefs.
    const t0 = Date.now();
    await adbShell(
      `am broadcast -n ${PKG}/.ApprovalActionReceiver -a ${PKG}.APPROVAL_RESPOND --es approval_id ${approvalId1} --ez allow true --ei notify_id ${notifyId1}`,
    );
    const broadcast401Ms = Date.now() - t0;
    assert.ok(
      broadcast401Ms < 8000,
      `401 approval broadcast took unexpectedly long (${broadcast401Ms} ms)`,
    );
    assert.equal(approvalsAnswered.length, 0, "Invalid-session ApprovalActionReceiver must be refused 401");
    const notifStillPresent = activeNotificationsDump(await adbShell("dumpsys notification --noredact"));
    assert.ok(
      notifStillPresent.includes(`id=${notifyId1}`),
      "Notification must remain present when /approve returns 401",
    );
    await waitFor(async () => {
      const prefsXml = await adbShell(`cat /data/data/${PKG}/shared_prefs/station.xml`);
      return prefsXml.includes("session_token") ? null : prefsXml;
    }, 3000);
    assert.deepEqual(await getAppCrashLines(), []);

    // Test 3: Signed-in X-Session approval (200 OK) -> Station records answer and cancels notification.
    const alertId2 = "alert-a15-02";
    const approvalId2 = "approvalA15Test00002";
    const notifyId2 = expectedNotifyId(alertId2);
    const alertsBeforeSignedIn = alertsRequests;
    currentAlerts = [
      {
        id: alertId2,
        kind: "order",
        title: "Standing Order Signed-In",
        body: "Approve deploy check?",
        at: new Date().toISOString(),
        approvalId: approvalId2,
      },
    ];
    await seedPrefsOnDevice({
      address: emulatorAddress,
      fingerprint: fp,
      alertEnabled: true,
      alertToken: token,
      sessionToken: session,
    });
    await adbShell(`am start -n ${PKG}/.MainActivity`);
    await sleep(2000);
    if (alertsRequests === alertsBeforeSignedIn) {
      await adbShell(`cmd jobscheduler run -f ${PKG} 47821`);
    }

    await waitFor(async () => {
      if (alertsRequests <= alertsBeforeSignedIn) return null;
      const dump = activeNotificationsDump(await adbShell("dumpsys notification --noredact"));
      return dump.includes(`id=${notifyId2}`) ? dump : null;
    }, 10_000);

    const t1 = Date.now();
    await adbShell(
      `am broadcast -n ${PKG}/.ApprovalActionReceiver -a ${PKG}.APPROVAL_RESPOND --es approval_id ${approvalId2} --ez allow true --ei notify_id ${notifyId2}`,
    );
    const broadcast200Ms = Date.now() - t1;
    assert.ok(
      broadcast200Ms < 8000,
      `200 approval broadcast took unexpectedly long (${broadcast200Ms} ms)`,
    );

    try {
      await waitFor(
        () => approvalsAnswered.find((entry) => entry.id === approvalId2 && entry.allow === true) ?? null,
        8000,
      );
    } catch (error) {
      const prefsXml = await adbShell(`cat /data/data/${PKG}/shared_prefs/station.xml 2>&1 || true`);
      const activeDump = activeNotificationsDump(await adbShell("dumpsys notification --noredact"));
      throw new Error(
        `Signed-in ApprovalActionReceiver did not record answer (${String(error)}); broadcast200Ms=${broadcast200Ms}; approvalsAnswered=${JSON.stringify(approvalsAnswered)}; prefs=${prefsXml}; activeNotifs=${activeDump.slice(0, 1200)}`,
        { cause: error },
      );
    }

    try {
      await waitFor(async () => {
        const dump = activeNotificationsDump(await adbShell("dumpsys notification --noredact"));
        return dump.includes(`id=${notifyId2}`) ? null : dump;
      }, 8000);
    } catch (error) {
      const activeDump = activeNotificationsDump(await adbShell("dumpsys notification --noredact"));
      throw new Error(
        `Signed-in approval answered (${JSON.stringify(approvalsAnswered)}) but active notification id=${notifyId2} remained (${String(error)}): ${activeDump.slice(0, 1200)}`,
        { cause: error },
      );
    }

    assert.deepEqual(await getAppCrashLines(), []);

    console.log(
      JSON.stringify(
        {
          ok: true,
          device: { serial: SERIAL, release, sdk, abi },
          stationAddressForEmulator: emulatorAddress,
          fingerprintPrefix: fp.slice(0, 12),
          timingsMs: { broadcast401Ms, broadcast200Ms },
          checks: {
            wrongPinBlocked: true,
            api35AlertPollerNotificationPosted: true,
            signedOutApproval401KeptNotificationAndClearedSession: true,
            signedInApproval200CancelledNotification: true,
          },
          alertsRequests,
          approvalsAnswered: approvalsAnswered.map((entry) => ({
            id: entry.id,
            allow: entry.allow,
            deviceName: entry.device.name,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await clearNotifications();
      await adbShell(`am force-stop ${PKG} && rm -f /data/data/${PKG}/shared_prefs/station.xml`);
    } catch {
      // Best-effort device cleanup.
    }
    await station.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

await main();

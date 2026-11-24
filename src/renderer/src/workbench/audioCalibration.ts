import type { RoomCalibrationReport, StudioToolsBridge } from "../../../shared/studioTools.ts";
import { el } from "./dom.ts";

function buildProbeSweep(sampleRate: number, durationSec: number): Float32Array {
  const length = Math.round(sampleRate * durationSec);
  const out = new Float32Array(length);
  const fadeSamples = Math.min(Math.floor(length / 4), Math.round(sampleRate * 0.02));
  const f0 = 180;
  const f1 = 1650;
  let chirpPhase = 0;
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const progress = length > 1 ? i / (length - 1) : 0;
    chirpPhase += (2 * Math.PI * (f0 * Math.pow(f1 / f0, progress))) / sampleRate;
    let env = 0.45;
    if (fadeSamples > 0 && i < fadeSamples) env *= 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
    else if (fadeSamples > 0 && i >= length - fadeSamples) {
      env *= 0.5 * (1 - Math.cos((Math.PI * (length - 1 - i)) / fadeSamples));
    }
    out[i] =
      (0.55 * Math.sin(chirpPhase) +
        0.28 * Math.sin(2 * Math.PI * 220 * t) +
        0.17 * Math.sin(2 * Math.PI * 520 * t)) *
      env;
  }
  return out;
}

async function captureLiveRoomProbe(): Promise<{
  sampleRate: number;
  referenceSamples: number[];
  recordedSamples: number[];
}> {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
    throw new Error("Microphone/speaker Web Audio API is unavailable; run Synthetic Self-Test instead.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const ctx = new AudioContext({ sampleRate: 16_000 });
  const recorded: number[] = [];
  const sampleRate = ctx.sampleRate || 16_000;
  const sweep = buildProbeSweep(sampleRate, 1.0);
  try {
    const sourceNode = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(2048, 1, 1);
    const muteGain = ctx.createGain();
    muteGain.gain.value = 0;
    processor.onaudioprocess = (ev) => {
      const ch = ev.inputBuffer.getChannelData(0);
      for (let i = 0; i < ch.length && recorded.length < 48_000; i += 1) {
        recorded.push(ch[i] ?? 0);
      }
    };
    sourceNode.connect(processor);
    processor.connect(muteGain);
    muteGain.connect(ctx.destination);

    const playBuf = ctx.createBuffer(1, sweep.length, sampleRate);
    playBuf.getChannelData(0).set(sweep);
    const player = ctx.createBufferSource();
    player.buffer = playBuf;
    player.connect(ctx.destination);
    player.start();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1180);
    });
    processor.disconnect();
    sourceNode.disconnect();
    muteGain.disconnect();
    return {
      sampleRate,
      referenceSamples: Array.from(sweep),
      recordedSamples: recorded.slice(0, sweep.length),
    };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => undefined);
  }
}

function renderRoomCalibrationReport(host: HTMLElement, report: RoomCalibrationReport): void {
  host.replaceChildren();
  const top = el("div", "row-between");
  top.append(
    el("strong", undefined, `Room Acoustic & Wake Report (${report.samplesAnalyzed} samples @ ${report.sampleRate} Hz)`),
  );
  const badges = el("div", "btn-row");
  badges.append(
    el("span", `badge ${report.erleDb >= 10 ? "ok" : report.erleDb >= 6 ? "warn" : "critical"}`, `ERLE ${report.erleDb.toFixed(1)} dB`),
    el("span", `badge ${report.bargeInReady ? "ok" : "warn"}`, report.bargeInReady ? "Barge-In Ready" : "Needs PipeWire AEC"),
    el("span", `badge ${report.wakePassRate >= 1 ? "ok" : "warn"}`, `Wake ${Math.round(report.wakePassRate * 100)}%`),
  );
  top.append(badges);
  host.append(top);

  const metrics = [
    `Raw Mic RMS: ${report.rawMicRms.toFixed(5)} · Post-NLMS Residual RMS: ${report.residualRms.toFixed(5)} · Room Noise Floor: ${report.noiseFloorRms.toFixed(5)}`,
    `Recommended Min SNR: ${report.recommendedMinSnrDb} dB · Recommended Barge-In Residual RMS: ${report.recommendedMinResidualRms.toFixed(4)}`,
  ];
  for (const line of metrics) host.append(el("div", "mono", line));
  for (const note of report.notes) host.append(el("div", "muted", note));

  host.append(
    el("div", "muted", "PipeWire WebRTC Echo-Cancel Command:"),
    el("pre", "code-box", report.pipewireAecCommand),
    el("strong", undefined, "Multilingual Wake-Word Gate & TV Rejection Checks"),
  );
  for (const chk of report.wakeChecks) {
    const row = el("div", "list-row row-between mono");
    row.append(
      el(
        "span",
        undefined,
        `"${chk.phrase}" · expect=${chk.expectedWake ? "wake" : "ignore"} · got=${chk.accepted ? "wake" : "ignore"} (SNR ${chk.snrDb.toFixed(1)} dB)`,
      ),
      el("span", `badge ${chk.passed ? "ok" : "critical"}`, chk.passed ? "PASS" : "FAIL"),
    );
    host.append(row);
  }
}

/** Renders the live-room AEC probe, PipeWire WebRTC helper, and multilingual wake calibration panel. */
export function renderWorkbenchAudioPanel(
  container: HTMLElement,
  studio: StudioToolsBridge,
  setStatus: (msg: string) => void,
): void {
  const card = el("div", "card stack");
  const head = el("div", "card-header");
  const titleWrap = el("div");
  titleWrap.append(
    el("h2", undefined, "Live-Room AEC & Wake-Word Calibration Utility"),
    el(
      "p",
      "muted",
      "Measure speaker-to-mic ERLE, calibrate NLMS barge-in thresholds, and verify EN/JA/ZH wake gating + ambient TV rejection.",
    ),
  );
  head.append(titleWrap);

  const btnRow = el("div", "btn-row");
  const liveBtn = el("button", "btn-primary", "Run Live Room Probe (Mic + Speaker)");
  liveBtn.type = "button";
  liveBtn.dataset.action = "run-live-calibration";

  const synthBtn = el("button", undefined, "Run Synthetic AEC & Wake Self-Test");
  synthBtn.type = "button";
  synthBtn.dataset.action = "run-synthetic-calibration";

  const reportHost = el("div", "stack");
  reportHost.dataset.testid = "aec-report";
  reportHost.append(
    el(
      "div",
      "muted",
      "No calibration run yet. Click Run Live Room Probe with speakers/mic active, or Run Synthetic AEC & Wake Self-Test for an isolated loopback verification.",
    ),
  );

  liveBtn.addEventListener("click", async () => {
    liveBtn.disabled = true;
    synthBtn.disabled = true;
    setStatus("Playing live calibration sweep and recording mic room response…");
    try {
      const probe = await captureLiveRoomProbe();
      const report = await studio.runRoomCalibration({
        mode: "live",
        sampleRate: probe.sampleRate,
        referenceSamples: probe.referenceSamples,
        recordedSamples: probe.recordedSamples,
      });
      renderRoomCalibrationReport(reportHost, report);
      setStatus(`Live AEC calibration complete: ERLE ${report.erleDb.toFixed(1)} dB.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      liveBtn.disabled = false;
      synthBtn.disabled = false;
    }
  });

  synthBtn.addEventListener("click", async () => {
    liveBtn.disabled = true;
    synthBtn.disabled = true;
    setStatus("Running synthetic NLMS echo cancellation & wake-word self-test…");
    try {
      const report = await studio.runRoomCalibration({ mode: "synthetic" });
      renderRoomCalibrationReport(reportHost, report);
      setStatus(
        `Synthetic AEC check complete: ERLE ${report.erleDb.toFixed(1)} dB, wake gate ${Math.round(report.wakePassRate * 100)}%.`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      liveBtn.disabled = false;
      synthBtn.disabled = false;
    }
  });

  btnRow.append(liveBtn, synthBtn);
  head.append(btnRow);
  card.append(head, reportHost);
  container.replaceChildren(card);
}

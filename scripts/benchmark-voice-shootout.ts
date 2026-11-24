/**
 * Zero-Python TTS Engine Shootout (`scripts/benchmark-voice-shootout.ts`):
 * Benchmarks cached `OnnxVoice` presets (`astra`, `bright`, `calm`) on CPU, reports
 * `ONNX_SHOOTOUT_CATALOG`, and exercises `LlamaCppSpeechBackend` + `ChatterboxNanoVoice` contracts.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ChatterboxNanoVoice, LlamaCppSpeechBackend } from "../src/core/voice/llamaSpeechBackend.ts";
import { ONNX_SHOOTOUT_CATALOG, OnnxVoice } from "../src/core/voice/onnxVoice.ts";
import { parseProsodyScript } from "../src/core/voice/speechText.ts";

const cacheDir = join(homedir(), ".local/share/ai-chan/models/speech");
const PHRASE =
  "KV cache compression calibrated and ship vitals look clear. Ready whenever you are!";

async function benchPreset(voice: string): Promise<Record<string, unknown>> {
  const backend = new OnnxVoice({ cacheDir, voice, speed: 1.0 });
  const tLoad = performance.now();
  await backend.warm();
  const loadMs = performance.now() - tLoad;
  await backend.synthesize("Warmup check.", "en");

  const t0 = performance.now();
  const out = await backend.synthesize(PHRASE, "en");
  const synthMs = performance.now() - t0;
  const audioMs = (out.samples.length / Math.max(1, out.sampleRate)) * 1000;
  await backend.dispose();

  return {
    preset: voice,
    loadMs: Number(loadMs.toFixed(1)),
    synthMs: Number(synthMs.toFixed(1)),
    audioDurationMs: Number(audioMs.toFixed(1)),
    rtf: Number((synthMs / Math.max(1, audioMs)).toFixed(3)),
  };
}

async function main(): Promise<void> {
  const presets = [await benchPreset("astra"), await benchPreset("bright")];

  // Contract verification for llama.cpp /v1/audio/speech + Chatterbox-Nano
  const prosody = parseProsodyScript("All checks passed! [pause 300ms] [emphasis] Standing by.", {
    lateNight: true,
  });
  const chatter = new ChatterboxNanoVoice({
    exaggeration: 0.6,
    runtime: {
      async synthesize() {
        return { samples: new Float32Array(1200), sampleRate: 24_000 };
      },
    },
  });
  const chAudio = await chatter.synthesize(prosody.speakText, "en");

  const llamaSpeech = new LlamaCppSpeechBackend({ endpointUrl: "http://127.0.0.1:8080" });

  console.log(
    JSON.stringify(
      {
        catalog: ONNX_SHOOTOUT_CATALOG,
        cpuPresets: presets,
        prosodyDemo: {
          speakText: prosody.speakText,
          gainScale: prosody.gainScale,
          cues: prosody.cues.length,
        },
        chatterboxNanoContractSamples: chAudio.samples.length,
        llamaCppEndpointLabel: llamaSpeech.label,
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  console.error("[benchmark-voice-shootout]", err);
  process.exit(1);
});

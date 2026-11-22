import { spawn } from "node:child_process";

/** Maximum uploaded voice clip size (2 MiB — ~64 seconds of 16 kHz mono 16-bit PCM WAV). */
export const MAX_VOICE_BYTES = 2 * 1024 * 1024;
/** Target sample rate expected by ClipTranscriber (Whisper). */
export const VOICE_SAMPLE_RATE = 16_000;
/** Maximum decoded audio length accepted for transcription (60 seconds at 16 kHz). */
export const MAX_VOICE_SAMPLES = VOICE_SAMPLE_RATE * 60;
const MIN_VOICE_SAMPLES = 800; // 50 ms at 16 kHz

const FFMPEG_MIMES = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"]);
const WAV_MIMES = new Set(["audio/wav", "audio/wave", "audio/x-wav"]);

/** Encodes 16 kHz mono float32 PCM samples (clamped to [-1, 1]) as a 16-bit RIFF/WAVE Buffer. */
export function encodeWav16kMono(samples: Float32Array): Buffer {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16); // PCM fmt chunk size
  out.writeUInt16LE(1, 20); // AudioFormat = PCM
  out.writeUInt16LE(1, 22); // NumChannels = 1
  out.writeUInt32LE(VOICE_SAMPLE_RATE, 24);
  out.writeUInt32LE(VOICE_SAMPLE_RATE * 2, 28); // ByteRate
  out.writeUInt16LE(2, 32); // BlockAlign
  out.writeUInt16LE(16, 34); // BitsPerSample
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const pcm = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, pcm)), 44 + i * 2);
  }
  return out;
}

function readSample(
  data: Buffer,
  offset: number,
  audioFormat: number,
  bitsPerSample: number,
): number {
  if (audioFormat === 3 && bitsPerSample === 32) {
    const val = data.readFloatLE(offset);
    return Number.isFinite(val) ? Math.max(-1, Math.min(1, val)) : 0;
  }
  switch (bitsPerSample) {
    case 8:
      return (data.readUInt8(offset) - 128) / 128;
    case 16:
      return data.readInt16LE(offset) / 32768;
    case 24: {
      const b0 = data.readUInt8(offset);
      const b1 = data.readUInt8(offset + 1);
      const b2 = data.readUInt8(offset + 2);
      const raw = (b2 << 16) | (b1 << 8) | b0;
      const signed = (raw & 0x800000) !== 0 ? raw | ~0xffffff : raw;
      return signed / 8388608;
    }
    case 32:
      return data.readInt32LE(offset) / 2147483648;
    default:
      return 0;
  }
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLength; i += 1) {
    const src = i * ratio;
    const i0 = Math.min(input.length - 1, Math.floor(src));
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = src - i0;
    const a = input[i0] ?? 0;
    const b = input[i1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Decodes a RIFF/WAVE buffer (PCM 8/16/24/32-bit or IEEE float32) to 16 kHz mono Float32Array. */
export function decodeWavTo16kMono(data: Buffer): Float32Array {
  if (
    data.length < 44 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Voice note is not a valid WAV recording.");
  }

  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let foundFmt = false;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = data.toString("ascii", offset, offset + 4);
    const chunkSize = data.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadAvailable = Math.min(chunkSize, data.length - payloadStart);

    if (id === "fmt " && payloadAvailable >= 16) {
      foundFmt = true;
      audioFormat = data.readUInt16LE(payloadStart);
      channels = data.readUInt16LE(payloadStart + 2);
      sampleRate = data.readUInt32LE(payloadStart + 4);
      bitsPerSample = data.readUInt16LE(payloadStart + 14);
      if (audioFormat === 0xfffe && payloadAvailable >= 40) {
        audioFormat = data.readUInt16LE(payloadStart + 24);
      }
    } else if (id === "data" && payloadAvailable > 0) {
      dataOffset = payloadStart;
      dataLength = payloadAvailable;
    }

    if (chunkSize > data.length - payloadStart) break;
    const padded = chunkSize + (chunkSize % 2);
    offset = payloadStart + padded;
  }

  if (!foundFmt || dataOffset < 0) {
    throw new Error("Voice note WAV header is missing format or audio data.");
  }
  if (channels < 1 || channels > 8) {
    throw new Error("Unsupported channel count in voice note.");
  }
  if (sampleRate < 8_000 || sampleRate > 192_000) {
    throw new Error("Unsupported sample rate in voice note.");
  }
  const supportedPcm =
    audioFormat === 1 &&
    (bitsPerSample === 8 || bitsPerSample === 16 || bitsPerSample === 24 || bitsPerSample === 32);
  const supportedFloat = audioFormat === 3 && bitsPerSample === 32;
  if (!supportedPcm && !supportedFloat) {
    throw new Error("Unsupported WAV encoding in voice note.");
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * channels;
  const numFrames = Math.floor(dataLength / frameBytes);
  const estimatedOut = Math.round((numFrames * VOICE_SAMPLE_RATE) / sampleRate);
  if (estimatedOut < MIN_VOICE_SAMPLES) {
    throw new Error("That voice note was too short to hear.");
  }
  if (estimatedOut > MAX_VOICE_SAMPLES) {
    throw new Error("That voice note is longer than the 60-second limit.");
  }

  const mono = new Float32Array(numFrames);
  for (let frame = 0; frame < numFrames; frame += 1) {
    let sum = 0;
    const frameOffset = dataOffset + frame * frameBytes;
    for (let ch = 0; ch < channels; ch += 1) {
      sum += readSample(data, frameOffset + ch * bytesPerSample, audioFormat, bitsPerSample);
    }
    mono[frame] = sum / channels;
  }

  const resampled = resampleLinear(mono, sampleRate, VOICE_SAMPLE_RATE);
  if (resampled.length < MIN_VOICE_SAMPLES) {
    throw new Error("That voice note was too short to hear.");
  }
  if (resampled.length > MAX_VOICE_SAMPLES) {
    throw new Error("That voice note is longer than the 60-second limit.");
  }
  return resampled;
}

function transcodeViaFfmpeg(data: Buffer): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-ar",
        String(VOICE_SAMPLE_RATE),
        "-ac",
        "1",
        "-f",
        "f32le",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const maxBytes = MAX_VOICE_SAMPLES * 4;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const finishError = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finishError(new Error("Voice note took too long to decode."));
    }, 15_000);

    child.on("error", (err) => {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      finishError(
        new Error(
          missing
            ? "Compressed voice clips need ffmpeg installed; send WAV audio instead."
            : "Could not start audio decoder for voice note.",
        ),
      );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finishError(new Error("That voice note is longer than the 60-second limit."));
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (code !== 0) {
        settled = true;
        reject(new Error("Could not decode that audio recording."));
        return;
      }
      const raw = Buffer.concat(chunks);
      const usableBytes = raw.length - (raw.length % 4);
      const samples = new Float32Array(usableBytes / 4);
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = raw.readFloatLE(i * 4);
      }
      if (samples.length < MIN_VOICE_SAMPLES) {
        settled = true;
        reject(new Error("That voice note was too short to hear."));
        return;
      }
      settled = true;
      resolve(samples);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(data);
  });
}

/** Validates and decodes an uploaded voice note buffer into 16 kHz mono float32 PCM samples. */
export async function decodeAudioTo16kMono(
  data: Buffer,
  contentType: string,
): Promise<Float32Array> {
  if (data.length === 0) throw new Error("Voice note was empty.");
  if (data.length > MAX_VOICE_BYTES) {
    throw new Error("Voice note exceeded the 2 MB size limit.");
  }
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const isWavBytes =
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WAVE";

  if (WAV_MIMES.has(mime) || (isWavBytes && (mime === "" || mime === "application/octet-stream"))) {
    return decodeWavTo16kMono(data);
  }
  if (FFMPEG_MIMES.has(mime)) {
    return transcodeViaFfmpeg(data);
  }
  throw new Error("Send voice notes as WAV audio (or WebM/OGG when ffmpeg is installed).");
}

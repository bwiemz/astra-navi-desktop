import { describe, expect, it } from "vitest";
import {
  decodeAudioTo16kMono,
  decodeWavTo16kMono,
  encodeWav16kMono,
  MAX_VOICE_BYTES,
  VOICE_SAMPLE_RATE,
} from "../src/core/voiceWav.ts";

describe("voiceWav", () => {
  it("round-trips 16 kHz mono PCM WAV cleanly", async () => {
    const samples = new Float32Array(VOICE_SAMPLE_RATE / 4); // 0.25s = 4000 samples
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / VOICE_SAMPLE_RATE);
    }
    const wav = encodeWav16kMono(samples);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");

    const decoded = await decodeAudioTo16kMono(wav, "audio/wav; codecs=pcm");
    expect(decoded.length).toBe(samples.length);
    for (let i = 0; i < 64; i += 1) {
      expect(decoded[i]).toBeCloseTo(samples[i] ?? 0, 3);
    }
  });

  it("downmixes 48 kHz stereo PCM WAV to 16 kHz mono", () => {
    const inRate = 48_000;
    const frames = 9_600; // 0.2s -> 3200 output samples at 16 kHz
    const dataBytes = frames * 4;
    const buf = Buffer.alloc(44 + dataBytes);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(36 + dataBytes, 4);
    buf.write("WAVEfmt ", 8, "ascii");
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(inRate, 24);
    buf.writeUInt32LE(inRate * 4, 28);
    buf.writeUInt16LE(4, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36, "ascii");
    buf.writeUInt32LE(dataBytes, 40);
    for (let f = 0; f < frames; f += 1) {
      // L=+0.8, R=0.0 -> mono average=+0.4
      buf.writeInt16LE(Math.round(0.8 * 32767), 44 + f * 4);
      buf.writeInt16LE(0, 44 + f * 4 + 2);
    }
    const mono = decodeWavTo16kMono(buf);
    expect(mono.length).toBe(3200);
    expect(mono[100]).toBeCloseTo(0.4, 2);
  });

  it("decodes 32-bit IEEE float WAV skipping JUNK chunks", () => {
    const junk = Buffer.from("ABCD", "ascii");
    const samples = 1600;
    const dataBytes = samples * 4;
    const buf = Buffer.alloc(12 + 8 + junk.length + 8 + 16 + 8 + dataBytes);
    let off = 0;
    buf.write("RIFF", off, "ascii");
    buf.writeUInt32LE(buf.length - 8, off + 4);
    buf.write("WAVE", off + 8, "ascii");
    off += 12;
    buf.write("JUNK", off, "ascii");
    buf.writeUInt32LE(junk.length, off + 4);
    junk.copy(buf, off + 8);
    off += 8 + junk.length;
    buf.write("fmt ", off, "ascii");
    buf.writeUInt32LE(16, off + 4);
    buf.writeUInt16LE(3, off + 8); // IEEE float
    buf.writeUInt16LE(1, off + 10);
    buf.writeUInt32LE(VOICE_SAMPLE_RATE, off + 12);
    buf.writeUInt32LE(VOICE_SAMPLE_RATE * 4, off + 16);
    buf.writeUInt16LE(4, off + 20);
    buf.writeUInt16LE(32, off + 22);
    off += 24;
    buf.write("data", off, "ascii");
    buf.writeUInt32LE(dataBytes, off + 4);
    for (let i = 0; i < samples; i += 1) {
      buf.writeFloatLE(-0.25, off + 8 + i * 4);
    }
    const decoded = decodeWavTo16kMono(buf);
    expect(decoded.length).toBe(samples);
    expect(decoded[50]).toBeCloseTo(-0.25, 4);
  });

  it("rejects empty, oversized, too-short, or unsupported clips", async () => {
    await expect(decodeAudioTo16kMono(Buffer.alloc(0), "audio/wav")).rejects.toThrow(/empty/i);
    await expect(
      decodeAudioTo16kMono(Buffer.alloc(MAX_VOICE_BYTES + 1), "audio/wav"),
    ).rejects.toThrow(/size limit/i);
    await expect(
      decodeAudioTo16kMono(Buffer.from("not-audio"), "text/plain"),
    ).rejects.toThrow(/WAV/i);
    // 10ms WAV is below 50ms minimum
    const tiny = encodeWav16kMono(new Float32Array(160));
    await expect(decodeAudioTo16kMono(tiny, "audio/wav")).rejects.toThrow(/too short/i);
  });
});

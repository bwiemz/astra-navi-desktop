import { readFile } from "node:fs/promises";
import { env, pipeline } from "@huggingface/transformers";
import { z } from "zod";
import { cosineSimilarity } from "./hygiene.ts";

/** Turns text into a list of numbers such that texts with similar meaning get similar lists. */
export interface Embedder {
  /** @param kind Whether the texts are things to be found ("passage") or what is being looked for ("query"). */
  embed(texts: readonly string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

export const DistilledEmbedderAdapterSchema = z.object({
  version: z.literal(1),
  dimension: z.number().int().positive(),
  scale: z.array(z.number()),
  domainCentroids: z.record(z.string(), z.array(z.number())),
});
export type DistilledEmbedderAdapter = z.infer<typeof DistilledEmbedderAdapterSchema>;

/** Builds a normalized domain-centroid adapter from teacher-verified (domain, vector) pairs. */
export function buildDistilledEmbedderAdapter(
  samples: readonly { domain: string; vector: readonly number[] }[],
): DistilledEmbedderAdapter | null {
  const first = samples.find((s) => s.vector.length > 0);
  if (!first) return null;
  const dim = first.vector.length;
  const sums = new Map<string, number[]>();
  const counts = new Map<string, number>();

  for (const sample of samples) {
    if (!sample.domain || sample.vector.length !== dim) continue;
    let acc = sums.get(sample.domain);
    if (!acc) {
      acc = new Array<number>(dim).fill(0);
      sums.set(sample.domain, acc);
    }
    for (let i = 0; i < dim; i += 1) {
      acc[i] = (acc[i] ?? 0) + (sample.vector[i] ?? 0);
    }
    counts.set(sample.domain, (counts.get(sample.domain) ?? 0) + 1);
  }
  if (sums.size === 0) return null;

  const domainCentroids: Record<string, number[]> = {};
  for (const [domain, acc] of sums.entries()) {
    const n = Math.max(1, counts.get(domain) ?? 1);
    const mean = acc.map((v) => v / n);
    const norm = Math.hypot(...mean) || 1;
    domainCentroids[domain] = mean.map((v) => Number((v / norm).toFixed(6)));
  }

  return {
    version: 1,
    dimension: dim,
    scale: new Array<number>(dim).fill(1),
    domainCentroids,
  };
}

const MODEL = "Xenova/multilingual-e5-small";

type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array }>;

/**
 * A small multilingual model (about 120 MB, runs on the processor in a few milliseconds)
 * that lets a question in one language find a note written in another, and "cut this
 * clip" find a note titled "trim a video".
 */
export class LocalEmbedder implements Embedder {
  private readonly cacheDir: string;
  private extractor: Promise<Extractor> | null = null;
  private adapter: DistilledEmbedderAdapter | null = null;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  /** Loads an optional overnight-distilled `router_adapter.json` into memory. */
  async loadDistilledAdapter(filePath: string): Promise<boolean> {
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      const parsed = DistilledEmbedderAdapterSchema.safeParse(raw);
      if (!parsed.success) return false;
      this.adapter = parsed.data;
      return true;
    } catch {
      return false;
    }
  }

  setDistilledAdapter(adapter: DistilledEmbedderAdapter | null): void {
    this.adapter = adapter;
  }

  applyAdapter(vec: Float32Array): Float32Array {
    if (!this.adapter || this.adapter.dimension !== vec.length) return vec;
    const out = new Float32Array(vec.length);
    let sq = 0;
    for (let i = 0; i < vec.length; i += 1) {
      const scaled = (vec[i] ?? 0) * (this.adapter.scale[i] ?? 1);
      out[i] = scaled;
      sq += scaled * scaled;
    }
    const norm = Math.sqrt(sq);
    if (norm > 1e-8) {
      for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) / norm;
    }
    return out;
  }

  /** Scores tool domains using distilled teacher centroids if an adapter is loaded. */
  scoreDomains(queryVec: Float32Array): Record<string, number> {
    if (!this.adapter) return {};
    const adapted = this.applyAdapter(queryVec);
    const scores: Record<string, number> = {};
    for (const [domain, centroid] of Object.entries(this.adapter.domainCentroids)) {
      if (centroid.length === adapted.length) {
        scores[domain] = cosineSimilarity(Array.from(adapted), centroid);
      }
    }
    return scores;
  }

  async embed(texts: readonly string[], kind: "query" | "passage"): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extract = await this.load();
    // This model was trained with these two prefixes and matches poorly without them.
    const output = await extract(
      texts.map((text) => `${kind}: ${text.slice(0, 1200)}`),
      { pooling: "mean", normalize: true },
    );
    const width = output.dims[1] ?? 0;
    return texts.map((_text, index) =>
      this.applyAdapter(output.data.slice(index * width, (index + 1) * width)),
    );
  }

  private load(): Promise<Extractor> {
    if (!this.extractor) {
      env.cacheDir = this.cacheDir;
      const loading = pipeline("feature-extraction", MODEL, {
        device: "cpu",
        dtype: "q8",
      }) as unknown as Promise<Extractor>;
      this.extractor = loading;
      // A failed load (no network on first use) is retried next time, not remembered.
      loading.catch(() => {
        if (this.extractor === loading) this.extractor = null;
      });
    }
    return this.extractor;
  }
}

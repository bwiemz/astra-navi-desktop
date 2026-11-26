import { pathToFileURL } from "node:url";
import { listCatalogDownloadAssets, type CatalogDownloadAsset } from "../src/core/models.ts";

export interface CatalogSizeCheckResult {
  asset: CatalogDownloadAsset;
  ok: boolean;
  actualBytes: number | null;
  status: number | null;
  diffRatio: number | null;
  error?: string;
}

export interface CheckCatalogSizesOptions {
  fetchImpl?: typeof fetch;
  /** Maximum allowed relative drift between declared `sizeBytes` and remote `Content-Length` (default 0.5%). */
  maxDiffRatio?: number;
  timeoutMs?: number;
}

function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const match = /\/(\d+)\s*$/.exec(header.trim());
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function probeRemoteSize(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; actualBytes: number | null }> {
  const headRes = await fetchImpl(url, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!headRes.ok) {
    return { status: headRes.status, actualBytes: null };
  }
  const lenHeader = headRes.headers.get("content-length");
  const headLen = lenHeader ? Number(lenHeader) : NaN;
  if (Number.isFinite(headLen) && headLen > 0) {
    return { status: headRes.status, actualBytes: headLen };
  }

  // Fallback for mirrors that omit Content-Length on HEAD: request 1 byte with Range.
  const rangeRes = await fetchImpl(url, {
    method: "GET",
    redirect: "follow",
    headers: { Range: "bytes=0-0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  await rangeRes.body?.cancel().catch(() => undefined);
  if (!rangeRes.ok && rangeRes.status !== 206) {
    return { status: rangeRes.status, actualBytes: null };
  }
  const total =
    parseContentRangeTotal(rangeRes.headers.get("content-range")) ??
    (() => {
      const len = Number(rangeRes.headers.get("content-length") ?? "");
      return Number.isFinite(len) && len > 0 ? len : null;
    })();
  return { status: rangeRes.status, actualBytes: total };
}

/**
 * Verifies every declared model and `mmproj` `sizeBytes` against the remote server's
 * actual file size so download integrity checks (`modelBundle.ts` 98% minimum) never
 * reject valid weights in production.
 */
export async function checkCatalogSizes(
  assets: readonly CatalogDownloadAsset[] = listCatalogDownloadAssets(),
  options: CheckCatalogSizesOptions = {},
): Promise<{ ok: boolean; results: CatalogSizeCheckResult[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxDiffRatio = options.maxDiffRatio ?? 0.005;
  const timeoutMs = options.timeoutMs ?? 20_000;

  const results = await Promise.all(
    assets.map(async (asset): Promise<CatalogSizeCheckResult> => {
      try {
        const { status, actualBytes } = await probeRemoteSize(asset.url, fetchImpl, timeoutMs);
        if (actualBytes === null) {
          return {
            asset,
            ok: false,
            actualBytes: null,
            status,
            diffRatio: null,
            error: `HTTP ${status} or missing Content-Length`,
          };
        }
        const diffRatio = Math.abs(actualBytes - asset.sizeBytes) / actualBytes;
        const ok = diffRatio <= maxDiffRatio;
        return {
          asset,
          ok,
          actualBytes,
          status,
          diffRatio,
          ...(ok
            ? {}
            : {
                error: `Declared ${asset.sizeBytes.toLocaleString("en-US")} bytes vs actual ${actualBytes.toLocaleString("en-US")} bytes (${(diffRatio * 100).toFixed(2)}% drift; max ${(maxDiffRatio * 100).toFixed(2)}%)`,
              }),
        };
      } catch (err) {
        return {
          asset,
          ok: false,
          actualBytes: null,
          status: null,
          diffRatio: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return { ok: results.every((r) => r.ok), results };
}

async function main(): Promise<void> {
  const assets = listCatalogDownloadAssets();
  console.log(`Checking ${assets.length} model catalog asset sizes against remote headers…`);
  const { ok, results } = await checkCatalogSizes(assets);
  for (const r of results) {
    if (r.ok) {
      console.log(
        `  OK   ${r.asset.fileName.padEnd(38)} declared=${r.asset.sizeBytes} actual=${r.actualBytes}`,
      );
    } else {
      console.error(`  FAIL ${r.asset.fileName.padEnd(38)} ${r.error ?? "unknown error"}`);
    }
  }
  if (!ok) {
    const failed = results.filter((r) => !r.ok).length;
    console.error(`\nCatalog size check failed: ${failed} of ${results.length} assets mismatched.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} catalog asset sizes verified.`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}

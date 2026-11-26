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
  /** Maximum retry attempts per asset for transient 429/5xx/network errors (default 3). */
  maxAttempts?: number;
  /** Base backoff delay between retries in ms (default 300ms). */
  retryBaseDelayMs?: number;
}

function parsePositiveHeaderInt(header: string | null): number | null {
  if (!header) return null;
  const parsed = Number(header.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const match = /\/(\d+)\s*$/.exec(header.trim());
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

async function probeRemoteSizeOnce(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; actualBytes: number | null; retryable: boolean }> {
  // First try manual-redirect HEAD so Hugging Face's `x-linked-size` header answers in 1 hop
  // without chasing CDN/LFS redirects.
  const manualRes = await fetchImpl(url, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const linkedSize = parsePositiveHeaderInt(manualRes.headers.get("x-linked-size"));
  if (linkedSize !== null && (manualRes.ok || (manualRes.status >= 300 && manualRes.status < 400))) {
    return { status: manualRes.status, actualBytes: linkedSize, retryable: false };
  }
  if (manualRes.ok) {
    const directLen = parsePositiveHeaderInt(manualRes.headers.get("content-length"));
    if (directLen !== null) {
      return { status: manualRes.status, actualBytes: directLen, retryable: false };
    }
  } else if (manualRes.status < 300 || manualRes.status >= 400) {
    return {
      status: manualRes.status,
      actualBytes: null,
      retryable: isRetryableStatus(manualRes.status),
    };
  }

  // Follow redirects for hosts that only supply Content-Length on the final target.
  const headRes = await fetchImpl(url, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!headRes.ok) {
    return {
      status: headRes.status,
      actualBytes: null,
      retryable: isRetryableStatus(headRes.status),
    };
  }
  const headLen =
    parsePositiveHeaderInt(headRes.headers.get("x-linked-size")) ??
    parsePositiveHeaderInt(headRes.headers.get("content-length"));
  if (headLen !== null) {
    return { status: headRes.status, actualBytes: headLen, retryable: false };
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
    return {
      status: rangeRes.status,
      actualBytes: null,
      retryable: isRetryableStatus(rangeRes.status),
    };
  }
  const total =
    parseContentRangeTotal(rangeRes.headers.get("content-range")) ??
    parsePositiveHeaderInt(rangeRes.headers.get("content-length"));
  return { status: rangeRes.status, actualBytes: total, retryable: total === null };
}

async function probeRemoteSize(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxAttempts: number,
  retryBaseDelayMs: number,
): Promise<{ status: number | null; actualBytes: number | null; lastError?: string }> {
  let lastStatus: number | null = null;
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await probeRemoteSizeOnce(url, fetchImpl, timeoutMs);
      lastStatus = res.status;
      if (res.actualBytes !== null || !res.retryable || attempt === maxAttempts) {
        return { status: res.status, actualBytes: res.actualBytes };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === maxAttempts) {
        return { status: lastStatus, actualBytes: null, lastError };
      }
    }
    if (retryBaseDelayMs > 0) {
      await new Promise((r) => setTimeout(r, retryBaseDelayMs * 2 ** (attempt - 1)));
    }
  }
  return { status: lastStatus, actualBytes: null, lastError };
}

/**
 * Verifies every declared model and `mmproj` `sizeBytes` against the remote server's
 * actual file size (using Hugging Face `x-linked-size` / `Content-Length` with retries)
 * so download integrity checks (`modelBundle.ts` 98% minimum) never reject valid weights.
 */
export async function checkCatalogSizes(
  assets: readonly CatalogDownloadAsset[] = listCatalogDownloadAssets(),
  options: CheckCatalogSizesOptions = {},
): Promise<{ ok: boolean; results: CatalogSizeCheckResult[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxDiffRatio = options.maxDiffRatio ?? 0.005;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 300);

  const results = await Promise.all(
    assets.map(async (asset): Promise<CatalogSizeCheckResult> => {
      const { status, actualBytes, lastError } = await probeRemoteSize(
        asset.url,
        fetchImpl,
        timeoutMs,
        maxAttempts,
        retryBaseDelayMs,
      );
      if (actualBytes === null) {
        return {
          asset,
          ok: false,
          actualBytes: null,
          status,
          diffRatio: null,
          error: lastError ?? `HTTP ${status ?? "unknown"} or missing Content-Length`,
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

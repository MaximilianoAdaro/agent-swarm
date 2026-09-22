import { readFileSync } from "node:fs";
import path from "node:path";

export interface ModelsDevCostBlock {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelsDevReasoningOption {
  type?: string;
  values?: string[];
}

export interface ModelsDevModel {
  id?: string;
  name?: string;
  cost?: ModelsDevCostBlock;
  limit?: { context?: number };
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
}

export interface ModelsDevProvider {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevCache = Record<string, ModelsDevProvider>;

export const MODELSDEV_CACHE_PATH = path.join("src", "be", "modelsdev-cache.json");

/** Parsed snapshots, keyed by the `MODELSDEV_CACHE_PATH` they were resolved from. */
const cacheByPath = new Map<string, ModelsDevCache | null>();

/**
 * Resolve the vendored models.dev cache from source checkouts and compiled
 * Docker images. The API image copies the snapshot to `/app/src/be/...`.
 *
 * This file is now fallback-only for pricing freshness: boot seeding uses it
 * when the DB is empty or models.dev is unavailable, while
 * `src/be/pricing-refresh.ts` owns live price updates. The UI model picker
 * fetches the live catalog from `GET /api/models-catalog`
 * (`src/be/models-catalog.ts`) and only falls back to its bundled copy of
 * this snapshot when that request hasn't resolved.
 *
 * Memoized per resolved `MODELSDEV_CACHE_PATH`: the snapshot is ~8 MiB of JSON
 * (~8 MiB more of retained heap once parsed) and is vendored into the image, so
 * it cannot change under a running process. `createServer()` calls
 * `seedPricingFromModelsDev()`, which calls this — and `createServer()` runs once
 * per MCP session, not once per boot, so an unmemoized read charged ~16 MiB to
 * every `initialize`. On 2026-09-22 a client that opened ~940 MCP sessions in 3
 * minutes drove the API heap from 2.3 GB to 7.2 GB and got the container
 * OOM-killed twice; this parse was the dominant term.
 * `models-catalog.ts` already memoizes its own derived slim the same way.
 */
export function loadModelsDevCache(): ModelsDevCache | null {
  const explicitPath = process.env.MODELSDEV_CACHE_PATH;
  const memoKey = explicitPath ?? "";
  const memoized = cacheByPath.get(memoKey);
  if (memoized !== undefined) return memoized;

  const candidates = [
    ...(explicitPath ? [explicitPath] : []),
    path.join(process.cwd(), MODELSDEV_CACHE_PATH),
    path.join(process.cwd(), "..", MODELSDEV_CACHE_PATH),
    path.join("/app", MODELSDEV_CACHE_PATH),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as ModelsDevCache;
      cacheByPath.set(memoKey, parsed);
      return parsed;
    } catch {
      // try next candidate
    }
  }

  // Cache the miss too: a process that cannot find the snapshot will not find it
  // on the next MCP session either, and the retry costs 4 failed reads per call.
  cacheByPath.set(memoKey, null);
  return null;
}

/** Drop the memoized snapshot. Tests that rewrite the file on disk need this. */
export function resetModelsDevCacheMemo(): void {
  cacheByPath.clear();
}

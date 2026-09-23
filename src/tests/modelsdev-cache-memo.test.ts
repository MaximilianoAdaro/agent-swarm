import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadModelsDevCache, resetModelsDevCacheMemo } from "../be/modelsdev-cache";

const originalPath = process.env.MODELSDEV_CACHE_PATH;

afterEach(() => {
  if (originalPath === undefined) delete process.env.MODELSDEV_CACHE_PATH;
  else process.env.MODELSDEV_CACHE_PATH = originalPath;
  resetModelsDevCacheMemo();
});

describe("models.dev snapshot memoization", () => {
  test("parses the snapshot once and hands back the same object", () => {
    // createServer() runs per MCP session and this parse is ~8 MiB of JSON; a
    // second parse per session is what drove the 2026-09-22 API OOM.
    resetModelsDevCacheMemo();
    const first = loadModelsDevCache();
    const second = loadModelsDevCache();

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  test("re-reads after an explicit reset", () => {
    resetModelsDevCacheMemo();
    const first = loadModelsDevCache();
    resetModelsDevCacheMemo();
    const afterReset = loadModelsDevCache();

    expect(afterReset).not.toBe(first);
    expect(afterReset).toEqual(first);
  });

  test("memoizes per MODELSDEV_CACHE_PATH so a switched path is honoured", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "modelsdev-memo-"));
    try {
      const custom = path.join(dir, "snapshot.json");
      writeFileSync(custom, JSON.stringify({ acme: { id: "acme", models: {} } }));

      resetModelsDevCacheMemo();
      const bundled = loadModelsDevCache();
      process.env.MODELSDEV_CACHE_PATH = custom;
      const overridden = loadModelsDevCache();

      expect(overridden).toEqual({ acme: { id: "acme", models: {} } });
      expect(overridden).not.toBe(bundled);
      // And the override is itself memoized.
      expect(loadModelsDevCache()).toBe(overridden);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("caches a miss so a failed lookup is not retried on every call", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "modelsdev-miss-"));
    const cwd = process.cwd();
    try {
      const target = path.join(dir, "snapshot.json");
      resetModelsDevCacheMemo();
      process.env.MODELSDEV_CACHE_PATH = target;
      // Move off the repo so the bundled fallback candidates miss too.
      process.chdir(dir);

      expect(loadModelsDevCache()).toBeNull();

      // Creating the file after the miss must not change the answer: proving the
      // null was memoized rather than re-derived from four failed reads.
      writeFileSync(target, JSON.stringify({ acme: { id: "acme", models: {} } }));
      expect(loadModelsDevCache()).toBeNull();

      resetModelsDevCacheMemo();
      expect(loadModelsDevCache()).toEqual({ acme: { id: "acme", models: {} } });
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

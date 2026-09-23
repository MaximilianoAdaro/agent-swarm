import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { rm } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";

// `createServer()` runs once per MCP session, so its boot-scale seeds are
// latched. The RBAC latch must only close on a sync that succeeded: RBAC off
// swallows a failed sync, and latching it would make a later live flip of
// RBAC_ENABLED hand out servers over a broken role catalog instead of failing
// closed. Own file: the module mock is file-wide.
const actualRbacRoles = { ...(await import("../be/rbac-roles")) };
let syncCalls = 0;
let syncFails = true;

mock.module("../be/rbac-roles", () => ({
  ...actualRbacRoles,
  ensureRbacSeedsSynced: () => {
    syncCalls++;
    if (syncFails) throw new Error("broken role catalog");
    return actualRbacRoles.ensureRbacSeedsSynced({ quiet: true });
  },
}));

const { createServer } = await import("../server");

const dbPath = "./test-server-boot-seed-latch.sqlite";
const savedRbac = process.env.RBAC_ENABLED;
const savedDbPath = process.env.DATABASE_PATH;

beforeAll(() => {
  process.env.DATABASE_PATH = dbPath;
  initDb(dbPath);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await rm(dbPath + suffix, { force: true });
  if (savedRbac === undefined) delete process.env.RBAC_ENABLED;
  else process.env.RBAC_ENABLED = savedRbac;
  if (savedDbPath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = savedDbPath;
});

test("a failed RBAC sync is retried and fails closed once RBAC is switched on", async () => {
  process.env.RBAC_ENABLED = "false";
  syncFails = true;

  // RBAC off: the failure is logged and swallowed, and the server is built.
  await createServer();
  await createServer();
  // Not latched: each session retried the sync.
  expect(syncCalls).toBe(2);

  // A live flip to RBAC on must now refuse to build a server.
  process.env.RBAC_ENABLED = "true";
  await expect(createServer()).rejects.toThrow("broken role catalog");
  expect(syncCalls).toBe(3);

  // Once the catalog syncs, the latch closes and later sessions skip it.
  syncFails = false;
  await createServer();
  expect(syncCalls).toBe(4);
  await createServer();
  expect(syncCalls).toBe(4);
});

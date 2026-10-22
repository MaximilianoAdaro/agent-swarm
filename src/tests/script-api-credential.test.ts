import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { closeDb, createAgent, initDb } from "../be/db";
import { resolveSessionToken } from "../be/users";
import { acquireScriptApiCredential } from "../scripts-runtime/loader";
import { getApiKey, setApiKey } from "../utils/api-key";

const OPERATOR_KEY = `script-api-credential-operator-${randomBytes(8).toString("hex")}`;
let agentId: string;

beforeAll(async () => {
  initDb(":memory:");
  setApiKey(OPERATOR_KEY);
  agentId = (
    await createAgent({
      name: `script-api-credential-${randomBytes(6).toString("hex")}`,
      isLead: false,
      status: "idle",
    })
  ).id;
});

afterAll(() => {
  closeDb();
});

describe("acquireScriptApiCredential", () => {
  test("hands a real agent a token scoped to that agent, not the operator key", async () => {
    const credential = await acquireScriptApiCredential(agentId);
    try {
      expect(credential.apiKey).not.toBe(getApiKey());
      const resolved = await resolveSessionToken(credential.apiKey);
      if (resolved?.kind !== "agent") throw new Error("expected an agent principal");
      expect(resolved.agentId).toBe(agentId);
    } finally {
      await credential.release();
    }
    // The token is revoked once the run releases it.
    expect(await resolveSessionToken(credential.apiKey)).toBeNull();
  });

  test("falls back to the operator key for a system run with no real agent", async () => {
    // Scheduler and workflow script runs pass sentinel ids like "schedule" /
    // "workflow" when there is no owning agent; those keep the operator key.
    const credential = await acquireScriptApiCredential("schedule");
    try {
      expect(credential.apiKey).toBe(getApiKey());
    } finally {
      await credential.release();
    }
  });
});

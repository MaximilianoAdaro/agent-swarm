import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { closeDb, createAgent, initDb } from "../be/db";
import { handleMcp } from "../http/mcp";
import { listenOnFreePort } from "./test-net";

// Covers the wiring the unit tests in mcp-session-cap.test.ts cannot see: that
// handleMcp enforces the cap on the real initialize path, after the agent is
// resolved (so it evicts the right agent's sessions) and before the new session
// is registered (so the new one is not itself a candidate for eviction).
const dbPath = "./test-mcp-session-cap-route.sqlite";
const transports: Record<string, StreamableHTTPServerTransport> = {};
const agents: Record<string, string> = {};
const activity: Record<string, number> = {};
const clients: Client[] = [];
const server = createHttpServer(async (req, res) => {
  if (await handleMcp(req, res, transports, activity, agents)) return;
  res.writeHead(404).end();
});
let url: URL;
let agentA: string;
let agentB: string;
const savedCap = process.env.MCP_MAX_SESSIONS_PER_AGENT;

beforeAll(async () => {
  process.env.MCP_MAX_SESSIONS_PER_AGENT = "2";
  initDb(dbPath);
  agentA = (await createAgent({ name: "cap-agent-a", isLead: false, status: "idle" })).id;
  agentB = (await createAgent({ name: "cap-agent-b", isLead: false, status: "idle" })).id;
  url = new URL(`http://127.0.0.1:${await listenOnFreePort(server, "127.0.0.1")}/mcp`);
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  await Promise.all(
    Object.values(transports).map((transport) => transport.close().catch(() => {})),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await rm(dbPath + suffix, { force: true });
  if (savedCap === undefined) delete process.env.MCP_MAX_SESSIONS_PER_AGENT;
  else process.env.MCP_MAX_SESSIONS_PER_AGENT = savedCap;
});

/** Connect a real MCP client and return the session id the server registered. */
async function connect(agentId: string): Promise<string> {
  const before = new Set(Object.keys(transports));
  const client = new Client({ name: "cap-test", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { "X-Agent-ID": agentId } },
    }),
  );
  const added = Object.keys(transports).filter((id) => !before.has(id));
  expect(added).toHaveLength(1);
  return added[0] as string;
}

const sessionsOf = (agentId: string) =>
  Object.keys(transports).filter((id) => agents[id] === agentId);

test("a session past the cap evicts that agent's oldest and spares other agents", async () => {
  const first = await connect(agentA);
  const second = await connect(agentA);
  const bystander = await connect(agentB);

  expect(sessionsOf(agentA).sort()).toEqual([first, second].sort());
  expect(sessionsOf(agentB)).toEqual([bystander]);

  // Third session for agent A: cap is 2, so the least-recently-used goes.
  const third = await connect(agentA);

  expect(sessionsOf(agentA).sort()).toEqual([second, third].sort());
  expect(transports[first]).toBeUndefined();
  expect(agents[first]).toBeUndefined();
  expect(activity[first]).toBeUndefined();

  // Agent B is untouched: the cap is per agent, not global.
  expect(transports[bystander]).toBeDefined();
  expect(agents[bystander]).toBe(agentB);

  // And the session that just initialized is never the one evicted.
  expect(transports[third]).toBeDefined();
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { closeDb, createAgent, initDb } from "../be/db";
import { countMcpSessionsForAgent, handleMcp, reserveMcpSessionSlot } from "../http/mcp";
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

/** Connect without asserting the session survived: eviction mid-burst is expected. */
async function connectRaw(agentId: string): Promise<void> {
  const client = new Client({ name: "cap-test", version: "1" });
  clients.push(client);
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { "X-Agent-ID": agentId } },
      }),
    );
  } catch {
    // A racing initialize may have had its transport closed by the cap.
  }
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

test("a burst of initializes leaves no reservation behind", async () => {
  const agentC = (await createAgent({ name: "cap-agent-c", isLead: false, status: "idle" })).id;

  await Promise.all(Array.from({ length: 8 }, () => connectRaw(agentC)));

  const settled = countMcpSessionsForAgent(transports, agents, agentC);
  // Every request released its slot, whether it succeeded or was evicted.
  expect(settled.pending).toBe(0);
  expect(settled.live).toBeLessThanOrEqual(Number(process.env.MCP_MAX_SESSIONS_PER_AGENT));
});

test("initialize is refused with 429 once live plus in-flight fills the cap", async () => {
  // Admission happens several awaits before onsessioninitialized registers the
  // session, so the cap has to count in-flight admissions too. Holding real
  // reservations on the handler's own registry reproduces that state without
  // depending on request interleaving, which this runtime does not exhibit.
  const agentD = (await createAgent({ name: "cap-agent-d", isLead: false, status: "idle" })).id;
  const cap = Number(process.env.MCP_MAX_SESSIONS_PER_AGENT);
  const held = Array.from(
    { length: cap },
    () => reserveMcpSessionSlot(transports, activity, agents, agentD) as () => void,
  );
  expect(held.every(Boolean)).toBe(true);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Agent-ID": agentD,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "cap-test", version: "1" },
        },
      }),
    });

    expect(res.status).toBe(429);
    expect((await res.json()).error.message).toContain(`limit ${cap}`);
    // The refusal must not itself consume a slot.
    expect(countMcpSessionsForAgent(transports, agents, agentD).pending).toBe(cap);
  } finally {
    for (const release of held) release();
  }

  expect(countMcpSessionsForAgent(transports, agents, agentD).pending).toBe(0);
});

test("an initialize hands its reservation to the live entry without double counting", async () => {
  // `onsessioninitialized` registers the session several steps before the
  // request's `finally` runs. Observe the registry at the instant of
  // registration: the agent's reservation must already be gone, or a
  // concurrent initialize would see this session as both live and pending.
  const proxied = new Proxy<Record<string, StreamableHTTPServerTransport>>(
    {},
    {
      set(target, id, value, receiver) {
        const ok = Reflect.set(target, id, value, receiver);
        seenAtRegistration.push(countMcpSessionsForAgent(receiver, proxiedAgents, agentE));
        return ok;
      },
    },
  );
  const proxiedAgents: Record<string, string> = {};
  const seenAtRegistration: ReturnType<typeof countMcpSessionsForAgent>[] = [];
  const proxiedServer = createHttpServer(async (req, res) => {
    if (await handleMcp(req, res, proxied, {}, proxiedAgents)) return;
    res.writeHead(404).end();
  });
  const agentE = (await createAgent({ name: "cap-agent-e", isLead: false, status: "idle" })).id;
  const proxiedUrl = new URL(
    `http://127.0.0.1:${await listenOnFreePort(proxiedServer, "127.0.0.1")}/mcp`,
  );
  const client = new Client({ name: "cap-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(proxiedUrl, {
        requestInit: { headers: { "X-Agent-ID": agentE } },
      }),
    );
    expect(seenAtRegistration).toHaveLength(1);
    // `sessionAgents` is written right after `transports`, so live reads 0 here;
    // what matters is that the reservation was already released.
    expect(seenAtRegistration[0]?.pending).toBe(0);
  } finally {
    await client.close().catch(() => {});
    await Promise.all(Object.values(proxied).map((t) => t.close().catch(() => {})));
    await new Promise<void>((resolve) => proxiedServer.close(() => resolve()));
  }
});

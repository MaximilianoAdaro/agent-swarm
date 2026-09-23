import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { closeDb, createAgent, initDb } from "../be/db";
import { listenOnFreePort } from "./test-net";

// The cap must not evict a session whose client is still waiting on a call:
// closing it cuts the stream the result would arrive on. That needs a tool that
// really blocks, so `createServer` is swapped for a minimal server exposing one
// gated on a promise the test controls. Own file: the module mock is file-wide.
let releaseGate: () => void = () => {};
let gate = new Promise<void>((resolve) => {
  releaseGate = resolve;
});
// Each call to the tool reports in here before it blocks, so a test can wait
// until the server is really holding the request instead of sleeping.
let onToolStarted: () => void = () => {};

mock.module("../server", () => ({
  createServer: async () => {
    const server = new McpServer({ name: "busy-test", version: "1" });
    server.registerTool("block", { description: "Waits for the test gate" }, async () => {
      onToolStarted();
      await gate;
      return { content: [{ type: "text" as const, text: "done" }] };
    });
    return server;
  },
}));

const { handleMcp } = await import("../http/mcp");

const dbPath = "./test-mcp-session-busy-route.sqlite";
const transports: Record<string, StreamableHTTPServerTransport> = {};
const agents: Record<string, string> = {};
const activity: Record<string, number> = {};
const clients: Client[] = [];
const server = createHttpServer(async (req, res) => {
  if (await handleMcp(req, res, transports, activity, agents)) return;
  res.writeHead(404).end();
});
let url: URL;
const savedCap = process.env.MCP_MAX_SESSIONS_PER_AGENT;

beforeAll(async () => {
  process.env.MCP_MAX_SESSIONS_PER_AGENT = "2";
  initDb(dbPath);
  url = new URL(`http://127.0.0.1:${await listenOnFreePort(server, "127.0.0.1")}/mcp`);
});

afterAll(async () => {
  releaseGate();
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

async function connect(agentId: string): Promise<{ client: Client; sessionId: string }> {
  const before = new Set(Object.keys(transports));
  const client = new Client({ name: "busy-test", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { "X-Agent-ID": agentId } },
    }),
  );
  const added = Object.keys(transports).filter((id) => !before.has(id));
  expect(added).toHaveLength(1);
  return { client, sessionId: added[0] as string };
}

/** Close the gate and return a promise that resolves once `count` calls are blocked on it. */
function resetGate(count: number): Promise<void> {
  gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let started = 0;
  return new Promise<void>((resolve) => {
    onToolStarted = () => {
      started++;
      if (started === count) resolve();
    };
  });
}

test("a session waiting on a tool call survives eviction and still gets its result", async () => {
  const blocked = resetGate(1);
  const agentId = (await createAgent({ name: "busy-agent-a", isLead: false, status: "idle" })).id;

  const busy = await connect(agentId);
  const pendingCall = busy.client.callTool({ name: "block", arguments: {} });
  await blocked;

  // Opened after the call started, so `busy` is this agent's least recently
  // used session: plain LRU would evict it first.
  const idle = await connect(agentId);
  const third = await connect(agentId);

  expect(transports[busy.sessionId]).toBeDefined();
  expect(transports[idle.sessionId]).toBeUndefined();
  expect(transports[third.sessionId]).toBeDefined();

  releaseGate();
  const result = await pendingCall;
  expect(result.content).toEqual([{ type: "text", text: "done" }]);
});

test("initialize is refused with 429 when every session over the cap is mid-call", async () => {
  const blocked = resetGate(2);
  const agentId = (await createAgent({ name: "busy-agent-b", isLead: false, status: "idle" })).id;

  const first = await connect(agentId);
  const second = await connect(agentId);
  const calls = [first, second].map(({ client }) =>
    client.callTool({ name: "block", arguments: {} }),
  );
  await blocked;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Agent-ID": agentId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "busy-test", version: "1" },
      },
    }),
  });

  expect(res.status).toBe(429);
  expect(transports[first.sessionId]).toBeDefined();
  expect(transports[second.sessionId]).toBeDefined();

  releaseGate();
  for (const result of await Promise.all(calls)) {
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
  }
});

import { describe, expect, test } from "bun:test";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpSessionAgents, McpTransportActivity } from "../http/mcp";
import {
  countMcpSessionsForAgent,
  DEFAULT_MCP_MAX_SESSIONS_PER_AGENT,
  DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS,
  enforceMcpSessionCapForAgent,
  reserveMcpSessionSlot,
  resolveMcpMaxSessionsPerAgent,
  resolveMcpTransportIdleTimeoutMs,
} from "../http/mcp";

function fakeTransport(onClose: () => void): StreamableHTTPServerTransport {
  return { close: onClose } as StreamableHTTPServerTransport;
}

describe("MCP per-agent session cap", () => {
  test("evicts least-recently-used sessions to make room for one more", () => {
    const closed: string[] = [];
    const transports: Record<string, StreamableHTTPServerTransport> = {
      oldest: fakeTransport(() => closed.push("oldest")),
      middle: fakeTransport(() => closed.push("middle")),
      newest: fakeTransport(() => closed.push("newest")),
    };
    const activity = { oldest: 1_000, middle: 2_000, newest: 3_000 };
    const agents = { oldest: "agent_a", middle: "agent_a", newest: "agent_a" };
    const evicted: string[] = [];

    // cap 2 with 3 live sessions: two must go so the incoming one lands at cap.
    const removed = enforceMcpSessionCapForAgent(transports, activity, agents, "agent_a", {
      cap: 2,
      onClose: (id) => evicted.push(id),
    });

    expect(removed).toBe(2);
    expect(closed).toEqual(["oldest", "middle"]);
    expect(evicted).toEqual(["oldest", "middle"]);
    expect(Object.keys(transports)).toEqual(["newest"]);
    expect(activity.oldest).toBeUndefined();
    expect(agents.middle).toBeUndefined();
    // The session the client is actually using is the one that survives.
    expect(transports.newest).toBeDefined();
  });

  test("never touches another agent's sessions", () => {
    const closed: string[] = [];
    const transports: Record<string, StreamableHTTPServerTransport> = {
      a1: fakeTransport(() => closed.push("a1")),
      b1: fakeTransport(() => closed.push("b1")),
      b2: fakeTransport(() => closed.push("b2")),
    };
    const activity = { a1: 1, b1: 2, b2: 3 };
    const agents = { a1: "agent_a", b1: "agent_b", b2: "agent_b" };

    const removed = enforceMcpSessionCapForAgent(transports, activity, agents, "agent_b", {
      cap: 2,
    });

    expect(removed).toBe(1);
    expect(closed).toEqual(["b1"]);
    expect(transports.a1).toBeDefined();
    expect(agents.a1).toBe("agent_a");
  });

  test("is a no-op below the cap", () => {
    const closed: string[] = [];
    const transports: Record<string, StreamableHTTPServerTransport> = {
      only: fakeTransport(() => closed.push("only")),
    };

    const removed = enforceMcpSessionCapForAgent(
      transports,
      { only: 1 },
      { only: "agent_a" },
      "agent_a",
      { cap: 4 },
    );

    expect(removed).toBe(0);
    expect(closed).toEqual([]);
    expect(transports.only).toBeDefined();
  });

  test("a session with no recorded activity is evicted first", () => {
    const closed: string[] = [];
    const transports: Record<string, StreamableHTTPServerTransport> = {
      untouched: fakeTransport(() => closed.push("untouched")),
      touched: fakeTransport(() => closed.push("touched")),
    };

    enforceMcpSessionCapForAgent(
      transports,
      { touched: 5_000 },
      { untouched: "agent_a", touched: "agent_a" },
      "agent_a",
      { cap: 2 },
    );

    expect(closed).toEqual(["untouched"]);
    expect(transports.touched).toBeDefined();
  });
});

describe("MCP session limit env parsing", () => {
  test("falls back to the defaults on missing or invalid values", () => {
    for (const raw of [undefined, "", "0", "-5", "abc"]) {
      expect(resolveMcpMaxSessionsPerAgent(raw)).toBe(DEFAULT_MCP_MAX_SESSIONS_PER_AGENT);
      expect(resolveMcpTransportIdleTimeoutMs(raw)).toBe(DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS);
    }
  });

  test("accepts positive values and floors fractions", () => {
    expect(resolveMcpMaxSessionsPerAgent("4")).toBe(4);
    expect(resolveMcpMaxSessionsPerAgent("4.9")).toBe(4);
    expect(resolveMcpTransportIdleTimeoutMs("900000")).toBe(900_000);
  });
});

describe("MCP admission accounts for in-flight sessions", () => {
  // A session only reaches `transports` once onsessioninitialized fires, several
  // awaits after admission. Counting live sessions alone would let concurrent
  // initializes each observe a stale count and all proceed.
  test("live + pending never exceeds the cap, with or without evictable sessions", () => {
    const transports: Record<string, StreamableHTTPServerTransport> = {};
    const activity: McpTransportActivity = {};
    const agents: McpSessionAgents = {};
    const total = () => countMcpSessionsForAgent(transports, agents, "agent_a").total;

    const first = reserveMcpSessionSlot(transports, activity, agents, "agent_a", { cap: 2 });
    expect(first).not.toBeNull();
    expect(total()).toBe(1);

    const second = reserveMcpSessionSlot(transports, activity, agents, "agent_a", { cap: 2 });
    expect(second).not.toBeNull();
    expect(total()).toBe(2);

    // Nothing is live, so there is nothing to evict: the third must be refused
    // rather than admitted past the cap.
    expect(reserveMcpSessionSlot(transports, activity, agents, "agent_a", { cap: 2 })).toBeNull();
    expect(total()).toBe(2);

    // Releasing one frees exactly one slot.
    first?.();
    expect(total()).toBe(1);
    const third = reserveMcpSessionSlot(transports, activity, agents, "agent_a", { cap: 2 });
    expect(third).not.toBeNull();
    expect(total()).toBe(2);
  });

  test("a live session is evicted before an in-flight admission is refused", () => {
    const closed: string[] = [];
    const transports: Record<string, StreamableHTTPServerTransport> = {
      live: fakeTransport(() => closed.push("live")),
    };
    const activity: McpTransportActivity = { live: 1_000 };
    const agents: McpSessionAgents = { live: "agent_a" };

    const held = reserveMcpSessionSlot(transports, activity, agents, "agent_a", { cap: 2 });
    expect(held).not.toBeNull();
    // cap 2 = 1 live + 1 pending, still room for nothing more without eviction.
    const next = reserveMcpSessionSlot(transports, activity, agents, "agent_a", { cap: 2 });
    expect(next).not.toBeNull();
    expect(closed).toEqual(["live"]);
    expect(countMcpSessionsForAgent(transports, agents, "agent_a")).toEqual({
      live: 0,
      pending: 2,
      total: 2,
    });
  });

  test("release is idempotent and scoped to its own agent", () => {
    const transports: Record<string, StreamableHTTPServerTransport> = {};
    const activity: McpTransportActivity = {};
    const agents: McpSessionAgents = {};

    const release = reserveMcpSessionSlot(transports, activity, agents, "agent_a", { cap: 2 });
    reserveMcpSessionSlot(transports, activity, agents, "agent_b", { cap: 2 });
    release?.();
    release?.();

    expect(countMcpSessionsForAgent(transports, agents, "agent_a").total).toBe(0);
    expect(countMcpSessionsForAgent(transports, agents, "agent_b").total).toBe(1);
  });

  test("pending counters are scoped to their session registry", () => {
    const registryA: Record<string, StreamableHTTPServerTransport> = {};
    const registryB: Record<string, StreamableHTTPServerTransport> = {};
    reserveMcpSessionSlot(registryA, {}, {}, "agent_a", { cap: 2 });

    expect(countMcpSessionsForAgent(registryA, {}, "agent_a").pending).toBe(1);
    expect(countMcpSessionsForAgent(registryB, {}, "agent_a").pending).toBe(0);
  });
});

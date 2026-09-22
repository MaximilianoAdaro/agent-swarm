import { describe, expect, test } from "bun:test";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  DEFAULT_MCP_MAX_SESSIONS_PER_AGENT,
  DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS,
  enforceMcpSessionCapForAgent,
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

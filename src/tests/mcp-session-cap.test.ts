import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MCP_SESSION_BOUNDS, validateConfigValue } from "../be/swarm-config-guard";
import type { McpSessionAgents, McpTransportActivity } from "../http/mcp";
import {
  countMcpSessionsForAgent,
  DEFAULT_MCP_MAX_SESSIONS_PER_AGENT,
  DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS,
  enforceMcpSessionCapForAgent,
  reserveMcpSessionSlot,
  resolveMcpMaxSessionsPerAgent,
  resolveMcpTransportIdleTimeoutMs,
  trackMcpSessionRequest,
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
    for (const raw of [undefined, "", "0", "-5", "abc", "1e3", " "]) {
      expect(resolveMcpMaxSessionsPerAgent(raw)).toBe(DEFAULT_MCP_MAX_SESSIONS_PER_AGENT);
      expect(resolveMcpTransportIdleTimeoutMs(raw)).toBe(DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS);
    }
  });

  // Flooring these used to yield 0: a cap that refuses every initialize and an
  // idle timeout that reaps every session on the next sweep.
  test("fractions fall back to the default instead of flooring to zero", () => {
    for (const raw of ["0.5", "0.999", "0.1", "4.9", "1.0"]) {
      expect(resolveMcpMaxSessionsPerAgent(raw)).toBe(DEFAULT_MCP_MAX_SESSIONS_PER_AGENT);
      expect(resolveMcpTransportIdleTimeoutMs(raw)).toBe(DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS);
    }
  });

  test("accepts whole numbers inside the bounds and nothing outside them", () => {
    const cap = MCP_SESSION_BOUNDS.MCP_MAX_SESSIONS_PER_AGENT;
    const idle = MCP_SESSION_BOUNDS.MCP_TRANSPORT_IDLE_TIMEOUT_MS;
    expect(resolveMcpMaxSessionsPerAgent("4")).toBe(4);
    expect(resolveMcpMaxSessionsPerAgent(String(cap.min))).toBe(cap.min);
    expect(resolveMcpMaxSessionsPerAgent(String(cap.max))).toBe(cap.max);
    expect(resolveMcpMaxSessionsPerAgent(String(cap.max + 1))).toBe(
      DEFAULT_MCP_MAX_SESSIONS_PER_AGENT,
    );
    expect(resolveMcpTransportIdleTimeoutMs("900000")).toBe(900_000);
    expect(resolveMcpTransportIdleTimeoutMs(String(idle.min))).toBe(idle.min);
    expect(resolveMcpTransportIdleTimeoutMs(String(idle.min - 1))).toBe(
      DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS,
    );
    expect(resolveMcpTransportIdleTimeoutMs(String(idle.max + 1))).toBe(
      DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS,
    );
  });

  // The dashboard must not save a value the runtime would quietly replace.
  test("the config API rejects exactly what the resolvers ignore", () => {
    for (const [key, { min, max }] of Object.entries(MCP_SESSION_BOUNDS)) {
      for (const bad of ["0", "-1", "0.5", "abc", String(min - 1), String(max + 1)]) {
        expect(validateConfigValue(key, bad)).not.toBeNull();
      }
      for (const good of [String(min), String(max)]) {
        expect(validateConfigValue(key, good)).toBeNull();
      }
    }
  });
});

/** A stand-in response: only the `finish` / `close` events matter here. */
function fakeResponse(): ServerResponse & EventEmitter {
  return new EventEmitter() as ServerResponse & EventEmitter;
}

describe("MCP cap never evicts a session mid-request", () => {
  test("skips a busy least-recently-used session and evicts the next idle one", () => {
    const closed: string[] = [];
    const transports: Record<string, StreamableHTTPServerTransport> = {
      busy: fakeTransport(() => closed.push("busy")),
      idle: fakeTransport(() => closed.push("idle")),
      newest: fakeTransport(() => closed.push("newest")),
    };
    const activity: McpTransportActivity = { busy: 1_000, idle: 2_000, newest: 3_000 };
    const agents: McpSessionAgents = { busy: "agent_a", idle: "agent_a", newest: "agent_a" };
    const res = fakeResponse();
    trackMcpSessionRequest(transports, activity, "busy", res);

    const removed = enforceMcpSessionCapForAgent(transports, activity, agents, "agent_a", {
      cap: 3,
    });

    expect(removed).toBe(1);
    expect(closed).toEqual(["idle"]);
    expect(transports.busy).toBeDefined();
  });

  test("refuses the new session when only busy sessions stand over the cap", () => {
    const closed: string[] = [];
    const transports: Record<string, StreamableHTTPServerTransport> = {
      s1: fakeTransport(() => closed.push("s1")),
      s2: fakeTransport(() => closed.push("s2")),
    };
    const activity: McpTransportActivity = { s1: 1_000, s2: 2_000 };
    const agents: McpSessionAgents = { s1: "agent_a", s2: "agent_a" };
    trackMcpSessionRequest(transports, activity, "s1", fakeResponse());
    trackMcpSessionRequest(transports, activity, "s2", fakeResponse());

    expect(reserveMcpSessionSlot(transports, activity, agents, "agent_a", { cap: 2 })).toBeNull();
    expect(closed).toEqual([]);
    expect(countMcpSessionsForAgent(transports, agents, "agent_a").pending).toBe(0);
  });

  test("a session is evictable again once its response settles, counted once", () => {
    const closed: string[] = [];
    const transports: Record<string, StreamableHTTPServerTransport> = {
      s1: fakeTransport(() => closed.push("s1")),
      s2: fakeTransport(() => closed.push("s2")),
    };
    const activity: McpTransportActivity = { s1: 1_000, s2: 2_000 };
    const agents: McpSessionAgents = { s1: "agent_a", s2: "agent_a" };
    const first = fakeResponse();
    const second = fakeResponse();
    trackMcpSessionRequest(transports, activity, "s1", first);
    trackMcpSessionRequest(transports, activity, "s1", second);

    // `finish` then `close` on one response must release one hold, not two.
    first.emit("finish");
    first.emit("close");
    expect(enforceMcpSessionCapForAgent(transports, activity, agents, "agent_a", { cap: 1 })).toBe(
      1,
    );
    expect(closed).toEqual(["s2"]);

    second.emit("close");
    // Settling stamps activity, so the finished session is no longer "oldest".
    expect(activity.s1).toBeGreaterThan(2_000);
    transports.s3 = fakeTransport(() => closed.push("s3"));
    agents.s3 = "agent_a";
    activity.s3 = 1;
    expect(enforceMcpSessionCapForAgent(transports, activity, agents, "agent_a", { cap: 1 })).toBe(
      2,
    );
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

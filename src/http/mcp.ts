import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { getAgentById, getResolvedConfig, getTaskById } from "@/be/db";
import { createServer } from "@/server";
import { parseEnvFlag } from "@/utils/env-flag";
import { getRequestAuth } from "@/utils/request-auth-context";
import { resolveScriptsOnlyMode } from "@/utils/scripts-only-mode";
import { parseTaskToolManifest, selectTaskTools } from "@/utils/task-tool-manifest";

export type McpTransportActivity = Record<string, number>;
export type McpSessionAgents = Record<string, string>;

export const DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Live MCP sessions one agent may hold. A well-behaved client keeps one session
 * per worker process; the cap only bites on a client that opens sessions and
 * never closes them. On 2026-09-22 one agent opened ~940 sessions in 3 minutes
 * (a paginated export that spawned a fresh MCP client per 3000-char chunk) and
 * each retained McpServer stayed resident for the full 2h idle window, which
 * OOM-killed the API container twice.
 */
export const DEFAULT_MCP_MAX_SESSIONS_PER_AGENT = 16;

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/** Read at sweep time, not module load, so a dashboard edit applies without a restart. */
export function resolveMcpTransportIdleTimeoutMs(
  raw = process.env.MCP_TRANSPORT_IDLE_TIMEOUT_MS,
): number {
  return resolvePositiveInt(raw, DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS);
}

export function resolveMcpMaxSessionsPerAgent(
  raw = process.env.MCP_MAX_SESSIONS_PER_AGENT,
): number {
  return resolvePositiveInt(raw, DEFAULT_MCP_MAX_SESSIONS_PER_AGENT);
}

/**
 * In-flight `initialize` requests per agent, keyed by the session registry that
 * owns them so each caller (the API server, each test harness) gets its own
 * counters without a signature change or cross-test leakage.
 *
 * Why this exists: a session only lands in `transports` once
 * `onsessioninitialized` fires, which is several awaits after admission
 * (`getResolvedConfig`, `createServer`). Counting live sessions alone lets N
 * concurrent initializes for one agent all observe fewer than `cap` and each
 * build an McpServer — exactly the unbounded burst the cap exists to stop.
 */
const pendingSessionsByRegistry = new WeakMap<
  Record<string, StreamableHTTPServerTransport>,
  Map<string, number>
>();

function pendingSessionsFor(
  transports: Record<string, StreamableHTTPServerTransport>,
): Map<string, number> {
  let pending = pendingSessionsByRegistry.get(transports);
  if (!pending) {
    pending = new Map();
    pendingSessionsByRegistry.set(transports, pending);
  }
  return pending;
}

/** Live sessions plus in-flight admissions for one agent. Exported for tests. */
export function countMcpSessionsForAgent(
  transports: Record<string, StreamableHTTPServerTransport>,
  sessionAgents: McpSessionAgents,
  agentId: string,
): { live: number; pending: number; total: number } {
  const live = Object.keys(transports).filter((id) => sessionAgents[id] === agentId).length;
  const pending = pendingSessionsFor(transports).get(agentId) ?? 0;
  return { live, pending, total: live + pending };
}

/**
 * Admit one new session for `agentId`, enforcing the cap across live **and**
 * in-flight sessions, and return an idempotent release for the reservation.
 *
 * Call this before the first await of the initialize path and release it once
 * the request has finished — by then the session is either registered in
 * `transports` (and counted as live) or it failed and left nothing behind.
 */
export function reserveMcpSessionSlot(
  transports: Record<string, StreamableHTTPServerTransport>,
  sessionActivity: McpTransportActivity,
  sessionAgents: McpSessionAgents,
  agentId: string,
  options: {
    cap?: number;
    now?: number;
    label?: string;
    onClose?: (id: string) => void;
  } = {},
): (() => void) | null {
  const cap = options.cap ?? resolveMcpMaxSessionsPerAgent();
  const pending = pendingSessionsFor(transports);
  const inFlight = pending.get(agentId) ?? 0;

  enforceMcpSessionCapForAgent(transports, sessionActivity, sessionAgents, agentId, {
    ...options,
    cap,
    reserved: inFlight,
  });

  // Eviction can only reclaim sessions that are already live. When in-flight
  // admissions alone fill the cap there is nothing left to shed, so admitting
  // anyway would leave live+pending above the cap and reopen the burst this
  // exists to bound. Refuse instead: the caller turns it into backpressure,
  // which is the honest signal for a client looping on initialize.
  if (countMcpSessionsForAgent(transports, sessionAgents, agentId).total >= cap) {
    return null;
  }

  pending.set(agentId, inFlight + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = pending.get(agentId) ?? 0;
    if (current <= 1) pending.delete(agentId);
    else pending.set(agentId, current - 1);
  };
}

/**
 * Close this agent's least-recently-used sessions until it can take one more
 * without exceeding the cap. Returns how many were closed.
 *
 * LRU rather than newest-first: the session a client is actively using is the
 * one it just touched, so evicting the oldest keeps a legitimate long-running
 * worker alive and sheds the abandoned ones a runaway client left behind.
 *
 * `reserved` is how many admissions for this agent are already in flight and
 * not yet in `transports`. They count against the cap, so a concurrent burst
 * cannot slip past by racing the registration.
 */
export function enforceMcpSessionCapForAgent(
  transports: Record<string, StreamableHTTPServerTransport>,
  sessionActivity: McpTransportActivity,
  sessionAgents: McpSessionAgents,
  agentId: string,
  options: {
    cap?: number;
    now?: number;
    label?: string;
    reserved?: number;
    onClose?: (id: string) => void;
  } = {},
): number {
  const cap = options.cap ?? resolveMcpMaxSessionsPerAgent();
  const now = options.now ?? Date.now();
  const reserved = options.reserved ?? 0;

  const owned = Object.keys(transports)
    .filter((id) => sessionAgents[id] === agentId)
    // Unknown activity sorts oldest: it is a session we never saw touched.
    .sort((a, b) => (sessionActivity[a] ?? 0) - (sessionActivity[b] ?? 0));

  // Leave room for the session about to be created, and for the ones already
  // admitted but not yet registered. When in-flight admissions alone fill the
  // cap this evicts every live session: the resident total is what we bound,
  // and a burst that large has no "actively used" session to protect anyway.
  const excess = owned.length - (cap - 1 - reserved);
  if (excess <= 0) return 0;

  let closed = 0;
  for (const id of owned.slice(0, excess)) {
    const transport = transports[id];
    try {
      void transport?.close();
    } catch (err) {
      console.warn(
        `[HTTP] Failed to close capped ${options.label ?? "MCP"} transport ${id}: ${err}`,
      );
    } finally {
      delete transports[id];
      delete sessionActivity[id];
      delete sessionAgents[id];
      options.onClose?.(id);
      closed++;
    }
  }

  if (closed > 0) {
    console.warn(
      `[HTTP] Agent ${agentId} exceeded the ${cap}-session ${options.label ?? "MCP"} cap; closed ${closed} least-recently-used session(s) at ${new Date(now).toISOString()}`,
    );
  }
  return closed;
}

export function markMcpTransportActivity(
  sessionActivity: McpTransportActivity,
  sessionId: string | undefined,
  now = Date.now(),
): void {
  if (sessionId) {
    sessionActivity[sessionId] = now;
  }
}

export function closeIdleMcpTransports(
  transports: Record<string, StreamableHTTPServerTransport>,
  sessionActivity: McpTransportActivity,
  options: {
    now?: number;
    idleTimeoutMs?: number;
    label?: string;
    onClose?: (id: string) => void;
  } = {},
): number {
  const now = options.now ?? Date.now();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS;
  let closed = 0;

  for (const [id, transport] of Object.entries(transports)) {
    const lastActivity = sessionActivity[id];
    if (lastActivity === undefined) {
      sessionActivity[id] = now;
      continue;
    }
    if (now - lastActivity < idleTimeoutMs) continue;

    try {
      void transport.close();
    } catch (err) {
      console.warn(`[HTTP] Failed to close idle ${options.label ?? "MCP"} transport ${id}: ${err}`);
    } finally {
      delete transports[id];
      delete sessionActivity[id];
      options.onClose?.(id);
      closed++;
    }
  }

  return closed;
}

function unauthorized(res: ServerResponse, message = "Unauthorized"): true {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
  return true;
}

function forbidden(res: ServerResponse, message: string): true {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
  return true;
}

/**
 * When a request is authenticated via an aseph_ session token (kind: "agent"),
 * the X-Agent-ID and X-Source-Task-Id headers MUST match the token's bound
 * agentId and taskId. A valid token cannot be used on behalf of a different
 * agent or task.
 */
function validateAgentTokenIdentity(req: IncomingMessage, res: ServerResponse): true | undefined {
  const auth = getRequestAuth(req);
  if (!auth || auth.kind !== "agent") return undefined;

  const agentId = headerValue(req.headers["x-agent-id"]);
  const taskId = headerValue(req.headers["x-source-task-id"]);

  if (!agentId || agentId !== auth.agentId) {
    return forbidden(res, "X-Agent-ID does not match session token");
  }
  if (!taskId || taskId !== auth.taskId) {
    return forbidden(res, "X-Source-Task-Id does not match session token");
  }
  return undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function requireKnownAgent(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<string | true> {
  const agentId = headerValue(req.headers["x-agent-id"]);
  if (!agentId) return unauthorized(res, "Missing X-Agent-ID header");
  if (!(await getAgentById(agentId))) return unauthorized(res, "Agent not found");
  return agentId;
}

function validateBoundAgent(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string | undefined,
  sessionAgents: McpSessionAgents,
): true | undefined {
  if (!sessionId) return undefined;
  const boundAgentId = sessionAgents[sessionId];
  if (!boundAgentId) return undefined;

  const agentId = headerValue(req.headers["x-agent-id"]);
  if (!agentId) {
    return unauthorized(res, "Missing X-Agent-ID header");
  }
  if (agentId !== boundAgentId) {
    return unauthorized(res, "X-Agent-ID does not match MCP session");
  }
  return undefined;
}

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Record<string, StreamableHTTPServerTransport>,
  sessionActivity: McpTransportActivity = {},
  sessionAgents: McpSessionAgents = {},
): Promise<boolean> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.url !== "/mcp") {
    return false;
  }

  const tokenIdentityMismatch = validateAgentTokenIdentity(req, res);
  if (tokenIdentityMismatch) return true;

  const agentMismatch = validateBoundAgent(req, res, sessionId, sessionAgents);
  if (agentMismatch) return true;

  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (!sessionId && body.method === "server/discover") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32601, message: "Method not found" },
          id: body.id ?? null,
        }),
      );
      return true;
    }

    let transport: StreamableHTTPServerTransport;
    // Set only on the initialize path; released once the request settles, on
    // every exit path including a throw from the awaited setup below.
    let releaseSessionSlot: (() => void) | undefined;
    try {
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
        markMcpTransportActivity(sessionActivity, sessionId);
      } else if (!sessionId && isInitializeRequest(body)) {
        const agentId = await requireKnownAgent(req, res);
        if (agentId === true) return true;

        // Bound what one agent can pin in memory. Each live session holds an
        // McpServer with the whole tool registry; the idle reaper alone only
        // reclaims them two hours later, which is far too slow for a client
        // looping on initialize. Reserve the slot BEFORE the awaited setup below
        // so concurrent initializes cannot all pass a stale live-session count.
        releaseSessionSlot =
          reserveMcpSessionSlot(transports, sessionActivity, sessionAgents, agentId) ?? undefined;
        if (!releaseSessionSlot) {
          const cap = resolveMcpMaxSessionsPerAgent();
          console.warn(
            `[HTTP] Refused MCP initialize for agent ${agentId}: ${cap} session(s) already live or in flight`,
          );
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: `Too many concurrent MCP sessions for this agent (limit ${cap}); close a session and retry`,
              },
              // Matches the sibling "Invalid session" branch below.
              id: null,
            }),
          );
          return true;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
            sessionAgents[id] = agentId;
            markMcpTransportActivity(sessionActivity, id);
          },
          onsessionclosed: (id) => {
            delete transports[id];
            delete sessionAgents[id];
            delete sessionActivity[id];
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
            delete sessionAgents[transport.sessionId];
            delete sessionActivity[transport.sessionId];
          }
        };

        const configs = await getResolvedConfig(agentId);
        const configValue = configs.find((config) => config.key === "SCRIPTS_ONLY_MCP")?.value;
        const preloadEnabled = parseEnvFlag(
          configs.find((config) => config.key === "TASK_TOOL_PRELOAD_ENABLED")?.value ??
            process.env.TASK_TOOL_PRELOAD_ENABLED,
          true,
        );
        let preloadedTools: string[] = [];
        if (preloadEnabled) {
          const taskId = headerValue(req.headers["x-source-task-id"]);
          const task = taskId ? await getTaskById(taskId) : undefined;
          // Never select a manifest using another agent's task. Session-token
          // identity is also checked above, before any MCP session is created.
          if (task?.agentId === agentId) {
            const manifestValue =
              configs.find((config) => config.key === "TASK_TOOL_MANIFESTS")?.value ??
              process.env.TASK_TOOL_MANIFESTS ??
              "{}";
            try {
              preloadedTools = selectTaskTools(parseTaskToolManifest(manifestValue), task);
            } catch {
              // An invalid deployment value must not prevent tool discovery.
              // Avoid logging its contents, which may contain misfiled secrets.
              console.warn("[MCP] Invalid TASK_TOOL_MANIFESTS; using ordinary tool discovery");
            }
          }
        }
        const server = await createServer({
          preloadedTools,
          scriptsOnly: resolveScriptsOnlyMode({
            env: process.env.SCRIPTS_ONLY_MCP,
            configValue,
          }),
        });
        await server.connect(transport);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Invalid session" },
            id: null,
          }),
        );
        return true;
      }

      await transport.handleRequest(req, res, body);
      markMcpTransportActivity(sessionActivity, transport.sessionId);
      return true;
    } finally {
      // By the time we get here the session is either registered in
      // `transports` (counted as live from now on) or setup failed and left
      // nothing behind, so the reservation must go either way.
      releaseSessionSlot?.();
    }
  }

  if (req.method === "GET" || req.method === "DELETE") {
    if (sessionId && transports[sessionId]) {
      markMcpTransportActivity(sessionActivity, sessionId);
      await transports[sessionId].handleRequest(req, res);
      return true;
    }
    res.writeHead(400);
    res.end("Invalid session");
    return true;
  }

  res.writeHead(405);
  res.end("Method not allowed");
  return true;
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json";
import { initDb } from "./be/db";
import { startPricingRefreshLoop } from "./be/pricing-refresh";
import { ensureRbacSeedsSynced } from "./be/rbac-roles";
import { seedPricingFromModelsDev } from "./be/seed-pricing";
import { isSteeringEnabled } from "./be/steering";
import { registerGithubTaskReactions } from "./github/task-reactions";
import { loadGlobalConfigsIntoEnv } from "./http/core";
import { resolveTemplate } from "./prompts/resolver";
import { isRbacEnabled } from "./rbac";
import { getSlackConfiguration } from "./slack/config";
import { registerAcceptSteerTool } from "./tools/accept-steer";
import { registerAppDiffTool } from "./tools/app-diff";
import { registerAppGetTool } from "./tools/app-get";
import { registerAppHistoryTool } from "./tools/app-history";
import { registerAppListTool } from "./tools/app-list";
import { registerAppPatchTool } from "./tools/app-patch";
import { registerAppQueryTool } from "./tools/app-query";
import { registerAppRollbackTool } from "./tools/app-rollback";
import { registerAppSyncTool } from "./tools/app-sync";
import { registerAppUpsertTool } from "./tools/app-upsert";
import { registerCancelTaskTool } from "./tools/cancel-task";
import { registerContextDiffTool } from "./tools/context-diff";
import { registerContextHistoryTool } from "./tools/context-history";
import { registerCreateChannelTool } from "./tools/create-channel";
import { registerCreateMetricTool } from "./tools/create-metric";
import { registerCreatePageTool } from "./tools/create-page";
import { registerCredentialBindingsTool } from "./tools/credential-bindings";
import { registerDbQueryTool } from "./tools/db-query";
import { registerDeferTaskTool } from "./tools/defer-task";
import { registerDeleteChannelTool } from "./tools/delete-channel";
import { registerDeletePageTool } from "./tools/delete-page";
import { registerExtensionActivateVersionTool } from "./tools/extension-activate-version";
import { registerExtensionDeleteTool } from "./tools/extension-delete";
import { registerExtensionDisableTool } from "./tools/extension-disable";
import { registerExtensionEnableTool } from "./tools/extension-enable";
import { registerExtensionInstallTool } from "./tools/extension-install";
import { registerExtensionListTool } from "./tools/extension-list";
import { registerGetMetricsTool } from "./tools/get-metrics";
import { registerGetSwarmTool } from "./tools/get-swarm";
import { registerGetTaskDetailsTool } from "./tools/get-task-details";
import { registerGetTasksTool } from "./tools/get-tasks";
import { registerInjectLearningTool } from "./tools/inject-learning";
import { registerJoinSwarmTool } from "./tools/join-swarm";
// KV capability
import {
  registerKvDeleteTool,
  registerKvGetTool,
  registerKvIncrTool,
  registerKvListTool,
  registerKvSetTool,
} from "./tools/kv";
// Messaging capability
import { registerListChannelsTool } from "./tools/list-channels";
import { registerListServicesTool } from "./tools/list-services";
import { registerManageUserTool } from "./tools/manage-user";
// MCP Servers capability
import {
  registerMcpServerCreateTool,
  registerMcpServerDeleteTool,
  registerMcpServerGetTool,
  registerMcpServerInstallTool,
  registerMcpServerListTool,
  registerMcpServerUninstallTool,
  registerMcpServerUpdateTool,
} from "./tools/mcp-servers";
// Memory capability
import { registerMemoryDeleteTool } from "./tools/memory-delete";
import { registerMemoryEditTool } from "./tools/memory-edit";
import { registerMemoryGetTool } from "./tools/memory-get";
import { registerMemoryRateTool } from "./tools/memory-rate";
import { registerMemorySearchTool } from "./tools/memory-search";
import { registerMemoryStoreTool } from "./tools/memory-store";
import { registerMyAgentInfoTool } from "./tools/my-agent-info";
import { registerGetOauthAccessTokenTool } from "./tools/oauth-access-token";
import { registerPollTaskTool } from "./tools/poll-task";
import { registerPostMessageTool } from "./tools/post-message";
// Prompt template tools
import {
  registerDeletePromptTemplateTool,
  registerGetPromptTemplateTool,
  registerListPromptTemplatesTool,
  registerPreviewPromptTemplateTool,
  registerSetPromptTemplateTool,
} from "./tools/prompt-templates";
import { registerReadMessagesTool } from "./tools/read-messages";
import { registerRegisterAgentmailInboxTool } from "./tools/register-agentmail-inbox";
import {
  registerRegisterKapsoNumberTool,
  registerUnregisterKapsoNumberTool,
} from "./tools/register-kapso-number";
// Services capability
import { registerRegisterServiceTool } from "./tools/register-service";
// Repo management tools
import { registerGetReposTool, registerUpdateRepoTool } from "./tools/repos";
import { registerRequestHumanInputTool } from "./tools/request-human-input";
import { registerResolveUserTool } from "./tools/resolve-user";
import {
  registerRoomChangeTool,
  registerRoomDecodeTool,
  registerRoomGetTool,
  registerRoomResetTool,
} from "./tools/rooms";
// Scheduling capability
import {
  registerCreateScheduleTool,
  registerDeleteScheduleTool,
  registerListSchedulesTool,
  registerPatchScheduleTool,
  registerRunScheduleNowTool,
  registerUpdateScheduleTool,
} from "./tools/schedules";
import { registerScriptApisTool } from "./tools/script-apis";
import { registerScriptConnectionsTool } from "./tools/script-connections";
import { registerScriptDeleteTool } from "./tools/script-delete";
import { registerScriptQueryTypesTool } from "./tools/script-query-types";
import { registerScriptRunTool } from "./tools/script-run";
import { registerScriptRunsTools } from "./tools/script-runs";
import { registerScriptSearchTool } from "./tools/script-search";
import { registerScriptUpsertTool } from "./tools/script-upsert";
import { registerSendTaskTool } from "./tools/send-task";
// Skills capability
import {
  registerSkillCreateTool,
  registerSkillDeleteTool,
  registerSkillGetFileTool,
  registerSkillGetTool,
  registerSkillInstallRemoteTool,
  registerSkillInstallTool,
  registerSkillListTool,
  registerSkillPublishTool,
  registerSkillSearchTool,
  registerSkillSyncRemoteTool,
  registerSkillUninstallTool,
  registerSkillUpdateTool,
} from "./tools/skills";
import { registerSlackArchiveChannelTool } from "./tools/slack-archive-channel";
import { registerSlackCreateChannelTool } from "./tools/slack-create-channel";
import { registerSlackDeleteTool } from "./tools/slack-delete";
import { registerSlackDownloadFileTool } from "./tools/slack-download-file";
import { registerSlackInviteToChannelTool } from "./tools/slack-invite-to-channel";
import { registerSlackListChannelsTool } from "./tools/slack-list-channels";
import { registerSlackPostTool } from "./tools/slack-post";
import { registerSlackReadTool } from "./tools/slack-read";
import { registerSlackReplyTool } from "./tools/slack-reply";
import { registerSlackStartThreadTool } from "./tools/slack-start-thread";
import { registerSlackUpdateTool } from "./tools/slack-update";
import { registerSlackUploadFileTool } from "./tools/slack-upload-file";
import { registerSteerTaskTool } from "./tools/steer-task";
import { registerStoreProgressTool } from "./tools/store-progress";
// Swarm config tools
import {
  registerDeleteConfigTool,
  registerGetConfigTool,
  registerListConfigTool,
  registerSetConfigTool,
} from "./tools/swarm-config";
import { registerSwarmXTool } from "./tools/swarm-x";
// Task pool capability
import { registerTaskActionTool } from "./tools/task-action";
// Tracker capability
import {
  registerTrackerLinkTaskTool,
  registerTrackerMapAgentTool,
  registerTrackerStatusTool,
  registerTrackerSyncStatusTool,
  registerTrackerUnlinkTool,
} from "./tools/tracker";
import { registerUnregisterServiceTool } from "./tools/unregister-service";
// Profiles capability
import { registerUpdateProfileTool } from "./tools/update-profile";
import { registerUpdateServiceStatusTool } from "./tools/update-service-status";
import { setPreloadedTools } from "./tools/utils";
import {
  registerReplyWhatsappMessageTool,
  registerSendWhatsappMessageTool,
} from "./tools/whatsapp-message";
// Workflows capability
import {
  registerCancelWorkflowRunTool,
  registerCreateWorkflowTool,
  registerDeleteWorkflowTool,
  registerGetWorkflowRunTool,
  registerGetWorkflowTool,
  registerListWorkflowRunsTool,
  registerListWorkflowsTool,
  registerPatchWorkflowNodeTool,
  registerPatchWorkflowTool,
  registerRetryWorkflowRunTool,
  registerTriggerWorkflowTool,
  registerUpdateWorkflowTool,
} from "./tools/workflows";
import { resolveScriptsOnlyMode } from "./utils/scripts-only-mode";

// Every known capability, including the ones disabled by default. Exported for
// surfaces that must see the full tool registry regardless of deployment
// defaults (tests, drift checks).
export const ALL_CAPABILITIES = [
  "core",
  "task-pool",
  "scripts",
  "config",
  "prompt-templates",
  "mcp",
  "profiles",
  "services",
  "scheduling",
  "memory",
  "workflows",
  "pages",
  "metrics",
  "kv",
  "slack",
  "tracker",
  "skills",
  "messaging",
  "repo",
  "agentmail",
  "kapso",
  "swarm-x",
] as const;

type CAPABILITIES_T = (typeof ALL_CAPABILITIES)[number];

// Capability-based feature flags
const DEFAULT_CAPABILITIES: string = [
  "core",
  "task-pool",
  "scripts",
  "config",
  "mcp",
  "profiles",
  "scheduling",
  "memory",
  "workflows",
  "pages",
  "metrics",
  "kv",
  "slack",
  "tracker",
  "skills",
  "repo",
  //
  // Disabled by default
  //
  // "services",
  // "prompt-templates",
  // "messaging",
  // "swarm-x",
  // "agentmail",
  // "kapso",
].join(",");

// Note: unknown names are kept (they never match hasCapability); workers
// reuse this env var for free-form skill tags, so dropping them here would
// break agent capability declarations. Empty entries (trailing commas) are
// filtered so they can't leak into enabledCapabilities payloads.
const getCapabilities = (): Set<CAPABILITIES_T> =>
  new Set(
    (process.env.CAPABILITIES || DEFAULT_CAPABILITIES)
      .split(",")
      .map((s) => s.trim() as CAPABILITIES_T)
      .filter((s) => s.length > 0),
  );

export function hasCapability(cap: CAPABILITIES_T): boolean {
  return getCapabilities().has(cap);
}

export function getEnabledCapabilities(): CAPABILITIES_T[] {
  const capabilities = Array.from(getCapabilities());
  // Phase 1 has no HTTP receiver. Do not advertise usable Slack tools to
  // workers when HTTP (or an invalid transport) was selected.
  return getSlackConfiguration().mode === "socket"
    ? capabilities
    : capabilities.filter((capability) => capability !== "slack");
}

/**
 * Experimental "code-mode" surface: when SCRIPTS_ONLY_MCP=true, the externally
 * exposed MCP server registers ONLY the reusable-script tools. Agents perform
 * every other swarm operation (task lifecycle, messaging, memory, kv, …) from
 * inside scripts via the SDK bridge (src/http/mcp-bridge.ts), which builds its
 * own full-surface server instance and is NOT affected by this flag.
 */
export function isScriptsOnlyMcp(): boolean {
  return resolveScriptsOnlyMode({ env: process.env.SCRIPTS_ONLY_MCP });
}

/**
 * One-shot latches for the boot-scale seeding inside `createServer()`. `initDb()`
 * already self-guards and `startPricingRefreshLoop()` /
 * `registerGithubTaskReactions()` use the same pattern; the pricing and RBAC
 * seeds were the two that still re-ran on every MCP session.
 *
 * `createServer()` is not the only seeding path: the HTTP server seeds both at
 * boot in `src/http/index.ts`, so an API process does one redundant seed on its
 * first MCP session and none after. The stdio transport (`src/stdio.ts`) has no
 * other path, which is why the calls stay here rather than moving to boot.
 *
 * Keyed to the process, not to the DB handle: a test that swaps the DB
 * in-process (`globalThis.__testMigrationTemplate`) and calls `createServer()`
 * again would get an unseeded DB. Reset the latches if you ever need that.
 */
let pricingSeedApplied = false;
/**
 * Separate from the pricing latch and set only after a sync that SUCCEEDED.
 * With RBAC off a failed sync is logged and swallowed; latching it anyway would
 * make every later `createServer()` skip the sync, so flipping the live-reloadable
 * `RBAC_ENABLED` on afterwards would hand out servers over a broken role catalog
 * instead of failing closed. The cost: RBAC off plus a broken catalog retries the
 * sync on every session, which is what every session did before the latch.
 */
let rbacSeedsSynced = false;

export async function createServer(
  opts: { scriptsOnly?: boolean; fullSurface?: boolean; preloadedTools?: readonly string[] } = {},
) {
  // Reload env
  await loadGlobalConfigsIntoEnv(true);

  // Capability flags shape the externally exposed MCP tool list only. Internal
  // full-surface consumers (the scripts SDK bridge, drift-check tests) pass
  // fullSurface to register every tool group regardless of CAPABILITIES.
  // This shadows the module-level hasCapability for the registrations below.
  const hasCapability = (cap: CAPABILITIES_T): boolean =>
    opts.fullSurface === true || getCapabilities().has(cap);

  // Initialize database with WAL mode
  // Uses DATABASE_PATH env var for Docker volume compatibility (WAL needs .sqlite, .sqlite-wal, .sqlite-shm on same filesystem)
  initDb(process.env.DATABASE_PATH);

  // Phase 2: project the vendored models.dev snapshot into the pricing table.
  // Idempotent (INSERT OR IGNORE keyed on PK with effective_from=0). Guarded to
  // run once per process, like startPricingRefreshLoop below: createServer()
  // runs once per MCP session, not once per boot, and this is boot-scale work —
  // an 8 MiB snapshot parse plus a 3121-statement BEGIN IMMEDIATE transaction.
  // Repeating it per session bought nothing ("0 new row(s)" every time) and on
  // 2026-09-22 it drove both the heap blowup and ~5 write-lock acquisitions/s
  // under a client that opened ~940 sessions in 3 minutes.
  // startPricingRefreshLoop() owns live price updates from here on.
  // See src/be/seed-pricing.ts for the projection logic and the manual-override
  // constants for runtime-fee / ACU pricing.
  if (!pricingSeedApplied) {
    seedPricingFromModelsDev();
    pricingSeedApplied = true;
  }
  startPricingRefreshLoop();

  // Same reasoning: boot-scale, idempotent, and re-run per MCP session before.
  // Fail-closed is preserved: the latch is set only on success, so a failed sync
  // is retried by the next call whether or not RBAC was on when it failed.
  if (!rbacSeedsSynced) {
    try {
      ensureRbacSeedsSynced();
      rbacSeedsSynced = true;
    } catch (err) {
      console.error("[startup] Failed to sync RBAC seed rows:", err);
      // RBAC flag-on must fail closed; flag-off deployments should not be bricked
      // by role-catalog drift for a disabled security feature.
      if (isRbacEnabled()) throw err;
    }
  }

  // Subscribe API-side integrations to task-lifecycle events. Idempotent.
  // (Inverts the old be/db → github/task-reactions import; see cycle-break #4.)
  registerGithubTaskReactions();

  const server = new McpServer(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
    },
    {
      ...(opts.preloadedTools?.length
        ? { instructions: resolveTemplate("system.agent.tool_preload", {}).text }
        : {}),
      capabilities: {
        logging: {},
      },
    },
  );

  if (opts.preloadedTools?.length) setPreloadedTools(server, opts.preloadedTools);

  // Scripts-only surface (experimental code-mode): register just the script
  // catalog tools and stop. script-connections / script-apis stay out — they
  // are lead-only security admin and excluded from the scripts SDK too.
  if (opts.scriptsOnly ?? isScriptsOnlyMcp()) {
    registerScriptSearchTool(server);
    registerScriptRunTool(server);
    registerScriptUpsertTool(server);
    registerExtensionDeleteTool(server);
    registerExtensionEnableTool(server);
    registerExtensionDisableTool(server);
    registerExtensionActivateVersionTool(server);
    registerExtensionInstallTool(server);
    registerExtensionListTool(server);
    registerScriptDeleteTool(server);
    registerScriptQueryTypesTool(server);
    registerScriptRunsTools(server);

    return server;
  }

  // Start of default-enabled capabilities

  // Core capability - swarm membership, task flow, progress, user identity, and lead debug tools
  if (hasCapability("core")) {
    registerJoinSwarmTool(server);
    registerPollTaskTool(server);
    registerGetSwarmTool(server);
    registerGetTasksTool(server);
    registerGetMetricsTool(server);
    registerSendTaskTool(server);
    registerGetTaskDetailsTool(server);
    registerStoreProgressTool(server);
    registerMyAgentInfoTool(server);
    registerCancelTaskTool(server);

    // User identity tools
    registerResolveUserTool(server);
    registerManageUserTool(server); // self-guards with lead check

    // Debug tools (self-guard with lead check)
    registerDbQueryTool(server);
    registerGetOauthAccessTokenTool(server);

    // Steering acknowledgement must ship with core: steering delivery works on
    // directly-assigned tasks (no task-pool capability required), and without
    // accept-steer every delivered message would be stuck at `delivered`.
    if (isSteeringEnabled()) {
      registerAcceptSteerTool(server);
      registerSteerTaskTool(server);
    }
  }

  // Task pool capability - task pool operations (create unassigned, claim, release, accept, reject)
  if (hasCapability("task-pool")) {
    registerTaskActionTool(server);
  }

  // Config capability - swarm config management and credential bindings
  if (hasCapability("config")) {
    registerSetConfigTool(server);
    registerGetConfigTool(server);
    registerListConfigTool(server);
    registerDeleteConfigTool(server);
    registerCredentialBindingsTool(server);
  }

  // Scripts capability - reusable script catalog (HTTP MCP only in v1)
  if (hasCapability("scripts")) {
    registerScriptSearchTool(server);
    registerScriptConnectionsTool(server);
    registerScriptApisTool(server);
    registerScriptRunTool(server);
    registerScriptUpsertTool(server);
    registerExtensionDeleteTool(server);
    registerExtensionEnableTool(server);
    registerExtensionDisableTool(server);
    registerExtensionActivateVersionTool(server);
    registerExtensionInstallTool(server);
    registerExtensionListTool(server);
    registerScriptDeleteTool(server);
    registerScriptQueryTypesTool(server);
    registerScriptRunsTools(server);
  }

  // MCP capability - managed MCP server registry (CRUD + install/uninstall)
  if (hasCapability("mcp")) {
    registerMcpServerCreateTool(server);
    registerMcpServerUpdateTool(server);
    registerMcpServerDeleteTool(server);
    registerMcpServerGetTool(server);
    registerMcpServerListTool(server);
    registerMcpServerInstallTool(server);
    registerMcpServerUninstallTool(server);
  }

  // Profiles capability - agent profile management
  if (hasCapability("profiles")) {
    registerUpdateProfileTool(server);
    registerContextHistoryTool(server);
    registerContextDiffTool(server);
  }

  // Repo capability - repository configuration management
  if (hasCapability("repo")) {
    registerGetReposTool(server);
    registerUpdateRepoTool(server);
  }

  // Scheduling capability - scheduled task management
  if (hasCapability("scheduling")) {
    registerListSchedulesTool(server);
    registerCreateScheduleTool(server);
    registerDeferTaskTool(server);
    registerUpdateScheduleTool(server);
    registerPatchScheduleTool(server);
    registerDeleteScheduleTool(server);
    registerRunScheduleNowTool(server);
  }

  // Memory capability - persistent memory with vector search
  if (hasCapability("memory")) {
    registerMemorySearchTool(server);
    registerMemoryStoreTool(server);
    registerMemoryGetTool(server);
    registerMemoryEditTool(server);
    registerMemoryDeleteTool(server);
    registerMemoryRateTool(server);
    registerInjectLearningTool(server);
  }

  // Tracker capability - external issue tracker integration
  if (hasCapability("tracker")) {
    registerTrackerStatusTool(server);
    registerTrackerLinkTaskTool(server);
    registerTrackerUnlinkTool(server);
    registerTrackerSyncStatusTool(server);
    registerTrackerMapAgentTool(server);
  }

  // Workflows capability - DAG-based automation workflows
  if (hasCapability("workflows")) {
    registerCreateWorkflowTool(server);
    registerListWorkflowsTool(server);
    registerGetWorkflowTool(server);
    registerUpdateWorkflowTool(server);
    registerPatchWorkflowTool(server);
    registerPatchWorkflowNodeTool(server);
    registerDeleteWorkflowTool(server);
    registerTriggerWorkflowTool(server);
    registerListWorkflowRunsTool(server);
    registerGetWorkflowRunTool(server);
    registerRetryWorkflowRunTool(server);
    registerCancelWorkflowRunTool(server);
    registerRequestHumanInputTool(server);
  }

  // Skills capability - installable skill packages (create, search, install, publish)
  if (hasCapability("skills")) {
    registerSkillCreateTool(server);
    registerSkillUpdateTool(server);
    registerSkillDeleteTool(server);
    registerSkillGetTool(server);
    registerSkillGetFileTool(server);
    registerSkillListTool(server);
    registerSkillSearchTool(server);
    registerSkillInstallTool(server);
    registerSkillUninstallTool(server);
    registerSkillInstallRemoteTool(server);
    registerSkillSyncRemoteTool(server);
    registerSkillPublishTool(server);
  }

  // Pages capability - DB-backed lightweight artifacts (HTML / JSON specs).
  if (hasCapability("pages")) {
    registerAppGetTool(server);
    registerAppHistoryTool(server);
    registerAppDiffTool(server);
    registerAppListTool(server);
    registerAppPatchTool(server);
    registerAppQueryTool(server);
    registerAppRollbackTool(server);
    registerAppSyncTool(server);
    registerAppUpsertTool(server);
    registerCreatePageTool(server);
    registerDeletePageTool(server);
  }

  // Metrics capability - time-series metrics (DB-backed, for dashboards).
  if (hasCapability("metrics")) {
    registerCreateMetricTool(server);
  }

  // KV capability — namespaced Redis-like key/value (see src/be/migrations/061_kv_store.sql).
  if (hasCapability("kv")) {
    registerKvGetTool(server);
    registerKvSetTool(server);
    registerKvDeleteTool(server);
    registerKvIncrTool(server);
    registerKvListTool(server);
    registerRoomGetTool(server);
    registerRoomChangeTool(server);
    registerRoomResetTool(server);
    registerRoomDecodeTool(server);
  }

  // Slack capability - Slack integration tools (no-op if Slack is not configured)
  if (hasCapability("slack")) {
    registerSlackReplyTool(server);
    registerSlackReadTool(server);
    registerSlackPostTool(server);
    registerSlackStartThreadTool(server);
    registerSlackCreateChannelTool(server);
    registerSlackInviteToChannelTool(server);
    registerSlackArchiveChannelTool(server);
    registerSlackListChannelsTool(server);
    registerSlackUploadFileTool(server);
    registerSlackDownloadFileTool(server);
    registerSlackDeleteTool(server);
    registerSlackUpdateTool(server);
  }

  // End of default-enabled capabilities
  // ----------------------------
  // Start of default-disabled capabilities

  // Prompt-templates capability - prompt template management (list/get/set/delete/preview)
  if (hasCapability("prompt-templates")) {
    registerListPromptTemplatesTool(server);
    registerGetPromptTemplateTool(server);
    registerSetPromptTemplateTool(server);
    registerDeletePromptTemplateTool(server);
    registerPreviewPromptTemplateTool(server);
  }

  // Agentmail capability - AgentMail integration (self-service inbox mapping)
  if (hasCapability("agentmail")) {
    registerRegisterAgentmailInboxTool(server);
  }

  // Kapso capability - Kapso/WhatsApp integration (native inbound provisioning + outbound)
  if (hasCapability("kapso")) {
    registerRegisterKapsoNumberTool(server);
    registerUnregisterKapsoNumberTool(server);
    registerSendWhatsappMessageTool(server);
    registerReplyWhatsappMessageTool(server);
  }

  // Swarm-x capability - external command routes mirroring the `agent-swarm x ...` CLI surface
  if (hasCapability("swarm-x")) {
    registerSwarmXTool(server);
  }

  // Messaging capability - internal swarm chat (post/read messages, channel CRUD)
  if (hasCapability("messaging")) {
    registerPostMessageTool(server);
    registerReadMessagesTool(server);

    // Channel management (CRUD on channels)
    registerListChannelsTool(server);
    registerCreateChannelTool(server);
    registerDeleteChannelTool(server);
  }

  // Services capability - PM2/background service registry
  if (hasCapability("services")) {
    registerRegisterServiceTool(server);
    registerUnregisterServiceTool(server);
    registerListServicesTool(server);
    registerUpdateServiceStatusTool(server);
  }

  return server;
}

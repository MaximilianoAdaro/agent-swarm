/**
 * Files a user shares with the bot on Slack, turned into task attachments.
 *
 * The API downloads each file with the bot token, stores it through the active
 * file provider and records a `task_attachments` row, so the worker gets the
 * same fetch recipe as a file uploaded from the UI. The task is created in
 * `draft` while that happens (#1240): nobody can claim it before its
 * attachments exist. Every file also stays in the task text as a
 * `[File: …]` line, and a file that could not be attached is flagged there
 * and in a thread reply — never dropped silently.
 */
import type { WebClient } from "@slack/web-api";
import { promoteDraftTask } from "../be/db";
import { MAX_TASK_ATTACHMENT_BYTES, recordTaskAttachmentUpload } from "../be/task-attachment-store";
import { getFileStorageProvider } from "../fs/registry";
import { resolveTemplate } from "../prompts/resolver";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import type { AgentTask, CreateTaskOptions } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getFileInfo, type SlackFile } from "./files";
// Side-effect import: registers all Slack event templates in the in-memory registry
import "./templates";

const DOWNLOAD_TIMEOUT_MS = 30_000;
const ATTACHMENT_INTENT = "user-upload";

export type SlackFileFailure = { file: SlackFile; reason: string };

export type InboundSlackFiles = {
  /** Every file on the message, with full metadata (resolved via `files.info` when the event omitted it). */
  files: SlackFile[];
  fetched: Array<{ file: SlackFile; body: Uint8Array }>;
  failed: SlackFileFailure[];
};

const NO_INBOUND_FILES: InboundSlackFiles = { files: [], fetched: [], failed: [] };

/**
 * Format a file size in bytes to a human-readable string.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Build a text representation of file attachments for inclusion in messages.
 * Each file is formatted as: [File: filename.ext (mimetype, size) id=FILE_ID],
 * followed by `(not attached: <reason>)` when the file never made it into the
 * task's attachments.
 */
export function buildAttachmentText(files: SlackFile[], failed: SlackFileFailure[] = []): string {
  const reasons = new Map(failed.map((f) => [f.file.id, f.reason]));
  return files
    .map((f) => {
      const line = `[File: ${f.name} (${f.mimetype}, ${formatFileSize(f.size)}) id=${f.id}]`;
      const reason = reasons.get(f.id);
      return reason ? `${line} (not attached: ${reason})` : line;
    })
    .join("\n");
}

/**
 * Build the effective message text from the original text and any file attachments.
 * - Text only: returns the text as-is
 * - Files only: returns the attachment metadata
 * - Both: returns text followed by attachment metadata
 */
export function buildEffectiveText(
  text: string | undefined,
  files?: SlackFile[],
  failed?: SlackFileFailure[],
): string {
  const hasText = !!text?.trim();
  const hasFiles = files && files.length > 0;

  if (hasText && hasFiles) {
    return `${text}\n\n${buildAttachmentText(files, failed)}`;
  }
  if (hasFiles) {
    return buildAttachmentText(files, failed);
  }
  return text || "";
}

/**
 * Download every file on a Slack message with the bot token. Never throws: a
 * file that can't be fetched lands in `failed` with a reason the user and the
 * agent can read.
 */
export async function fetchSlackFiles(
  client: WebClient,
  files: SlackFile[] | undefined,
  token: string | undefined = client.token ?? process.env.SLACK_BOT_TOKEN,
): Promise<InboundSlackFiles> {
  if (!files || files.length === 0) return NO_INBOUND_FILES;

  const result: InboundSlackFiles = { files: [], fetched: [], failed: [] };
  for (const eventFile of files) {
    // Slack Connect and some file_share events carry only the file id.
    const file = eventFile.url_private_download
      ? eventFile
      : ((await getFileInfo(client, eventFile.id)) ?? eventFile);
    result.files.push(file);

    const outcome = await downloadSlackFile(file, token);
    if (typeof outcome === "string") {
      console.warn(scrubSecrets(`[Slack] could not fetch file ${file.id}: ${outcome}`));
      result.failed.push({ file, reason: outcome });
    } else {
      result.fetched.push({ file, body: outcome });
    }
  }
  return result;
}

/** The file's bytes, or the reason they couldn't be fetched. */
async function downloadSlackFile(
  file: SlackFile,
  token: string | undefined,
): Promise<Uint8Array | string> {
  const limit = `larger than the ${MAX_TASK_ATTACHMENT_BYTES / (1024 * 1024)} MB limit`;
  if (file.size > MAX_TASK_ATTACHMENT_BYTES) return limit;
  if (!file.url_private_download) return "Slack gave no download URL";
  if (!token) return "no Slack bot token configured";

  try {
    const response = await fetch(file.url_private_download, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) return `download failed (HTTP ${response.status})`;
    // Without `files:read` Slack answers 200 with its HTML sign-in page.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.startsWith("text/html") && !file.mimetype?.startsWith("text/html")) {
      return "Slack returned its sign-in page instead of the file (is the files:read scope granted?)";
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_TASK_ATTACHMENT_BYTES) return limit;
    return body;
  } catch (error) {
    return `download failed (${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * Create a Slack-sourced task and attach the files fetched from its message.
 * With files, the task is created in `draft` and promoted once every upload
 * has settled — success or not — so a worker can't start before its
 * attachments exist. Returns the files that were fetched but couldn't be stored.
 */
export async function createSlackTaskWithFiles(
  description: string,
  options: CreateTaskOptions,
  inbound: InboundSlackFiles,
): Promise<{ task: AgentTask; failed: SlackFileFailure[] }> {
  if (inbound.fetched.length === 0) {
    return { task: await createTaskWithSiblingAwareness(description, options), failed: [] };
  }

  const task = await createTaskWithSiblingAwareness(description, { ...options, status: "draft" });
  const failed: SlackFileFailure[] = [];
  try {
    const provider = getFileStorageProvider();
    const usedNames = new Set<string>();
    for (const { file, body } of inbound.fetched) {
      // Pasted screenshots are all called "image.png"; the provider key is
      // derived from the name, so a repeat would overwrite the first one.
      const name = usedNames.has(file.name) ? `${file.id}-${file.name}` : file.name;
      usedNames.add(name);
      const scope = { taskId: task.id, name };
      try {
        const uploaded = await provider.upload(scope, body, {
          contentType: file.mimetype,
          sizeBytes: body.byteLength,
          message: `Upload ${name} shared on Slack for task ${task.id}`,
        });
        await recordTaskAttachmentUpload({
          provider,
          scope,
          uploaded,
          body,
          contentType: file.mimetype,
          agentId: null,
          intent: ATTACHMENT_INTENT,
          description: `Shared on Slack (file ${file.id})`,
        });
      } catch (error) {
        const reason = `could not be stored (${error instanceof Error ? error.message : String(error)})`;
        console.warn(scrubSecrets(`[Slack] file ${file.id} for task ${task.id} ${reason}`));
        failed.push({ file, reason });
      }
    }
  } finally {
    await promoteDraftTask(task.id);
  }
  return { task, failed };
}

/**
 * Tell the user, in the thread, which of their files the agent won't see —
 * one reply listing each file once, even when several tasks failed on it.
 * Best-effort: a failed post is logged, never thrown.
 */
export async function notifySlackFileFailures(
  client: WebClient,
  channel: string,
  threadTs: string,
  failures: SlackFileFailure[],
): Promise<void> {
  if (failures.length === 0) return;
  const byFile = new Map(failures.map((f) => [f.file.id, f]));
  const failedFiles = [...byFile.values()]
    .map((f) => `\`${f.file.name}\` (${f.reason})`)
    .join(", ");
  const { text } = resolveTemplate("slack.message.attachment_failed", {
    failed_files: failedFiles,
  });
  try {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    console.warn(
      scrubSecrets(
        `[Slack] could not post the attachment-failure notice in ${channel}/${threadTs}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
}

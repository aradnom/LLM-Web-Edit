import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The data root deliberately defaults to somewhere outside this repo: each
// change directory becomes the cwd of a Claude Code session, and we don't want
// those sessions inheriting this project's CLAUDE.md or settings.
export const config = {
  host: "127.0.0.1",
  port: Number(process.env.WEB_EDIT_PORT ?? 7411),
  root: resolve(process.env.WEB_EDIT_ROOT ?? join(homedir(), ".web-edit")),
  // Snapshots carry every script the page loaded, so bodies run to tens of MB.
  maxBodyBytes: 256 * 1024 * 1024,
  claudeBin: process.env.WEB_EDIT_CLAUDE_BIN ?? "claude",
  /** Model alias or ID for change sessions; unset uses Claude Code's own default. */
  model: process.env.WEB_EDIT_MODEL || null,
  sessionTimeoutMs: Number(process.env.WEB_EDIT_SESSION_TIMEOUT_MIN ?? 20) * 60_000,
};

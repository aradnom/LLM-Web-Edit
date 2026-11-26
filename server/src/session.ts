import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { preprocessChange } from "./preprocess.ts";
import { clampName, NAME_MAX, writeRecord } from "./store.ts";
import type { ChangeRecord, SessionResult } from "./store.ts";

// The session's instructions live in this repo and are passed by path, so they
// are versioned with the server and never copied into the data directory.
const INSTRUCTIONS = join(import.meta.dirname, "..", "prompts", "session.md");

// The return contract. Claude Code validates the session's final answer
// against this and hands it back as `structured_output`, so the server never
// has to parse prose or trust a hand-written result file.
const RESULT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "partial", "failed"] },
    message: { type: "string" },
    name: { type: "string", maxLength: NAME_MAX },
  },
  required: ["status", "message", "name"],
  additionalProperties: false,
});

interface ClaudeOutput {
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  structured_output?: unknown;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function runClaude(cwd: string, args: string[], prompt: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, config.sessionTimeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    // The request goes in on stdin: it is arbitrary user text, and this keeps
    // it out of argv entirely.
    child.stdin.end(prompt);
  });
}

function parseResult(value: unknown): SessionResult | null {
  if (!value || typeof value !== "object") return null;
  const { status, message, name } = value as Record<string, unknown>;
  if (status !== "done" && status !== "partial" && status !== "failed") return null;
  return {
    status,
    message: typeof message === "string" ? message : "",
    // The schema asks for the limit; this guarantees it for the UI.
    name: typeof name === "string" ? clampName(name) : "",
  };
}

/**
 * Runs one turn of the change's Claude Code session, for the last entry in
 * `record.turns`: the first turn when the record has no session yet, a resumed
 * one otherwise. Always leaves the record in "finished" or "error".
 */
export async function runSession(record: ChangeRecord, prompt: string): Promise<void> {
  const turn = record.turns.at(-1)!;
  record.status = "running";
  delete record.error;
  await writeRecord(record);

  const args = [
    "-p",
    "--output-format", "json",
    "--permission-mode", "auto",
    "--append-system-prompt-file", INSTRUCTIONS,
    "--json-schema", RESULT_SCHEMA,
  ];
  if (config.model) args.push("--model", config.model);
  if (record.sessionId) args.push("--resume", record.sessionId);
  else args.push("--name", `web-edit:${record.hostname}:${record.id}`);

  try {
    await mkdir(join(record.dir, "output"), { recursive: true });
    const run = await runClaude(record.dir, args, prompt);

    let output: ClaudeOutput = {};
    try {
      output = JSON.parse(run.stdout) as ClaudeOutput;
    } catch {
      // handled below: no parseable output means the run failed
    }
    if (output.session_id) record.sessionId = output.session_id;
    if (typeof output.total_cost_usd === "number") {
      record.costUsd = (record.costUsd ?? 0) + output.total_cost_usd;
    }

    const result = output.is_error ? null : parseResult(output.structured_output);
    if (result) {
      turn.result = result;
      record.result = result;
      if (result.name) record.name = result.name;
      record.updatedAt = new Date().toISOString();
    } else {
      turn.error = run.timedOut
        ? `Claude Code session timed out after ${Math.round(config.sessionTimeoutMs / 60000)} minutes`
        : (output.result || run.stderr.trim().slice(-2000) || `claude exited with code ${run.code}`);
    }
  } catch (err) {
    turn.error = `Could not run Claude Code: ${err instanceof Error ? err.message : String(err)}`;
  }
  // A failed update leaves the change usable: the turn carries the error and
  // the output from the last turn that worked is still offered.
  if (turn.result || record.result) {
    record.status = "finished";
  } else {
    record.status = "error";
    record.error = turn.error;
  }
  await writeRecord(record);
  console.log(`[${new Date().toISOString()}] ${record.status} ${record.hostname}/${record.id}`);
}

/** The full life of a new change: format the snapshot, then hand it to Claude Code. */
export async function processChange(record: ChangeRecord): Promise<void> {
  await preprocessChange(record);
  await runSession(record, record.request);
}

export interface UpdateContext {
  request: string;
  /** The page the update was requested from. */
  url: string;
  /** Whether this change's overlay was applied in the tab when it was captured. */
  applied: boolean;
}

// The standing instructions cover updates too; this repeats the part that is
// easy to get wrong, right next to the request, with this update's specifics.
function updatePrompt({ request, url, applied }: UpdateContext): string {
  return [
    "This is an update request for the change you made earlier in this session.",
    "",
    `\`snapshot/\` has just been replaced with a fresh capture of the page as it is now (${url}). ` +
      "It is not the snapshot you worked from before: any amount of time may have passed, the site may have " +
      "changed, and this may be a different page of the same site. Assume nothing carries over; check the " +
      "selectors and code you rely on against the new snapshot.",
    "",
    applied
      ? "Your current overlay WAS applied to the page when this capture was taken, so the captured DOM " +
        "includes whatever your script did to it."
      : "Your current overlay was NOT applied to the page when this capture was taken.",
    "",
    "`output/` is as you left it. Revise those files in place.",
    "",
    "The request:",
    "",
    request,
  ].join("\n");
}

/** An update to an existing change: format the fresh snapshot, then resume the session. */
export async function processUpdate(record: ChangeRecord, context: UpdateContext): Promise<void> {
  await preprocessChange(record);
  await runSession(record, updatePrompt(context));
}

export interface ChangeOutput {
  css: string | null;
  js: string | null;
}

/** The overlay files the session wrote, if any. */
export async function readOutput(record: ChangeRecord): Promise<ChangeOutput> {
  const read = (name: string) => readFile(join(record.dir, "output", name), "utf8").catch(() => null);
  return { css: await read("change.css"), js: await read("change.js") };
}

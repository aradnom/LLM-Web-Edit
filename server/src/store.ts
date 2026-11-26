import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classify, isFirstParty, kindExtension, scriptKind, sourceMapUrl } from "./scripts.ts";
import type { ScriptKind, ScriptPayload } from "./scripts.ts";

export interface StylesheetPayload {
  href: string | null;
  media: string;
  disabled: boolean;
  /** Tag name of the owning node ("link", "style"), or "constructed"/"import". */
  owner: string;
  css: string | null;
  error?: string;
}

export interface ChangePayload {
  url: string;
  title: string;
  request: string;
  snapshot: {
    html: string;
    stylesheets: StylesheetPayload[];
    scripts: ScriptPayload[];
    /** Storage/cookie key names and page-defined globals; shape owned by the extension. */
    runtime: unknown;
    /** PNG data URL of the visible viewport, if the extension could take one. */
    screenshot: string | null;
    viewport?: unknown;
    userAgent?: string;
  };
}

export interface ChangeRecord {
  id: string;
  hostname: string;
  url: string;
  title: string;
  request: string;
  createdAt: string;
  /**
   * "preprocessing": snapshot saved, scripts being formatted.
   * "running": a Claude Code turn is in progress.
   * "finished": the turn completed and `result` holds its answer.
   * "error": the turn could not be run or returned nothing usable; see `error`.
   */
  status: "preprocessing" | "running" | "finished" | "error";
  /** Set when formatting could not run at all; the snapshot is still usable, just unformatted. */
  preprocessError?: string;
  /** Short display name chosen by the session (at most NAME_MAX characters). */
  name?: string;
  /** Claude Code session for this change; follow-ups resume it. */
  sessionId?: string;
  /** The session's answer for the most recent turn. */
  result?: SessionResult;
  error?: string;
  /**
   * The conversation, oldest first: the original request, then each update
   * request, each with the answer it got. `request` and `result` above mirror
   * the first request and the latest successful answer.
   */
  turns: Turn[];
  /** When the output files were last (successfully) revised. Clients use it to spot stale copies. */
  updatedAt?: string;
  /** Records written before `turns` existed; folded into `turns` when read. */
  followUps?: { request: string; at: string }[];
  /** Total across all turns, as reported by Claude Code. */
  costUsd?: number;
  dir: string;
}

export interface Turn {
  request: string;
  at: string;
  /** The page the request was made from (updates can come from another page of the site). */
  url?: string;
  result?: SessionResult;
  /** Set instead of `result` when the session could not run or returned nothing usable. */
  error?: string;
}

/** What the model reports back. `message` is always shown to the user. */
export interface SessionResult {
  status: "done" | "partial" | "failed";
  message: string;
  name: string;
}

export interface ScriptIndexEntry {
  /** Path relative to snapshot/scripts/, or null if the code could not be fetched. */
  file: string | null;
  url: string | null;
  inline: boolean;
  kind: ScriptKind;
  source: "tag" | "resource";
  async: boolean;
  defer: boolean;
  bytes: number | null;
  firstParty: boolean;
  /** Best guess, see scripts.ts. */
  category: string;
  /** False until the formatter has rewritten the file (stays false if it could not parse it). */
  formatted: boolean;
  sourceMapUrl: string | null;
  error?: string;
}

export class PayloadError extends Error {}

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);

export function parsePayload(body: unknown): ChangePayload {
  const fail = (msg: string): never => {
    throw new PayloadError(msg);
  };
  const list = (value: unknown, name: string): Record<string, unknown>[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) fail(`snapshot.${name} must be an array`);
    return (value as unknown[]).filter((v) => v && typeof v === "object") as Record<string, unknown>[];
  };

  if (!body || typeof body !== "object") fail("body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.url !== "string") fail("url is required");
  if (typeof b.request !== "string" || !b.request.trim()) fail("request is required");
  if (!b.snapshot || typeof b.snapshot !== "object") fail("snapshot is required");
  const snap = b.snapshot as Record<string, unknown>;
  if (typeof snap.html !== "string" || !snap.html) fail("snapshot.html is required");
  const screenshot = snap.screenshot ?? null;
  if (screenshot !== null && typeof screenshot !== "string") fail("snapshot.screenshot must be a data URL");

  return {
    url: b.url as string,
    title: str(b.title),
    request: (b.request as string).trim(),
    snapshot: {
      html: snap.html as string,
      stylesheets: list(snap.stylesheets, "stylesheets").map((s) => ({
        href: strOrNull(s.href),
        media: str(s.media),
        disabled: s.disabled === true,
        owner: str(s.owner),
        css: strOrNull(s.css),
        ...(typeof s.error === "string" ? { error: s.error } : {}),
      })),
      scripts: list(snap.scripts, "scripts").map((s) => ({
        url: strOrNull(s.url),
        type: str(s.type),
        async: s.async === true,
        defer: s.defer === true,
        source: s.source === "resource" ? "resource" : "tag",
        code: strOrNull(s.code),
        ...(typeof s.error === "string" ? { error: s.error } : {}),
      })),
      runtime: snap.runtime ?? null,
      screenshot: screenshot as string | null,
      viewport: snap.viewport,
      userAgent: typeof snap.userAgent === "string" ? snap.userAgent : undefined,
    },
  };
}

/** Directory name for a site: its hostname, restricted to safe characters. */
export function siteDirName(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PayloadError("url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PayloadError("only http(s) pages are supported");
  }
  const name = url.hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  return /[a-z0-9]/.test(name) ? name : "_unknown";
}

/** "NN-<last path segment of the URL, or the fallback>.<ext>", safe for any filesystem. */
function assetFileName(index: number, url: string | null, fallback: string, ext: string): string {
  let base = fallback;
  if (url) {
    try {
      base = new URL(url).pathname.split("/").pop() || fallback;
    } catch {
      // keep the fallback name
    }
  }
  base = base.replace(/\.(css|m?js|json)$/i, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60) || fallback;
  return `${String(index).padStart(2, "0")}-${base}${ext}`;
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

async function writeStylesheets(dir: string, sheets: StylesheetPayload[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const index = [];
  for (const [i, sheet] of sheets.entries()) {
    const file = sheet.css === null ? null : assetFileName(i, sheet.href, sheet.owner || "sheet", ".css");
    if (file) await writeFile(join(dir, file), sheet.css!);
    index.push({
      file,
      href: sheet.href,
      media: sheet.media,
      disabled: sheet.disabled,
      owner: sheet.owner,
      ...(sheet.error ? { error: sheet.error } : {}),
    });
  }
  await writeFile(join(dir, "index.json"), json(index));
}

async function writeScripts(dir: string, pageUrl: string, scripts: ScriptPayload[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const index: ScriptIndexEntry[] = [];
  for (const [i, script] of scripts.entries()) {
    const kind = scriptKind(script.type);
    const firstParty = isFirstParty(pageUrl, script.url);
    const file = script.code === null ? null : assetFileName(i, script.url, "inline", kindExtension[kind]);
    if (file) await writeFile(join(dir, file), script.code!);
    index.push({
      file,
      url: script.url,
      inline: script.url === null,
      kind,
      source: script.source,
      async: script.async,
      defer: script.defer,
      bytes: script.code === null ? null : Buffer.byteLength(script.code),
      firstParty,
      category: classify(kind, script.url, firstParty, script.code),
      formatted: false,
      sourceMapUrl: script.code === null ? null : sourceMapUrl(script.code, script.url),
      ...(script.error ? { error: script.error } : {}),
    });
  }
  await writeFile(join(dir, "index.json"), json(index));
}

/**
 * Layout:
 *   <root>/sites/<hostname>/<uuid>/
 *     change.json
 *     snapshot/page.html
 *     snapshot/meta.json
 *     snapshot/runtime.json
 *     snapshot/screenshot.png
 *     snapshot/stylesheets/index.json, NN-<name>.css
 *     snapshot/scripts/index.json, NN-<name>.{js,mjs,json,txt}
 *
 * Scripts are written as received; preprocess.ts formats them in place
 * afterwards. The Claude Code session later adds output/change.{css,js}.
 */
async function writeSnapshot(snapDir: string, payload: ChangePayload, capturedAt: string): Promise<void> {
  await mkdir(snapDir, { recursive: true });
  const { snapshot } = payload;

  await writeStylesheets(join(snapDir, "stylesheets"), snapshot.stylesheets);
  await writeScripts(join(snapDir, "scripts"), payload.url, snapshot.scripts);

  let hasScreenshot = false;
  const shot = /^data:image\/png;base64,(.+)$/s.exec(snapshot.screenshot ?? "");
  if (shot) {
    await writeFile(join(snapDir, "screenshot.png"), Buffer.from(shot[1]!, "base64"));
    hasScreenshot = true;
  }

  await writeFile(join(snapDir, "page.html"), snapshot.html);
  await writeFile(join(snapDir, "runtime.json"), json(snapshot.runtime));
  await writeFile(
    join(snapDir, "meta.json"),
    json({
      url: payload.url,
      title: payload.title,
      capturedAt,
      viewport: snapshot.viewport ?? null,
      userAgent: snapshot.userAgent ?? null,
      hasScreenshot,
    }),
  );
}

export async function saveChange(root: string, payload: ChangePayload): Promise<ChangeRecord> {
  const hostname = siteDirName(payload.url);
  const id = randomUUID();
  const dir = join(root, "sites", hostname, id);
  const createdAt = new Date().toISOString();
  await writeSnapshot(join(dir, "snapshot"), payload, createdAt);

  const record: ChangeRecord = {
    id,
    hostname,
    url: payload.url,
    title: payload.title,
    request: payload.request,
    createdAt,
    status: "preprocessing",
    turns: [{ request: payload.request, at: createdAt, url: payload.url }],
    dir,
  };
  // Written last, so a change.json on disk means the snapshot is complete.
  await writeRecord(record);
  return record;
}

/**
 * Swaps in a fresh capture for an update request. The new snapshot is written
 * in full beside the old one first, so a failed write leaves the old one
 * intact. `output/` is not touched: the session revises what it wrote before.
 */
export async function replaceSnapshot(record: ChangeRecord, payload: ChangePayload, capturedAt: string): Promise<void> {
  const current = join(record.dir, "snapshot");
  const next = join(record.dir, "snapshot.next");
  await rm(next, { recursive: true, force: true });
  await writeSnapshot(next, payload, capturedAt);
  await rm(current, { recursive: true, force: true });
  await rename(next, current);
}

/** Reads a change.json, giving records from before `turns` existed the same shape. */
async function readRecord(path: string): Promise<ChangeRecord> {
  const record = JSON.parse(await readFile(path, "utf8")) as ChangeRecord;
  if (!Array.isArray(record.turns)) {
    record.turns = [
      { request: record.request, at: record.createdAt, url: record.url },
      ...(record.followUps ?? []).map((f) => ({ request: f.request, at: f.at })),
    ];
    // Old records only kept the latest answer; it belongs to the latest request.
    const last = record.turns.at(-1)!;
    if (record.status === "finished" && record.result) last.result = record.result;
    if (record.status === "error" && record.error) last.error = record.error;
  }
  delete record.followUps;
  return record;
}

export async function writeRecord(record: ChangeRecord): Promise<void> {
  await writeFile(join(record.dir, "change.json"), json(record));
}

export interface ChangeSummary {
  id: string;
  url: string;
  /** Short display name from the session; falls back to the start of the request. */
  name: string;
  request: string;
  createdAt: string;
  updatedAt: string | null;
  status: ChangeRecord["status"];
  turns: Turn[];
  result: SessionResult | null;
  error: string | null;
  hasCss: boolean;
  hasJs: boolean;
}

export const NAME_MAX = 32;

export function clampName(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= NAME_MAX ? clean : clean.slice(0, NAME_MAX - 1).trimEnd() + "…";
}

/** Every change for the site `pageUrl` belongs to, newest first. */
export async function listSiteChanges(root: string, pageUrl: string): Promise<ChangeSummary[]> {
  const siteDir = join(root, "sites", siteDirName(pageUrl));
  let ids: string[];
  try {
    ids = await readdir(siteDir);
  } catch {
    return [];
  }
  const summaries: ChangeSummary[] = [];
  for (const id of ids) {
    let record: ChangeRecord;
    try {
      record = await readRecord(join(siteDir, id, "change.json"));
    } catch {
      continue; // not a change directory, or still being written
    }
    // Output from an earlier turn stays on disk while an update runs, but it
    // is only offered once the change is finished.
    const outputs =
      record.status === "finished" ? await readdir(join(siteDir, id, "output")).catch(() => [] as string[]) : [];
    summaries.push({
      id: record.id,
      url: record.url,
      name: record.name || clampName(record.request),
      request: record.request,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt ?? null,
      status: record.status,
      turns: record.turns,
      result: record.result ?? null,
      error: record.error ?? null,
      hasCss: outputs.includes("change.css"),
      hasJs: outputs.includes("change.js"),
    });
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function findChange(root: string, id: string): Promise<ChangeRecord | null> {
  if (!UUID.test(id)) return null;
  let sites: string[];
  try {
    sites = await readdir(join(root, "sites"));
  } catch {
    return null;
  }
  for (const site of sites) {
    try {
      return await readRecord(join(root, "sites", site, id, "change.json"));
    } catch {
      // not under this site
    }
  }
  return null;
}

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAuthorized, loadOrCreateToken } from "./auth.ts";
import { config } from "./config.ts";
import { processChange, processUpdate, readOutput } from "./session.ts";
import {
  findChange,
  listSiteChanges,
  parsePayload,
  PayloadError,
  replaceSnapshot,
  saveChange,
  siteDirName,
  writeRecord,
} from "./store.ts";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw new HttpError(413, "payload too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

/**
 * Only the extension may call us from a browser. Web pages can reach
 * 127.0.0.1 too, so any request carrying a non-extension Origin is refused
 * before the token is even looked at. Returns false if the request was handled.
 */
function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!origin.startsWith("moz-extension://")) {
      send(res, 403, { error: "origin not allowed" });
      return false;
    }
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-max-age", "600");
  }
  if (req.method === "OPTIONS") {
    send(res, 204);
    return false;
  }
  return true;
}

const token = await loadOrCreateToken(config.root);

const server = createServer(async (req, res) => {
  try {
    if (!applyCors(req, res)) return;
    if (!isAuthorized(req, token)) throw new HttpError(401, "missing or invalid token");

    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const path = requestUrl.pathname;

    if (req.method === "GET" && path === "/health") {
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/changes") {
      const record = await saveChange(config.root, parsePayload(await readJson(req)));
      console.log(`[${record.createdAt}] saved ${record.hostname}/${record.id}: ${record.request}`);
      send(res, 201, record);
      // The work continues after the response; clients poll GET /changes/:id.
      // processChange records its own failures and never rejects.
      void processChange({ ...record });
      return;
    }

    if (req.method === "GET" && path === "/changes") {
      const pageUrl = requestUrl.searchParams.get("url");
      if (!pageUrl) throw new HttpError(400, "url query parameter is required");
      return send(res, 200, await listSiteChanges(config.root, pageUrl));
    }

    const changeMatch = /^\/changes\/([^/]+)$/.exec(path);
    if (req.method === "GET" && changeMatch) {
      const record = await findChange(config.root, changeMatch[1]!);
      if (!record) throw new HttpError(404, "no such change");
      const output = record.status === "finished" ? await readOutput(record) : null;
      return send(res, 200, { ...record, output });
    }

    // An update to an existing change: same body as POST /changes (the request
    // plus a fresh snapshot), and optionally `applied`, saying whether this
    // change's overlay was in the page when it was captured.
    const updateMatch = /^\/changes\/([^/]+)\/followups$/.exec(path);
    if (req.method === "POST" && updateMatch) {
      const body = await readJson(req);
      const payload = parsePayload(body);
      const applied = (body as { applied?: unknown }).applied === true;
      const record = await findChange(config.root, updateMatch[1]!);
      if (!record) throw new HttpError(404, "no such change");
      if (siteDirName(payload.url) !== record.hostname) {
        throw new HttpError(400, `this change belongs to ${record.hostname}`);
      }
      if (record.status === "preprocessing" || record.status === "running") {
        throw new HttpError(409, "this change is still being worked on");
      }
      if (!record.sessionId) throw new HttpError(409, "this change has no session to continue; start a new change");
      // Claimed before the slow part, so a second request cannot slip in.
      const previousStatus = record.status;
      record.status = "preprocessing";
      await writeRecord(record);
      const at = new Date().toISOString();
      try {
        await replaceSnapshot(record, payload, at);
      } catch (err) {
        record.status = previousStatus;
        await writeRecord(record);
        throw err;
      }
      record.turns.push({ request: payload.request, at, url: payload.url });
      await writeRecord(record);
      console.log(`[${at}] update ${record.hostname}/${record.id}: ${payload.request}`);
      send(res, 202, record);
      void processUpdate(record, { request: payload.request, url: payload.url, applied });
      return;
    }

    throw new HttpError(404, "not found");
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    if (err instanceof PayloadError) return send(res, 400, { error: err.message });
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: "internal error" });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`web-edit server listening on http://${config.host}:${config.port}`);
  console.log(`data root: ${config.root}`);
  console.log(`token:     ${token}`);
});

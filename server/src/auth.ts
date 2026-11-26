import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

/** Reads the shared secret from `<root>/token`, generating it on first run. */
export async function loadOrCreateToken(root: string): Promise<string> {
  const file = join(root, "token");
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing) return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(root, { recursive: true });
  await writeFile(file, token + "\n", { mode: 0o600 });
  return token;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return timingSafeEqual(digest(match[1]!.trim()), digest(token));
}

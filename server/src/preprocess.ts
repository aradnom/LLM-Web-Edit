import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChangeRecord, ScriptIndexEntry } from "./store.ts";

const BIOME = join(import.meta.dirname, "..", "node_modules", ".bin", "biome");

// Biome skips files over 1 MiB unless told otherwise; bundles routinely exceed that.
const MAX_FILE_BYTES = 256 * 1024 * 1024;

/**
 * Formats every script in `dir` in place. A minified bundle is one enormous
 * line, which makes grep hits and partial reads useless; line structure is the
 * whole point, the style is irrelevant. Files Biome cannot parse are left as
 * they were, and its non-zero exit for those is expected.
 */
function runBiome(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      BIOME,
      ["format", "--write", `--files-max-size=${MAX_FILE_BYTES}`, "."],
      { cwd: dir, maxBuffer: 64 * 1024 * 1024 },
      (err) => {
        // A numeric exit code means Biome ran and reported per-file problems.
        if (err && typeof err.code !== "number") reject(err);
        else resolve();
      },
    );
  });
}

const hashFile = async (path: string) => createHash("sha1").update(await readFile(path)).digest("hex");

/** Runs after the snapshot is saved. Never rejects: a failure is noted on the record. */
export async function preprocessChange(record: ChangeRecord): Promise<void> {
  const dir = join(record.dir, "snapshot", "scripts");
  const indexPath = join(dir, "index.json");
  try {
    const index = JSON.parse(await readFile(indexPath, "utf8")) as ScriptIndexEntry[];
    const files = index.filter((e) => e.file !== null);

    const before = new Map<string, string>();
    for (const entry of files) before.set(entry.file!, await hashFile(join(dir, entry.file!)));

    if (files.length > 0) await runBiome(dir);

    for (const entry of files) {
      entry.formatted = (await hashFile(join(dir, entry.file!))) !== before.get(entry.file!);
    }
    await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n");
  } catch (err) {
    record.preprocessError = err instanceof Error ? err.message : String(err);
    console.error(`preprocessing failed for ${record.id}:`, err);
  }
}

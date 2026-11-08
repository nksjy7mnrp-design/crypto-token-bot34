import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { logger } from "../lib/logger";

// ─── Where the "already sent" list is saved ──────────────────────────────────
// 1. SEEN_FILE         → a full file path you choose yourself
// 2. A Railway Volume  → Railway sets RAILWAY_VOLUME_MOUNT_PATH when one is attached
// 3. Otherwise the app folder → Railway WIPES this on every redeploy and restart
const explicitFile = process.env["SEEN_FILE"];
const volumeDir = process.env["RAILWAY_VOLUME_MOUNT_PATH"];

const CACHE_FILE =
  explicitFile ??
  (volumeDir ? join(volumeDir, "seen-tokens.json") : join(process.cwd(), "seen-tokens.json"));

const PERSISTENT = Boolean(explicitFile || volumeDir);
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // remember a token for 7 days

type CacheEntry = [string, number];

let seen: Map<string, number> | undefined;
let loadedCount = 0;
let writeFailed = false;

function load(): Map<string, number> {
  if (seen) return seen;
  const map = new Map<string, number>();
  const now = Date.now();
  try {
    if (existsSync(CACHE_FILE)) {
      const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as unknown;
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (typeof entry === "string") {
            map.set(entry.toLowerCase(), now);
          } else if (Array.isArray(entry) && entry.length === 2) {
            const [ca, ts] = entry as [string, number];
            if (typeof ca === "string" && now - ts <= TTL_MS) {
              map.set(ca.toLowerCase(), ts);
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warn(
      { err: String(err), file: CACHE_FILE },
      "Could not read the saved token list — starting with an empty one",
    );
  }
  seen = map;
  loadedCount = map.size;
  return map;
}

function persist(): void {
  try {
    const map = load();

    // drop entries older than the TTL so the file never grows forever
    const now = Date.now();
    for (const [ca, ts] of map) {
      if (now - ts > TTL_MS) map.delete(ca);
    }

    const dir = dirname(CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const entries: CacheEntry[] = [...map.entries()];
    const tmp = `${CACHE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), "utf-8");
    renameSync(tmp, CACHE_FILE); // swap in one step so a crash can't leave a half-written file
    writeFailed = false;
  } catch (err) {
    if (!writeFailed) {
      logger.error(
        { err: String(err), file: CACHE_FILE },
        "Could not SAVE the sent-token list (folder not writable?) — repeats are possible after a restart",
      );
    }
    writeFailed = true;
  }
}

export function hasSeen(ca: string): boolean {
  return load().has(ca.toLowerCase());
}

export function markSeen(ca: string): void {
  load().set(ca.toLowerCase(), Date.now());
  persist();
}

/** Forget a token again (used when posting it failed, so it gets retried next cycle) */
export function unmarkSeen(ca: string): void {
  load().delete(ca.toLowerCase());
  persist();
}

/** True when the saved list was empty at startup (first run ever, or the file was wiped) */
export function startedEmpty(): boolean {
  load();
  return loadedCount === 0;
}

export function cacheInfo(): { file: string; persistent: boolean; entries: number } {
  return { file: CACHE_FILE, persistent: PERSISTENT, entries: load().size };
}

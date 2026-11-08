import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const CACHE_FILE = join(process.cwd(), "seen-tokens.json");
const TTL_MS = 24 * 60 * 60 * 1000;

type CacheEntry = [string, number];

let seen: Map<string, number>;

function load(): Map<string, number> {
  if (seen) return seen;
  const now = Date.now();
  try {
    if (existsSync(CACHE_FILE)) {
      const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as unknown;
      seen = new Map();
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (typeof entry === "string") {
            seen.set(entry.toLowerCase(), now);
          } else if (Array.isArray(entry) && entry.length === 2) {
            const [ca, ts] = entry as [string, number];
            if (now - ts <= TTL_MS) {
              seen.set(ca.toLowerCase(), ts);
            }
          }
        }
      }
    } else {
      seen = new Map();
    }
  } catch {
    seen = new Map();
  }
  return seen;
}

function persist(): void {
  try {
    const entries: CacheEntry[] = [...load().entries()];
    writeFileSync(CACHE_FILE, JSON.stringify(entries), "utf-8");
  } catch {}
}

export function hasSeen(ca: string): boolean {
  return load().has(ca.toLowerCase());
}

export function markSeen(ca: string): void {
  load().set(ca.toLowerCase(), Date.now());
  persist();
}

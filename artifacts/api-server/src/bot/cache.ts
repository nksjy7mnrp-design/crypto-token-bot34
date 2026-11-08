
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { dirname, resolve } from "path";

const CACHE_FILE = resolve(
  process.env.SEEN_TOKENS_FILE || "seen-tokens.json"
);

const TTL_DAYS = Number(process.env.SEEN_TOKEN_TTL_DAYS || 30);
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

type CacheEntry = [string, number];

let seen: Map<string, number> | undefined;

function load(): Map<string, number> {
  if (seen) return seen;

  seen = new Map();
  const now = Date.now();

  try {
    if (existsSync(CACHE_FILE)) {
      const raw = JSON.parse(
        readFileSync(CACHE_FILE, "utf-8")
      ) as unknown;

      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string" &&
            typeof entry[1] === "number" &&
            now - entry[1] <= TTL_MS
          ) {
            seen.set(entry[0].toLowerCase(), entry[1]);
          }
        }
      }
    }
  } catch (error) {
    console.error("Could not load token cache:", error);
  }

  return seen;
}

function persist(): void {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });

    const entries: CacheEntry[] = [...load().entries()];

    writeFileSync(
      CACHE_FILE,
      JSON.stringify(entries),
      "utf-8"
    );
  } catch (error) {
    console.error("Could not save token cache:", error);
  }
}

export function hasSeen(ca: string): boolean {
  return load().has(ca.toLowerCase());
}

export function markSeen(ca: string): void {
  load().set(ca.toLowerCase(), Date.now());
  persist();
}

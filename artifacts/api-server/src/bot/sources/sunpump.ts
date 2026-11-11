import axios from "axios";
import { logger } from "../../lib/logger";
import type { TokenAlert } from "../telegram";
import { isRecent } from "./utils";

// SunPump's token search. (The old ".../token/list" address does not exist, this one does.)
const SUNPUMP_URL = "https://api-v2.sunpump.meme/pump-api/token/search";
const PAGE_SIZE = 20;

// We don't know which "newest first" setting the server accepts, so on the first run we try these
// in order, CHECK that the answer really is in newest-first date order, and remember the one that works.
const KEYWORDS = ["", "a"];
const SORTS: (string | undefined)[] = [
  "tokenCreatedInstant,desc",
  "id,desc",
  "tokenLaunchedInstant,desc",
  undefined, // no sort setting at all (in case the default is already newest first)
];

// If nothing works, only try again every 3 hours (instead of failing every minute)
const RETRY_AFTER_MS = 3 * 60 * 60 * 1000;

const HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  Referer: "https://sunpump.meme/",
};

type Raw = Record<string, unknown>;

let working: { keyword: string; sort?: string } | undefined;
let pausedUntil = 0;
let loggedFields = false;

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function httpOrUndefined(value: string | undefined): string | undefined {
  return value && value.startsWith("http") ? value : undefined;
}

/** SunPump sends creation times as Unix seconds (e.g. 1787645262); other forms are understood too */
function toMs(value: unknown): number {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  if (typeof value === "string" && value) {
    const n = Number(value);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

function createdMs(t: Raw): number {
  return toMs(t["tokenCreatedInstant"] ?? t["createdAt"] ?? t["createTime"] ?? t["createdTime"]);
}

/** Looks through the reply (whatever its shape) for the list of tokens */
function findTokens(value: unknown, depth = 0): Raw[] {
  if (depth > 4 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    const items = value.filter((v): v is Raw => !!v && typeof v === "object");
    return items.some((t) => typeof t["contractAddress"] === "string") ? items : [];
  }
  const obj = value as Raw;
  if (typeof obj["contractAddress"] === "string") return [obj];
  for (const child of Object.values(obj)) {
    const found = findTokens(child, depth + 1);
    if (found.length) return found;
  }
  return [];
}

/** True only when the list is clearly in newest-first order (and not just all the same time) */
function isNewestFirst(tokens: Raw[]): boolean {
  const times = tokens.map(createdMs).filter((ms) => ms > 0);
  if (times.length < 2) return false;
  for (let i = 1; i < times.length; i++) {
    if ((times[i] as number) > (times[i - 1] as number)) return false;
  }
  return times[0] !== times[times.length - 1];
}

/** One request. Returns undefined if SunPump answered with an error inside a normal reply. */
async function request(keyword: string, sort?: string): Promise<unknown> {
  // a failed request throws; it is already logged (with the HTTP status) by the request logger in worker.ts
  const res = await axios.get<unknown>(SUNPUMP_URL, {
    timeout: 10000,
    params: { keyword, size: PAGE_SIZE, ...(sort ? { sort } : {}) },
    headers: HEADERS,
  });
  const body = res.data as { code?: unknown; msg?: unknown } | undefined;
  if (typeof body?.code === "number" && body.code !== 0) {
    logger.warn({ keyword, sort, code: body.code, msg: String(body.msg ?? "") }, "SunPump replied with an error");
    return undefined;
  }
  return res.data;
}

/** First run: find a request that returns the newest tokens first */
async function discover(): Promise<Raw[] | undefined> {
  let answered = false;
  for (const keyword of KEYWORDS) {
    for (const sort of SORTS) {
      let body: unknown;
      try {
        body = await request(keyword, sort);
      } catch {
        continue;
      }
      if (body === undefined) continue;
      answered = true;
      const tokens = findTokens(body);
      if (isNewestFirst(tokens)) {
        working = { keyword, sort };
        logger.info(
          { keyword: keyword || "(empty)", sort: sort ?? "(none)" },
          "SunPump: found a way to list the newest tokens first",
        );
        return tokens;
      }
    }
  }
  pausedUntil = Date.now() + RETRY_AFTER_MS;
  logger.warn(
    answered
      ? "SunPump answers, but I could not make it list the newest tokens first - pausing this source for 3 hours"
      : "SunPump did not answer on the new server - pausing this source for 3 hours",
  );
  return undefined;
}

export async function fetchSunPump(_sinceMs: number): Promise<TokenAlert[]> {
  if (Date.now() < pausedUntil) return [];

  try {
    let tokens: Raw[] | undefined;
    if (working) {
      try {
        const body = await request(working.keyword, working.sort);
        tokens = body === undefined ? undefined : findTokens(body);
      } catch {
        return []; // a temporary problem: simply try again next minute
      }
      if (!tokens) return [];
    } else {
      tokens = await discover();
      if (!tokens) return [];
    }

    if (!loggedFields && tokens[0]) {
      loggedFields = true;
      logger.info({ fields: Object.keys(tokens[0]) }, "SunPump token fields (for troubleshooting)");
    }

    const results: TokenAlert[] = [];
    for (const t of tokens) {
      const ca = firstString(t["contractAddress"]);
      const tg = firstString(t["telegramUrl"], t["telegram"], t["telegramLink"]);
      if (!ca || !tg) continue;
      if (t["active"] === false) continue;

      // Only tokens whose creation time we can read AND is recent (we never guess a token is new)
      const created = createdMs(t);
      if (!(created > 0) || !isRecent(created)) continue;

      results.push({
        ca,
        symbol: firstString(t["symbol"]) ?? "UNKNOWN",
        name: firstString(t["name"]),
        chain: "tron",
        telegramLink: tg.startsWith("http") ? tg : `https://t.me/${tg.replace(/^@/, "")}`,
        source: "SunPump",
        imageUrl: httpOrUndefined(firstString(t["logoUrl"], t["logo"], t["imageUrl"])),
        websiteUrl: httpOrUndefined(firstString(t["websiteUrl"], t["website"])),
        twitterUrl: httpOrUndefined(firstString(t["twitterUrl"], t["twitter"])),
      });
    }

    logger.info({ source: "SunPump", found: results.length }, "SunPump fetch complete");
    return results;
  } catch (err) {
    logger.warn({ source: "SunPump", err: String(err) }, "SunPump fetch failed");
    return [];
  }
}

/** Short status for the log line, e.g. "paused 170 more min" */
export function sunpumpNote(): string | undefined {
  const now = Date.now();
  return now < pausedUntil ? `paused ${Math.ceil((pausedUntil - now) / 60_000)} more min` : undefined;
}

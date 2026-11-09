import axios from "axios";
import { logger } from "../../lib/logger";
import type { TokenAlert } from "../telegram";
import { isRecent } from "./utils";

// SunPump moved to a new server. The old address (api.sunpump.meme) now answers "404 Not Found".
const SUNPUMP_URL = "https://api-v2.sunpump.meme/pump-api/token/list";

// "Newest first". We try these sort names in order and remember the one that works.
const SORT_OPTIONS = ["tokenCreatedInstant,desc", "createdAt,desc", "createTime,desc"];

// If nothing works at all, only try again every 30 minutes (instead of failing every minute)
const RETRY_AFTER_MS = 30 * 60 * 1000;

const HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  Referer: "https://sunpump.meme/",
};

type Raw = Record<string, unknown>;

let workingSort: string | undefined;
let pausedUntil = 0;
let loggedFields = false;
let loggedNoList = false;

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

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

/** Returns the reply body, or undefined if no sort option worked */
async function requestList(): Promise<unknown> {
  const options = workingSort ? [workingSort] : SORT_OPTIONS;
  for (const sort of options) {
    try {
      const res = await axios.get<unknown>(SUNPUMP_URL, {
        timeout: 10000,
        params: { size: 50, sort },
        headers: HEADERS,
      });
      const body = res.data as { code?: unknown; msg?: unknown } | undefined;
      if (typeof body?.code === "number" && body.code !== 0) {
        logger.warn({ sort, code: body.code, msg: String(body.msg ?? "") }, "SunPump replied with an error");
        continue;
      }
      if (workingSort !== sort) {
        workingSort = sort;
        logger.info({ sort }, "SunPump is answering on the new server");
      }
      return res.data;
    } catch {
      // the failure is already logged (with the HTTP status) by the request logger in worker.ts
    }
  }
  return undefined;
}

export async function fetchSunPump(_sinceMs: number): Promise<TokenAlert[]> {
  if (Date.now() < pausedUntil) return [];

  try {
    const body = await requestList();

    if (body === undefined) {
      if (!workingSort) {
        pausedUntil = Date.now() + RETRY_AFTER_MS;
        logger.warn("SunPump did not answer on the new server — pausing this source for 30 minutes");
      }
      return [];
    }

    const tokens = findTokens(body);

    if (tokens.length === 0) {
      if (!loggedNoList) {
        loggedNoList = true;
        const top = body && typeof body === "object" ? Object.keys(body as Raw) : [];
        logger.info({ responseKeys: top }, "SunPump replied but no token list was found in it");
      }
      logger.info({ source: "SunPump", found: 0 }, "SunPump fetch complete");
      return [];
    }

    if (!loggedFields) {
      loggedFields = true;
      logger.info({ fields: Object.keys(tokens[0] ?? {}) }, "SunPump token fields (for troubleshooting)");
    }

    const results: TokenAlert[] = [];
    for (const t of tokens) {
      const ca = firstString(t["contractAddress"]);
      const tg = firstString(t["telegramUrl"], t["telegram"], t["telegramLink"]);
      if (!ca || !tg) continue;

      // Only tokens whose creation time we can read AND is recent (we never guess a token is new)
      const createdMs = toMs(
        t["tokenCreatedInstant"] ?? t["createdAt"] ?? t["createTime"] ?? t["createdTime"],
      );
      if (!(createdMs > 0) || !isRecent(createdMs)) continue;

      const tgLink = tg.startsWith("http") ? tg : `https://t.me/${tg.replace(/^@/, "")}`;
      const logo = firstString(t["logoUrl"], t["logo"], t["imageUrl"]);

      results.push({
        ca,
        symbol: firstString(t["symbol"]) ?? "UNKNOWN",
        name: firstString(t["name"]),
        chain: "tron",
        telegramLink: tgLink,
        source: "SunPump",
        imageUrl: logo && logo.startsWith("http") ? logo : undefined,
      });
    }

    logger.info({ source: "SunPump", found: results.length }, "SunPump fetch complete");
    return results;
  } catch (err) {
    logger.warn({ source: "SunPump", err: String(err) }, "SunPump fetch failed");
    return [];
  }
}

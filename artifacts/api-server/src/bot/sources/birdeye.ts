import axios from "axios";
import { logger } from "../../lib/logger";
import { hasSeen } from "../cache";
import type { TokenAlert } from "../telegram";
import { TEN_MIN_MS } from "./utils";

// ─── Settings (all optional, set them as Railway Variables) ──────────────────
//   BIRDEYE_API_KEY       your Birdeye key. Without it this source stays OFF.
//   BIRDEYE_POLL_MINUTES  how often to ask Birdeye (default 10)
//   BIRDEYE_PAGES         pages of 10 new tokens per check (default 2, max 5)
//   BIRDEYE_CHAINS        e.g. "solana,base,bsc" (default "solana")
const API_KEY = process.env["BIRDEYE_API_KEY"];
const POLL_MINUTES = Math.max(1, Number(process.env["BIRDEYE_POLL_MINUTES"]) || 10);
const PAGES = Math.min(5, Math.max(1, Number(process.env["BIRDEYE_PAGES"]) || 2));
const CHAINS = (process.env["BIRDEYE_CHAINS"] ?? "solana")
  .split(",")
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);

const BASE_URL = "https://public-api.birdeye.so";
const DEXSCREENER_TOKENS_URL = "https://api.dexscreener.com/latest/dex/tokens/";

const NEW_LISTING_CU = 80; // what one "new listing" request costs on Birdeye
const META_CU = 3; // what one "token metadata" request costs
const MAX_META_CALLS = 6; // token-link lookups per check
const MIN_GAP_MS = 1100; // Birdeye's free plan allows 1 request per second

const HOUR_MS = 60 * 60 * 1000;

// Birdeye is only asked every few minutes, so "new" means "listed since our last check"
// (and never less than the normal "new token" window)
const AGE_LIMIT_MS = Math.max(TEN_MIN_MS, (POLL_MINUTES + 1) * 60_000);
const isFresh = (listedAtMs: number) => Date.now() - listedAtMs <= AGE_LIMIT_MS;

interface ListingItem {
  address?: string;
  symbol?: string;
  name?: string;
  source?: string;
  liquidityAddedAt?: string | number;
  logoURI?: string;
  liquidity?: number;
}

interface DexPair {
  chainId?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  fdv?: number;
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  info?: {
    imageUrl?: string;
    websites?: { url?: string }[];
    socials?: { type?: string; url?: string }[];
  };
}

interface Links {
  telegram?: string;
  website?: string;
  twitter?: string;
  image?: string;
}

interface DexInfo extends Links {
  pair?: DexPair;
}

let nextRunAt = 0;
let pausedUntil = 0;
let metaBlockedUntil = 0;
let announced = false;
let lastCallAt = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function httpOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("http") ? value : undefined;
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

function toTelegramLink(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(www\.)?(t|telegram)\.me\//i.test(value)) return `https://${value}`; // "t.me/name" without https
  return `https://t.me/${value.replace(/^@/, "")}`; // just a handle like "@name"
}

function statusOf(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

/** The short explanation Birdeye sends back with an error (it never contains your key) */
function messageOf(err: unknown): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data as { message?: unknown } | undefined;
  return typeof data?.message === "string" ? data.message.slice(0, 160) : "";
}

/** One Birdeye request. The key goes in a header, so it never shows up in a URL or in the logs. */
async function birdeyeGet(
  path: string,
  chain: string,
  params: Record<string, string | number | boolean>,
): Promise<unknown> {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();

  const res = await axios.get<unknown>(`${BASE_URL}${path}`, {
    params,
    timeout: 12000,
    headers: { "X-API-KEY": API_KEY ?? "", "x-chain": chain, accept: "application/json" },
  });
  return res.data;
}

/** Newest tokens on a chain (Birdeye gives at most 10 per request, so we can ask for a few pages) */
async function fetchListings(chain: string): Promise<ListingItem[]> {
  const all: ListingItem[] = [];
  const seenAddresses = new Set<string>();
  let timeTo = Math.floor(Date.now() / 1000);

  for (let page = 0; page < PAGES; page++) {
    const params: Record<string, string | number | boolean> = { limit: 10, time_to: timeTo };
    if (chain === "solana") params["meme_platform_enabled"] = true; // include pump.fun-style launches

    const body = (await birdeyeGet("/defi/v2/tokens/new_listing", chain, params)) as {
      success?: boolean;
      message?: string;
      data?: { items?: ListingItem[] } | ListingItem[];
    };

    if (body?.success === false) {
      logger.warn({ chain, message: String(body.message ?? "") }, "Birdeye replied with an error");
      break;
    }

    const raw = Array.isArray(body?.data) ? body.data : body?.data?.items;
    const items = Array.isArray(raw) ? raw : [];
    for (const item of items) {
      if (item.address && !seenAddresses.has(item.address)) {
        seenAddresses.add(item.address);
        all.push(item);
      }
    }

    // Go further back in time for the next page, but stop once we're past the "new" window
    const times = items.map((i) => toMs(i.liquidityAddedAt)).filter((ms) => ms > 0);
    if (items.length < 10 || times.length === 0) break;
    const oldest = Math.min(...times);
    if (!isFresh(oldest)) break;
    timeTo = Math.floor(oldest / 1000);
  }
  return all;
}

/** DexScreener knows many tokens' links for free, so we ask it first (one request for all tokens) */
async function dexLookup(chain: string, addresses: string[]): Promise<Map<string, DexInfo>> {
  const out = new Map<string, DexInfo>();
  if (addresses.length === 0) return out;
  try {
    const res = await axios.get<{ pairs?: DexPair[] }>(
      DEXSCREENER_TOKENS_URL + addresses.slice(0, 30).join(","),
      { timeout: 10000 },
    );
    for (const pair of res.data?.pairs ?? []) {
      if (pair.chainId && pair.chainId !== chain) continue;
      const ca = pair.baseToken?.address?.toLowerCase();
      if (!ca) continue;

      const entry: DexInfo = out.get(ca) ?? {};
      if (!entry.pair || (pair.liquidity?.usd ?? 0) > (entry.pair.liquidity?.usd ?? 0)) {
        entry.pair = pair;
      }
      const socials = pair.info?.socials ?? [];
      entry.telegram ??= firstString(
        socials.find((s) => s.type === "telegram" || (s.url ?? "").includes("t.me"))?.url,
      );
      entry.twitter ??= firstString(
        socials.find((s) => s.type === "twitter" || /twitter\.com|x\.com/.test(s.url ?? ""))?.url,
      );
      entry.website ??= firstString(pair.info?.websites?.[0]?.url);
      entry.image ??= httpOrUndefined(pair.info?.imageUrl);
      out.set(ca, entry);
    }
  } catch {
    // the failure is already logged (with the HTTP status) by the request logger in worker.ts
  }
  return out;
}

/** Birdeye's own token links (needs a paid Birdeye plan, so it is only used when DexScreener has no Telegram link) */
async function birdeyeLinks(chain: string, address: string): Promise<Links> {
  const body = (await birdeyeGet("/defi/v3/token/meta-data/single", chain, { address })) as {
    data?: { logo_uri?: string; extensions?: Record<string, unknown> };
  };
  const ext = body?.data?.extensions ?? {};
  return {
    telegram: firstString(ext["telegram"]),
    website: firstString(ext["website"]),
    twitter: firstString(ext["twitter"]),
    image: httpOrUndefined(body?.data?.logo_uri),
  };
}

async function fetchChain(chain: string): Promise<TokenAlert[]> {
  const listings = await fetchListings(chain);

  // Only brand-new tokens we have not posted before
  const fresh = listings.filter((item) => {
    const created = toMs(item.liquidityAddedAt);
    return !!item.address && created > 0 && isFresh(created) && !hasSeen(item.address);
  });
  if (fresh.length === 0) return [];

  const dex = await dexLookup(
    chain,
    fresh.map((item) => item.address as string),
  );

  const alerts: TokenAlert[] = [];
  let metaCalls = 0;

  for (const item of fresh) {
    const ca = item.address as string;
    const d = dex.get(ca.toLowerCase());
    const pair = d?.pair;

    let telegram = d?.telegram;
    let website = d?.website;
    let twitter = d?.twitter;
    let image = d?.image ?? httpOrUndefined(item.logoURI);

    if (!telegram && Date.now() >= metaBlockedUntil && metaCalls < MAX_META_CALLS) {
      metaCalls++;
      try {
        const links = await birdeyeLinks(chain, ca);
        telegram = links.telegram;
        website ??= links.website;
        twitter ??= links.twitter;
        image ??= links.image;
      } catch (err) {
        const status = statusOf(err);
        if (status === 401 || status === 403) {
          metaBlockedUntil = Date.now() + 6 * HOUR_MS;
          logger.warn(
            "Your Birdeye plan can't read token links (it needs the Lite plan or higher) - using DexScreener for links instead",
          );
        } else if (status === 429) {
          metaCalls = MAX_META_CALLS; // stop link lookups for this check
        }
      }
    }

    if (!telegram) continue; // this bot only posts tokens that have a Telegram group

    alerts.push({
      ca,
      symbol: firstString(item.symbol, pair?.baseToken?.symbol) ?? ca.slice(0, 6).toUpperCase(),
      name: firstString(item.name, pair?.baseToken?.name),
      chain,
      telegramLink: toTelegramLink(telegram),
      source: `Birdeye (${chain})`,
      imageUrl: image,
      websiteUrl: website,
      twitterUrl: twitter,
      priceUsd: pair?.priceUsd ? parseFloat(pair.priceUsd) : undefined,
      fdv: pair?.fdv ?? undefined,
      volume24h: pair?.volume?.h24 ?? undefined,
      liquidity: pair?.liquidity?.usd ?? item.liquidity ?? undefined,
      buys24h: pair?.txns?.h24?.buys ?? undefined,
      sells24h: pair?.txns?.h24?.sells ?? undefined,
    });
  }
  return alerts;
}

export async function fetchBirdeye(_sinceMs: number): Promise<TokenAlert[]> {
  if (!API_KEY) {
    if (!announced) {
      announced = true;
      logger.info("Birdeye is OFF - add the BIRDEYE_API_KEY variable in Railway to turn it on");
    }
    return [];
  }

  const now = Date.now();
  if (now < pausedUntil || now < nextRunAt) return []; // not time yet
  nextRunAt = now + POLL_MINUTES * 60_000;

  if (!announced) {
    announced = true;
    const checksPerMonth = (30 * 24 * 60) / POLL_MINUTES;
    const worstCase = Math.round(checksPerMonth * CHAINS.length * PAGES * NEW_LISTING_CU);
    logger.info(
      { everyMinutes: POLL_MINUTES, chains: CHAINS, pages: PAGES },
      `Birdeye is ON - at most about ${worstCase.toLocaleString("en-US")} compute units a month for new-listing requests (${NEW_LISTING_CU} each), plus ${META_CU} per token-link lookup. Free plan = 30,000 a month.`,
    );
  }

  const results: TokenAlert[] = [];
  for (const chain of CHAINS) {
    try {
      results.push(...(await fetchChain(chain)));
    } catch (err) {
      const status = statusOf(err);
      const said = messageOf(err);
      const saidText = said ? ` Birdeye says: "${said}".` : "";
      if (status === 401 || status === 403) {
        pausedUntil = now + HOUR_MS;
        logger.warn(
          `Birdeye refused the request (HTTP ${status}).${saidText} Check the BIRDEYE_API_KEY variable and that your plan includes "New Listing". Pausing Birdeye for 1 hour.`,
        );
        break;
      }
      if (status === 429) {
        // "compute units used up" lasts for days; "too many per second" passes in minutes
        const quotaUsedUp = /compute|usage|quota|exceed|limit/i.test(said) && !/second|\brps\b/i.test(said);
        pausedUntil = now + (quotaUsedUp ? 3 * HOUR_MS : 15 * 60_000);
        logger.warn(
          quotaUsedUp
            ? `Birdeye says this month's compute units are used up.${saidText} Pausing Birdeye for 3 hours. Check your usage on Birdeye's dashboard, or raise BIRDEYE_POLL_MINUTES / lower BIRDEYE_PAGES.`
            : `Birdeye says too many requests (or this month's compute units are used up).${saidText} Pausing Birdeye for 15 minutes.`,
        );
        break;
      }
      logger.warn({ chain, err: String(err) }, "Birdeye fetch failed");
    }
  }

  logger.info({ source: "Birdeye", found: results.length }, "Birdeye fetch complete");
  return results;
}

/** Short status for the log line, e.g. "next check in 8 min" */
export function birdeyeNote(): string | undefined {
  if (!API_KEY) return "off - no API key";
  const now = Date.now();
  if (now < pausedUntil) return `paused ${Math.ceil((pausedUntil - now) / 60_000)} more min`;
  if (nextRunAt === 0) return undefined;
  return `next check in ${Math.max(0, Math.ceil((nextRunAt - now) / 60_000))} min`;
}

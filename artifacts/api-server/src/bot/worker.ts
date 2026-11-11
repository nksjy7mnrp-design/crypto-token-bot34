import axios from "axios";
import { logger } from "../lib/logger";
import { cacheInfo, hasSeen, markSeen, startedEmpty, unmarkSeen } from "./cache";
import { sendTokenAlert } from "./telegram";
import type { TokenAlert } from "./telegram";
import { fetchDexScreener } from "./sources/dexscreener";
import { fetchPumpFun } from "./sources/pumpfun";
import { fetchSunPump, sunpumpNote } from "./sources/sunpump";
import { fetchTop100Token } from "./sources/top100token";
import { fetchGeckoTerminal } from "./sources/geckoterminal";
import { fetchBirdeye, birdeyeNote } from "./sources/birdeye";

const INTERVAL_MS = 60_000;
const SEND_GAP_MS = 4_000; // Telegram allows roughly 20 posts a minute to one channel
const MAX_SENDS_PER_CYCLE = 10; // 10 posts x 4s keeps one cycle under a minute
const MAX_ATTEMPTS_PER_TOKEN = 3; // after 3 failed tries a token is dropped

interface Source {
  name: string;
  run: () => Promise<TokenAlert[]>;
  note?: () => string | undefined; // short status shown in the log line, e.g. "next check in 8 min"
}

const ALL_SOURCES: Source[] = [
  { name: "DexScreener", run: () => fetchDexScreener(0) },
  { name: "pump.fun", run: () => fetchPumpFun(0) },
  { name: "SunPump", run: () => fetchSunPump(0), note: sunpumpNote },
  { name: "Boosted", run: () => fetchTop100Token(0) },
  { name: "GeckoTerminal", run: () => fetchGeckoTerminal(0) },
  { name: "Birdeye", run: () => fetchBirdeye(0), note: birdeyeNote },
];

// Switch sources off with the Railway variable DISABLED_SOURCES, e.g.:  pump.fun, SunPump
// (capital letters, dots and spaces don't matter)
const simplify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const requestedOff = (process.env["DISABLED_SOURCES"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const offKeys = new Set(requestedOff.map(simplify));
const SOURCES = ALL_SOURCES.filter((source) => !offKeys.has(simplify(source.name)));
const unknownOff = requestedOff.filter(
  (name) => !ALL_SOURCES.some((source) => simplify(source.name) === simplify(name)),
);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Log every failed web request, so the logs show WHICH source is being blocked and why
axios.interceptors.response.use(
  (response) => response,
  (error) => {
    let host = "unknown";
    try {
      host = new URL(String(error?.config?.url ?? "")).host;
    } catch {
      /* ignore */
    }
    logger.warn(
      { host, status: error?.response?.status, code: error?.code },
      `HTTP request failed: ${host} - ${error?.message ?? "unknown error"}`,
    );
    return Promise.reject(error);
  },
);

let running = false;
// If the saved list is empty (first run, or Railway wiped it), the first cycle only REMEMBERS
// what is listed right now. Without this, every restart re-posted everything still in the lists.
let baselineActive = startedEmpty();
const failedAttempts = new Map<string, number>();

async function cycle(): Promise<void> {
  logger.info("Worker cycle started — polling all sources");

  const settled = await Promise.allSettled(SOURCES.map((source) => source.run()));

  // Work out what is genuinely NEW: not posted before, and not already taken from an earlier source this cycle
  const queue: TokenAlert[] = [];
  const claimed = new Set<string>();
  const summary: string[] = [];
  let found = 0;

  settled.forEach((result, i) => {
    const source = SOURCES[i];
    if (!source) return;
    const name = source.name;
    if (result.status === "rejected") {
      logger.warn({ source: name, err: String(result.reason) }, "Source crashed");
      summary.push(`${name}: crashed`);
      return;
    }
    let fresh = 0;
    for (const token of result.value) {
      found++;
      const key = token.ca.toLowerCase();
      if (hasSeen(key) || claimed.has(key)) continue;
      claimed.add(key);
      queue.push(token);
      fresh++;
    }
    const note = source.note?.();
    summary.push(`${name}: ${result.value.length} found, ${fresh} new${note ? ` (${note})` : ""}`);
  });

  logger.info(summary.join(" | "));

  // First cycle after a fresh start: remember everything, post nothing
  if (baselineActive) {
    if (found === 0) {
      logger.info("Fresh start — no token data yet, trying again next minute");
      return;
    }
    for (const token of queue) markSeen(token.ca);
    baselineActive = false;
    logger.info(
      { remembered: queue.length },
      "Fresh start: remembered the tokens listed right now WITHOUT posting them, so old ones are never re-sent. New launches are posted from the next cycle.",
    );
    return;
  }

  let sent = 0;
  let failed = 0;
  let handled = 0;

  for (const token of queue) {
    if (handled >= MAX_SENDS_PER_CYCLE) break; // the rest stay "new" and go out next cycle
    handled++;
    const key = token.ca.toLowerCase();
    if (handled > 1) await sleep(SEND_GAP_MS);

    markSeen(token.ca); // claim it first, so nothing can post it twice
    const result = await sendTokenAlert(token);

    if (result.ok) {
      sent++;
      failedAttempts.delete(key);
    } else {
      failed++;
      const attempts = (failedAttempts.get(key) ?? 0) + 1;
      failedAttempts.set(key, attempts);
      if (attempts < MAX_ATTEMPTS_PER_TOKEN) {
        unmarkSeen(token.ca); // it did NOT reach the channel, so try again next cycle
      } else {
        logger.error(
          { ca: token.ca, error: result.error },
          `Giving up on this token after ${attempts} failed attempts`,
        );
      }
    }
  }

  const waiting = queue.length - handled;
  logger.info(
    { sent, failed, waiting, skipped: found - queue.length },
    `Worker cycle complete - ${sent} posted, ${failed} failed, ${waiting} waiting for next cycle`,
  );
}

export async function runCycle(): Promise<void> {
  if (running) {
    logger.warn("Previous cycle is still running — skipping this one");
    return;
  }
  running = true;
  try {
    await cycle();
  } finally {
    running = false;
  }
}

export function startWorker(): void {
  const info = cacheInfo();
  logger.info(
    {
      ...info,
      deployment: process.env["RAILWAY_DEPLOYMENT_ID"],
      replica: process.env["RAILWAY_REPLICA_ID"],
    },
    "Crypto token monitor worker starting",
  );
  if (!info.persistent) {
    logger.warn(
      "No Railway Volume attached - the sent-token list is lost on every restart/redeploy. Attach a Volume to keep it.",
    );
  }

  const off = ALL_SOURCES.filter((source) => !SOURCES.includes(source)).map((source) => source.name);
  if (off.length > 0) {
    logger.info(`Sources switched off with DISABLED_SOURCES: ${off.join(", ")}`);
  }
  if (unknownOff.length > 0) {
    logger.warn(
      `DISABLED_SOURCES contains names I don't know: ${unknownOff.join(", ")}. Valid names: ${ALL_SOURCES.map((s) => s.name).join(", ")}`,
    );
  }

  runCycle().catch((err) => logger.error({ err }, "Worker cycle error"));

  setInterval(() => {
    runCycle().catch((err) => logger.error({ err }, "Worker cycle error"));
  }, INTERVAL_MS);
}

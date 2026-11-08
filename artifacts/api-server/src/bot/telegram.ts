import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";

const token = process.env["TELEGRAM_BOT_TOKEN"];
const channelId = process.env["TELEGRAM_CHANNEL_ID"];

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
if (!channelId) throw new Error("TELEGRAM_CHANNEL_ID is not set");

const bot = new TelegramBot(token);

export interface TokenAlert {
  symbol: string;
  ca: string;
  telegramLink: string;
  source: string;
  imageUrl?: string;
  name?: string;
  chain?: string;
  priceUsd?: number;
  fdv?: number;
  volume24h?: number;
  liquidity?: number;
  buys24h?: number;
  sells24h?: number;
  websiteUrl?: string;
  twitterUrl?: string;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;"); // a quote inside a link used to break the whole message
}

function buildDexUrl(ca: string, chain: string): string {
  const chainMap: Record<string, string> = {
    solana: "solana",
    bsc: "bsc",
    ethereum: "ethereum",
    eth: "ethereum",
    base: "base",
    arbitrum: "arbitrum",
    polygon: "polygon",
    avalanche: "avalanche",
    avax: "avalanche",
    tron: "tron",
  };
  const normalized = chainMap[chain.toLowerCase()] ?? chain.toLowerCase();
  return `https://dexscreener.com/${normalized}/${ca}`;
}

function formatUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(8).replace(/\.?0+$/, "")}`;
}

function formatPrice(n: number): string {
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  const exp = n.toExponential(3);
  return `$${exp}`;
}

function buildCaption(alert: TokenAlert): string {
  const name = alert.name ? escapeHtml(alert.name) : null;
  const symbol = escapeHtml(alert.symbol);
  const ca = escapeHtml(alert.ca);
  const source = escapeHtml(alert.source);
  const chain = alert.chain ? escapeHtml(alert.chain.toUpperCase()) : null;
  const dexUrl = alert.chain ? buildDexUrl(alert.ca, alert.chain) : null;

  const hasMarketData = alert.priceUsd !== undefined || alert.fdv !== undefined ||
    alert.volume24h !== undefined || alert.liquidity !== undefined;

  const hasTxData = alert.buys24h !== undefined || alert.sells24h !== undefined;

  const lines: string[] = [
    `🚀 <b>NEW TOKEN LAUNCH DETECTED</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    name ? `🪙 <b>$${symbol}</b>  —  ${name}` : `🪙 <b>$${symbol}</b>`,
    chain ? `⛓ <b>Chain:</b>  ${chain}` : ``,
    ``,
    `📋 <b>Contract Address:</b>`,
    `<code>${ca}</code>`,
  ];

  if (hasMarketData) {
    lines.push(``);
    lines.push(`📊 <b>Market Data:</b>`);

    const row1Parts: string[] = [];
    if (alert.priceUsd !== undefined) row1Parts.push(`💰 Price: <b>${formatPrice(alert.priceUsd)}</b>`);
    if (alert.fdv !== undefined) row1Parts.push(`📈 FDV: <b>${formatUsd(alert.fdv)}</b>`);
    if (row1Parts.length) lines.push(`  ${row1Parts.join("   ")}`);

    const row2Parts: string[] = [];
    if (alert.volume24h !== undefined) row2Parts.push(`📦 Vol 24h: <b>${formatUsd(alert.volume24h)}</b>`);
    if (alert.liquidity !== undefined) row2Parts.push(`💧 Liq: <b>${formatUsd(alert.liquidity)}</b>`);
    if (row2Parts.length) lines.push(`  ${row2Parts.join("   ")}`);

    if (hasTxData) {
      const buys = alert.buys24h ?? 0;
      const sells = alert.sells24h ?? 0;
      const total = buys + sells;
      const bullRatio = total > 0 ? Math.round((buys / total) * 10) : 0;
      const bar = "🟢".repeat(bullRatio) + "🔴".repeat(10 - bullRatio);
      lines.push(`  🔄 Txns: <b>${buys}↑ / ${sells}↓</b>  ${bar}`);
    }
  }

  lines.push(``);
  lines.push(`🔗 <b>Links:</b>`);
  lines.push(`  💬 <a href="${escapeHtml(alert.telegramLink)}">Telegram Community</a>`);
  if (dexUrl) lines.push(`  📊 <a href="${escapeHtml(dexUrl)}">DexScreener Chart</a>`);
  if (alert.websiteUrl) lines.push(`  🌐 <a href="${escapeHtml(alert.websiteUrl)}">Website</a>`);
  if (alert.twitterUrl) lines.push(`  🐦 <a href="${escapeHtml(alert.twitterUrl)}">Twitter / X</a>`);

  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`📡 <i>Detected via ${source}</i>`);

  return lines.filter((l) => l !== undefined && l !== null).join("\n");
}

// ─── Helpers for safe sending ────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Length Telegram will count for a photo caption (limit is 1024) */
function captionLength(html: string): number {
  return unescapeHtml(html.replace(/<[^>]+>/g, "")).length;
}

/** Same message without any HTML (links written out as "text: url") */
function toPlainText(html: string): string {
  const withLinks = html.replace(/<a href="([^"]*)">([^<]*)<\/a>/g, "$2: $1");
  return unescapeHtml(withLinks.replace(/<[^>]+>/g, ""));
}

function describeError(err: unknown): { message: string; retryAfter?: number } {
  const e = err as { message?: string; response?: { body?: unknown } };
  let body: unknown = e?.response?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* not JSON */
    }
  }
  const b = body as { description?: string; parameters?: { retry_after?: number } } | undefined;
  return {
    message: b?.description ?? e?.message ?? String(err),
    retryAfter: b?.parameters?.retry_after,
  };
}

/** If Telegram says "too many messages, retry after N seconds", wait and try again (up to 2 times) */
async function withRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const { retryAfter } = describeError(err);
      if (retryAfter !== undefined && retryAfter <= 60 && attempt < 2) {
        logger.warn({ retryAfter }, "Telegram says slow down — waiting, then retrying");
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Posts one alert to the channel. Returns { ok: true } only if Telegram accepted it,
 * so the caller knows whether it really reached the channel.
 */
export async function sendTokenAlert(alert: TokenAlert): Promise<SendResult> {
  const caption = buildCaption(alert);
  const info = { ca: alert.ca, symbol: alert.symbol, source: alert.source };
  let lastError = "";

  // 1) Photo + caption (only when the caption fits Telegram's 1024-character photo limit)
  if (alert.imageUrl && captionLength(caption) <= 1024) {
    try {
      await withRetry(() =>
        bot.sendPhoto(channelId!, alert.imageUrl!, { caption, parse_mode: "HTML" }),
      );
      logger.info(info, "Alert sent");
      return { ok: true };
    } catch (err) {
      lastError = describeError(err).message;
      logger.warn({ ...info, error: lastError }, "Photo alert failed — trying text instead");
    }
  }

  // 2) Normal text message
  try {
    await withRetry(() => bot.sendMessage(channelId!, caption, { parse_mode: "HTML" }));
    logger.info(info, "Alert sent (text)");
    return { ok: true };
  } catch (err) {
    lastError = describeError(err).message;
    logger.warn({ ...info, error: lastError }, "Text alert failed — trying plain text");
  }

  // 3) Last resort: no HTML at all, in case Telegram rejected the formatting
  try {
    await withRetry(() => bot.sendMessage(channelId!, toPlainText(caption)));
    logger.info(info, "Alert sent (plain text)");
    return { ok: true };
  } catch (err) {
    lastError = describeError(err).message;
  }

  logger.error({ ...info, error: lastError }, "Failed to send Telegram alert");
  return { ok: false, error: lastError };
}

import axios from "axios";

// How old a token's trading pair may be and still count as "new".
// Default 10 minutes. Set the Railway variable MAX_TOKEN_AGE_MINUTES (e.g. 120) to widen it.
const configuredMinutes = Number(process.env["MAX_TOKEN_AGE_MINUTES"]);
export const TEN_MIN_MS =
  (Number.isFinite(configuredMinutes) && configuredMinutes > 0 ? configuredMinutes : 10) * 60 * 1000;

export interface PairInfo {
  createdAt: number;
  symbol?: string;
  name?: string;
  priceUsd?: number;
  fdv?: number;
  volume24h?: number;
  liquidity?: number;
  buys24h?: number;
  sells24h?: number;
}

/**
 * Batch-fetches pair data for a list of token addresses via DexScreener.
 * Returns a Map of lowercase(CA) → PairInfo (earliest creation time + full market data).
 */
export async function getPairInfo(addresses: string[]): Promise<Map<string, PairInfo>> {
  const result = new Map<string, PairInfo>();
  if (addresses.length === 0) return result;

  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += 30) {
    chunks.push(addresses.slice(i, i + 30));
  }

  for (const chunk of chunks) {
    try {
      const res = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`,
        { timeout: 10000 },
      );
      const pairs: Array<{
        baseToken?: { address?: string; name?: string; symbol?: string };
        pairCreatedAt?: number;
        priceUsd?: string;
        fdv?: number;
        volume?: { h24?: number };
        liquidity?: { usd?: number };
        txns?: { h24?: { buys?: number; sells?: number } };
      }> = res.data?.pairs ?? [];

      for (const pair of pairs) {
        const ca = pair.baseToken?.address?.toLowerCase();
        const createdAt = pair.pairCreatedAt;
        if (!ca || !createdAt) continue;
        const existing = result.get(ca);
        if (!existing || existing.createdAt > createdAt) {
          result.set(ca, {
            createdAt,
            symbol: pair.baseToken?.symbol,
            name: pair.baseToken?.name,
            priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : undefined,
            fdv: pair.fdv ?? undefined,
            volume24h: pair.volume?.h24 ?? undefined,
            liquidity: pair.liquidity?.usd ?? undefined,
            buys24h: pair.txns?.h24?.buys ?? undefined,
            sells24h: pair.txns?.h24?.sells ?? undefined,
          });
        }
      }
    } catch (_) {}
  }

  return result;
}

/**
 * Convenience wrapper — returns only createdAt times (backward-compatible).
 */
export async function getCreationTimes(addresses: string[]): Promise<Map<string, number>> {
  const info = await getPairInfo(addresses);
  const result = new Map<string, number>();
  for (const [ca, { createdAt }] of info) {
    result.set(ca, createdAt);
  }
  return result;
}

/** Returns true if createdAtMs is within the last 10 minutes */
export function isRecent(createdAtMs: number): boolean {
  return Date.now() - createdAtMs <= TEN_MIN_MS;
}

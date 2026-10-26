export interface DexTokenData {
  name: string;
  symbol: string;
  priceUsd: number;
  change24h: number;
  logoUrl?: string;
}

const CHAIN_MAP: Record<string, string> = {
  ethereum:  'ethereum',
  bsc:       'bsc',
  base:      'base',
  solana:    'solana',
  polygon:   'polygon',
  arbitrum:  'arbitrum',
  optimism:  'optimism',
  avalanche: 'avalanche',
  tron:      'tron',
  robinhood: 'robinhood',
};

// DexScreener's /tokens endpoint returns at most ~30 pairs per response, shared
// across all addresses in the request. A batch of tokens with many pairs can push
// a low-liquidity token's pair out of the response, so any address that comes back
// without a pair is retried in smaller batches until it is checked on its own.
const MAX_PAIRS_PER_RESPONSE = 30;

type DexPair = {
  chainId?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  priceChange?: { h24?: number };
  info?: { imageUrl?: string };
};

async function queryDexBatch(
  addresses: string[],
  dexChain: string,
  result: Map<string, DexTokenData>
): Promise<{ ok: boolean; truncated: boolean }> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${addresses.join(',')}`,
      { headers: { Accept: 'application/json' }, next: { revalidate: 60 } }
    );
    if (!res.ok) return { ok: false, truncated: false };
    const data = await res.json();
    const pairs = (data.pairs ?? []) as DexPair[];

    for (const pair of pairs) {
      if (pair.chainId !== dexChain) continue;
      const addr = pair.baseToken?.address?.toLowerCase();
      if (!addr || result.has(addr)) continue;
      result.set(addr, {
        name: pair.baseToken?.name ?? '',
        symbol: pair.baseToken?.symbol ?? '',
        priceUsd: parseFloat(pair.priceUsd ?? '0') || 0,
        change24h: pair.priceChange?.h24 ?? 0,
        logoUrl: pair.info?.imageUrl,
      });
    }
    return { ok: true, truncated: pairs.length >= MAX_PAIRS_PER_RESPONSE };
  } catch {
    return { ok: false, truncated: false };
  }
}

// Batch query DexScreener for token metadata + prices.
// Returns a map of lowercase address → token data.
export async function getDexTokens(
  addresses: string[],
  chain: string
): Promise<Map<string, DexTokenData>> {
  const result = new Map<string, DexTokenData>();
  const unique = [...new Set(addresses.map(a => a.toLowerCase()))];
  if (!unique.length) return result;

  const dexChain = CHAIN_MAP[chain] ?? chain;

  // Work queue of batches; truncated batches are split and re-queued.
  const queue: string[][] = [];
  for (let i = 0; i < unique.length; i += 30) queue.push(unique.slice(i, i + 30));

  let requests = 0;
  const MAX_REQUESTS = 60; // safety cap (DexScreener allows ~300 requests/min)

  while (queue.length && requests < MAX_REQUESTS) {
    const batch = queue.shift()!;
    const { ok, truncated } = await queryDexBatch(batch, dexChain, result);
    requests++;

    if (ok && truncated) {
      const missing = batch.filter(a => !result.has(a));
      if (missing.length > 1) {
        const half = Math.ceil(missing.length / 2);
        queue.push(missing.slice(0, half), missing.slice(half));
      } else if (missing.length === 1 && batch.length > 1) {
        queue.push(missing);
      }
    }
    if (queue.length) await new Promise(r => setTimeout(r, 150));
  }
  return result;
}

const BASE = 'https://api.coingecko.com/api/v3';
const cache = new Map<string, { data: unknown; ts: number }>();
const TTL = 60_000;

async function cgFetch<T>(path: string, retries = 1): Promise<T> {
  const cached = cache.get(path);
  if (cached && Date.now() - cached.ts < TTL) return cached.data as T;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429 && retries > 0) {
    await new Promise(r => setTimeout(r, 2000));
    return cgFetch<T>(path, retries - 1);
  }

  if (!res.ok) throw new Error(`CoinGecko ${res.status}: ${path}`);
  const data = await res.json();
  cache.set(path, { data, ts: Date.now() });
  return data as T;
}

export interface CgPrice {
  usd: number;
  eur: number;
  usd_24h_change: number;
}

export async function getCoinPrices(ids: string[]): Promise<Record<string, CgPrice>> {
  if (!ids.length) return {};
  const path = `/simple/price?ids=${ids.join(',')}&vs_currencies=usd,eur&include_24hr_change=true`;
  return cgFetch<Record<string, CgPrice>>(path);
}

// The free CoinGecko API only accepts ONE contract address per request
// (asking for more returns HTTP 400), so tokens are queried one at a time.
// Only use this as a fallback for a few tokens that DexScreener couldn't price.
export async function getTokenPricesByContract(
  platform: string,
  addresses: string[],
  maxRequests = 5
): Promise<Record<string, CgPrice>> {
  const out: Record<string, CgPrice> = {};
  const unique = [...new Set(addresses.map(a => a.toLowerCase()))].slice(0, maxRequests);
  for (const addr of unique) {
    const path = `/simple/token_price/${platform}?contract_addresses=${addr}&vs_currencies=usd,eur&include_24hr_change=true`;
    try {
      const data = await cgFetch<Record<string, CgPrice>>(path, 0);
      if (data[addr]) out[addr] = data[addr];
    } catch {
      // unknown token or rate limit — skip
    }
  }
  return out;
}

export async function searchCoin(query: string): Promise<{ id: string; symbol: string; name: string }[]> {
  try {
    const data = await cgFetch<{ coins: { id: string; symbol: string; name: string }[] }>(`/search?query=${encodeURIComponent(query)}`);
    return data.coins.slice(0, 5);
  } catch {
    return [];
  }
}

// Alchemy EVM support for all non-Solana, non-Tron chains.
// Covers: BNB, Polygon, Arbitrum, Optimism, Avalanche, Robinhood Chain.

import { Chain } from '@/types';
import { getDexTokens } from '@/lib/dexscreener';

const KEY = process.env.ALCHEMY_API_KEY || '';

// Alchemy RPC endpoints (all EVM chains Alchemy supports)
const ALCHEMY_RPCS: Partial<Record<Chain, string>> = KEY
  ? {
      ethereum:  `https://eth-mainnet.g.alchemy.com/v2/${KEY}`,
      bsc:       `https://bnb-mainnet.g.alchemy.com/v2/${KEY}`,
      base:      `https://base-mainnet.g.alchemy.com/v2/${KEY}`,
      polygon:   `https://polygon-mainnet.g.alchemy.com/v2/${KEY}`,
      arbitrum:  `https://arb-mainnet.g.alchemy.com/v2/${KEY}`,
      optimism:  `https://opt-mainnet.g.alchemy.com/v2/${KEY}`,
      avalanche: `https://avax-mainnet.g.alchemy.com/v2/${KEY}`,
      robinhood: `https://robinhood-mainnet.g.alchemy.com/v2/${KEY}`,
    }
  : {};

// Reliable public RPCs for native balance fallback (no auth, cloud-friendly)
const PUBLIC_RPCS: Partial<Record<Chain, string[]>> = {
  ethereum: [
    'https://cloudflare-eth.com',
    'https://eth-rpc.publicnode.com',
    'https://rpc.ankr.com/eth',
  ],
  bsc: [
    'https://bsc-rpc.publicnode.com',
    'https://1rpc.io/bnb',
    'https://bsc-dataseed1.defibit.io',
    'https://bsc-dataseed2.defibit.io',
    'https://bsc-dataseed1.ninicoin.io',
  ],
  base: [
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
  ],
  polygon: [
    'https://polygon-rpc.com/',
    'https://polygon-rpc.publicnode.com',
    'https://1rpc.io/matic',
  ],
  avalanche: [
    'https://api.avax.network/ext/bc/C/rpc',
    'https://avalanche-c-chain-rpc.publicnode.com',
  ],
  arbitrum: [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://1rpc.io/arb',
  ],
  optimism: [
    'https://mainnet.optimism.io',
    'https://optimism-rpc.publicnode.com',
    'https://1rpc.io/op',
  ],
  robinhood: [
    'https://rpc.mainnet.chain.robinhood.com',
  ],
};

// Top BEP-20 tokens for BSC fallback (when Alchemy unavailable)
const BSC_TOP_TOKENS = [
  { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT',  name: 'Tether USD',           decimals: 18 },
  { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC',  name: 'USD Coin',             decimals: 18 },
  { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD',  name: 'BUSD',                 decimals: 18 },
  { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', symbol: 'CAKE',  name: 'PancakeSwap Token',    decimals: 18 },
  { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB',  name: 'Wrapped BNB',          decimals: 18 },
  { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', symbol: 'BTCB',  name: 'BTCB Token',           decimals: 18 },
  { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', symbol: 'ETH',   name: 'Ethereum Token',        decimals: 18 },
  { address: '0xbA2aE424d960c26247Dd6c32edC70B295c744C43', symbol: 'DOGE',  name: 'Dogecoin',             decimals: 8  },
  { address: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE', symbol: 'XRP',   name: 'XRP Token',            decimals: 18 },
  { address: '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47', symbol: 'ADA',   name: 'Cardano Token',        decimals: 18 },
];

const BALANCE_OF = '0x70a08231';

async function rpcCall(url: string, method: string, params: unknown[], timeoutMs = 7000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      signal: ctrl.signal,
      next: { revalidate: 60 },
    } as RequestInit);
    const data = await res.json();
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

// Try Alchemy then public RPCs in sequence; returns first non-null result.
async function rpcWithFallback(chain: Chain, method: string, params: unknown[]): Promise<unknown> {
  const alchemyUrl = ALCHEMY_RPCS[chain];
  const publicUrls = PUBLIC_RPCS[chain] ?? [];
  const candidates = [...(alchemyUrl ? [alchemyUrl] : []), ...publicUrls];

  let lastErr: unknown;
  for (const url of candidates) {
    try {
      const result = await rpcCall(url, method, params);
      if (result !== null && result !== undefined) return result;
    } catch (err) {
      lastErr = err;
    }
  }
  console.error(`[alchemyEvm/${chain}] all RPCs failed for`, method, lastErr instanceof Error ? lastErr.message : lastErr);
  throw lastErr ?? new Error(`No RPC available for ${chain}`);
}

export async function getAlchemyNativeBalance(chain: Chain, address: string): Promise<number> {
  try {
    const hex = await rpcWithFallback(chain, 'eth_getBalance', [address, 'latest']) as string;
    return parseInt(hex, 16) / 1e18;
  } catch {
    return 0;
  }
}

export interface AlchemyTokenBalance {
  contractAddress: string;
  contractAddressOriginal: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: bigint;
}

// Returns true if Alchemy is configured for this chain (key present + chain supported)
export function isAlchemyAvailable(chain: Chain): boolean {
  return !!KEY && !!ALCHEMY_RPCS[chain];
}

// Limits for the token pipeline (keeps us inside Vercel's timeout budget)
const MAX_BALANCE_PAGES = 10;      // up to ~1000 tokens from alchemy_getTokenBalances
const MAX_PRICED_TOKENS = 60;      // tokens with a DexScreener price → always get metadata
const MAX_UNPRICED_TOKENS = 20;    // a few unpriced ones, so CoinGecko can still try them

const ZERO_BALANCE = '0x0000000000000000000000000000000000000000000000000000000000000000';

// Step 1: read EVERY page of balances (cheap — balances only, no metadata).
async function getAllRawBalances(alchemyUrl: string, walletAddress: string) {
  const all: Array<{ contractAddress: string; tokenBalance: string }> = [];
  let pageKey: string | undefined;
  for (let page = 0; page < MAX_BALANCE_PAGES; page++) {
    const params: unknown[] = pageKey
      ? [walletAddress, 'erc20', { pageKey }]
      : [walletAddress, 'erc20'];
    const res = await rpcCall(alchemyUrl, 'alchemy_getTokenBalances', params, 10000) as {
      tokenBalances?: Array<{ contractAddress: string; tokenBalance: string }>;
      pageKey?: string;
    };
    if (!res?.tokenBalances) break;
    all.push(...res.tokenBalances);
    if (!res.pageKey) break;
    pageKey = res.pageKey;
  }
  return all.filter(t => t.tokenBalance && t.tokenBalance !== ZERO_BALANCE && t.tokenBalance !== '0x');
}

export async function getAlchemyTokenBalances(chain: Chain, walletAddress: string): Promise<AlchemyTokenBalance[]> {
  const alchemyUrl = ALCHEMY_RPCS[chain];

  if (alchemyUrl) {
    try {
      const nonZero = await getAllRawBalances(alchemyUrl, walletAddress);
      if (!nonZero.length) return []; // Alchemy responded, wallet has no tokens (authoritative)

      // Step 2: ask DexScreener which of these tokens actually trade (have a price).
      // Spam airdrops have no liquidity, so they drop to the back of the queue.
      const dex = await getDexTokens(nonZero.map(t => t.contractAddress.toLowerCase()), chain);
      const priced   = nonZero.filter(t =>  (dex.get(t.contractAddress.toLowerCase())?.priceUsd ?? 0) > 0);
      const unpriced = nonZero.filter(t => !((dex.get(t.contractAddress.toLowerCase())?.priceUsd ?? 0) > 0));
      const selected = [
        ...priced.slice(0, MAX_PRICED_TOKENS),
        ...unpriced.slice(0, MAX_UNPRICED_TOKENS),
      ];

      // Step 3: fetch name/symbol/decimals only for the selected tokens.
      const results: AlchemyTokenBalance[] = [];
      const CHUNK = 15;
      for (let i = 0; i < selected.length; i += CHUNK) {
        const chunk = selected.slice(i, i + CHUNK);
        const metas = await Promise.all(
          chunk.map(async t => {
            try {
              const balance = BigInt(t.tokenBalance);
              if (balance <= 0n) return null;
              const meta = await rpcCall(alchemyUrl, 'alchemy_getTokenMetadata', [t.contractAddress]) as {
                decimals: number | null; name: string | null; symbol: string | null;
              };
              const d = dex.get(t.contractAddress.toLowerCase());
              return {
                contractAddress: t.contractAddress.toLowerCase(),
                contractAddressOriginal: t.contractAddress,
                symbol: meta?.symbol || d?.symbol || t.contractAddress.slice(0, 6),
                name: meta?.name || d?.name || 'Unknown Token',
                decimals: meta?.decimals ?? 18,
                balance,
              } satisfies AlchemyTokenBalance;
            } catch { return null; }
          })
        );
        results.push(...(metas.filter(Boolean) as AlchemyTokenBalance[]));
        if (i + CHUNK < selected.length) await new Promise(r => setTimeout(r, 50));
      }
      return results;
    } catch (err) {
      console.error(`[alchemyEvm/${chain}] alchemy_getTokenBalances failed:`, err instanceof Error ? err.message : err);
    }
  }

  // Fallback for BSC only: check top BEP-20 tokens via public RPC
  if (chain === 'bsc') return getBscFallbackTokens(walletAddress);

  // For other chains without Alchemy, no token discovery via public RPC
  return [];
}

async function getBscFallbackTokens(walletAddress: string): Promise<AlchemyTokenBalance[]> {
  const publicUrls = PUBLIC_RPCS.bsc ?? [];
  const results: AlchemyTokenBalance[] = [];
  const CHUNK = 5;

  for (let i = 0; i < BSC_TOP_TOKENS.length; i += CHUNK) {
    const chunk = BSC_TOP_TOKENS.slice(i, i + CHUNK);
    const bals = await Promise.all(chunk.map(async t => {
      const calldata = BALANCE_OF + walletAddress.replace('0x', '').toLowerCase().padStart(64, '0');
      for (const url of publicUrls) {
        try {
          const result = await rpcCall(url, 'eth_call', [{ to: t.address, data: calldata }, 'latest']) as string;
          const balance = result && result !== '0x' ? BigInt(result) : 0n;
          if (balance <= 0n) return null;
          return {
            contractAddress: t.address.toLowerCase(),
            contractAddressOriginal: t.address,
            symbol: t.symbol, name: t.name, decimals: t.decimals, balance,
          } satisfies AlchemyTokenBalance;
        } catch {
          // try next RPC
        }
      }
      return null;
    }));
    results.push(...(bals.filter(Boolean) as AlchemyTokenBalance[]));
    if (i + CHUNK < BSC_TOP_TOKENS.length) await new Promise(r => setTimeout(r, 100));
  }
  return results;
}

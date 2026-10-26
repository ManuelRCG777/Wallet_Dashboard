import { NextRequest, NextResponse } from 'next/server';
import { Chain, NativeBalance, TokenHolding, ChainSummary, PortfolioData, Wallet } from '@/types';
import { CHAIN_CONFIG, isEtherscanChain, isAlchemyEvmChain } from '@/lib/chains';
import { getNativeBalance, getERC20Balances } from '@/lib/etherscan';
import { getSolanaBalance, getSolanaTokenAccounts } from '@/lib/alchemy';
import { getAlchemyNativeBalance, getAlchemyTokenBalances } from '@/lib/alchemyEvm';
import { getTronNativeBalance, getTronTokenBalances } from '@/lib/tron';
import { getCoinPrices, getTokenPricesByContract, CgPrice } from '@/lib/coingecko';
import { getDexTokens } from '@/lib/dexscreener';
import { getJupiterTokenMap } from '@/lib/jupiterTokens';

// Token positions worth less than this (in USD) are treated as dust/airdrop spam and hidden.
const MIN_TOKEN_USD = 5;

function evmLogoUrl(chain: Chain, checksumAddress: string): string {
  const twChain: Partial<Record<Chain, string>> = {
    ethereum: 'ethereum',
    base:     'base',
    polygon:  'polygon',
    arbitrum: 'arbitrum',
    optimism: 'optimism',
    avalanche: 'avalanchec',
  };
  const p = twChain[chain];
  return p
    ? `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${p}/assets/${checksumAddress}/logo.png`
    : '';
}

export async function POST(req: NextRequest) {
  try {
    const { wallets }: { wallets: Wallet[] } = await req.json();
    if (!wallets?.length) return NextResponse.json({ error: 'No wallets' }, { status: 400 });

    // ── 1. Native balances ───────────────────────────────────────────────────
    const nativeBalances = (
      await Promise.all(
        wallets.map(async (w): Promise<NativeBalance | null> => {
          try {
            const cfg = CHAIN_CONFIG[w.chain];
            let balance = 0;

            if (w.chain === 'solana') {
              balance = await getSolanaBalance(w.address);
            } else if (w.chain === 'tron') {
              balance = await getTronNativeBalance(w.address);
            } else if (isAlchemyEvmChain(w.chain)) {
              balance = await getAlchemyNativeBalance(w.chain, w.address);
            } else {
              // Etherscan V2 free chains: ethereum, base
              const raw = await getNativeBalance(w.chain, w.address);
              balance = Number(raw) / Math.pow(10, cfg.decimals);
            }

            return {
              chain: w.chain, walletId: w.id, walletAddress: w.address,
              walletName: w.name, balance, symbol: cfg.symbol, name: cfg.name,
              usdValue: 0, eurValue: 0, usdPrice: 0, eurPrice: 0, change24h: 0,
            };
          } catch {
            return null;
          }
        })
      )
    ).filter(Boolean) as NativeBalance[];

    // ── 2. Token holdings ────────────────────────────────────────────────────
    const jupiterMap = await getJupiterTokenMap();

    const allTokens = (
      await Promise.all(
        wallets.map(async (w): Promise<TokenHolding[]> => {
          try {
            // Solana
            if (w.chain === 'solana') {
              const accounts = await getSolanaTokenAccounts(w.address);
              return accounts
                .map(acc => {
                  const info = acc.account.data.parsed.info;
                  const uiAmt = info.tokenAmount.uiAmount;
                  if (!uiAmt || uiAmt <= 0) return null;
                  const meta = jupiterMap.get(info.mint);
                  return {
                    chain: 'solana' as Chain,
                    walletId: w.id, walletAddress: w.address,
                    contractAddress: info.mint,
                    symbol: meta?.symbol ?? info.mint.slice(0, 4) + '…',
                    name: meta?.name ?? 'Unknown SPL Token',
                    decimals: info.tokenAmount.decimals,
                    balance: uiAmt,
                    logoUrl: meta?.logoURI,
                    usdPrice: 0, eurPrice: 0, usdValue: 0, eurValue: 0,
                    change24h: 0, portfolioPercent: 0,
                  } as TokenHolding;
                })
                .filter(Boolean) as TokenHolding[];
            }

            // Tron
            if (w.chain === 'tron') {
              const tokens = await getTronTokenBalances(w.address);
              return tokens.map(t => ({
                chain: 'tron' as Chain,
                walletId: w.id, walletAddress: w.address,
                contractAddress: t.contractAddress,
                symbol: t.symbol, name: t.name, decimals: t.decimals,
                balance: t.balance,
                logoUrl: '',
                usdPrice: 0, eurPrice: 0, usdValue: 0, eurValue: 0,
                change24h: 0, portfolioPercent: 0,
              }));
            }

            // Alchemy EVM chains (BSC, Polygon, Arbitrum, Optimism, Avalanche)
            if (isAlchemyEvmChain(w.chain)) {
              const tokens = await getAlchemyTokenBalances(w.chain, w.address);
              return tokens.map(t => ({
                chain: w.chain as Chain,
                walletId: w.id, walletAddress: w.address,
                contractAddress: t.contractAddress,
                symbol: t.symbol, name: t.name, decimals: t.decimals,
                balance: Number(t.balance) / Math.pow(10, t.decimals),
                logoUrl: '',
                usdPrice: 0, eurPrice: 0, usdValue: 0, eurValue: 0,
                change24h: 0, portfolioPercent: 0,
              }));
            }

            // Etherscan V2 free chains (Ethereum, Base)
            const tokens = await getERC20Balances(w.chain, w.address);
            return tokens.map(t => ({
              chain: w.chain as Chain,
              walletId: w.id, walletAddress: w.address,
              contractAddress: t.contractAddress,
              symbol: t.symbol, name: t.name, decimals: t.decimals,
              balance: Number(t.balance) / Math.pow(10, t.decimals),
              logoUrl: evmLogoUrl(w.chain, t.contractAddressOriginal),
              usdPrice: 0, eurPrice: 0, usdValue: 0, eurValue: 0,
              change24h: 0, portfolioPercent: 0,
            }));
          } catch {
            return [];
          }
        })
      )
    ).flat();

    // ── 3. CoinGecko prices for native coins ─────────────────────────────────
    const uniqueNativeIds = [...new Set(wallets.map(w => CHAIN_CONFIG[w.chain].coingeckoId))];
    let nativePrices: Record<string, CgPrice> = {};
    try { nativePrices = await getCoinPrices(uniqueNativeIds); } catch {}

    let eurUsdRate = 0.92;
    for (const p of Object.values(nativePrices)) {
      if (p.usd > 0 && p.eur > 0) { eurUsdRate = p.eur / p.usd; break; }
    }

    for (const nb of nativeBalances) {
      const price = nativePrices[CHAIN_CONFIG[nb.chain].coingeckoId];
      if (price) {
        nb.usdPrice = price.usd || 0;
        nb.eurPrice = price.eur || 0;
        nb.usdValue = nb.balance * nb.usdPrice;
        nb.eurValue = nb.balance * nb.eurPrice;
        nb.change24h = price.usd_24h_change || 0;
      }
    }

    // ── 4. DexScreener prices for tokens (all chains) ────────────────────────
    const chainGroups = new Map<string, TokenHolding[]>();
    for (const t of allTokens) {
      const list = chainGroups.get(t.chain) ?? [];
      list.push(t);
      chainGroups.set(t.chain, list);
    }

    const dexMaps = await Promise.all(
      Array.from(chainGroups.entries()).map(async ([chain, tokens]) => {
        const addrs = [...new Set(tokens.map(t => t.contractAddress))];
        const map = await getDexTokens(addrs, chain);
        return { chain, map };
      })
    );
    const dexByChain = new Map(dexMaps.map(({ chain, map }) => [chain, map]));

    for (const token of allTokens) {
      const dex = dexByChain.get(token.chain)?.get(token.contractAddress.toLowerCase());
      if (!dex) continue;
      if (token.symbol.endsWith('…') || token.name === 'Unknown SPL Token' || token.name === 'Unknown Token') {
        if (dex.symbol) token.symbol = dex.symbol;
        if (dex.name) token.name = dex.name;
        if (dex.logoUrl) token.logoUrl = dex.logoUrl;
      }
      if (dex.priceUsd > 0) {
        token.usdPrice = dex.priceUsd;
        token.eurPrice = dex.priceUsd * eurUsdRate;
        token.usdValue = token.balance * token.usdPrice;
        token.eurValue = token.balance * token.eurPrice;
        token.change24h = dex.change24h;
        if (dex.logoUrl && !token.logoUrl) token.logoUrl = dex.logoUrl;
      }
    }

    // ── 5. CoinGecko token prices (supplement / override DexScreener) ────────
    const uniqueTokenChains = [...new Set(allTokens.map(t => t.chain))];
    for (const chain of uniqueTokenChains) {
      const addrs = allTokens.filter(t => t.chain === chain).map(t => t.contractAddress);
      if (!addrs.length) continue;
      const platform = CHAIN_CONFIG[chain].coingeckoPlatform;
      try {
        const prices = await getTokenPricesByContract(platform, addrs);
        for (const token of allTokens.filter(t => t.chain === chain)) {
          const p = prices[token.contractAddress.toLowerCase()];
          if (!p) continue;
          token.usdPrice = p.usd || token.usdPrice;
          token.eurPrice = p.eur || token.eurPrice;
          token.usdValue = token.balance * token.usdPrice;
          token.eurValue = token.balance * token.eurPrice;
          token.change24h = p.usd_24h_change ?? token.change24h;
        }
      } catch {}
    }

    // ── 5b. Hide dust and unpriced spam ──────────────────────────────────────
    const visibleTokens = allTokens.filter(t => t.usdValue >= MIN_TOKEN_USD);

    // ── 6. Portfolio totals ──────────────────────────────────────────────────
    const totalNativeUsd = nativeBalances.reduce((s, b) => s + b.usdValue, 0);
    const totalNativeEur = nativeBalances.reduce((s, b) => s + b.eurValue, 0);
    const totalTokenUsd = visibleTokens.reduce((s, t) => s + t.usdValue, 0);
    const totalTokenEur = visibleTokens.reduce((s, t) => s + t.eurValue, 0);
    const totalUsd = totalNativeUsd + totalTokenUsd;
    const totalEur = totalNativeEur + totalTokenEur;

    for (const token of visibleTokens) {
      token.portfolioPercent = totalUsd > 0 ? (token.usdValue / totalUsd) * 100 : 0;
    }

    let change24h = 0;
    if (totalUsd > 0) {
      const allItems = [
        ...nativeBalances.map(b => ({ usdValue: b.usdValue, change24h: b.change24h })),
        ...visibleTokens.map(t => ({ usdValue: t.usdValue, change24h: t.change24h })),
      ];
      change24h = allItems.reduce((s, i) => s + (i.usdValue / totalUsd) * i.change24h, 0);
    }

    // ── 7. Chain summaries ───────────────────────────────────────────────────
    const chainMap = new Map<Chain, ChainSummary>();
    for (const nb of nativeBalances) {
      chainMap.set(nb.chain, {
        chain: nb.chain, name: CHAIN_CONFIG[nb.chain].name,
        symbol: CHAIN_CONFIG[nb.chain].symbol, color: CHAIN_CONFIG[nb.chain].color,
        totalUsd: nb.usdValue, totalEur: nb.eurValue,
        nativeBalance: nb.balance, nativeUsdValue: nb.usdValue,
        change24h: nb.change24h, tokenCount: 0,
      });
    }
    for (const token of visibleTokens) {
      if (!chainMap.has(token.chain)) {
        chainMap.set(token.chain, {
          chain: token.chain, name: CHAIN_CONFIG[token.chain].name,
          symbol: CHAIN_CONFIG[token.chain].symbol, color: CHAIN_CONFIG[token.chain].color,
          totalUsd: 0, totalEur: 0, nativeBalance: 0, nativeUsdValue: 0,
          change24h: 0, tokenCount: 0,
        });
      }
      const cs = chainMap.get(token.chain)!;
      cs.totalUsd += token.usdValue;
      cs.totalEur += token.eurValue;
      cs.tokenCount++;
    }

    const portfolio: PortfolioData = {
      totalUsd, totalEur, change24h,
      nativeBalances,
      tokens: visibleTokens.sort((a, b) => b.usdValue - a.usdValue),
      chains: Array.from(chainMap.values()).sort((a, b) => b.totalUsd - a.totalUsd),
      lastUpdated: Math.floor(Date.now() / 1000),
    };

    return NextResponse.json(portfolio);
  } catch (err) {
    console.error('[portfolio]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

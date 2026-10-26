const API_KEY = process.env.ALCHEMY_API_KEY || '';
const SOLANA_ALCHEMY = API_KEY ? `https://solana-mainnet.g.alchemy.com/v2/${API_KEY}` : '';

// Public Solana RPCs — reliable from Vercel/cloud environments
const SOLANA_FALLBACK_RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];

let _reqId = 1;

async function fetchWithTimeout(url: string, body: string, ms = 7000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const id = _reqId++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const urls = SOLANA_ALCHEMY ? [SOLANA_ALCHEMY, ...SOLANA_FALLBACK_RPCS] : SOLANA_FALLBACK_RPCS;

  let lastErr: unknown;
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, body);
      if (!res.ok) throw new Error(`Solana HTTP ${res.status} from ${url}`);
      const data = await res.json();
      if (data.error) throw new Error(`Solana RPC error: ${data.error.message}`);
      return data.result as T;
    } catch (err) {
      lastErr = err;
      // try next RPC
    }
  }
  console.error('[alchemy/solana] all RPCs failed for', method, lastErr instanceof Error ? lastErr.message : lastErr);
  throw lastErr;
}

export async function getSolanaBalance(address: string): Promise<number> {
  const result = await rpc<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
  return result.value / 1e9;
}

export interface SolanaTokenAccount {
  pubkey: string;
  account: {
    data: {
      parsed: {
        info: {
          mint: string;
          owner: string;
          tokenAmount: {
            amount: string;
            decimals: number;
            uiAmount: number | null;
          };
        };
        type: string;
      };
      program: string;
    };
  };
}

export async function getSolanaTokenAccounts(address: string): Promise<SolanaTokenAccount[]> {
  const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  try {
    const result = await rpc<{ value: SolanaTokenAccount[] }>('getTokenAccountsByOwner', [
      address,
      { programId: TOKEN_PROGRAM_ID },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    return result?.value ?? [];
  } catch {
    return [];
  }
}

export interface SolanaSignature {
  signature: string;
  slot: number;
  err: unknown;
  memo: string | null;
  blockTime: number | null;
}

export async function getSolanaSignatures(address: string, limit = 50): Promise<SolanaSignature[]> {
  try {
    return await rpc<SolanaSignature[]>('getSignaturesForAddress', [address, { limit }]);
  } catch {
    return [];
  }
}

export interface SolanaTransaction {
  blockTime: number | null;
  slot: number;
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean }>;
      instructions: Array<{
        programId: string;
        parsed?: {
          type: string;
          info: Record<string, unknown>;
        };
      }>;
    };
    signatures: string[];
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances: Array<{ accountIndex: number; mint: string; uiTokenAmount: { uiAmount: number | null; decimals: number } }>;
    postTokenBalances: Array<{ accountIndex: number; mint: string; uiTokenAmount: { uiAmount: number | null; decimals: number } }>;
  } | null;
}

export async function getSolanaTransaction(signature: string): Promise<SolanaTransaction | null> {
  try {
    return await rpc<SolanaTransaction | null>('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]);
  } catch {
    return null;
  }
}

export async function getSolanaTransactionsBatch(signatures: string[]): Promise<(SolanaTransaction | null)[]> {
  if (!signatures.length) return [];

  const body = JSON.stringify(
    signatures.map((sig, i) => ({
      jsonrpc: '2.0',
      id: i + 1,
      method: 'getTransaction',
      params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
    }))
  );

  const urls = SOLANA_ALCHEMY ? [SOLANA_ALCHEMY, ...SOLANA_FALLBACK_RPCS] : SOLANA_FALLBACK_RPCS;

  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, body);
      const results = await res.json();
      if (!Array.isArray(results)) continue;
      return results
        .sort((a, b) => a.id - b.id)
        .map(r => r.result as SolanaTransaction | null);
    } catch {
      // try next
    }
  }
  return signatures.map(() => null);
}

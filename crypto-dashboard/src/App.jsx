import { useState, useEffect, useCallback, useRef, useMemo } from "react";

// ─── Live Price Hook (CoinGecko) ───
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function useCryptoPrices() {
  const [prices, setPrices] = useState(null);
  const [sparklines, setSparklines] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchPrices = useCallback(async () => {
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true"
      );
      if (!res.ok) throw new Error("CoinGecko API failed");
      const data = await res.json();
      setPrices(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSparklines = useCallback(async () => {
    const ids = ["bitcoin", "ethereum", "solana"];
    const result = {};
    for (let i = 0; i < ids.length; i++) {
      if (i > 0) await delay(1500); // CoinGecko free tier rate limit
      try {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/coins/${ids[i]}/market_chart?vs_currency=usd&days=1`
        );
        if (res.status === 429) { await delay(3000); continue; } // back off on 429
        if (!res.ok) continue;
        const data = await res.json();
        const raw = data.prices || []; // [[timestamp, price], ...]
        const step = Math.max(1, Math.floor(raw.length / 50));
        result[ids[i]] = raw.filter((_, j) => j % step === 0);
      } catch {}
    }
    if (Object.keys(result).length > 0) setSparklines(result);
  }, []);

  useEffect(() => {
    fetchPrices();
    // Delay sparkline fetch to avoid competing with price fetch for rate limit
    const sparkTimeout = setTimeout(fetchSparklines, 2000);
    const priceInterval = setInterval(fetchPrices, 60000);
    const sparklineInterval = setInterval(fetchSparklines, 300000);
    return () => { clearTimeout(sparkTimeout); clearInterval(priceInterval); clearInterval(sparklineInterval); };
  }, [fetchPrices, fetchSparklines]);

  return { prices, sparklines, loading, error, refetch: fetchPrices };
}

// ─── Crypto News Hook (cryptocurrency.cv free API) ───
// Fetches a large batch once; articles are shared/filtered client-side for per-card news.
function parseNewsItems(json) {
  // Handle both {articles:[]} and {Data:[]} shapes defensively
  const raw = json.articles || json.Data || json.data || [];
  return raw.map((a, i) => ({
    id: i,
    title: a.title || a.headline || "",
    url: a.link || a.url || "",
    source: a.source || a.sourceName || "",
    timeAgo: a.timeAgo || "",
    time: a.pubDate ? new Date(a.pubDate).getTime() : (a.published_on ? a.published_on * 1000 : 0),
  })).filter((a) => a.title && a.url);
}

function useCryptoNews() {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const prevRef = useRef([]);

  const fetchNews = useCallback(async () => {
    try {
      const res = await fetch("https://cryptocurrency.cv/api/news?limit=50");
      if (!res.ok) throw new Error(`News ${res.status}`);
      const json = await res.json();
      const items = parseNewsItems(json);
      if (items.length) {
        prevRef.current = items;
        setArticles(items);
        setError(null);
      } else {
        throw new Error("Empty response");
      }
    } catch {
      // Keep stale data on failure; only surface error if we have nothing at all
      if (prevRef.current.length === 0) setError("News unavailable");
      else setArticles(prevRef.current);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNews();
    const iv = setInterval(fetchNews, 300000);
    return () => clearInterval(iv);
  }, [fetchNews]);

  return { articles, loading, error };
}

// Filter a list of news articles by one or more keywords (case-insensitive, checks title)
function filterNewsByKeywords(articles, keywords) {
  if (!articles.length || !keywords.length) return [];
  const lc = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  return articles.filter((a) => {
    const t = a.title.toLowerCase();
    return lc.some((k) => t.includes(k));
  });
}

// ─── GeckoTerminal Trending Tokens Hook ───
function readCache(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null")?.data || []; } catch { return []; }
}
function readCacheTs(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null")?.ts || null; } catch { return null; }
}
function writeCache(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() })); } catch {}
}

// ─── GeckoTerminal shared helpers ───
const getNetworksToFetch = (chain) =>
  chain === "Solana" ? ["solana"] : chain === "Base" ? ["base"] : ["solana", "base"];

function fetchPoolsIntoList(data, network, out, { volMin, liqMin, h1Min, h24HrMin }) {
  const chainId = network === "solana" ? "solana" : "base";
  const tokenMap = new Map();
  (data.included || []).forEach((item) => {
    if (item.type === "token") tokenMap.set(item.id, item.attributes);
  });
  (data.data || []).forEach((pool) => {
    const baseTokenId = pool.relationships?.base_token?.data?.id;
    const tokenAttrs  = tokenMap.get(baseTokenId);
    if (!tokenAttrs) return;
    const ca    = baseTokenId?.replace(`${network}_`, "") || "";
    const vol24 = parseFloat(pool.attributes.volume_usd?.h24 || 0);
    const liq   = parseFloat(pool.attributes.reserve_in_usd || 0);
    if (vol24 < volMin || liq < liqMin) return;
    const h1Buys   = pool.attributes.transactions?.h1?.buys;
    const h1Sells  = pool.attributes.transactions?.h1?.sells;
    const h24Buys  = pool.attributes.transactions?.h24?.buys  || 0;
    const h24Sells = pool.attributes.transactions?.h24?.sells || 0;
    const h1Present = h1Buys != null && h1Sells != null;
    const h1Txns    = h1Present ? (h1Buys + h1Sells) : 0;
    if (h1Present ? h1Txns < h1Min : Math.round((h24Buys + h24Sells) / 24) < h24HrMin) return;
    out.push({
      baseToken: { symbol: tokenAttrs.symbol || "???", name: tokenAttrs.name || "Unknown", address: ca },
      chainId,
      marketCap:  parseFloat(pool.attributes.market_cap_usd || pool.attributes.fdv_usd || 0),
      fdv:        parseFloat(pool.attributes.fdv_usd || 0),
      volume:     { h1: parseFloat(pool.attributes.volume_usd?.h1 || 0), h6: parseFloat(pool.attributes.volume_usd?.h6 || 0), h24: vol24 },
      liquidity:  { usd: liq },
      priceChange: {
        h1: pool.attributes.price_change_percentage?.h1 != null ? parseFloat(pool.attributes.price_change_percentage.h1) : null,
        h6: pool.attributes.price_change_percentage?.h6 != null ? parseFloat(pool.attributes.price_change_percentage.h6) : null,
      },
      txns: {
        h1:  { buys: h1Buys  || 0, sells: h1Sells  || 0 },
        h24: { buys: h24Buys || 0, sells: h24Sells || 0 },
      },
      pairCreatedAt: pool.attributes.pool_created_at ? new Date(pool.attributes.pool_created_at).getTime() : null,
      priceUsd:    pool.attributes.base_token_price_usd,
      icon:        tokenAttrs.image_url || null,
      pairAddress: pool.attributes.address,
      source: "gt",
      boostAmount: 0,
      url: `https://dexscreener.com/${chainId}/${pool.attributes.address}`,
    });
  });
}

// Tokens that always dominate volume but aren't interesting for discovery
const BLACKLISTED_CAS = new Set([
  "So11111111111111111111111111111111111111112",  // Wrapped SOL
]);

function dedupeAndSlice(tokens, sortByVol = false) {
  const arr  = sortByVol ? [...tokens].sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0)) : tokens;
  const seen = new Set();
  return arr.filter((t) => {
    const addr = t.baseToken.address;
    if (!addr || seen.has(addr) || BLACKLISTED_CAS.has(addr)) return false;
    seen.add(addr);
    return true;
  }).slice(0, 40);
}

function useTrendingTokens(activeChain) {
  const cacheKey = `gt_trending_${activeChain}`;
  // Seed state from localStorage so page reload shows data immediately
  const [tokens, setTokens] = useState(() => readCache(cacheKey));
  const [loading, setLoading] = useState(() => readCache(cacheKey).length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(() => readCacheTs(cacheKey)); // epoch ms of last successful fetch
  const [error, setError] = useState(null);
  const fetchIdRef = useRef(0);
  const hasDataRef = useRef(readCache(cacheKey).length > 0);

  const fetchTrending = useCallback(async () => {
    const myId = ++fetchIdRef.current;
    // First load → show skeletons. Background refresh → keep existing tokens, show spinner.
    if (!hasDataRef.current) { setLoading(true); setError(null); }
    else setRefreshing(true);
    try {
      const networksToFetch = getNetworksToFetch(activeChain);
      const allTokens = [];
      let successPages = 0;

      for (const network of networksToFetch) {
        for (const page of [1, 2]) {
          try {
            const res = await fetch(
              `https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools?page=${page}&include=base_token`
            );
            if (!res.ok) continue;
            fetchPoolsIntoList(await res.json(), network, allTokens, { volMin: 500, liqMin: 5000, h1Min: 20, h24HrMin: 30 });
            successPages++;
          } catch {}
        }
      }

      if (successPages === 0) throw new Error("GeckoTerminal unreachable — rate limited or offline.");
      const deduped = dedupeAndSlice(allTokens);

      if (fetchIdRef.current !== myId) return;
      const now = Date.now();
      setTokens(deduped);
      setFetchedAt(now);
      setError(null);
      hasDataRef.current = true;
      writeCache(cacheKey, deduped);
    } catch (err) {
      if (fetchIdRef.current !== myId) return;
      // If we already have data on screen, keep it — just stop the spinner silently
      if (!hasDataRef.current) setError(err.message);
    } finally {
      if (fetchIdRef.current !== myId) return;
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeChain]);

  // When activeChain changes: immediately load that chain's cache (or blank + skeleton)
  useEffect(() => {
    const cached = readCache(cacheKey);
    if (cached.length > 0) {
      setTokens(cached);
      setFetchedAt(readCacheTs(cacheKey));
      hasDataRef.current = true;
      setLoading(false);
    } else {
      setTokens([]);
      setFetchedAt(null);
      hasDataRef.current = false;
      setLoading(true);
    }
    setError(null);
  }, [activeChain]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchTrending();
    const interval = setInterval(fetchTrending, 120000);
    return () => { fetchIdRef.current++; clearInterval(interval); };
  }, [fetchTrending]);

  return { tokens, loading, refreshing, fetchedAt, error, refetch: fetchTrending };
}

// ─── Pinned Tokens Hook ───
function usePinnedTokens(pinnedCAs) {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchPinned = useCallback(async () => {
    if (pinnedCAs.length === 0) { setTokens([]); return; }
    setLoading(true);
    try {
      const byChain = {};
      pinnedCAs.forEach(({ ca, chainId }) => {
        if (!byChain[chainId]) byChain[chainId] = [];
        byChain[chainId].push(ca);
      });

      const allPairs = [];
      for (const [chainId, addresses] of Object.entries(byChain)) {
        const chunks = [];
        for (let i = 0; i < addresses.length; i += 30) chunks.push(addresses.slice(i, i + 30));
        for (const chunk of chunks) {
          try {
            const res = await fetch(`https://api.dexscreener.com/tokens/v1/${chainId}/${chunk.join(",")}`);
            if (res.ok) {
              const pairs = await res.json();
              if (Array.isArray(pairs)) allPairs.push(...pairs);
            }
          } catch { }
        }
      }

      const tokenMap = new Map();
      allPairs.forEach((pair) => {
        const addr = pair.baseToken?.address;
        if (!addr) return;
        const existing = tokenMap.get(addr);
        if (!existing || (pair.volume?.h24 || 0) > (existing.volume?.h24 || 0)) {
          tokenMap.set(addr, { ...pair, icon: pair.icon || pair.info?.imageUrl || null });
        }
      });

      setTokens(pinnedCAs.map(({ ca }) => tokenMap.get(ca)).filter(Boolean));
    } catch { } finally {
      setLoading(false);
    }
  }, [pinnedCAs]);

  useEffect(() => { fetchPinned(); }, [fetchPinned]);
  return { tokens, loading, refetch: fetchPinned };
}

// ─── Solana RPC helper — tries endpoints in order with retry + backoff ───
const SOLANA_RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana",
  "https://mainnet.helius-rpc.com/?api-key=0dd8f0ec-f2a5-4f9e-b275-379afa3e73cd",
  "https://solana-mainnet.g.alchemy.com/v2/demo",
  "https://solana.public-rpc.com",
];

async function postRPC(body, timeoutMs = 12000) {
  let lastErr = new Error("All RPC endpoints failed");
  for (const rpc of SOLANA_RPCS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (res.status === 403) { lastErr = new Error("RPC access denied"); break; } // skip this endpoint
        if (res.status === 429) { lastErr = new Error("Rate limited"); await delay(2000 * (attempt + 1)); continue; }
        if (!res.ok)            { lastErr = new Error(`RPC error HTTP ${res.status}`); break; }
        const data = await res.json();
        if (data.error) {
          if (data.error?.code === -32601) throw new Error(data.error.message || "RPC error");
          lastErr = new Error(data.error?.message || "RPC error");
          continue;
        }
        return data;
      } catch (e) {
        if (e.name === "AbortError") { lastErr = new Error("RPC request timed out"); break; }
        if (e.message?.includes("RPC error")) throw e;
        lastErr = e;
        if (attempt === 0) await delay(1000);
      }
    }
  }
  throw lastErr;
}

// ─── Wallet Tokens Hook (Solana RPC) ───
function useWalletTokens(address) {
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetch_ = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      // Query both Token Program and Token-2022 Program
      const TOKEN_PROGRAMS = [
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   // SPL Token
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",   // Token-2022
      ];
      const allAccounts = [];
      for (const pid of TOKEN_PROGRAMS) {
        try {
          const rpcData = await postRPC({
            jsonrpc: "2.0", id: 1,
            method: "getTokenAccountsByOwner",
            params: [address, { programId: pid }, { encoding: "jsonParsed" }],
          });
          const accts = rpcData.result?.value || [];
          allAccounts.push(...accts);
        } catch { } // if one program fails, still try the other
      }

      const rawHoldings = allAccounts
        .map((a) => ({
          mint: a.account.data.parsed.info.mint,
          amount: a.account.data.parsed.info.tokenAmount.uiAmount || 0,
        }))
        .filter((t) => t.amount > 0)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 30);

      if (rawHoldings.length === 0) { setHoldings([]); return; }

      const mints = rawHoldings.map((h) => h.mint);
      const chunks = [];
      for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));

      const allPairs = [];
      for (const chunk of chunks) {
        try {
          const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`);
          if (res.ok) {
            const pairs = await res.json();
            if (Array.isArray(pairs)) allPairs.push(...pairs);
          }
        } catch { }
      }

      const tokenMap = new Map();
      allPairs.forEach((pair) => {
        const addr = pair.baseToken?.address;
        if (!addr) return;
        const existing = tokenMap.get(addr);
        if (!existing || (pair.volume?.h24 || 0) > (existing.volume?.h24 || 0)) {
          tokenMap.set(addr, { ...pair, icon: pair.icon || pair.info?.imageUrl || null });
        }
      });

      const enriched = rawHoldings
        .map((h) => ({ ...h, pair: tokenMap.get(h.mint) || null }))
        .filter((h) => h.pair);

      setHoldings(enriched);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { fetch_(); }, [fetch_]);
  return { holdings, loading, error, refetch: fetch_ };
}

// ─── Token Holders Hook (Solana RPC) ───
function useTokenHolders(ca, chainId, enabled) {
  const [holders, setHolders] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!enabled || !ca || chainId !== "solana") return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const [largestData, supplyData] = await Promise.all([
          postRPC({ jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [ca, { commitment: "confirmed" }] }),
          postRPC({ jsonrpc: "2.0", id: 2, method: "getTokenSupply", params: [ca] }),
        ]);
        if (cancelled) return;
        const accounts = largestData.result?.value || [];
        const totalSupply = parseFloat(supplyData.result?.value?.uiAmount || 0);
        if (accounts.length === 0 || totalSupply === 0) { setHolders([]); return; }

        // Resolve token accounts → owner wallet addresses
        const addrs = accounts.map((a) => a.address);
        const multiData = await postRPC({ jsonrpc: "2.0", id: 3, method: "getMultipleAccounts", params: [addrs, { encoding: "jsonParsed" }] });
        if (cancelled) return;
        const infos = multiData.result?.value || [];

        const enriched = accounts
          .map((acc, i) => {
            const owner = infos[i]?.data?.parsed?.info?.owner || acc.address;
            const amount = parseFloat(acc.uiAmount || 0);
            const pct = totalSupply > 0 ? (amount / totalSupply) * 100 : 0;
            return { tokenAccount: acc.address, owner, amount, pct };
          })
          .filter((h) => h.amount > 0);

        setHolders(enriched);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [enabled, ca, chainId, refreshKey]);

  return { holders, loading, error, refetch };
}

// ─── Pool Chart Hook (GeckoTerminal OHLCV for token cards) ───
// Maps DexScreener chainId → GeckoTerminal network slug
const CHAIN_TO_GT_NETWORK = {
  solana: "solana", base: "base", ethereum: "eth", bsc: "bsc",
  arbitrum: "arbitrum", polygon: "polygon", avalanche: "avax",
  optimism: "optimism", blast: "blast", sui: "sui",
};

// Timeframe → { timespan, aggregate, limit } for GeckoTerminal OHLCV API
const TF_CONFIG = {
  "1H":  { timespan: "hour", aggregate: 1, limit: 6  }, // last 6h at 1h res, shows recent movement
  "12H": { timespan: "hour", aggregate: 1, limit: 12 },
  "1D":  { timespan: "hour", aggregate: 1, limit: 24 },
};

// Successful-only cache keyed by network:pool:tf (never caches null/empty results)
const chartCache = {};

// Cache: "network:ca" → GT pool address (only caches successes)
const gtPoolCache = {};
const gtPoolPending = {}; // dedup concurrent lookups for same token
async function findGTPool(network, tokenCA) {
  const key = `${network}:${tokenCA}`;
  if (gtPoolCache[key]) return gtPoolCache[key];
  if (gtPoolPending[key]) return gtPoolPending[key];
  const promise = (async () => {
    try {
      const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${tokenCA}/pools?page=1`;
      let res = await fetch(url);
      if (res.status === 429) { await delay(2000); res = await fetch(url); }
      if (!res.ok) return null;
      const json = await res.json();
      const pools = json.data || [];
      if (!pools.length) return null;
      const addr = pools[0].attributes?.address;
      if (addr) gtPoolCache[key] = addr;
      return addr || null;
    } catch {
      return null;
    } finally {
      delete gtPoolPending[key];
    }
  })();
  gtPoolPending[key] = promise;
  return promise;
}

// gtPoolAddr: if the token came from GeckoTerminal, pass its pool address directly to skip the lookup
function usePoolChart(chainId, tokenCA, gtPoolAddr, enabled, timeframe = "1D") {
  const [priceData, setPriceData] = useState(null);
  const [volumeData, setVolumeData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !tokenCA || !chainId) return;
    const network = CHAIN_TO_GT_NETWORK[chainId] ?? chainId;
    const { timespan, aggregate, limit } = TF_CONFIG[timeframe] || TF_CONFIG["1D"];
    const cacheKey = `${network}:${tokenCA}:${timeframe}`;

    // Serve from cache only if we previously got real data
    if (chartCache[cacheKey]) {
      setPriceData(chartCache[cacheKey].priceData);
      setVolumeData(chartCache[cacheKey].volumeData);
      return;
    }

    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setPriceData(null); // clear stale data from previous timeframe
      setVolumeData(null);
      try {
        // Use known GT pool address if available, otherwise look it up from token CA
        const poolAddress = gtPoolAddr || await findGTPool(network, tokenCA);
        if (!poolAddress) throw new Error("No GT pool found for token");
        if (cancelled) return;
        const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/${timespan}?aggregate=${aggregate}&limit=${limit}`;
        let res = await fetch(url);
        if (res.status === 429) { await delay(2000); res = await fetch(url); }
        if (!res.ok) throw new Error(`OHLCV ${res.status}`);
        const json = await res.json();
        const candles = (json.data?.attributes?.ohlcv_list || []).slice().reverse();
        const prices  = candles.map((c) => [c[0] * 1000, c[4]]);
        const volumes = candles.map((c) => [c[0] * 1000, c[5]]);
        const pd = prices.length >= 2 ? prices : null;
        const vd = volumes.length >= 2 ? volumes : null;
        // Only cache when we have real data — empty results stay uncached so retries work
        if (pd) chartCache[cacheKey] = { priceData: pd, volumeData: vd };
        if (!cancelled) { setPriceData(pd); setVolumeData(vd); }
      } catch {
        if (!cancelled) { setPriceData(null); setVolumeData(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [enabled, chainId, tokenCA, gtPoolAddr, timeframe]);

  return { priceData, volumeData, loading };
}

// ─── Helpers ───
function formatPrice(num) {
  if (!num || num === 0) return "$0";
  if (num >= 1000) return "$" + num.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (num >= 1) return "$" + num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (num >= 0.01) return "$" + num.toFixed(4);
  if (num >= 0.0001) return "$" + num.toFixed(6);
  return "$" + num.toExponential(2);
}

function formatChange(num) {
  if (num === null || num === undefined) return "—";
  const sign = num >= 0 ? "+" : "";
  return sign + num.toFixed(1) + "%";
}

function formatVolume(num) {
  if (!num) return "$0";
  if (num >= 1e12) return "$" + (num / 1e12).toFixed(2) + "T";
  if (num >= 1e9)  return "$" + (num / 1e9).toFixed(1)  + "B";
  if (num >= 1e6)  return "$" + (num / 1e6).toFixed(1)  + "M";
  if (num >= 1e3)  return "$" + (num / 1e3).toFixed(1)  + "K";
  if (num >= 10)   return "$" + Math.round(num);
  return "$" + num.toFixed(2);
}

function formatTokenAmount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(2);
}

function formatAge(createdAt) {
  if (!createdAt) return "—";
  const diffMs = Math.max(0, Date.now() - createdAt);
  const diffMins = Math.round(diffMs / 60000);
  if (diffMins < 1) return "new";
  if (diffMins < 60) return diffMins + "m";
  const diffHrs = diffMs / 3600000;
  if (diffHrs < 2) {
    const m = Math.round(diffMins % 60);
    return "1h" + (m > 0 ? " " + m + "m" : "");
  }
  if (diffHrs < 24) return Math.round(diffHrs) + "h";
  const diffDays = diffHrs / 24;
  if (diffDays < 30) return Math.round(diffDays) + "d";
  return Math.round(diffDays / 30) + "mo";
}

function getChainLabel(chainId) {
  if (chainId === "solana") return "SOL";
  if (chainId === "base") return "BASE";
  if (chainId === "ethereum") return "ETH";
  return chainId?.toUpperCase() || "?";
}

function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < (str || "").length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 45%, 22%)`;
}

function getBubbleMapsUrl(chainId, ca) {
  const chainMap = { solana: "sol", base: "base", ethereum: "eth" };
  const chain = chainMap[chainId] || chainId;
  return `https://app.bubblemaps.io/${chain}/token/${ca}`;
}

function truncateAddr(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function getGreeting() {
  const h = new Date().getHours();
  if (h >= 5  && h < 12) return { title: "Morning",   panel: "Good morning",   sub: "Here's what happened overnight",       emoji: "☕" };
  if (h >= 12 && h < 17) return { title: "Afternoon", panel: "Good afternoon", sub: "Here's what's happening right now",     emoji: "☀️" };
  if (h >= 17 && h < 21) return { title: "Evening",   panel: "Good evening",   sub: "Here's what's been moving today",      emoji: "🌆" };
  return                         { title: "Night",     panel: "Late night",     sub: "Checking in while the world sleeps",   emoji: "🌙" };
}

function getHolderType(pct) {
  if (pct >= 10) return { label: "🐋 Whale",  color: "#60a5fa", border: "#1d4ed888" };
  if (pct >= 5)  return { label: "🦈 Large",  color: "#818cf8", border: "#4f46e588" };
  if (pct >= 1)  return { label: "🐬 Mid",    color: "#34d399", border: "#05966988" };
  return               { label: "🐟 Small",  color: "#64748b", border: "#1e293b"   };
}

// Parses filter inputs like "50K", "1.5M", "200" into a raw number
function parseVolInput(str) {
  if (!str) return 0;
  const s = str.trim().toUpperCase();
  if (s.endsWith("B")) return parseFloat(s) * 1e9;
  if (s.endsWith("M")) return parseFloat(s) * 1e6;
  if (s.endsWith("K")) return parseFloat(s) * 1e3;
  return parseFloat(s) || 0;
}

// ─── Components ───
const ChainBadge = ({ chain }) => {
  const colors = {
    SOL: { bg: "#9945FF22", text: "#c084fc", border: "#9945FF44" },
    BASE: { bg: "#0052FF22", text: "#60a5fa", border: "#0052FF44" },
    ETH: { bg: "#627EEA22", text: "#818cf8", border: "#627EEA44" },
  };
  const c = colors[chain] || { bg: "#ffffff11", text: "#94a3b8", border: "#ffffff22" };
  return (
    <span style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}`, fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, letterSpacing: 0.5, fontFamily: "monospace" }}>
      {chain}
    </span>
  );
};

const BuySellBar = ({ buys, sells }) => {
  const total = buys + sells;
  if (total === 0) return null;
  const buyPct = (buys / total) * 100;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
      <span style={{ color: "#4ade80", fontSize: 12, fontWeight: 500, minWidth: 70 }}>{buys.toLocaleString()} buys</span>
      <div style={{ flex: 1, height: 4, borderRadius: 2, background: "#ef444488", overflow: "hidden" }}>
        <div style={{ width: `${buyPct}%`, height: "100%", background: "#4ade80", borderRadius: 2 }} />
      </div>
      <span style={{ color: "#f87171", fontSize: 12, fontWeight: 500, minWidth: 70, textAlign: "right" }}>{sells.toLocaleString()} sells</span>
    </div>
  );
};

const PriceChangeText = ({ value }) => {
  if (value === null || value === undefined) return <span style={{ color: "#475569", fontSize: 13 }}>—</span>;
  const positive = value >= 0;
  return <span style={{ color: positive ? "#4ade80" : "#f87171", fontSize: 13, fontWeight: 600 }}>{formatChange(value)}</span>;
};

// ─── Holder Panel ───
const HolderPanel = ({ ca, chainId, holders, loading, error, onRefresh }) => {
  const [copiedIdx, setCopiedIdx] = useState(null);

  const copyOwner = (addr, idx) => {
    navigator.clipboard?.writeText(addr);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1500);
  };

  if (chainId !== "solana") {
    const explorerUrl = chainId === "ethereum"
      ? `https://etherscan.io/token/${ca}#balances`
      : `https://basescan.org/token/${ca}#balances`;
    const explorerName = chainId === "ethereum" ? "Etherscan" : "Basescan";
    return (
      <div style={{ marginTop: 12, padding: "10px 14px", background: "#0d1321", borderRadius: 8, border: "1px solid #1e293b" }}>
        <span style={{ color: "#64748b", fontSize: 12 }}>Holder analysis is Solana-only. </span>
        <a href={explorerUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa", fontSize: 12 }}>View on {explorerName} ↗</a>
      </div>
    );
  }

  const top10pct = holders ? holders.slice(0, 10).reduce((s, h) => s + h.pct, 0) : null;
  const concColor = top10pct == null ? "#64748b" : top10pct > 60 ? "#f87171" : top10pct > 40 ? "#f59e0b" : "#4ade80";
  const concLabel = top10pct == null ? "" : top10pct > 60 ? " ⚠ concentrated" : top10pct > 40 ? " moderate" : " healthy";

  return (
    <div style={{ marginTop: 12, padding: "10px 14px", background: "#0d1321", borderRadius: 8, border: "1px solid #1e293b" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 700 }}>Top Holders</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {top10pct != null && (
            <span style={{ fontSize: 11, color: concColor, fontWeight: 700 }}>
              Top 10: {top10pct.toFixed(1)}%{concLabel}
            </span>
          )}
          {onRefresh && (
            <button
              onClick={(e) => { e.stopPropagation(); onRefresh(); }}
              title="Refresh holders"
              style={{ background: "none", border: "none", color: loading ? "#334155" : "#475569", cursor: loading ? "default" : "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}
              disabled={loading}
            >
              ↺
            </button>
          )}
        </div>
      </div>

      {loading && <div style={{ color: "#475569", fontSize: 12, textAlign: "center", padding: "8px 0" }}>Fetching holders…</div>}
      {error && <div style={{ color: "#fca5a5", fontSize: 12 }}>⚠ {error}</div>}
      {!loading && holders && holders.length === 0 && (
        <div style={{ color: "#475569", fontSize: 12 }}>No holder data found.</div>
      )}

      {!loading && holders && holders.map((h, i) => {
        const type = getHolderType(h.pct);
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 0", borderBottom: i < holders.length - 1 ? "1px solid #1e293b44" : "none" }}>
            <span style={{ color: "#334155", fontSize: 11, minWidth: 16 }}>{i + 1}</span>
            <span style={{ flex: 1, color: "#64748b", fontSize: 11, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {truncateAddr(h.owner)}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); copyOwner(h.owner, i); }}
              title="Copy wallet address"
              style={{ background: "none", border: "none", color: copiedIdx === i ? "#4ade80" : "#334155", cursor: "pointer", fontSize: 11, padding: "1px 3px", flexShrink: 0 }}
            >
              {copiedIdx === i ? "✓" : "⎘"}
            </button>
            <span style={{ fontSize: 10, color: type.color, border: `1px solid ${type.border}`, borderRadius: 4, padding: "1px 5px", fontWeight: 700, whiteSpace: "nowrap" }}>
              {type.label}
            </span>
            <span style={{ color: "#475569", fontSize: 11, minWidth: 44, textAlign: "right" }}>{h.pct.toFixed(2)}%</span>
            <a
              href={`https://gmgn.ai/sol/address/${h.owner}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Check PnL on GMGN"
              style={{ color: "#818cf8", fontSize: 10, textDecoration: "none", whiteSpace: "nowrap", flexShrink: 0 }}
            >
              PnL ↗
            </a>
          </div>
        );
      })}

      {!loading && holders && holders.length > 0 && (
        <div style={{ color: "#334155", fontSize: 10, marginTop: 8 }}>Note: some entries may be LP pools or program accounts</div>
      )}
    </div>
  );
};

// ─── Token Card ───
const TokenCard = ({ pair, isPinned, onPin, onUnpin, walletHolders = [], rank, allNews = [], newsLoading = false }) => {
  const symbol = pair.baseToken?.symbol || "???";
  const name = pair.baseToken?.name || "Unknown";
  const chain = getChainLabel(pair.chainId);
  const ca = pair.baseToken?.address || "";
  const mcap = pair.marketCap || pair.fdv || 0;
  const vol1h = pair.volume?.h1 || 0;
  const vol6h = pair.volume?.h6 || 0;
  const vol24 = pair.volume?.h24 || 0;
  const liq = pair.liquidity?.usd || 0;
  const change1h = pair.priceChange?.h1 ?? null;
  const change6h = pair.priceChange?.h6 ?? null;
  const buys24 = pair.txns?.h24?.buys || 0;
  const sells24 = pair.txns?.h24?.sells || 0;
  const age = formatAge(pair.pairCreatedAt);
  const iconUrl = pair.icon || pair.info?.imageUrl || null;
  const dexUrl = pair.url || `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`;
  const bubbleMapsUrl = getBubbleMapsUrl(pair.chainId, ca);

  const [showHolders, setShowHolders] = useState(false);
  const [showWalletHolders, setShowWalletHolders] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [chartMode, setChartMode] = useState("price"); // "price" | "mcap"
  const [chartTf, setChartTf] = useState("1D");        // "1H" | "12H" | "1D"
  const [caCopied, setCaCopied] = useState(false);
  const { holders, loading: holdersLoading, error: holdersError, refetch: refetchHolders } = useTokenHolders(ca, pair.chainId, showHolders);
  const gtPoolAddr = pair.source === "gt" ? pair.pairAddress : null;
  const { priceData: chartData, volumeData, loading: chartLoading } = usePoolChart(pair.chainId, ca, gtPoolAddr, showChart, chartTf);

  // Derive mcap series by scaling price by fixed supply ratio
  const currentPrice = pair.priceUsd ? parseFloat(pair.priceUsd) : 0;
  const supply = currentPrice > 0 && mcap > 0 ? mcap / currentPrice : 0;
  const mcapChartData = chartData && supply > 0
    ? chartData.map(([ts, price]) => [ts, price * supply])
    : null;

  const activeChartData = chartMode === "mcap" ? mcapChartData : chartData;
  const chartFormatter = chartMode === "mcap" ? formatVolume : formatPrice;

  const glowClass = change1h === null ? "token-card-flat" : change1h >= 0 ? "token-card-up" : "token-card-down";

  return (
    <div
      className={glowClass}
      style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 14, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 4, transition: "border-color 0.25s, box-shadow 0.25s", position: "relative", height: "100%", boxSizing: "border-box" }}
    >
      {/* Action buttons — top right */}
      <div style={{ position: "absolute", top: 12, right: 12, display: "flex", gap: 4, zIndex: 2 }}>
        {/* Mini chart toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); setShowChart((v) => !v); }}
          title={showChart ? "Hide chart" : "Show 24h chart"}
          style={{ width: 28, height: 28, borderRadius: 6, background: showChart ? "#6366f122" : "#1e293b", border: `1px solid ${showChart ? "#6366f1" : "#334155"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: showChart ? "#818cf8" : "#94a3b8", cursor: "pointer", flexShrink: 0 }}
        >
          📈
        </button>
        {/* BubbleMaps */}
        <a
          href={bubbleMapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in BubbleMaps"
          style={{ width: 28, height: 28, borderRadius: 6, background: "#1e293b", border: "1px solid #334155", display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontSize: 14, color: "#60a5fa", cursor: "pointer", flexShrink: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          🫧
        </a>
        {/* Top Holders toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); setShowHolders((v) => !v); }}
          title={showHolders ? "Hide holder analysis" : "Analyze holders"}
          style={{ width: 28, height: 28, borderRadius: 6, background: showHolders ? "#1e40af33" : "#1e293b", border: `1px solid ${showHolders ? "#1d4ed888" : "#334155"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: showHolders ? "#60a5fa" : "#94a3b8", cursor: "pointer", flexShrink: 0 }}
        >
          👥
        </button>
        {/* Bookmark / Pin */}
        <button
          onClick={(e) => { e.stopPropagation(); isPinned ? onUnpin(ca, pair.chainId) : onPin(ca, pair.chainId); }}
          title={isPinned ? "Unpin" : "Pin / Bookmark"}
          style={{ width: 28, height: 28, borderRadius: 6, background: isPinned ? "#6366f122" : "#1e293b", border: `1px solid ${isPinned ? "#6366f1" : "#334155"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: isPinned ? "#818cf8" : "#64748b", cursor: "pointer", flexShrink: 0 }}
        >
          {isPinned ? "📌" : "🔖"}
        </button>
        {/* Tracked wallets badge */}
        {walletHolders.length > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowWalletHolders((v) => !v); }}
            title={`${walletHolders.length} tracked wallet${walletHolders.length > 1 ? "s" : ""} hold this`}
            style={{ position: "relative", width: 28, height: 28, borderRadius: 6, background: showWalletHolders ? "#4ade8033" : "#4ade8018", border: `1px solid ${showWalletHolders ? "#4ade8088" : "#4ade8044"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, cursor: "pointer", flexShrink: 0 }}
          >
            👜
            <span style={{ position: "absolute", top: -4, right: -4, background: "#4ade80", color: "#0d1321", borderRadius: "50%", fontSize: 9, fontWeight: 800, minWidth: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 2px", lineHeight: 1 }}>
              {walletHolders.length}
            </span>
          </button>
        )}
      </div>

      {/* Wallet holders popover */}
      {showWalletHolders && walletHolders.length > 0 && (
        <div
          style={{ position: "absolute", top: 44, right: 12, zIndex: 20, background: "#1e293b", border: "1px solid #334155", borderRadius: 10, padding: "12px 14px", minWidth: 220, boxShadow: "0 4px 24px #00000088" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ color: "#4ade80", fontSize: 12, fontWeight: 700, marginBottom: 8 }}>👜 Your wallets holding this</div>
          {walletHolders.map((h, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderTop: i > 0 ? "1px solid #334155" : "none" }}>
              <div style={{ color: "#94a3b8", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 130 }}>
                {h.label || truncateAddr(h.address)}
              </div>
              <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 8 }}>
                {h.usdValue >= 0.01 && <div style={{ color: "#f1f5f9", fontSize: 12, fontWeight: 600 }}>{formatVolume(h.usdValue)}</div>}
                <div style={{ color: "#64748b", fontSize: 11 }}>
                  {formatTokenAmount(h.amount)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Token info */}
      <div>
        <div style={{ display: "flex", alignItems: "flex-start" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", paddingRight: 100 }}>
            <div style={{ position: "relative", width: 40, height: 40, flexShrink: 0 }}>
              {iconUrl && (
                <img src={iconUrl} alt={symbol} style={{ width: 40, height: 40, borderRadius: 10, border: "1px solid #ffffff11", objectFit: "cover", position: "absolute", top: 0, left: 0 }}
                  onError={(e) => { e.target.style.display = "none"; }}
                />
              )}
              <div style={{ width: 40, height: 40, borderRadius: 10, background: hashColor(symbol), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: "#e2e8f0", border: "1px solid #ffffff11" }}>
                {symbol.slice(0, 2)}
              </div>
              {rank && <span className="rank-badge">#{rank}</span>}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 15, letterSpacing: 0.3 }}>{symbol}</span>
                <ChainBadge chain={chain} />
                {pair.boostAmount > 0 && (
                  <span style={{ fontSize: 10, color: "#f59e0b", fontWeight: 600 }}>🔥 {pair.boostAmount}</span>
                )}
              </div>
              <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 2, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
              <div style={{ display: "flex", gap: 10, color: "#64748b", fontSize: 11, marginTop: 2 }}>
                <span>Age <span style={{ color: "#94a3b8" }}>{age}</span></span>
                <span>Price <span style={{ color: "#94a3b8" }}>{pair.priceUsd ? formatPrice(parseFloat(pair.priceUsd)) : "—"}</span></span>
              </div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div>
              <div style={{ color: "#64748b", fontSize: 11, fontWeight: 500, letterSpacing: 0.5 }}>MCAP</div>
              <div style={{ color: "#f1f5f9", fontSize: 22, fontWeight: 700, marginTop: 2 }}>{formatVolume(mcap)}</div>
            </div>
            <div style={{ display: "flex", gap: 16, textAlign: "right" }}>
              <div>
                <div style={{ color: "#64748b", fontSize: 10, marginBottom: 2 }}>1h</div>
                <PriceChangeText value={change1h} />
              </div>
              <div>
                <div style={{ color: "#64748b", fontSize: 10, marginBottom: 2 }}>6h</div>
                <PriceChangeText value={change6h} />
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, color: "#64748b", fontSize: 12, marginTop: 6, flexWrap: "wrap" }}>
            <span>Vol 1h <span style={{ color: "#94a3b8" }}>{formatVolume(vol1h)}</span></span>
            <span>Vol 24h <span style={{ color: "#94a3b8" }}>{formatVolume(vol24)}</span></span>
            <span>Liq <span style={{ color: "#94a3b8" }}>{formatVolume(liq)}</span></span>
          </div>
        </div>
      </div>

      <BuySellBar buys={buys24} sells={sells24} />

      {/* Mini chart */}
      {showChart && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #1e293b" }}>
          {/* Controls row */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            {/* Timeframe pills */}
            <div style={{ display: "flex", gap: 3 }}>
              {["1H", "12H", "1D"].map((tf) => {
                const active = chartTf === tf;
                return (
                  <button key={tf}
                    onClick={(e) => { e.stopPropagation(); setChartTf(tf); }}
                    disabled={chartLoading}
                    style={{ padding: "2px 7px", fontSize: 9, fontWeight: 700, borderRadius: 4,
                      border: `1px solid ${active ? "#38bdf8" : "#1e293b"}`,
                      background: active ? "#38bdf822" : "transparent",
                      color: active ? "#7dd3fc" : "#475569",
                      cursor: chartLoading ? "default" : "pointer",
                      opacity: chartLoading && !active ? 0.4 : 1 }}>
                    {tf}
                  </button>
                );
              })}
            </div>
            {/* Mode pills — Vol is always shown as overlay, not a separate mode */}
            <div style={{ display: "flex", gap: 3 }}>
              {[["price", "Price"], ["mcap", "MCap"]].map(([mode, label]) => {
                const active = chartMode === mode;
                return (
                  <button key={mode}
                    onClick={(e) => { e.stopPropagation(); setChartMode(mode); }}
                    disabled={chartLoading}
                    style={{ padding: "2px 7px", fontSize: 9, fontWeight: 700, borderRadius: 4,
                      border: `1px solid ${active ? "#6366f1" : "#1e293b"}`,
                      background: active ? "#6366f122" : "transparent",
                      color: active ? "#a5b4fc" : "#475569",
                      cursor: chartLoading ? "default" : "pointer",
                      opacity: chartLoading && !active ? 0.4 : 1 }}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          {/* Loading bar */}
          {chartLoading && (
            <div style={{ height: 2, borderRadius: 1, background: "#1e293b", overflow: "hidden", marginBottom: 6 }}>
              <div style={{ height: "100%", width: "40%", background: "#6366f1", borderRadius: 1, animation: "shimmer 1.2s ease-in-out infinite" }} />
            </div>
          )}
          {!chartLoading && activeChartData && activeChartData.length >= 2 && (
            <Sparkline
              data={activeChartData}
              volumeData={volumeData}
              width="100%"
              height={56}
              interactive
              formatter={chartFormatter}
            />
          )}
          {!chartLoading && (!activeChartData || activeChartData.length < 2) && (
            <div style={{ color: "#334155", fontSize: 11, textAlign: "center", padding: "8px 0" }}>No chart data</div>
          )}
        </div>
      )}

      {/* CA row */}
      {ca && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "#334155", fontSize: 10, fontFamily: "monospace" }}>CA:</span>
          <span style={{ color: "#475569", fontSize: 10, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{ca}</span>
          <button
            onClick={() => { navigator.clipboard?.writeText(ca); setCaCopied(true); setTimeout(() => setCaCopied(false), 1500); }}
            title="Copy CA"
            style={{ background: "none", border: "none", color: caCopied ? "#4ade80" : "#475569", cursor: "pointer", fontSize: 11, padding: "1px 4px", transition: "color 0.15s" }}
          >
            {caCopied ? "✓ copied" : "copy"}
          </button>
        </div>
      )}

      {/* Trade buttons */}
      {ca && (
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <a
            href={dexUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="View chart on DexScreener"
            style={{ flex: 1, textAlign: "center", padding: "6px 0", borderRadius: 8, background: "#1e293b", border: "1px solid #334155", color: "#94a3b8", fontSize: 12, fontWeight: 700, textDecoration: "none", letterSpacing: 0.3 }}
          >
            📊 Chart
          </a>
          {pair.chainId === "solana" && (
            <a
              href={`https://jup.ag/tokens/${ca}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Trade on Jupiter"
              onClick={(e) => e.stopPropagation()}
              style={{ flex: 1, textAlign: "center", padding: "6px 0", borderRadius: 8, background: "#9945FF22", border: "1px solid #9945FF55", color: "#c084fc", fontSize: 12, fontWeight: 700, textDecoration: "none", letterSpacing: 0.3 }}
            >
              ⚡ Jupiter
            </a>
          )}
          {pair.chainId === "base" && (
            <a
              href={`https://gmgn.ai/base/token/${ca}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Trade on GMGN"
              onClick={(e) => e.stopPropagation()}
              style={{ flex: 1, textAlign: "center", padding: "6px 0", borderRadius: 8, background: "#0052FF22", border: "1px solid #0052FF55", color: "#60a5fa", fontSize: 12, fontWeight: 700, textDecoration: "none", letterSpacing: 0.3 }}
            >
              🔵 GMGN
            </a>
          )}
        </div>
      )}

      {/* Holder analysis panel */}
      {showHolders && (
        <HolderPanel
          ca={ca}
          chainId={pair.chainId}
          holders={holders}
          loading={holdersLoading}
          error={holdersError}
          onRefresh={refetchHolders}
        />
      )}

      {/* Token news */}
      {(() => {
        const tokenArticles = filterNewsByKeywords(allNews, [symbol, name]).slice(0, 3);
        if (!newsLoading && tokenArticles.length === 0) return null; // hide section entirely if no news & not loading
        return (
          <div style={{ borderTop: "1px solid #1e293b", marginTop: 10, paddingTop: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6 }}>
              {symbol} News
            </div>
            <NewsSnippet articles={tokenArticles} loading={newsLoading} label={symbol} />
          </div>
        );
      })()}
    </div>
  );
};

// ─── Wallet Link Graph ───
const HELIUS_KEY = "0dd8f0ec-f2a5-4f9e-b275-379afa3e73cd";

// Fetch last N transaction signatures for a wallet via Helius enhanced API
async function fetchWalletTxs(address, limit = 40) {
  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=${limit}&type=TRANSFER`
    );
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

// Extract all counterparty addresses from a Helius enhanced transaction
function extractCounterparties(tx, ownAddress) {
  const addrs = new Set();
  (tx.nativeTransfers || []).forEach((t) => {
    if (t.fromUserAccount && t.fromUserAccount !== ownAddress) addrs.add(t.fromUserAccount);
    if (t.toUserAccount && t.toUserAccount !== ownAddress) addrs.add(t.toUserAccount);
  });
  (tx.tokenTransfers || []).forEach((t) => {
    if (t.fromUserAccount && t.fromUserAccount !== ownAddress) addrs.add(t.fromUserAccount);
    if (t.toUserAccount && t.toUserAccount !== ownAddress) addrs.add(t.toUserAccount);
  });
  return [...addrs];
}

// Extract {counterpartyAddress → Set<mint>} from a transaction
function extractCounterpartyMints(tx, ownAddress) {
  const map = new Map(); // counterparty → Set<mint>
  (tx.tokenTransfers || []).forEach((t) => {
    if (!t.mint) return;
    [t.fromUserAccount, t.toUserAccount].forEach((acct) => {
      if (acct && acct !== ownAddress) {
        if (!map.has(acct)) map.set(acct, new Set());
        map.get(acct).add(t.mint);
      }
    });
  });
  return map;
}

// Hook: given walletMintMap + wallets, compute all link edges + discover related untracked wallets
function useWalletLinks(wallets, walletMintMap) {
  const [links, setLinks] = useState([]);
  const [relatedWallets, setRelatedWallets] = useState([]); // [{address, sharedWith: [addr], txCount, reason}]
  const [loading, setLoading] = useState(false);
  const addrs = wallets.map((w) => w.address);

  useEffect(() => {
    if (wallets.length < 2) { setLinks([]); return; }
    const addrSet = new Set(addrs);
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      const edgeMap = new Map(); // key: "addrA:addrB" (sorted) → {types, sharedTokens, directTxCount}

      const ensureEdge = (a, b) => {
        const key = [a, b].sort().join(":");
        if (!edgeMap.has(key)) edgeMap.set(key, { a: key.split(":")[0], b: key.split(":")[1], types: new Set(), sharedTokens: [], directTxCount: 0 });
        return edgeMap.get(key);
      };

      // ── Signal 1: shared token holdings ──
      Object.entries(walletMintMap).forEach(([, holders]) => {
        const holdingAddrs = holders.map((h) => h.address).filter((a) => addrSet.has(a));
        for (let i = 0; i < holdingAddrs.length; i++) {
          for (let j = i + 1; j < holdingAddrs.length; j++) {
            const edge = ensureEdge(holdingAddrs[i], holdingAddrs[j]);
            edge.types.add("shared_token");
            const mintEntry = holders[0]; // get symbol from first holder's pair data
            if (mintEntry?.pair?.baseToken?.symbol) edge.sharedTokens.push(mintEntry.pair.baseToken.symbol);
          }
        }
      });

      // ── Signal 2: transaction-level links (direct transfers + common funder) ──
      const txsByWallet = new Map();
      await Promise.all(
        addrs.map(async (addr) => {
          const txs = await fetchWalletTxs(addr, 50);
          if (!cancelled) txsByWallet.set(addr, txs);
        })
      );
      if (cancelled) return;

      // Direct transfers between tracked wallets
      addrs.forEach((addr) => {
        const txs = txsByWallet.get(addr) || [];
        txs.forEach((tx) => {
          const counterparties = extractCounterparties(tx, addr);
          counterparties.forEach((cp) => {
            if (addrSet.has(cp) && cp !== addr) {
              const edge = ensureEdge(addr, cp);
              edge.types.add("direct_transfer");
              edge.directTxCount++;
            }
          });
        });
      });

      // Common funder + related wallet discovery:
      // Build: externalAddr → { wallets: Set<trackedAddr>, txCount, mints: Set<mint> }
      const externalMap = new Map();
      addrs.forEach((addr) => {
        const txs = txsByWallet.get(addr) || [];
        txs.forEach((tx) => {
          // Accumulate counterparty → mints from token transfers
          const mintMap = extractCounterpartyMints(tx, addr);
          extractCounterparties(tx, addr).forEach((cp) => {
            if (!addrSet.has(cp)) {
              if (!externalMap.has(cp)) externalMap.set(cp, { wallets: new Set(), txCount: 0, mints: new Set() });
              const entry = externalMap.get(cp);
              entry.wallets.add(addr);
              entry.txCount++;
              // Collect mints transferred to/from this counterparty
              (mintMap.get(cp) || []).forEach((m) => entry.mints.add(m));
            }
          });
        });
      });

      // Common funder edges (external addr appeared in 2+ tracked wallets)
      externalMap.forEach(({ wallets: walletSet, txCount }, funder) => {
        if (walletSet.size < 2) return;
        const arr = [...walletSet];
        for (let i = 0; i < arr.length; i++) {
          for (let j = i + 1; j < arr.length; j++) {
            const edge = ensureEdge(arr[i], arr[j]);
            edge.types.add("common_funder");
            if (!edge.commonFunders) edge.commonFunders = [];
            edge.commonFunders.push(funder);
          }
        }
      });

      // Related wallet discovery: external addresses that interacted with ANY tracked wallet
      // Sort by: (number of distinct tracked wallets it touched) desc, then txCount desc
      const related = [];
      externalMap.forEach(({ wallets: walletSet, txCount, mints }, extAddr) => {
        related.push({
          address: extAddr,
          sharedWith: [...walletSet],
          txCount,
          mints: [...mints], // token mints transferred to/from this address
          sharedWithLabels: [...walletSet].map((a) => {
            const w = wallets.find((x) => x.address === a);
            return w?.label || `${a.slice(0, 4)}…${a.slice(-4)}`;
          }),
        });
      });
      related.sort((a, b) => b.sharedWith.length - a.sharedWith.length || b.txCount - a.txCount);

      if (!cancelled) {
        // Deduplicate sharedTokens and commonFunders per edge
        const result = [];
        edgeMap.forEach((edge) => {
          result.push({
            ...edge,
            types: [...edge.types],
            sharedTokens: [...new Set(edge.sharedTokens)].slice(0, 5),
            commonFunders: (edge.commonFunders || []).slice(0, 3),
          });
        });
        setLinks(result);
        setRelatedWallets(related.slice(0, 20)); // top 20 related wallets
        setLoading(false);
      }
    };

    run();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets.length, JSON.stringify(addrs), Object.keys(walletMintMap).length]);

  return { links, relatedWallets, loading };
}

// Tiny force-layout: push nodes apart, pull linked nodes together
function useForceLayout(nodeCount, edges, width, height) {
  const [positions, setPositions] = useState(() => {
    const pos = [];
    for (let i = 0; i < nodeCount; i++) {
      const angle = (2 * Math.PI * i) / Math.max(nodeCount, 1);
      const r = Math.min(width, height) * 0.3;
      pos.push({ x: width / 2 + r * Math.cos(angle), y: height / 2 + r * Math.sin(angle) });
    }
    return pos;
  });

  useEffect(() => {
    if (nodeCount === 0) return;
    let pos = [];
    for (let i = 0; i < nodeCount; i++) {
      const angle = (2 * Math.PI * i) / Math.max(nodeCount, 1);
      const r = Math.min(width, height) * 0.3;
      pos.push({ x: width / 2 + r * Math.cos(angle), y: height / 2 + r * Math.sin(angle) });
    }

    const ITERATIONS = 120;
    const REPULSE = 4000;
    const ATTRACT = 0.04;
    const pad = 60;

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const forces = pos.map(() => ({ fx: 0, fy: 0 }));
      // Repulsion between all pairs
      for (let i = 0; i < nodeCount; i++) {
        for (let j = i + 1; j < nodeCount; j++) {
          const dx = pos[i].x - pos[j].x;
          const dy = pos[i].y - pos[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = REPULSE / (dist * dist);
          forces[i].fx += (dx / dist) * f;
          forces[i].fy += (dy / dist) * f;
          forces[j].fx -= (dx / dist) * f;
          forces[j].fy -= (dy / dist) * f;
        }
      }
      // Attraction along edges
      edges.forEach(({ idxA, idxB }) => {
        const dx = pos[idxB].x - pos[idxA].x;
        const dy = pos[idxB].y - pos[idxA].y;
        forces[idxA].fx += dx * ATTRACT;
        forces[idxA].fy += dy * ATTRACT;
        forces[idxB].fx -= dx * ATTRACT;
        forces[idxB].fy -= dy * ATTRACT;
      });
      // Apply, clamped to canvas
      pos = pos.map((p, i) => ({
        x: Math.max(pad, Math.min(width - pad, p.x + forces[i].fx)),
        y: Math.max(pad, Math.min(height - pad, p.y + forces[i].fy)),
      }));
    }
    setPositions(pos);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeCount, edges.length, width, height]);

  return positions;
}

const LINK_COLORS = {
  direct_transfer: "#4ade80",
  shared_token:    "#38bdf8",
  common_funder:   "#f59e0b",
};
const LINK_LABELS = {
  direct_transfer: "Direct tx",
  shared_token:    "Shared token",
  common_funder:   "Common funder",
};

function WalletGraph({ wallets, links, loading }) {
  const W = 640, H = 320;
  const [tooltip, setTooltip] = useState(null); // {x,y,edge}

  const addrToIdx = useMemo(() => {
    const m = new Map();
    wallets.forEach((w, i) => m.set(w.address, i));
    return m;
  }, [wallets]);

  const edgesWithIdx = useMemo(() =>
    links
      .map((l) => ({ ...l, idxA: addrToIdx.get(l.a), idxB: addrToIdx.get(l.b) }))
      .filter((l) => l.idxA !== undefined && l.idxB !== undefined),
    [links, addrToIdx]
  );

  const positions = useForceLayout(wallets.length, edgesWithIdx, W, H);

  const truncAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

  if (wallets.length < 2) return null;

  return (
    <div style={{ background: "#0d1321", border: "1px solid #1e293b", borderRadius: 14, padding: "18px 20px", marginBottom: 24, position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "#e2e8f0", letterSpacing: 0.5 }}>Wallet Connection Graph</h3>
          <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>Links between tracked wallets — based on shared tokens, direct transfers &amp; common funders</div>
        </div>
        {loading && <div style={{ fontSize: 11, color: "#38bdf8", animation: "pulse-dot 1.5s infinite" }}>Analysing…</div>}
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
        {Object.entries(LINK_LABELS).map(([type, label]) => (
          <div key={type} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#64748b" }}>
            <div style={{ width: 18, height: 2, background: LINK_COLORS[type], borderRadius: 1 }} />
            {label}
          </div>
        ))}
      </div>

      <div style={{ position: "relative", overflow: "hidden", borderRadius: 8 }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
          <defs>
            {Object.entries(LINK_COLORS).map(([type, color]) => (
              <marker key={type} id={`arrow-${type}`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L0,6 L6,3 z" fill={color} opacity="0.7" />
              </marker>
            ))}
          </defs>

          {/* Edges */}
          {edgesWithIdx.map((edge, ei) => {
            const pa = positions[edge.idxA];
            const pb = positions[edge.idxB];
            if (!pa || !pb) return null;
            // One line per link type
            return edge.types.map((type, ti) => {
              const offset = (ti - (edge.types.length - 1) / 2) * 5;
              const dx = pb.x - pa.x, dy = pb.y - pa.y;
              const len = Math.sqrt(dx * dx + dy * dy) || 1;
              const nx = -dy / len * offset, ny = dx / len * offset;
              const mx = (pa.x + pb.x) / 2 + nx, my = (pa.y + pb.y) / 2 + ny;
              const color = LINK_COLORS[type] || "#64748b";
              return (
                <g key={`${ei}-${type}`}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => setTooltip({ x: mx, y: my, edge })}
                  onMouseLeave={() => setTooltip(null)}
                >
                  <line x1={pa.x + nx} y1={pa.y + ny} x2={pb.x + nx} y2={pb.y + ny}
                    stroke={color} strokeWidth="2" strokeOpacity="0.7"
                    markerEnd={`url(#arrow-${type})`} />
                  {/* Invisible thick hit area */}
                  <line x1={pa.x + nx} y1={pa.y + ny} x2={pb.x + nx} y2={pb.y + ny}
                    stroke="transparent" strokeWidth="12" />
                </g>
              );
            });
          })}

          {/* Nodes */}
          {wallets.map((w, i) => {
            const p = positions[i];
            if (!p) return null;
            const hasLinks = edgesWithIdx.some((e) => e.idxA === i || e.idxB === i);
            const label = w.label || truncAddr(w.address);
            return (
              <g key={w.address}>
                <circle cx={p.x} cy={p.y} r={20} fill="#111827" stroke={hasLinks ? "#6366f1" : "#334155"} strokeWidth={hasLinks ? 2 : 1} />
                <text x={p.x} y={p.y + 1} textAnchor="middle" dominantBaseline="middle" fontSize="9" fill="#94a3b8" fontWeight="700">
                  {label.length > 10 ? label.slice(0, 9) + "…" : label}
                </text>
              </g>
            );
          })}
          {/* Tooltip inside SVG */}
          {tooltip && (() => {
            const { edge } = tooltip;
            const wa = wallets.find((w) => w.address === edge.a);
            const wb = wallets.find((w) => w.address === edge.b);
            const TW = 210, TH = 20 + edge.types.length * 16 + (edge.sharedTokens.length > 0 ? 18 : 0) + (edge.commonFunders?.length > 0 ? 16 : 0);
            const tx = Math.max(4, Math.min(tooltip.x - TW / 2, W - TW - 4));
            const ty = Math.max(4, tooltip.y - TH - 10);
            return (
              <g style={{ pointerEvents: "none" }}>
                <rect x={tx} y={ty} width={TW} height={TH} rx="6" fill="#1e293b" stroke="#334155" strokeWidth="1" />
                <text x={tx + 10} y={ty + 14} fontSize="10" fontWeight="700" fill="#e2e8f0">{(wa?.label || truncAddr(edge.a))} ↔ {(wb?.label || truncAddr(edge.b))}</text>
                {edge.types.map((type, ti) => (
                  <g key={type}>
                    <circle cx={tx + 14} cy={ty + 26 + ti * 16} r="4" fill={LINK_COLORS[type]} />
                    <text x={tx + 24} y={ty + 30 + ti * 16} fontSize="9" fill={LINK_COLORS[type]}>{LINK_LABELS[type]}{type === "direct_transfer" && edge.directTxCount > 0 ? ` (${edge.directTxCount})` : ""}</text>
                  </g>
                ))}
                {edge.sharedTokens.length > 0 && (
                  <text x={tx + 10} y={ty + 26 + edge.types.length * 16 + 10} fontSize="9" fill="#38bdf8">Tokens: {edge.sharedTokens.slice(0, 4).join(", ")}</text>
                )}
                {edge.commonFunders?.length > 0 && (
                  <text x={tx + 10} y={ty + 26 + edge.types.length * 16 + (edge.sharedTokens.length > 0 ? 26 : 10)} fontSize="9" fill="#f59e0b">Via: {edge.commonFunders[0].slice(0, 12)}…</text>
                )}
              </g>
            );
          })()}
        </svg>
      </div>

      {!loading && links.length === 0 && (
        <div style={{ textAlign: "center", color: "#334155", fontSize: 12, padding: "18px 0" }}>No connections found between these wallets</div>
      )}
    </div>
  );
}

// ─── Related Wallets Panel ───
function RelatedWallets({ relatedWallets, trackedAddrs, loading, onTrack, walletMintMap }) {
  const [expanded, setExpanded] = useState(false);
  const [tracked, setTracked] = useState(new Set());

  // ── Token CA filter state ──
  const [caInput, setCaInput] = useState("");
  const [activeCA, setActiveCA] = useState(null);
  const [filterLoading, setFilterLoading] = useState(false);
  const [filterError, setFilterError] = useState(null);
  const [filterMeta, setFilterMeta] = useState(null);   // { icon, symbol }
  const [filterResults, setFilterResults] = useState([]); // relatedWallet entries that hold the CA, + tokenAmount

  // Build mint → {icon, symbol} from walletMintMap
  const mintMeta = useMemo(() => {
    const m = new Map();
    Object.entries(walletMintMap || {}).forEach(([mint, holders]) => {
      const h = holders.find((x) => x.icon) || holders[0];
      if (h) m.set(mint, { icon: h.icon || null, symbol: h.symbol || mint.slice(0, 4) });
    });
    return m;
  }, [walletMintMap]);

  const handleSearch = async (e) => {
    e.preventDefault();
    const ca = caInput.trim();
    if (!ca || !relatedWallets.length) return;
    setActiveCA(ca);
    setFilterLoading(true);
    setFilterError(null);
    setFilterResults([]);

    // Resolve token meta from walletMintMap first, fall back to DexScreener
    let meta = mintMeta.get(ca) || null;
    if (!meta) {
      try {
        const dex = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
        const dexJson = await dex.json();
        const pair = dexJson?.pairs?.[0];
        if (pair) meta = { icon: pair.info?.imageUrl || null, symbol: pair.baseToken?.symbol || ca.slice(0, 6) };
      } catch (_) {}
    }
    setFilterMeta(meta);

    // Check each related wallet for holdings — batch 5 at a time to avoid rate limits
    const BATCH = 5;
    const found = [];
    for (let i = 0; i < relatedWallets.length; i += BATCH) {
      const batch = relatedWallets.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (w) => {
        try {
          const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0", id: w.address,
              method: "getTokenAccountsByOwner",
              params: [w.address, { mint: ca }, { encoding: "jsonParsed" }],
            }),
          });
          const json = await res.json();
          const accounts = json?.result?.value || [];
          const amount = accounts.reduce(
            (sum, a) => sum + (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0
          );
          return amount > 0 ? { ...w, tokenAmount: amount } : null;
        } catch (_) { return null; }
      }));
      found.push(...results.filter(Boolean));
      setFilterResults([...found]); // update incrementally
    }

    setFilterLoading(false);
  };

  const clearSearch = () => { setActiveCA(null); setCaInput(""); setFilterResults([]); setFilterMeta(null); setFilterError(null); };

  if (loading) return null;
  if (!relatedWallets.length && !activeCA) return null;

  function renderCAFilter() {
    const meta = filterMeta || (activeCA ? mintMeta.get(activeCA) : null);
    return (
      <form onSubmit={handleSearch} style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
        {meta?.icon && (
          <img src={meta.icon} alt={meta.symbol} style={{ width: 16, height: 16, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} onError={(e) => { e.target.style.display = "none"; }} />
        )}
        <input
          value={caInput}
          onChange={(e) => setCaInput(e.target.value)}
          placeholder="Filter by token CA…"
          style={{
            width: 220, padding: "5px 10px", background: "#111827", border: `1px solid ${activeCA ? "#6366f144" : "#1e293b"}`,
            borderRadius: 6, color: "#e2e8f0", fontSize: 11, outline: "none", fontFamily: "monospace",
          }}
        />
        <button
          type="submit"
          disabled={filterLoading || !caInput.trim()}
          style={{
            padding: "5px 12px", borderRadius: 6, background: "#6366f122", border: "1px solid #6366f144",
            color: "#818cf8", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
            opacity: filterLoading || !caInput.trim() ? 0.5 : 1,
          }}
        >
          {filterLoading ? "…" : "Filter"}
        </button>
        {activeCA && (
          <button type="button" onClick={clearSearch}
            style={{ padding: "5px 8px", borderRadius: 6, background: "transparent", border: "1px solid #334155", color: "#475569", fontSize: 11, cursor: "pointer" }}
          >
            ✕
          </button>
        )}
      </form>
    );
  }

  function renderTokenHolders() {
    if (!activeCA) return null;
    const meta = filterMeta || mintMeta.get(activeCA);
    const fmt = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B`
      : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M`
      : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K`
      : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

    return (
      <div style={{ marginTop: 12, borderTop: "1px solid #1e293b", paddingTop: 12 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          {meta?.icon && (
            <img src={meta.icon} alt={meta?.symbol} style={{ width: 16, height: 16, borderRadius: "50%", objectFit: "cover" }} onError={(e) => { e.target.style.display = "none"; }} />
          )}
          <span style={{ fontSize: 11, fontWeight: 700, color: "#e2e8f0" }}>
            {meta?.symbol ? `Related wallets holding ${meta.symbol}` : "Related wallets holding this token"}
          </span>
          <span style={{ background: filterResults.length ? "#6366f122" : "#1e293b", color: filterResults.length ? "#818cf8" : "#475569", border: `1px solid ${filterResults.length ? "#6366f133" : "#1e293b"}`, borderRadius: 4, fontSize: 10, fontWeight: 700, padding: "1px 6px" }}>
            {filterLoading ? `${filterResults.length}…` : filterResults.length}
          </span>
          {filterLoading && (
            <span style={{ fontSize: 10, color: "#475569" }}>checking {relatedWallets.length} wallets…</span>
          )}
        </div>

        {filterError && <div style={{ fontSize: 11, color: "#f87171", marginBottom: 8 }}>{filterError}</div>}

        {!filterLoading && filterResults.length === 0 && (
          <div style={{ fontSize: 11, color: "#475569", padding: "4px 0" }}>
            None of your related wallets hold this token.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {filterResults.map((r) => {
            const isAlreadyTracked = trackedAddrs.has(r.address) || tracked.has(r.address);
            const isStrong = r.sharedWith.length >= 2;
            return (
              <div key={r.address} style={{ background: "#111827", borderRadius: 8, border: `1px solid ${isStrong ? "#f59e0b33" : "#6366f122"}`, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px" }}>
                  {/* Dot */}
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: isStrong ? "#f59e0b" : "#334155", flexShrink: 0 }} />

                  {/* Address */}
                  <span style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.address}
                  </span>

                  {/* Shared count */}
                  <span style={{ fontSize: 9, color: "#64748b", flexShrink: 0 }}>
                    {r.sharedWith.length} wallet{r.sharedWith.length !== 1 ? "s" : ""}
                  </span>

                  {/* Token amount badge */}
                  <span style={{ background: "#6366f111", color: "#818cf8", border: "1px solid #6366f122", borderRadius: 4, fontSize: 9, fontWeight: 700, padding: "1px 6px", whiteSpace: "nowrap", flexShrink: 0 }}>
                    {fmt(r.tokenAmount)} {meta?.symbol || ""}
                  </span>

                  {/* Copy + Track */}
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    <button onClick={() => navigator.clipboard?.writeText(r.address)} title="Copy address"
                      style={{ width: 24, height: 24, borderRadius: 5, background: "#1e293b", border: "1px solid #334155", color: "#64748b", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      ⎘
                    </button>
                    <button
                      onClick={() => { onTrack(r.address, ""); setTracked((prev) => new Set([...prev, r.address])); }}
                      disabled={isAlreadyTracked}
                      style={{ padding: "2px 8px", height: 24, borderRadius: 5, background: isAlreadyTracked ? "#1e293b" : "#4ade8022", border: `1px solid ${isAlreadyTracked ? "#334155" : "#4ade8044"}`, color: isAlreadyTracked ? "#334155" : "#4ade80", fontSize: 10, fontWeight: 700, cursor: isAlreadyTracked ? "default" : "pointer", whiteSpace: "nowrap" }}
                    >
                      {isAlreadyTracked ? "✓ tracked" : "+ Track"}
                    </button>
                  </div>
                </div>

                {/* Shared with labels */}
                {r.sharedWithLabels?.length > 0 && (
                  <div style={{ display: "flex", gap: 4, padding: "0 10px 7px 25px", flexWrap: "wrap" }}>
                    {r.sharedWithLabels.slice(0, 2).map((lbl, i) => (
                      <span key={i} style={{ fontSize: 9, background: "#1e293b", color: "#64748b", borderRadius: 3, padding: "1px 5px" }}>{lbl}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }


  const strong = relatedWallets.filter((r) => r.sharedWith.length >= 2);
  const weak   = relatedWallets.filter((r) => r.sharedWith.length < 2);
  const shown  = expanded ? relatedWallets : strong.length > 0 ? strong : weak.slice(0, 5);

  return (
    <div style={{ background: "#0d1321", border: "1px solid #1e293b", borderRadius: 14, padding: "16px 20px", marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10, gap: 12 }}>
        <div style={{ flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "#e2e8f0", letterSpacing: 0.5 }}>
            Potentially Related Wallets
            <span style={{ marginLeft: 8, background: "#f59e0b22", color: "#f59e0b", border: "1px solid #f59e0b44", borderRadius: 4, fontSize: 10, fontWeight: 700, padding: "1px 6px" }}>{relatedWallets.length}</span>
          </h3>
          <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>
            Addresses that transacted with your tracked wallets — not yet added to tracker
          </div>
        </div>
        {renderCAFilter()}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {shown.map((r) => {
          const isAlreadyTracked = trackedAddrs.has(r.address) || tracked.has(r.address);
          const isStrong = r.sharedWith.length >= 2;

          // Resolve token icons for mints this address transacted with
          const tokenIcons = (r.mints || [])
            .map((mint) => ({ mint, ...mintMeta.get(mint) }))
            .filter((t) => t.icon || t.symbol)
            .slice(0, 6);

          return (
            <div key={r.address} style={{ background: "#111827", borderRadius: 8, border: `1px solid ${isStrong ? "#f59e0b33" : "#1e293b"}`, overflow: "hidden" }}>
              {/* Main row */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px" }}>
                {/* Signal dot */}
                <div style={{ flexShrink: 0, width: 6, height: 6, borderRadius: "50%", background: isStrong ? "#f59e0b" : "#334155" }} title={isStrong ? "Linked to multiple tracked wallets" : "Linked to 1 tracked wallet"} />

                {/* Address */}
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.address}
                </span>

                {/* Tags */}
                <div style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
                  {isStrong && (
                    <span style={{ background: "#f59e0b22", color: "#f59e0b", border: "1px solid #f59e0b44", borderRadius: 4, fontSize: 9, fontWeight: 700, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      {r.sharedWith.length} wallets
                    </span>
                  )}
                  <span style={{ background: "#1e293b", color: "#475569", borderRadius: 4, fontSize: 9, padding: "1px 5px", whiteSpace: "nowrap" }}>
                    {r.txCount} tx{r.txCount !== 1 ? "s" : ""}
                  </span>
                  {r.sharedWithLabels.slice(0, 2).map((lbl, i) => (
                    <span key={i} style={{ background: "#6366f122", color: "#818cf8", border: "1px solid #6366f133", borderRadius: 4, fontSize: 9, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      {lbl}
                    </span>
                  ))}
                </div>

                {/* Copy + Track */}
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button
                    onClick={() => navigator.clipboard?.writeText(r.address)}
                    title="Copy address"
                    style={{ width: 24, height: 24, borderRadius: 5, background: "#1e293b", border: "1px solid #334155", color: "#64748b", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                  >
                    ⎘
                  </button>
                  <button
                    onClick={() => { onTrack(r.address, ""); setTracked((prev) => new Set([...prev, r.address])); }}
                    disabled={isAlreadyTracked}
                    title={isAlreadyTracked ? "Already tracked" : "Add to tracker"}
                    style={{ padding: "2px 8px", height: 24, borderRadius: 5, background: isAlreadyTracked ? "#1e293b" : "#4ade8022", border: `1px solid ${isAlreadyTracked ? "#334155" : "#4ade8044"}`, color: isAlreadyTracked ? "#334155" : "#4ade80", fontSize: 10, fontWeight: 700, cursor: isAlreadyTracked ? "default" : "pointer", whiteSpace: "nowrap" }}
                  >
                    {isAlreadyTracked ? "✓ tracked" : "+ Track"}
                  </button>
                </div>
              </div>

              {/* Token icons strip */}
              {tokenIcons.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px 7px 24px", flexWrap: "wrap" }}>
                  {tokenIcons.map(({ mint, icon, symbol }) => (
                    <div key={mint} title={symbol} style={{ display: "flex", alignItems: "center", gap: 3, background: "#0d1321", border: "1px solid #1e293b", borderRadius: 20, padding: "2px 6px 2px 2px" }}>
                      {icon
                        ? <img src={icon} alt={symbol} style={{ width: 14, height: 14, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} onError={(e) => { e.target.style.display = "none"; }} />
                        : <div style={{ width: 14, height: 14, borderRadius: "50%", background: "#334155", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 7, color: "#94a3b8", fontWeight: 700 }}>{(symbol || "?")[0]}</div>
                      }
                      <span style={{ fontSize: 9, color: "#64748b", fontWeight: 600 }}>{symbol}</span>
                    </div>
                  ))}
                  {(r.mints || []).length > 6 && (
                    <span style={{ fontSize: 9, color: "#334155" }}>+{r.mints.length - 6} more</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {(weak.length > 0 || (strong.length === 0 && weak.length > 5)) && (
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{ marginTop: 10, width: "100%", padding: "6px 0", background: "transparent", border: "1px dashed #1e293b", borderRadius: 6, color: "#475569", fontSize: 11, cursor: "pointer" }}
        >
          {expanded ? "Show less" : `Show ${weak.length} more (weaker signal)`}
        </button>
      )}

      {/* Token holder filter results */}
      {activeCA && renderTokenHolders()}

      <div style={{ fontSize: 10, color: "#1e293b", marginTop: 8 }}>
        Based on last 50 transactions per wallet via Helius • Amber dot = linked to 2+ of your wallets
      </div>
    </div>
  );
}

// ─── Wallet Card ───
const WalletHoldingRow = ({ holding }) => {
  const { pair, amount, mint } = holding;
  const symbol = pair.baseToken?.symbol || "???";
  const name = pair.baseToken?.name || "Unknown";
  const chain = getChainLabel(pair.chainId);
  const price = pair.priceUsd ? parseFloat(pair.priceUsd) : 0;
  const usdValue = price * amount;
  const iconUrl = pair.icon || pair.info?.imageUrl || null;
  const dexUrl = pair.url || `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`;
  const bubbleMapsUrl = getBubbleMapsUrl(pair.chainId, mint);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #1e293b" }}>
      <div style={{ position: "relative", width: 32, height: 32, flexShrink: 0 }}>
        {iconUrl && (
          <img src={iconUrl} alt={symbol} style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #ffffff11", objectFit: "cover", position: "absolute", top: 0, left: 0 }} onError={(e) => { e.target.style.display = "none"; }} />
        )}
        <div style={{ width: 32, height: 32, borderRadius: 8, background: hashColor(symbol), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#e2e8f0" }}>
          {symbol.slice(0, 2)}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 13 }}>{symbol}</span>
          <ChainBadge chain={chain} />
        </div>
        <div style={{ color: "#64748b", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ color: "#f1f5f9", fontSize: 13, fontWeight: 600 }}>{usdValue >= 0.01 ? formatVolume(usdValue) : "< $0.01"}</div>
        <div style={{ color: "#64748b", fontSize: 11 }}>{formatTokenAmount(amount)}</div>
      </div>
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        <a href={dexUrl} target="_blank" rel="noopener noreferrer" title="DexScreener" style={{ width: 26, height: 26, borderRadius: 5, background: "#1e293b", border: "1px solid #334155", display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontSize: 12, color: "#94a3b8" }}>↗</a>
        <a href={bubbleMapsUrl} target="_blank" rel="noopener noreferrer" title="BubbleMaps" style={{ width: 26, height: 26, borderRadius: 5, background: "#1e293b", border: "1px solid #334155", display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontSize: 12, color: "#60a5fa" }}>🫧</a>
      </div>
    </div>
  );
};

const WalletCard = ({ wallet, onRemove, onHoldingsLoaded }) => {
  const { holdings, loading, error, refetch } = useWalletTokens(wallet.address);
  const [expanded, setExpanded] = useState(true);

  // Report loaded holdings back to parent so it can build the mint → wallets map
  useEffect(() => {
    if (!loading && !error && holdings.length > 0) {
      onHoldingsLoaded?.(wallet.address, wallet.label || "", holdings);
    }
  }, [holdings, loading, error, wallet.address, wallet.label, onHoldingsLoaded]);

  const totalUsd = holdings.reduce((sum, h) => {
    const price = h.pair?.priceUsd ? parseFloat(h.pair.priceUsd) : 0;
    return sum + price * h.amount;
  }, 0);

  return (
    <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 14, padding: "16px 20px", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: expanded ? 12 : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => setExpanded(!expanded)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14, padding: 0 }}>
            {expanded ? "▾" : "▸"}
          </button>
          <div>
            {wallet.label && <div style={{ color: "#f1f5f9", fontWeight: 600, fontSize: 14 }}>{wallet.label}</div>}
            <div style={{ color: "#64748b", fontSize: 12, fontFamily: "monospace" }} title={wallet.address}>{truncateAddr(wallet.address)}</div>
          </div>
          <span style={{ background: "#9945FF22", color: "#c084fc", border: "1px solid #9945FF44", fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, fontFamily: "monospace" }}>SOL</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {totalUsd > 0 && <span style={{ color: "#4ade80", fontWeight: 700, fontSize: 14 }}>{formatVolume(totalUsd)}</span>}
          <button onClick={refetch} title="Refresh" style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14 }}>↺</button>
          <button onClick={() => onRemove(wallet.address)} title="Remove wallet" style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 14 }}>✕</button>
        </div>
      </div>

      {expanded && (
        <>
          {loading && <div style={{ color: "#475569", fontSize: 13, textAlign: "center", padding: 16 }}>Loading holdings…</div>}
          {error && <div style={{ color: "#fca5a5", fontSize: 13, padding: 8 }}>⚠ {error}</div>}
          {!loading && !error && holdings.length === 0 && (
            <div style={{ color: "#475569", fontSize: 13, textAlign: "center", padding: 16 }}>No tradeable tokens found. Only tokens listed on DexScreener are shown.</div>
          )}
          {holdings.map((h, i) => <WalletHoldingRow key={i} holding={h} />)}
        </>
      )}
    </div>
  );
};

// ─── Add CA Panel ───
const AddCAPanel = ({ onAdd, onClose }) => {
  const [ca, setCa] = useState("");
  const [chainId, setChainId] = useState("solana");
  const [status, setStatus] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleAdd = async () => {
    const trimmed = ca.trim();
    if (!trimmed) return;
    setStatus("loading");
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/${chainId}/${trimmed}`);
      if (!res.ok) throw new Error("Not found");
      const pairs = await res.json();
      if (!Array.isArray(pairs) || pairs.length === 0) throw new Error("Token not found on DexScreener");
      onAdd(trimmed, chainId);
      setStatus("ok");
      setTimeout(onClose, 1200);
    } catch (e) {
      setStatus("error:" + e.message);
    }
  };

  return (
    <div style={{ background: "#111827", border: "1px solid #6366f1", borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ color: "#818cf8", fontWeight: 700, fontSize: 14 }}>Track a token by CA</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 16 }}>✕</button>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <select value={chainId} onChange={(e) => setChainId(e.target.value)} style={{ background: "#0d1321", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 13, padding: "8px 10px", cursor: "pointer" }}>
          <option value="solana">Solana</option>
          <option value="base">Base</option>
          <option value="ethereum">Ethereum</option>
        </select>
        <input
          ref={inputRef}
          value={ca}
          onChange={(e) => { setCa(e.target.value); setStatus(null); }}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="Paste contract address…"
          style={{ flex: 1, background: "#0d1321", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 13, padding: "8px 12px", outline: "none" }}
        />
        <button
          onClick={handleAdd}
          disabled={!ca.trim() || status === "loading"}
          style={{ background: "#6366f1", border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 600, padding: "8px 16px", cursor: !ca.trim() || status === "loading" ? "not-allowed" : "pointer", opacity: !ca.trim() ? 0.5 : 1 }}
        >
          {status === "loading" ? "…" : status === "ok" ? "✓" : "Pin"}
        </button>
      </div>
      {status && status.startsWith("error:") && (
        <div style={{ color: "#fca5a5", fontSize: 12, marginTop: 8 }}>⚠ {status.replace("error:", "")}</div>
      )}
    </div>
  );
};

// ─── Skeletons ───
const TokenSkeleton = () => (
  <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 14, padding: "18px 20px" }}>
    <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: "#1e293b", animation: "shimmer 1.5s infinite" }} />
      <div>
        <div style={{ width: 80, height: 14, borderRadius: 4, background: "#1e293b", marginBottom: 6, animation: "shimmer 1.5s infinite" }} />
        <div style={{ width: 120, height: 10, borderRadius: 4, background: "#1e293b", animation: "shimmer 1.5s infinite" }} />
      </div>
    </div>
    <div style={{ width: 100, height: 24, borderRadius: 6, background: "#1e293b", marginBottom: 8, animation: "shimmer 1.5s infinite" }} />
    <div style={{ width: "100%", height: 4, borderRadius: 2, background: "#1e293b", animation: "shimmer 1.5s infinite" }} />
  </div>
);

const CryptoIcon = ({ symbol, color }) => (
  <div style={{ width: 26, height: 26, borderRadius: "50%", background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: "#fff", flexShrink: 0 }}>
    {symbol === "BTC" ? "₿" : symbol === "ETH" ? "Ξ" : "◎"}
  </div>
);

const PriceSkeleton = () => (
  <div style={{ background: "#0d1321", border: "1px solid #1e293b", borderRadius: 12, padding: "16px 18px" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
      <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#1e293b", animation: "shimmer 1.5s infinite" }} />
      <div style={{ width: 40, height: 14, borderRadius: 4, background: "#1e293b", animation: "shimmer 1.5s infinite" }} />
    </div>
    <div style={{ width: 120, height: 28, borderRadius: 6, background: "#1e293b", marginBottom: 8, animation: "shimmer 1.5s infinite" }} />
    <div style={{ width: 50, height: 16, borderRadius: 4, background: "#1e293b", animation: "shimmer 1.5s infinite" }} />
  </div>
);

// Reusable mini news list used in CoinCard and TokenCard
function NewsSnippet({ articles, loading, label }) {
  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {[1, 2].map((i) => (
          <div key={i} style={{ height: 10, background: "#1e293b", borderRadius: 3, width: i === 1 ? "90%" : "70%", animation: "shimmer 1.5s infinite" }} />
        ))}
      </div>
    );
  }
  if (!articles || articles.length === 0) {
    return <div style={{ fontSize: 11, color: "#334155", fontStyle: "italic" }}>No news for {label}</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {articles.map((a) => (
        <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", display: "block" }}>
          <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.35, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{a.title}</div>
          <div style={{ fontSize: 10, color: "#475569", marginTop: 1 }}>{a.source}{a.timeAgo ? ` · ${a.timeAgo}` : ""}</div>
        </a>
      ))}
    </div>
  );
}

function CoinCard({ coin, data, sparkline, allNews, newsLoading }) {
  const price = data?.usd || 0;
  const change = data?.usd_24h_change || 0;
  const vol = data?.usd_24h_vol || 0;
  const mcap = data?.usd_market_cap || 0;
  const positive = change >= 0;
  // Filter from the shared news pool — use full coin name + symbol as keywords
  const coinArticles = useMemo(
    () => filterNewsByKeywords(allNews || [], [coin.newsKey, coin.symbol]).slice(0, 3),
    [allNews, coin.newsKey, coin.symbol]
  );

  return (
    <div style={{ background: "#0d1321", border: "1px solid #1e293b", borderLeft: `3px solid ${coin.color}`, borderRadius: 12, padding: "16px 18px", boxShadow: `0 0 24px ${coin.color}0a` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: "50%", background: coin.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800, color: "#fff", flexShrink: 0, boxShadow: `0 0 10px ${coin.color}66` }}>
          {coin.symbol === "BTC" ? "₿" : coin.symbol === "ETH" ? "Ξ" : "◎"}
        </div>
        <span style={{ fontWeight: 700, fontSize: 13, color: "#94a3b8", letterSpacing: 0.5 }}>{coin.symbol}</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 800, color: "#f8fafc", marginBottom: 2, letterSpacing: -0.5 }}>{formatPrice(price)}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: positive ? "#4ade80" : "#f87171", marginBottom: 4 }}>{formatChange(change)}</div>
      <Sparkline data={sparkline} width={160} height={40} color={positive ? "#4ade80" : "#f87171"} interactive />
      <div style={{ color: "#475569", fontSize: 11, lineHeight: 1.8, borderTop: "1px solid #1e293b", paddingTop: 8, marginTop: 4, display: "flex", flexDirection: "column", gap: 1 }}>
        <span>Vol 24h <span style={{ color: "#64748b" }}>{formatVolume(vol)}</span></span>
        <span>MCap <span style={{ color: "#64748b" }}>{formatVolume(mcap)}</span></span>
      </div>
      {/* Per-coin news */}
      <div style={{ borderTop: "1px solid #1e293b", marginTop: 10, paddingTop: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6 }}>{coin.symbol} News</div>
        <NewsSnippet articles={coinArticles} loading={newsLoading} label={coin.symbol} />
      </div>
    </div>
  );
}

const LiveIndicator = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
    <div style={{ position: "relative", width: 10, height: 10, flexShrink: 0 }}>
      {/* Ring pulse */}
      <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "1.5px solid #4ade80", animation: "ring-expand 2s ease-out infinite" }} />
      {/* Dot */}
      <div style={{ position: "absolute", inset: 1, borderRadius: "50%", background: "#4ade80", animation: "pulse-dot 2s ease-in-out infinite" }} />
    </div>
    <span style={{ color: "#4ade80", fontSize: 11, fontWeight: 700, letterSpacing: 0.8 }}>LIVE</span>
  </div>
);

// ─── Sparkline (SVG mini chart with optional hover + volume overlay) ───
// Uses a fixed internal viewBox (300×height) so it scales to any container width.
// Optional volumeData: [[ts, vol], ...] — renders as semi-transparent bars behind the line.
const SPARK_VB_W = 300;
const Sparkline = ({ data, volumeData, width = 140, height = 32, color, interactive = false, formatter }) => {
  const containerRef = useRef(null);
  const [hoverIdx, setHoverIdx] = useState(null);
  if (!data || data.length < 2) return null;

  const hasTime = Array.isArray(data[0]);
  const prices = hasTime ? data.map((d) => d[1]) : data;
  const times  = hasTime ? data.map((d) => d[0]) : null;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const positive = prices[prices.length - 1] >= prices[0];
  const stroke = color || (positive ? "#4ade80" : "#f87171");
  const gradId = `sf-${stroke.replace(/[^a-zA-Z0-9]/g, "")}`;

  // Price line coords in viewBox space
  const coords = prices.map((p, i) => ({
    x: (i / (prices.length - 1)) * SPARK_VB_W,
    y: height - 2 - ((p - min) / range) * (height - 4),
  }));
  const linePath = `M${coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" L")}`;
  const fillPath = `${linePath} L${SPARK_VB_W},${height} L0,${height} Z`;

  // Volume bar calculations — bars use bottom 30% of chart height
  const VOL_MAX_H = height * 0.3;
  let volBars = null;
  if (volumeData && volumeData.length >= 2) {
    const vols = volumeData.map((d) => d[1]);
    const maxVol = Math.max(...vols) || 1;
    const n = vols.length;
    const barW = Math.max(2, SPARK_VB_W / n - 1);
    volBars = vols.map((v, i) => {
      const barH = (v / maxVol) * VOL_MAX_H;
      const x = (i / (n - 1)) * SPARK_VB_W - barW / 2;
      return { x, y: height - barH, w: barW, h: barH };
    });
  }

  const onMove = interactive ? (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * SPARK_VB_W;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const d = Math.abs(coords[i].x - mx);
      if (d < bestD) { bestD = d; best = i; }
    }
    setHoverIdx(best);
  } : undefined;

  const hp = hoverIdx !== null ? coords[hoverIdx] : null;
  const tooltipLeftPct = hp ? (hp.x / SPARK_VB_W) * 100 : 0;
  const svgWidth = width === "100%" ? "100%" : width;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <svg
        width={svgWidth} height={height}
        viewBox={`0 0 ${SPARK_VB_W} ${height}`}
        preserveAspectRatio="none"
        style={{ display: "block", marginTop: 6, cursor: interactive ? "crosshair" : "default" }}
        onMouseMove={onMove}
        onMouseLeave={interactive ? () => setHoverIdx(null) : undefined}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Volume bars — behind everything */}
        {volBars && volBars.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h}
            fill={stroke} opacity="0.15" rx="1" />
        ))}
        {/* Hover volume bar highlight */}
        {hp && volBars && volBars[hoverIdx] && (() => {
          const b = volBars[hoverIdx];
          return <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={stroke} opacity="0.35" rx="1" />;
        })()}
        {/* Price fill + line */}
        <path d={fillPath} fill={`url(#${gradId})`} />
        <path d={linePath} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {/* Crosshair */}
        {hp && (
          <>
            <line x1={hp.x} y1={0} x2={hp.x} y2={height} stroke="#ffffff22" strokeWidth="1" strokeDasharray="3,3" />
            <circle cx={hp.x} cy={hp.y} r="4" fill={stroke} stroke="#0d1321" strokeWidth="2" />
          </>
        )}
      </svg>
      {/* Hover tooltip */}
      {hp && (
        <div style={{
          position: "absolute", bottom: "100%",
          left: `clamp(0px, calc(${tooltipLeftPct}% - 50px), calc(100% - 110px))`,
          background: "#1e293bef", border: "1px solid #334155", borderRadius: 6,
          padding: "4px 8px", fontSize: 11, color: "#e2e8f0",
          whiteSpace: "nowrap", pointerEvents: "none", marginBottom: 4, zIndex: 10,
        }}>
          <div style={{ fontWeight: 700 }}>{(formatter || formatPrice)(prices[hoverIdx])}</div>
          {volBars && volumeData?.[hoverIdx] && (
            <div style={{ color: "#64748b", fontSize: 10 }}>Vol {formatVolume(volumeData[hoverIdx][1])}</div>
          )}
          {times?.[hoverIdx] && (
            <div style={{ color: "#64748b", fontSize: 10 }}>
              {new Date(times[hoverIdx]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Filter / Sort Bar ───
const SORT_OPTIONS = [
  { key: "vol",      label: "Vol 24h" },
  { key: "vol1h",    label: "Vol 1h" },
  { key: "vol6h",    label: "Vol 6h" },
  { key: "mcap",     label: "MCap" },
  { key: "change1h", label: "1h %" },
  { key: "change6h", label: "6h %" },
  { key: "age",      label: "Age" },
];

const FilterBar = ({ sortBy, sortDir, onSort, minVol, onMinVol, minMcap, onMinMcap, minChange1h, onMinChange1h, count, total }) => (
  <div style={{ background: "#0d1321", border: "1px solid #1e293b", borderRadius: 10, padding: "10px 14px", marginBottom: 16, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
    {/* Sort pills */}
    <span style={{ color: "#475569", fontSize: 11, fontWeight: 600, letterSpacing: 0.5 }}>SORT</span>
    {SORT_OPTIONS.map((s) => {
      const active = sortBy === s.key;
      return (
        <button
          key={s.key}
          onClick={() => onSort(s.key)}
          style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${active ? "#6366f1" : "#1e293b"}`, background: active ? "#6366f122" : "transparent", color: active ? "#818cf8" : "#64748b", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 3 }}
        >
          {s.label}
          {active && <span style={{ fontSize: 10 }}>{sortDir === "desc" ? " ↓" : " ↑"}</span>}
        </button>
      );
    })}

    {/* Divider */}
    <div style={{ width: 1, height: 18, background: "#1e293b", margin: "0 2px", flexShrink: 0 }} />

    {/* Filter inputs */}
    <span style={{ color: "#475569", fontSize: 11, fontWeight: 600, letterSpacing: 0.5 }}>FILTER</span>

    <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ color: "#475569", fontSize: 11 }}>{sortBy === "vol1h" ? "Vol1h≥" : sortBy === "vol6h" ? "Vol6h≥" : "Vol≥"}</span>
      <input
        value={minVol}
        onChange={(e) => onMinVol(e.target.value)}
        placeholder="10K"
        style={{ width: 56, background: "#111827", border: "1px solid #1e293b", borderRadius: 5, color: "#e2e8f0", fontSize: 12, padding: "3px 7px", outline: "none" }}
      />
    </label>

    <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ color: "#475569", fontSize: 11 }}>MCap≥</span>
      <input
        value={minMcap}
        onChange={(e) => onMinMcap(e.target.value)}
        placeholder="100K"
        style={{ width: 56, background: "#111827", border: "1px solid #1e293b", borderRadius: 5, color: "#e2e8f0", fontSize: 12, padding: "3px 7px", outline: "none" }}
      />
    </label>

    <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ color: "#475569", fontSize: 11 }}>1h≥</span>
      <input
        value={minChange1h}
        onChange={(e) => onMinChange1h(e.target.value)}
        placeholder="5"
        style={{ width: 42, background: "#111827", border: "1px solid #1e293b", borderRadius: 5, color: "#e2e8f0", fontSize: 12, padding: "3px 7px", outline: "none" }}
      />
      <span style={{ color: "#475569", fontSize: 11 }}>%</span>
    </label>

    {/* Token count */}
    <span style={{ marginLeft: "auto", color: "#334155", fontSize: 11 }}>{count}{total !== count ? `/${total}` : ""} tokens</span>
  </div>
);

// ─── Add Wallet Panel ───
// Parse a bulk import block: one wallet per line, optional label after comma or whitespace
function parseBulkWallets(raw) {
  const trimmed = raw.trim();
  // Detect JSON array format: [{"address": "...", "name": "..."}, ...]
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        return arr
          .filter((w) => w && typeof w.address === "string")
          .map((w) => ({ address: w.address.trim(), label: (w.name || w.label || "").trim() }))
          .filter(({ address }) => address.length >= 32 && address.length <= 44);
      }
    } catch { /* not valid JSON, fall through to line-by-line */ }
  }
  // Line-by-line format: "address,label" or "address label"
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const commaIdx = line.indexOf(",");
      if (commaIdx !== -1) {
        return { address: line.slice(0, commaIdx).trim(), label: line.slice(commaIdx + 1).trim() };
      }
      const spaceIdx = line.search(/\s/);
      if (spaceIdx !== -1) {
        return { address: line.slice(0, spaceIdx).trim(), label: line.slice(spaceIdx + 1).trim() };
      }
      return { address: line, label: "" };
    })
    .filter(({ address }) => address.length >= 32 && address.length <= 44);
}

const AddWalletPanel = ({ onAdd, onClose }) => {
  const [mode, setMode] = useState("single"); // "single" | "bulk"
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [bulk, setBulk] = useState("");
  const [bulkResult, setBulkResult] = useState(null); // null | number
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleAddSingle = () => {
    const trimmed = address.trim();
    if (!trimmed) return;
    onAdd(trimmed, label.trim());
    onClose();
  };

  const handleBulkImport = () => {
    const entries = parseBulkWallets(bulk);
    if (entries.length === 0) return;
    entries.forEach(({ address, label }) => onAdd(address, label));
    setBulkResult(entries.length);
    setTimeout(onClose, 1400);
  };

  const parsed = mode === "bulk" ? parseBulkWallets(bulk) : [];

  return (
    <div style={{ background: "#111827", border: "1px solid #4ade8044", borderRadius: 12, padding: "16px 20px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "#4ade80", fontWeight: 700, fontSize: 14 }}>Add Solana wallet</span>
          {/* Mode toggle */}
          <div style={{ display: "flex", background: "#0d1321", border: "1px solid #334155", borderRadius: 6, overflow: "hidden" }}>
            {["single", "bulk"].map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{ padding: "3px 10px", border: "none", background: mode === m ? "#4ade8022" : "transparent", color: mode === m ? "#4ade80" : "#64748b", fontSize: 11, fontWeight: 700, cursor: "pointer", textTransform: "capitalize" }}
              >
                {m === "single" ? "Single" : "Bulk import"}
              </button>
            ))}
          </div>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 16 }}>✕</button>
      </div>

      {mode === "single" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            ref={inputRef}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddSingle()}
            placeholder="Wallet address (Solana)…"
            style={{ background: "#0d1321", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 13, padding: "8px 12px", outline: "none" }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (optional)"
              style={{ flex: 1, background: "#0d1321", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 13, padding: "8px 12px", outline: "none" }}
            />
            <button
              onClick={handleAddSingle}
              disabled={!address.trim()}
              style={{ background: "#4ade8022", border: "1px solid #4ade8044", borderRadius: 8, color: "#4ade80", fontSize: 13, fontWeight: 600, padding: "8px 16px", cursor: !address.trim() ? "not-allowed" : "pointer", opacity: !address.trim() ? 0.5 : 1 }}
            >
              Add
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <textarea
            ref={inputRef}
            value={bulk}
            onChange={(e) => { setBulk(e.target.value); setBulkResult(null); }}
            placeholder={"Paste addresses (one per line) or JSON array:\n\nABC...XYZ, My main wallet\nDEF...UVW whale\n\nJSON: [{\"address\":\"...\",\"name\":\"...\"}]"}
            rows={6}
            style={{ background: "#0d1321", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 12, fontFamily: "monospace", padding: "10px 12px", outline: "none", resize: "vertical", lineHeight: 1.6 }}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: parsed.length > 0 ? "#94a3b8" : "#475569", fontSize: 12 }}>
              {parsed.length > 0 ? `${parsed.length} valid address${parsed.length > 1 ? "es" : ""} detected` : "Paste addresses above"}
            </span>
            {bulkResult !== null ? (
              <span style={{ color: "#4ade80", fontSize: 13, fontWeight: 700 }}>✓ Added {bulkResult} wallet{bulkResult > 1 ? "s" : ""}</span>
            ) : (
              <button
                onClick={handleBulkImport}
                disabled={parsed.length === 0}
                style={{ background: "#4ade8022", border: "1px solid #4ade8044", borderRadius: 8, color: "#4ade80", fontSize: 13, fontWeight: 600, padding: "8px 16px", cursor: parsed.length === 0 ? "not-allowed" : "pointer", opacity: parsed.length === 0 ? 0.5 : 1 }}
              >
                Import {parsed.length > 0 ? parsed.length : ""} wallet{parsed.length !== 1 ? "s" : ""}
              </button>
            )}
          </div>
        </div>
      )}

      <div style={{ color: "#475569", fontSize: 11, marginTop: 8 }}>Only Solana wallets supported. Shows tokens listed on DexScreener.</div>
    </div>
  );
};

// ─── Main App ───
export default function App() {
  const greeting = getGreeting();
  const [activeChain, setActiveChain] = useState("All Chains");
  const [activeSection, setActiveSection] = useState("discover"); // "discover" | "wallets"
  const chains = ["All Chains", "Solana", "Base"];

  const { prices, sparklines, loading: priceLoading, error: priceError } = useCryptoPrices();
  const { articles: newsArticles, loading: newsLoading, error: newsError } = useCryptoNews();
  const { tokens, loading: tokenLoading, refreshing: tokenRefreshing, fetchedAt: tokenFetchedAt, error: tokenError } = useTrendingTokens(activeChain);

  // Pinned CAs: [{ca, chainId}]
  const [pinnedCAs, setPinnedCAs] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pinnedCAs") || "[]"); } catch { return []; }
  });

  const { tokens: pinnedTokens, loading: pinnedLoading, refetch: refetchPinned } = usePinnedTokens(pinnedCAs);

  // Wallets: [{address, label}]
  const [wallets, setWallets] = useState(() => {
    try { return JSON.parse(localStorage.getItem("trackedWallets") || "[]"); } catch { return []; }
  });

  const [showAddCA, setShowAddCA] = useState(false);
  const [showAddWallet, setShowAddWallet] = useState(false);

  // mint → [{address, label, amount, usdValue}] across all tracked wallets
  const [walletMintMap, setWalletMintMap] = useState({});
  const { links: walletLinks, relatedWallets: relatedWalletList, loading: walletLinksLoading } = useWalletLinks(wallets, walletMintMap);
  const handleHoldingsLoaded = useCallback((walletAddr, walletLabel, holdings) => {
    setWalletMintMap((prev) => {
      const next = { ...prev };
      // Remove stale entries for this wallet
      Object.keys(next).forEach((mint) => {
        next[mint] = next[mint].filter((h) => h.address !== walletAddr);
        if (next[mint].length === 0) delete next[mint];
      });
      // Add fresh entries
      holdings.forEach((h) => {
        if (!h.mint) return;
        const price = h.pair?.priceUsd ? parseFloat(h.pair.priceUsd) : 0;
        const icon = h.pair?.icon || h.pair?.info?.imageUrl || null;
        const symbol = h.pair?.baseToken?.symbol || null;
        const entry = { address: walletAddr, label: walletLabel, amount: h.amount, usdValue: price * h.amount, icon, symbol };
        next[h.mint] = [...(next[h.mint] || []), entry];
      });
      return next;
    });
  }, []);

  // Filters & sort
  const [sortBy, setSortBy] = useState("vol");
  const [sortDir, setSortDir] = useState("desc");
  const [minVol, setMinVol] = useState("");
  const [minMcap, setMinMcap] = useState("");
  const [minChange1h, setMinChange1h] = useState("");

  const handleSort = (key) => {
    if (sortBy === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortBy(key); setSortDir("desc"); }
  };

  const applyFilters = (list) => {
    const volMin = parseVolInput(minVol);
    const mcapMin = parseVolInput(minMcap);
    const change1hMin = minChange1h !== "" ? parseFloat(minChange1h) : null;
    return list
      .filter((t) => {
        if (!volMin) return true;
        const v = sortBy === "vol1h" ? (t.volume?.h1 || 0) : sortBy === "vol6h" ? (t.volume?.h6 || 0) : (t.volume?.h24 || 0);
        return v >= volMin;
      })
      .filter((t) => !mcapMin || (t.marketCap || t.fdv || 0) >= mcapMin)
      .filter((t) => change1hMin === null || (t.priceChange?.h1 ?? -Infinity) >= change1hMin)
      .sort((a, b) => {
        let aVal, bVal;
        if (sortBy === "vol")        { aVal = a.volume?.h24 || 0;          bVal = b.volume?.h24 || 0; }
        else if (sortBy === "vol1h") { aVal = a.volume?.h1 || 0;           bVal = b.volume?.h1 || 0; }
        else if (sortBy === "vol6h") { aVal = a.volume?.h6 || 0;           bVal = b.volume?.h6 || 0; }
        else if (sortBy === "mcap")  { aVal = a.marketCap || a.fdv || 0;   bVal = b.marketCap || b.fdv || 0; }
        else if (sortBy === "change1h") { aVal = a.priceChange?.h1 ?? -999; bVal = b.priceChange?.h1 ?? -999; }
        else if (sortBy === "change6h") { aVal = a.priceChange?.h6 ?? -999; bVal = b.priceChange?.h6 ?? -999; }
        else if (sortBy === "age") { aVal = a.pairCreatedAt || 0;         bVal = b.pairCreatedAt || 0; }
        else { aVal = 0; bVal = 0; }
        return sortDir === "desc" ? bVal - aVal : aVal - bVal;
      });
  };

  const lastFetchedAt = tokenFetchedAt ? new Date(tokenFetchedAt) : null;

  useEffect(() => {
    localStorage.setItem("pinnedCAs", JSON.stringify(pinnedCAs));
  }, [pinnedCAs]);

  useEffect(() => {
    localStorage.setItem("trackedWallets", JSON.stringify(wallets));
  }, [wallets]);

  const pinToken = (ca, chainId) => {
    setPinnedCAs((prev) => prev.find((p) => p.ca === ca) ? prev : [...prev, { ca, chainId }]);
  };

  const unpinToken = (ca) => {
    setPinnedCAs((prev) => prev.filter((p) => p.ca !== ca));
  };

  const addWallet = (address, label) => {
    setWallets((prev) => prev.find((w) => w.address === address) ? prev : [...prev, { address, label }]);
  };

  const removeWallet = (address) => {
    setWallets((prev) => prev.filter((w) => w.address !== address));
    // Remove this wallet's holdings from the mint map so badges disappear
    setWalletMintMap((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((mint) => {
        next[mint] = next[mint].filter((h) => h.address !== address);
        if (next[mint].length === 0) delete next[mint];
      });
      return next;
    });
  };

  const chainFilter = (t) =>
    activeChain === "Solana" ? t.chainId === "solana" :
    activeChain === "Base"   ? t.chainId === "base"   : true;

  const filteredTokens = applyFilters(tokens.filter(chainFilter));
  const filteredPinned = applyFilters(pinnedTokens.filter(chainFilter));

  const coinConfigs = [
    { id: "bitcoin", symbol: "BTC", color: "#F7931A", newsKey: "bitcoin" },
    { id: "ethereum", symbol: "ETH", color: "#627EEA", newsKey: "ethereum" },
    { id: "solana", symbol: "SOL", color: "#9945FF", newsKey: "solana" },
  ];

  return (
    <div className="app-bg" style={{ minHeight: "100vh", padding: "32px 24px", maxWidth: 1120, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32, flexWrap: "wrap", gap: 16 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
            <span style={{ fontSize: 26, animation: "float 3s ease-in-out infinite", display: "inline-block" }}>{greeting.emoji}</span>
            <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0, letterSpacing: -0.5 }}>
              <span className="logo-text">CryptoDawn</span>
            </h1>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#334155", border: "1px solid #1e293b", borderRadius: 5, padding: "2px 7px", letterSpacing: 1 }}>
              {greeting.title.toUpperCase()}
            </span>
          </div>
          <p style={{ color: "#475569", fontSize: 13, margin: 0, paddingLeft: 36 }}>{greeting.sub}</p>
        </div>
        <div className="chain-group">
          {chains.map((chain) => (
            <button
              key={chain}
              onClick={() => setActiveChain(chain)}
              className={`chain-btn ${activeChain === chain ? "active" : "inactive"}`}
            >
              {chain}
            </button>
          ))}
        </div>
      </div>

      {/* Market Overview Panel */}
      <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 16, padding: 24, marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>Market Overview</span>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <LiveIndicator />
            {tokenRefreshing && (
              <span style={{ color: "#475569", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>↺</span> Refreshing…
              </span>
            )}
            {lastFetchedAt && !tokenRefreshing && (
              <span style={{ color: "#334155", fontSize: 11 }}>Updated {lastFetchedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            )}
          </div>
        </div>

        {priceError && (
          <div style={{ background: "#7f1d1d33", border: "1px solid #991b1b", borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: "#fca5a5", fontSize: 13 }}>⚠ Price fetch failed: {priceError}</div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
          {priceLoading
            ? [1, 2, 3].map((i) => <PriceSkeleton key={i} />)
            : coinConfigs.map((coin) => (
                <CoinCard key={coin.symbol} coin={coin} data={prices?.[coin.id]} sparkline={sparklines?.[coin.id]} allNews={newsArticles} newsLoading={newsLoading} />
              ))}
        </div>
      </div>

      {/* News Feed */}
      <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 16, padding: "20px 24px", marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, color: "#e2e8f0", margin: 0, letterSpacing: 0.3 }}>Crypto News</h2>
          <span style={{ fontSize: 11, color: "#475569" }}>Updates every 5m</span>
        </div>
        {newsLoading && newsArticles.length === 0 ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
            {[1,2,3,4].map((i) => (
              <div key={i} style={{ background: "#0d1321", borderRadius: 10, padding: 14, height: 72 }}>
                <div style={{ width: "80%", height: 12, background: "#1e293b", borderRadius: 4, marginBottom: 8 }} />
                <div style={{ width: "50%", height: 10, background: "#1e293b", borderRadius: 4 }} />
              </div>
            ))}
          </div>
        ) : newsError && newsArticles.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: 13, textAlign: "center", padding: "18px 0" }}>
            Unable to load news — will retry automatically
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
            {newsArticles.slice(0, 12).map((a) => {
              const timeLabel = a.timeAgo || (() => { const m = Math.floor((Date.now() - a.time) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; })();
              return (
                <a
                  key={a.id}
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ background: "#0d1321", border: "1px solid #1e293b", borderRadius: 10, padding: "12px 14px", textDecoration: "none", display: "flex", gap: 12, alignItems: "flex-start", transition: "border-color 0.15s" }}
                  onMouseEnter={(e) => e.currentTarget.style.borderColor = "#334155"}
                  onMouseLeave={(e) => e.currentTarget.style.borderColor = "#1e293b"}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#cbd5e1", lineHeight: 1.35, marginBottom: 4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{a.title}</div>
                    <div style={{ fontSize: 11, color: "#475569" }}>{a.source} · {timeLabel}</div>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>

      {/* Section Nav */}
      <div className="gradient-divider" />
      <div style={{ display: "flex", marginBottom: 28 }}>
        <div className="tab-group">
          {[
            { key: "discover", label: "🔥 Discover" },
            { key: "wallets",  label: `👜 Wallets${wallets.length > 0 ? ` (${wallets.length})` : ""}` },
          ].map((s) => (
            <button
              key={s.key}
              onClick={() => setActiveSection(s.key)}
              className={`tab-btn ${activeSection === s.key ? "active" : "inactive"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Discover Section ─── */}
      {activeSection === "discover" && (
        <>
          {/* Filter / Sort bar */}
          <FilterBar
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={handleSort}
            minVol={minVol}
            onMinVol={setMinVol}
            minMcap={minMcap}
            onMinMcap={setMinMcap}
            minChange1h={minChange1h}
            onMinChange1h={setMinChange1h}
            count={filteredTokens.length}
            total={tokens.filter(chainFilter).length}
          />

          {/* Pinned tokens */}
          {(pinnedCAs.length > 0) && (
            <div style={{ marginBottom: 32 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: "#818cf8", margin: 0 }}>📌 Pinned</h2>
                <button
                  onClick={() => setShowAddCA(!showAddCA)}
                  style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #6366f144", background: showAddCA ? "#6366f122" : "transparent", color: "#818cf8", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                >
                  + Track CA
                </button>
              </div>

              {showAddCA && <AddCAPanel onAdd={(ca, chainId) => { pinToken(ca, chainId); refetchPinned(); }} onClose={() => setShowAddCA(false)} />}

              {pinnedLoading && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
                  {[1, 2].map((i) => <TokenSkeleton key={i} />)}
                </div>
              )}
              {!pinnedLoading && filteredPinned.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
                  {filteredPinned.map((pair, i) => (
                    <TokenCard
                      key={`pinned-${pair.pairAddress}-${i}`}
                      pair={pair}
                      isPinned={true}
                      onPin={pinToken}
                      onUnpin={unpinToken}
                      walletHolders={(pair.baseToken?.address && walletMintMap[pair.baseToken.address]) || []}
                      allNews={newsArticles}
                      newsLoading={newsLoading}
                    />
                  ))}
                </div>
              )}
              {!pinnedLoading && filteredPinned.length === 0 && pinnedCAs.length > 0 && (
                <div style={{ color: "#475569", fontSize: 13, padding: "12px 0" }}>No pinned tokens match this chain filter.</div>
              )}
            </div>
          )}

          {/* Track CA button (when no pinned tokens yet) */}
          {pinnedCAs.length === 0 && (
            <div style={{ marginBottom: 24 }}>
              {showAddCA ? (
                <AddCAPanel onAdd={(ca, chainId) => { pinToken(ca, chainId); refetchPinned(); }} onClose={() => setShowAddCA(false)} />
              ) : (
                <button
                  onClick={() => setShowAddCA(true)}
                  style={{ padding: "8px 16px", borderRadius: 8, border: "1px dashed #334155", background: "transparent", color: "#64748b", fontSize: 13, fontWeight: 600, cursor: "pointer", width: "100%" }}
                >
                  + Track a token by contract address
                </button>
              )}
            </div>
          )}

          {/* Trending tokens */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
            <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: "#f1f5f9", margin: 0 }}>Trending</h2>
            <span style={{ color: "#64748b", fontSize: 12 }}>Powered by GeckoTerminal • Click card to view</span>
          </div>

          {tokenError && (
            <div style={{ background: "#7f1d1d33", border: "1px solid #991b1b", borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: "#fca5a5", fontSize: 13 }}>⚠ Token fetch failed: {tokenError}. Will retry…</div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
            {tokenLoading
              ? [1, 2, 3, 4, 5, 6].map((i) => <TokenSkeleton key={i} />)
              : filteredTokens.map((pair, i) => {
                  const ca = pair.baseToken?.address || "";
                  return (
                    <TokenCard
                      key={`${pair.pairAddress}-${i}`}
                      pair={pair}
                      rank={i + 1}
                      isPinned={pinnedCAs.some((p) => p.ca === ca)}
                      onPin={pinToken}
                      onUnpin={unpinToken}
                      walletHolders={(ca && walletMintMap[ca]) || []}
                      allNews={newsArticles}
                      newsLoading={newsLoading}
                    />
                  );
                })}
          </div>

          {!tokenLoading && filteredTokens.length === 0 && !tokenError && (
            <div style={{ textAlign: "center", color: "#475569", padding: 48, fontSize: 14 }}>No trending tokens found for this chain right now.</div>
          )}
        </>
      )}

      {/* ─── Wallets Section ─── */}
      {activeSection === "wallets" && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <div>
              <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: "#4ade80", margin: 0 }}>Wallet Tracker</h2>
              <p style={{ color: "#475569", fontSize: 12, margin: "4px 0 0" }}>Add Solana wallets to track their token positions</p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {wallets.length > 0 && (
                <button
                  onClick={() => {
                    const data = wallets.map((w) => ({ address: w.address, name: w.label || "", emoji: "", groups: [] }));
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    Object.assign(document.createElement("a"), { href: url, download: "cryptodawn-wallets.json" }).click();
                    URL.revokeObjectURL(url);
                  }}
                  style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #334155", background: "transparent", color: "#64748b", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                >
                  ↓ Export
                </button>
              )}
              <button
                onClick={() => setShowAddWallet(!showAddWallet)}
                style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #4ade8044", background: showAddWallet ? "#4ade8022" : "transparent", color: "#4ade80", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
              >
                + Add Wallet
              </button>
            </div>
          </div>

          {showAddWallet && <AddWalletPanel onAdd={addWallet} onClose={() => setShowAddWallet(false)} />}

          {wallets.length === 0 && !showAddWallet && (
            <div style={{ textAlign: "center", color: "#475569", padding: 64, fontSize: 14, border: "1px dashed #1e293b", borderRadius: 14 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>👜</div>
              <div style={{ fontWeight: 600, marginBottom: 6, color: "#64748b" }}>No wallets tracked yet</div>
              <div>Add a Solana wallet address to see its token positions</div>
            </div>
          )}

          <WalletGraph wallets={wallets} links={walletLinks} loading={walletLinksLoading} />

          <RelatedWallets
            relatedWallets={relatedWalletList}
            trackedAddrs={new Set(wallets.map((w) => w.address))}
            loading={walletLinksLoading}
            onTrack={addWallet}
            walletMintMap={walletMintMap}
          />

          {wallets.map((wallet) => (
            <WalletCard key={wallet.address} wallet={wallet} onRemove={removeWallet} onHoldingsLoaded={handleHoldingsLoaded} />
          ))}

          {wallets.length > 0 && (
            <div style={{ color: "#334155", fontSize: 11, marginTop: 16, textAlign: "center" }}>
              Token holdings fetched from Solana RPC • Prices from DexScreener • Only tokens listed on DexScreener shown
            </div>
          )}
        </>
      )}

      <div className="gradient-divider" style={{ marginTop: 40, marginBottom: 16 }} />
      <div style={{ textAlign: "center", color: "#1e293b", fontSize: 11, paddingBottom: 24, letterSpacing: 0.5 }}>
        CryptoDawn • Prices via CoinGecko • Tokens via GeckoTerminal • Auto-refreshes every 2 min
      </div>
    </div>
  );
}

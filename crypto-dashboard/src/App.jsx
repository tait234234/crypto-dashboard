import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";

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
            fetchPoolsIntoList(await res.json(), network, allTokens, { volMin: 500, liqMin: 1000, h1Min: 20, h24HrMin: 30 });
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
  const [lastFetchedAt, setLastFetchedAt] = useState(null);

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
        .slice(0, 80); // fetch 80 so USD-value sort below can surface high-value tokens

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
        .filter((h) => h.pair)
        // Re-sort by USD value so high-value positions in any token show first,
        // regardless of raw token-unit balance
        .sort((a, b) => {
          const usdA = parseFloat(a.pair.priceUsd || 0) * a.amount;
          const usdB = parseFloat(b.pair.priceUsd || 0) * b.amount;
          return usdB - usdA;
        })
        .slice(0, 50);

      setHoldings(enriched);
      setLastFetchedAt(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { fetch_(); }, [fetch_]);
  return { holdings, loading, error, lastFetchedAt, refetch: fetch_ };
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

// ── GeckoTerminal request queue ──
// Limits to 2 concurrent requests with 400ms spacing to stay within free-tier rate limits.
// All GT API calls must go through gtFetch() instead of raw fetch().
const _gtReq = (() => {
  const q = [];
  let active = 0;
  const MAX = 2, SPACING = 400;
  let lastLaunch = 0;
  function next() {
    if (active >= MAX || !q.length) return;
    const wait = Math.max(0, lastLaunch + SPACING - Date.now());
    setTimeout(() => {
      if (active >= MAX || !q.length) return;
      const { fn, resolve, reject } = q.shift();
      active++; lastLaunch = Date.now();
      fn().then(resolve, reject).finally(() => { active--; next(); });
    }, wait);
  }
  return (fn) => new Promise((resolve, reject) => { q.push({ fn, resolve, reject }); next(); });
})();

async function gtFetch(url) {
  return _gtReq(async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(url);
      if (res.status !== 429) return res;
      await delay(1500 * (i + 1)); // 1.5s → 3s → 4.5s backoff
    }
    throw new Error("GT rate limited");
  });
}

// ── Persistent cache helpers (sessionStorage + in-memory) ──
const _memCache = {};
function ssGet(key) {
  if (_memCache[key] !== undefined) return _memCache[key];
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { v, ts, ttl } = JSON.parse(raw);
    if (Date.now() - ts > ttl) { sessionStorage.removeItem(key); return null; }
    _memCache[key] = v;
    return v;
  } catch { return null; }
}
function ssSet(key, value, ttl) {
  _memCache[key] = value;
  try { sessionStorage.setItem(key, JSON.stringify({ v: value, ts: Date.now(), ttl })); } catch {}
}
const SS_TTL_POOL  = 24 * 60 * 60 * 1000; // pool address: 24h
const SS_TTL_CHART = 30 * 60 * 1000;       // chart data:   30min

// ── Pool address lookup cache ──
const gtPoolPending = {}; // dedup concurrent lookups for same token

async function findGTPool(network, tokenCA) {
  const key = "gtp:" + network + ":" + tokenCA;
  const cached = ssGet(key);
  if (cached) return cached;
  if (gtPoolPending[key]) return gtPoolPending[key];

  const promise = (async () => {
    try {
      const url = "https://api.geckoterminal.com/api/v2/networks/" + network + "/tokens/" + tokenCA + "/pools?page=1";
      const res = await gtFetch(url);
      if (!res.ok) return null;
      const json = await res.json();
      const addr = json.data?.[0]?.attributes?.address || null;
      if (addr) ssSet(key, addr, SS_TTL_POOL);
      return addr;
    } catch { return null; }
    finally { delete gtPoolPending[key]; }
  })();
  gtPoolPending[key] = promise;
  return promise;
}

// gtPoolAddr: if the token came from GeckoTerminal, pass its pool address directly to skip the lookup
function usePoolChart(chainId, tokenCA, gtPoolAddr, enabled, timeframe = "1D") {
  const [priceData, setPriceData] = useState(null);
  const [volumeData, setVolumeData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed]   = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const retry = useCallback(() => setRetryTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !tokenCA || !chainId) return;
    const network = CHAIN_TO_GT_NETWORK[chainId] ?? chainId;
    const { timespan, aggregate, limit } = TF_CONFIG[timeframe] || TF_CONFIG["1D"];
    const cacheKey = "ctd:" + network + ":" + tokenCA + ":" + timeframe;

    // Serve from cache (memory or sessionStorage) — skip fetch entirely
    const cached = ssGet(cacheKey);
    if (cached) {
      setPriceData(cached.priceData);
      setVolumeData(cached.volumeData);
      setFailed(false);
      return;
    }

    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setFailed(false);
      setPriceData(null);
      setVolumeData(null);
      try {
        const poolAddress = gtPoolAddr || await findGTPool(network, tokenCA);
        if (!poolAddress) throw new Error("no pool");
        if (cancelled) return;
        const url = "https://api.geckoterminal.com/api/v2/networks/" + network + "/pools/" + poolAddress
          + "/ohlcv/" + timespan + "?aggregate=" + aggregate + "&limit=" + limit;
        const res = await gtFetch(url);
        if (!res.ok) throw new Error("OHLCV " + res.status);
        const json = await res.json();
        const candles = (json.data?.attributes?.ohlcv_list || []).slice().reverse();
        const prices  = candles.map((c) => [c[0] * 1000, c[4]]);
        const volumes = candles.map((c) => [c[0] * 1000, c[5]]);
        const pd = prices.length >= 2 ? prices : null;
        const vd = volumes.length >= 2 ? volumes : null;
        if (pd) ssSet(cacheKey, { priceData: pd, volumeData: vd }, SS_TTL_CHART);
        if (!cancelled) { setPriceData(pd); setVolumeData(vd); setFailed(!pd); }
      } catch {
        if (!cancelled) { setPriceData(null); setVolumeData(null); setFailed(true); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [enabled, chainId, tokenCA, gtPoolAddr, timeframe, retryTick]);

  return { priceData, volumeData, loading, failed, retry };
}

// ─── Copy-to-clipboard utility with toast feedback ───
function showCopyToast(text = "Copied!") {
  const existing = document.querySelector(".copy-toast");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.className = "copy-toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add("hiding");
    setTimeout(() => el.remove(), 200);
  }, 1200);
}

function copyAddr(text) {
  if (!text) return;
  navigator.clipboard?.writeText(text).then(
    () => showCopyToast("Copied!"),
    () => showCopyToast("Copy failed")
  );
}

// ─── Helpers ───
function formatPrice(num) {
  if (!Number.isFinite(num) || num === 0) return "$0";
  if (num >= 1000) return "$" + num.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (num >= 1) return "$" + num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (num >= 0.01) return "$" + num.toFixed(4);
  if (num >= 0.0001) return "$" + num.toFixed(6);
  return "$" + num.toExponential(2);
}

function formatChange(num) {
  if (!Number.isFinite(num)) return "—";
  const sign = num >= 0 ? "+" : "";
  return sign + num.toFixed(1) + "%";
}

function formatVolume(num) {
  if (!Number.isFinite(num) || num === 0) return "$0";
  if (num >= 1e12) return "$" + (num / 1e12).toFixed(2) + "T";
  if (num >= 1e9)  return "$" + (num / 1e9).toFixed(1)  + "B";
  if (num >= 1e6)  return "$" + (num / 1e6).toFixed(1)  + "M";
  if (num >= 1e3)  return "$" + (num / 1e3).toFixed(1)  + "K";
  if (num >= 10)   return "$" + Math.round(num);
  return "$" + num.toFixed(2);
}

function formatTokenAmount(n) {
  if (!Number.isFinite(n)) return "0";
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

function timeAgo(date) {
  if (!date) return null;
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 15)  return "just now";
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
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
    copyAddr(addr);
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

  const top3pct  = holders ? holders.slice(0, 3).reduce((s, h) => s + h.pct, 0) : null;
  const top10pct = holders ? holders.slice(0, 10).reduce((s, h) => s + h.pct, 0) : null;
  const concColor = top10pct == null ? "#64748b" : top10pct > 60 ? "#f87171" : top10pct > 40 ? "#f59e0b" : "#4ade80";
  const concLabel = top10pct == null ? "" : top10pct > 60 ? "⚠ Concentrated" : top10pct > 40 ? "Moderate" : "Healthy";

  return (
    <div style={{ marginTop: 12, padding: "10px 14px", background: "#0d1321", borderRadius: 8, border: "1px solid #1e293b" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: top10pct != null ? 6 : 8 }}>
        <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 700 }}>Top Holders</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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

      {/* Concentration summary bar */}
      {top10pct != null && !loading && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <div style={{ display: "flex", gap: 12 }}>
              <span style={{ fontSize: 10, color: "#64748b" }}>
                Top 3: <span style={{ fontWeight: 700, color: (top3pct || 0) > 40 ? "#f87171" : "#94a3b8" }}>{(top3pct || 0).toFixed(1)}%</span>
              </span>
              <span style={{ fontSize: 10, color: "#64748b" }}>
                Top 10: <span style={{ fontWeight: 700, color: concColor }}>{top10pct.toFixed(1)}%</span>
              </span>
            </div>
            <span style={{ fontSize: 10, fontWeight: 700, color: concColor, background: `${concColor}18`, border: `1px solid ${concColor}44`, borderRadius: 5, padding: "1px 6px" }}>{concLabel}</span>
          </div>
          <div style={{ height: 4, background: "#1e293b", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.min(top10pct, 100)}%`, background: concColor, borderRadius: 2, transition: "width 0.4s ease" }} />
          </div>
        </div>
      )}

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
const TokenCard = memo(({ pair, isPinned, onPin, onUnpin, walletHolders = [], rank, allNews = [], newsLoading = false, priceAlerts = [], onSetAlert, onRemoveAlert, note = "", onNoteChange }) => {
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
  const [showAlertForm, setShowAlertForm] = useState(false);
  const [alertTarget, setAlertTarget] = useState("");
  const [alertDir, setAlertDir] = useState("above");
  const myAlerts = priceAlerts.filter((a) => a.ca === ca);
  const hasAlert = myAlerts.length > 0;
  const { holders, loading: holdersLoading, error: holdersError, refetch: refetchHolders } = useTokenHolders(ca, pair.chainId, showHolders);
  const gtPoolAddr = pair.source === "gt" ? pair.pairAddress : null;
  const { priceData: chartData, volumeData, loading: chartLoading, failed: chartFailed, retry: retryChart } = usePoolChart(pair.chainId, ca, gtPoolAddr, showChart, chartTf);

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
        {/* DexScreener link */}
        <a
          href={dexUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open on DexScreener"
          style={{ width: 28, height: 28, borderRadius: 6, background: "#1e293b", border: "1px solid #334155", display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontSize: 11, fontWeight: 800, color: "#94a3b8", cursor: "pointer", flexShrink: 0, letterSpacing: -0.5 }}
          onClick={(e) => e.stopPropagation()}
        >
          DS
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
        {/* Price alert bell */}
        {ca && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowAlertForm((v) => !v); }}
            title={hasAlert ? `${myAlerts.length} alert active — click to manage` : "Set price alert"}
            style={{ position: "relative", width: 28, height: 28, borderRadius: 6, background: showAlertForm ? "#f59e0b22" : hasAlert ? "#f59e0b18" : "#1e293b", border: `1px solid ${hasAlert || showAlertForm ? "#f59e0b55" : "#334155"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: hasAlert || showAlertForm ? "#f59e0b" : "#64748b", cursor: "pointer", flexShrink: 0 }}
          >
            🔔
            {hasAlert && (
              <span style={{ position: "absolute", top: -4, right: -4, background: "#f59e0b", color: "#0d1321", borderRadius: "50%", fontSize: 8, fontWeight: 800, minWidth: 12, height: 12, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
                {myAlerts.length}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Price alert form */}
      {showAlertForm && ca && (
        <div style={{ background: "#0d1321", border: "1px solid #f59e0b33", borderRadius: 8, padding: "10px 12px", marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
          <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600 }}>Alert when</span>
          <select
            value={alertDir}
            onChange={(e) => setAlertDir(e.target.value)}
            style={{ background: "#111827", border: "1px solid #334155", borderRadius: 5, color: "#e2e8f0", fontSize: 11, padding: "2px 6px", cursor: "pointer" }}
          >
            <option value="above">price goes above</option>
            <option value="below">price drops below</option>
          </select>
          <input
            type="number"
            value={alertTarget}
            onChange={(e) => setAlertTarget(e.target.value)}
            placeholder={pair.priceUsd ? `current: $${parseFloat(pair.priceUsd).toPrecision(4)}` : "target price"}
            style={{ width: 120, background: "#111827", border: "1px solid #334155", borderRadius: 5, color: "#e2e8f0", fontSize: 11, padding: "2px 8px", outline: "none" }}
          />
          <button
            onClick={() => {
              const t = parseFloat(alertTarget);
              if (!isNaN(t) && t > 0) {
                onSetAlert?.(ca, pair.chainId, symbol, t, alertDir);
                showCopyToast(`🔔 Alert set: ${symbol} ${alertDir} $${t.toPrecision(4)}`);
                setShowAlertForm(false);
                setAlertTarget("");
              }
            }}
            style={{ padding: "2px 10px", borderRadius: 5, border: "1px solid #f59e0b44", background: "#f59e0b22", color: "#f59e0b", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
          >
            Set
          </button>
          {hasAlert && (
            <button
              onClick={() => { onRemoveAlert?.(ca); setShowAlertForm(false); showCopyToast("Alert cleared"); }}
              style={{ padding: "2px 8px", borderRadius: 5, border: "1px solid #334155", background: "transparent", color: "#64748b", fontSize: 11, cursor: "pointer" }}
            >
              Clear all
            </button>
          )}
          {myAlerts.length > 0 && (
            <div style={{ width: "100%", display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
              {myAlerts.map((a) => (
                <span key={a.direction} style={{ fontSize: 10, color: a.triggered ? "#4ade80" : "#f59e0b", background: a.triggered ? "#4ade8011" : "#f59e0b11", borderRadius: 5, padding: "2px 7px", border: `1px solid ${a.triggered ? "#4ade8033" : "#f59e0b33"}` }}>
                  {a.triggered ? "✓ triggered" : a.direction === "above" ? "↑" : "↓"} ${a.targetPrice.toPrecision(4)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

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
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 0" }}>
              <span style={{ color: "#334155", fontSize: 11 }}>
                {chartFailed ? "Chart unavailable" : "No chart data"}
              </span>
              {chartFailed && (
                <button
                  onClick={(e) => { e.stopPropagation(); retryChart(); }}
                  style={{ padding: "1px 7px", borderRadius: 4, background: "#1e293b", border: "1px solid #334155", color: "#64748b", fontSize: 10, cursor: "pointer" }}
                >
                  retry
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* CA row */}
      {ca && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "#334155", fontSize: 10, fontFamily: "monospace" }}>CA:</span>
          <span style={{ color: "#475569", fontSize: 10, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{ca}</span>
          <button
            onClick={() => { copyAddr(ca); setCaCopied(true); setTimeout(() => setCaCopied(false), 1500); }}
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

      {/* Notes — only for pinned tokens */}
      {isPinned && (
        <div style={{ borderTop: "1px solid #1e293b", marginTop: 10, paddingTop: 8 }} onClick={(e) => e.stopPropagation()}>
          <textarea
            value={note}
            onChange={(e) => onNoteChange?.(e.target.value)}
            placeholder="Add research notes…"
            rows={note ? Math.max(2, (note.match(/\n/g) || []).length + 1) : 1}
            style={{ width: "100%", background: "transparent", border: "none", outline: "none", color: note ? "#64748b" : "#1e293b", fontSize: 11, resize: "none", fontFamily: "inherit", boxSizing: "border-box", padding: 0, lineHeight: 1.5, cursor: "text" }}
          />
        </div>
      )}
    </div>
  );
});

// ─── Wallet Link Graph ───
const HELIUS_KEY = "0dd8f0ec-f2a5-4f9e-b275-379afa3e73cd";

// Fetch up to maxTxs transactions for a wallet via Helius enhanced API (paginated)
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 503) {
        if (i < retries) { await new Promise((r) => setTimeout(r, 1000 * (i + 1))); continue; }
        return null;
      }
      if (!res.ok) return null;
      return res;
    } catch {
      if (i < retries) { await new Promise((r) => setTimeout(r, 1000 * (i + 1))); continue; }
      return null;
    }
  }
  return null;
}

async function fetchWalletTxs(address, maxTxs = 200, type = null) {
  const PER_PAGE = 100;
  const all = [];
  let before = undefined;
  while (all.length < maxTxs) {
    const toFetch = Math.min(PER_PAGE, maxTxs - all.length);
    const base = "https://api.helius.xyz/v0/addresses/" + address + "/transactions";
    let params = "?api-key=" + HELIUS_KEY + "&limit=" + toFetch;
    if (type) params += "&type=" + type;
    if (before) params += "&before=" + before;
    const res = await fetchWithRetry(base + params);
    if (!res) break;
    try {
      const page = await res.json();
      if (!Array.isArray(page) || !page.length) break;
      all.push(...page);
      if (page.length < toFetch) break;
      before = page[page.length - 1].signature;
    } catch { break; }
  }
  return all;
}

// ── Blacklist: program IDs, pool vaults, and fee collectors that are NOT user wallets ──
// These appear as counterparties in swaps/transfers but belong to protocols, not people.
const PROTOCOL_BLACKLIST = new Set([
  // Solana system / token infrastructure
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",   // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bxbc", // Associated Token
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111h",
  "Stake11111111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",   // Memo program

  // Raydium – programs + fee/authority accounts
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // AMM v4
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",  // AMM authority
  "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",  // Fee collector
  "HWy1jotHpo6UqeQxx49dpYYdQB8wj9Qk9MdxwjLvDHB8",  // Fee collector v2
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",  // Protocol fee
  "EhhTKczWMGQt46ynNeRX1WfeagwwJd7ufHvCDjRxjo5Q",  // V3 fee
  "3uaZBfHPfmpAHW7dsimC1SnyR61X4bJqQZKWmRSCXJxv",  // Staking
  "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",  // CLMM
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",  // CLMM program

  // Jupiter
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "jupoNjAxXgZ4rjzxzPMP4QoLQtCMY9rHwxGqsGDFFBX",
  "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf",  // Jupiter fee token account

  // Orca Whirlpools
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",

  // Pump.fun
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBymLf5",
  "CebN5WGQ4jvEPvsVU4EoHEpgznyKmGG8KE9W3VHwHhGZ",  // Fee wallet

  // Meteora
  "Eo7WjKq67rjJQDd81erLuyWJloaZBMUMbAMhLHa1S4zp",  // DLMM
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",   // LB pair

  // OpenBook / Serum
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",
  "opnb2LAfJYbRMAHHvqjCwQxanZn7n7BS2qDGGRNxNEy",
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",  // Serum v2

  // Moonshot
  "MoonCVVNZFSYkqNXP6bxHLPL6QQXiMbNtjfTYDHCB1h",
]);

// DEX/AMM program IDs whose owned accounts (vaults, positions) are pool contracts, not user wallets.
// Used to dynamically filter pool addresses from accountData without needing every pool address.
const DEX_PROGRAM_OWNERS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // Raydium AMM v4
  "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",  // Raydium CLMM
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",  // Raydium CLMM program
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   // Orca Whirlpools
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",  // Orca v2
  "Eo7WjKq67rjJQDd81erLuyWJloaZBMUMbAMhLHa1S4zp",  // Meteora DLMM
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",   // Meteora LB
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",   // Serum v3
  "opnb2LAfJYbRMAHHvqjCwQxanZn7n7BS2qDGGRNxNEy",   // OpenBook
]);

// Build the set of addresses to exclude for a given transaction.
// Combines the static blacklist with any pool-owned accounts found in accountData.
function buildExcluded(tx) {
  const excluded = new Set(PROTOCOL_BLACKLIST);
  (tx.accountData || []).forEach((a) => {
    if (a.programOwner && DEX_PROGRAM_OWNERS.has(a.programOwner) && a.account) {
      excluded.add(a.account);
    }
  });
  return excluded;
}

// Extract all counterparty addresses from a Helius enhanced transaction
function extractCounterparties(tx, ownAddress) {
  const excluded = buildExcluded(tx);
  const addrs = new Set();
  const ok = (addr) => addr && addr !== ownAddress && !excluded.has(addr);
  (tx.nativeTransfers || []).forEach((t) => {
    if (ok(t.fromUserAccount)) addrs.add(t.fromUserAccount);
    if (ok(t.toUserAccount)) addrs.add(t.toUserAccount);
  });
  (tx.tokenTransfers || []).forEach((t) => {
    if (ok(t.fromUserAccount)) addrs.add(t.fromUserAccount);
    if (ok(t.toUserAccount)) addrs.add(t.toUserAccount);
  });
  return [...addrs];
}

// Extract {counterpartyAddress → Set<mint>} from a transaction
function extractCounterpartyMints(tx, ownAddress) {
  const excluded = buildExcluded(tx);
  const map = new Map(); // counterparty → Set<mint>
  (tx.tokenTransfers || []).forEach((t) => {
    if (!t.mint) return;
    [t.fromUserAccount, t.toUserAccount].forEach((acct) => {
      if (acct && acct !== ownAddress && !excluded.has(acct)) {
        if (!map.has(acct)) map.set(acct, new Set());
        map.get(acct).add(t.mint);
      }
    });
  });
  return map;
}

// Hook: given walletMintMap + wallets, compute all link edges + discover related untracked wallets
const MIN_FUNDING_SOL    = 0.01;          // ignore SOL transfers below this (lamports: 10_000_000)
const MIN_FUNDING_USDC   = 5;             // ignore USDC transfers below $5
const USDC_MINT          = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function useWalletLinks(wallets, walletMintMap) {
  const [links, setLinks] = useState([]);
  const [relatedWallets, setRelatedWallets] = useState([]);
  const [fundingWallets, setFundingWallets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanStatus, setScanStatus] = useState(""); // human-readable scan phase
  const [scanKey, setScanKey] = useState(0); // increment to force rescan
  const addrs = wallets.map((w) => w.address);

  const rescan = useCallback(() => setScanKey((k) => k + 1), []);

  useEffect(() => {
    if (wallets.length < 1) { setLinks([]); setRelatedWallets([]); setFundingWallets([]); return; }
    const addrSet = new Set(addrs);
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setScanStatus("Fetching transactions…");

      // Run items in small batches with a delay between batches to avoid rate limits.
      const runBatched = async (items, fn, batchSize = 3, delayMs = 400) => {
        for (let i = 0; i < items.length; i += batchSize) {
          if (cancelled) break;
          await Promise.all(items.slice(i, i + batchSize).map(fn));
          if (i + batchSize < items.length && !cancelled) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
      };

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
            // Bug fix: walletMintMap entries are {address, label, amount, usdValue, icon, symbol}
            // — access .symbol directly, not via .pair.baseToken.symbol
            const sym = holders.find((h) => h.symbol)?.symbol;
            if (sym) edge.sharedTokens.push(sym);
          }
        }
      });

      // ── Signal 2: transaction-level links ──
      // Fetch a broad set of recent txs + a deep TRANSFER-only set to maximise coverage.
      // TRANSFER set is deeper (500) so we can catch older funding/wallet-to-wallet transfers.
      const txsByWallet = new Map();
      await Promise.all(
        addrs.map(async (addr) => {
          const [allTxs, transferTxs] = await Promise.all([
            fetchWalletTxs(addr, 200),           // recent activity — all types
            fetchWalletTxs(addr, 500, "TRANSFER"), // deeper history — direct transfers & funding
          ]);
          if (!cancelled) {
            const seen = new Set();
            const merged = [];
            for (const tx of [...allTxs, ...transferTxs]) {
              if (tx.signature && !seen.has(tx.signature)) {
                seen.add(tx.signature);
                merged.push(tx);
              }
            }
            txsByWallet.set(addr, merged);
          }
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
      // Also track SOL/stablecoin transfer amounts per counterparty so we can
      // prioritise high-value intermediaries for 2nd-degree probing.
      if (!cancelled) setScanStatus("Building 1st-degree connections…");
      const USDT_MINT_LOCAL = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
      const STABLES_LOCAL = new Set([USDC_MINT, USDT_MINT_LOCAL]);
      const externalMap = new Map();
      addrs.forEach((addr) => {
        const txs = txsByWallet.get(addr) || [];
        txs.forEach((tx) => {
          const excluded = buildExcluded(tx);
          const mintMap = extractCounterpartyMints(tx, addr);
          extractCounterparties(tx, addr).forEach((cp) => {
            if (!addrSet.has(cp)) {
              if (!externalMap.has(cp)) externalMap.set(cp, { wallets: new Set(), txCount: 0, mints: new Set(), sol: 0, stable: 0 });
              const entry = externalMap.get(cp);
              entry.wallets.add(addr);
              entry.txCount++;
              (mintMap.get(cp) || []).forEach((m) => entry.mints.add(m));
            }
          });
          // Accumulate SOL amounts per counterparty
          (tx.nativeTransfers || []).forEach((t) => {
            const solAmt = (t.amount || 0) / 1e9;
            if (solAmt <= 0) return;
            [t.fromUserAccount, t.toUserAccount].forEach((a) => {
              if (a && a !== addr && !addrSet.has(a) && !excluded.has(a) && externalMap.has(a)) {
                externalMap.get(a).sol += solAmt;
              }
            });
          });
          // Accumulate stablecoin amounts per counterparty
          (tx.tokenTransfers || []).forEach((t) => {
            const amt = t.tokenAmount || 0;
            if (amt <= 0 || !STABLES_LOCAL.has(t.mint)) return;
            [t.fromUserAccount, t.toUserAccount].forEach((a) => {
              if (a && a !== addr && !addrSet.has(a) && !excluded.has(a) && externalMap.has(a)) {
                externalMap.get(a).stable += amt;
              }
            });
          });
        });
      });

      // Common funder edges
      externalMap.forEach(({ wallets: walletSet }, funder) => {
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

      // 1st-degree related wallet list — now includes sol/stable amounts
      const related = [];
      externalMap.forEach(({ wallets: walletSet, txCount, mints, sol, stable }, extAddr) => {
        related.push({
          address: extAddr,
          sharedWith: [...walletSet],
          txCount,
          mints: [...mints],
          degree: 1,
          via: [],
          sol: Math.round(sol * 1000) / 1000,
          stable: Math.round(stable * 100) / 100,
          sharedWithLabels: [...walletSet].map((a) => {
            const w = wallets.find((x) => x.address === a);
            return w?.label || `${a.slice(0, 4)}…${a.slice(-4)}`;
          }),
        });
      });
      related.sort((a, b) => b.sharedWith.length - a.sharedWith.length || b.txCount - a.txCount);

      // ── 2nd-degree discovery: probe top intermediary wallets ──
      // Sort by transfer value (SOL + stables) so high-value fund-flow
      // intermediaries are probed first and deeper.
      const probeTargets = related
        .filter((r) => r.txCount >= 1)
        .sort((a, b) => {
          // Value score: SOL + stables normalised to SOL equivalent
          const valA = (a.sol || 0) + (a.stable || 0) / 150;
          const valB = (b.sol || 0) + (b.stable || 0) / 150;
          if (valB !== valA) return valB - valA;
          return b.sharedWith.length - a.sharedWith.length || b.txCount - a.txCount;
        })
        .slice(0, 30); // increased from 20 → 30

      if (probeTargets.length > 0 && !cancelled) {
        const knownAddrs = new Set([...addrSet, ...externalMap.keys()]);
        const secondDegree = new Map();
        setScanStatus(`Scanning 2nd-degree connections (${probeTargets.length} wallets, 3 at a time)…`);

        await runBatched(probeTargets, async (intermediary) => {
            try {
              // High-value intermediaries (≥$100 stables or ≥1 SOL) get a deeper probe
              const isHighValue = (intermediary.stable || 0) >= 100 || (intermediary.sol || 0) >= 1;
              const txLimit = isHighValue ? 300 : 100;
              const txs = await fetchWalletTxs(intermediary.address, txLimit, "TRANSFER");
              if (cancelled) return;
              txs.forEach((tx) => {
                const excluded = buildExcluded(tx);
                extractCounterparties(tx, intermediary.address).forEach((cp) => {
                  if (addrSet.has(cp) || cp === intermediary.address) return;
                  if (knownAddrs.has(cp)) return;
                  if (!secondDegree.has(cp)) secondDegree.set(cp, { via: new Set(), trackedLinks: new Set(), txCount: 0, sol: 0, stable: 0 });
                  const entry = secondDegree.get(cp);
                  entry.via.add(intermediary.address);
                  entry.txCount++;
                  intermediary.sharedWith.forEach((w) => entry.trackedLinks.add(w));
                });
                // Track SOL/stablecoin amounts for 2nd-degree counterparties
                (tx.nativeTransfers || []).forEach((t) => {
                  const solAmt = (t.amount || 0) / 1e9;
                  if (solAmt <= 0) return;
                  [t.fromUserAccount, t.toUserAccount].forEach((a) => {
                    if (a && secondDegree.has(a)) secondDegree.get(a).sol += solAmt;
                  });
                });
                (tx.tokenTransfers || []).forEach((t) => {
                  const amt = t.tokenAmount || 0;
                  if (amt <= 0 || !STABLES_LOCAL.has(t.mint)) return;
                  [t.fromUserAccount, t.toUserAccount].forEach((a) => {
                    if (a && secondDegree.has(a)) secondDegree.get(a).stable += amt;
                  });
                });
              });
            } catch {}
        });

        // Add 2nd-degree wallets with transfer amounts
        secondDegree.forEach(({ via, trackedLinks, txCount, sol, stable }, addr) => {
          if (txCount < 1) return;
          related.push({
            address: addr,
            sharedWith: [...trackedLinks],
            txCount,
            mints: [],
            degree: 2,
            via: [...via],
            sol: Math.round(sol * 1000) / 1000,
            stable: Math.round(stable * 100) / 100,
            viaLabels: [...via].map((v) => `${v.slice(0, 4)}…${v.slice(-4)}`),
            sharedWithLabels: [...trackedLinks].map((a) => {
              const w = wallets.find((x) => x.address === a);
              return w?.label || `${a.slice(0, 4)}…${a.slice(-4)}`;
            }),
          });
        });

        related.sort((a, b) => {
          if (a.degree !== b.degree) return a.degree - b.degree;
          // Within same degree, sort by value then by shared wallet count
          const valA = (a.sol || 0) + (a.stable || 0) / 150;
          const valB = (b.sol || 0) + (b.stable || 0) / 150;
          if (valB !== valA) return valB - valA;
          return b.sharedWith.length - a.sharedWith.length || b.txCount - a.txCount;
        });

        // ── 3rd-degree discovery: follow high-value 2nd-degree wallets further ──
        // Only probe 2nd-degree wallets that had significant value transferred through them.
        // This automatically traces chains like: trackedWallet → A → B → C
        if (!cancelled) {
          const allKnown = new Set([...addrSet, ...externalMap.keys(), ...secondDegree.keys()]);
          const thirdDegreeTargets = [...secondDegree.entries()]
            .filter(([, v]) => (v.stable || 0) >= 100 || (v.sol || 0) >= 1)
            .sort(([, a], [, b]) => ((b.sol || 0) + (b.stable || 0) / 150) - ((a.sol || 0) + (a.stable || 0) / 150))
            .slice(0, 15)
            .map(([addr, v]) => ({ address: addr, ...v }));

          if (thirdDegreeTargets.length > 0) {
            const thirdDegree = new Map();
            // Keep a reference map so we can build the full via-chain later:
            // 3rd-degree wallet → which 2nd-degree wallet discovered it
            const thirdViaIntermediary = new Map();

            setScanStatus(`Scanning 3rd-degree connections (${thirdDegreeTargets.length} wallets, 3 at a time)…`);

            await runBatched(thirdDegreeTargets, async (intermediary) => {
              try {
                const txs = await fetchWalletTxs(intermediary.address, 150, "TRANSFER");
                if (cancelled) return;
                txs.forEach((tx) => {
                  extractCounterparties(tx, intermediary.address).forEach((cp) => {
                    if (cp === intermediary.address) return;
                    if (allKnown.has(cp)) return;
                    if (!thirdDegree.has(cp)) thirdDegree.set(cp, { via: new Set(), trackedLinks: new Set(), txCount: 0, sol: 0, stable: 0 });
                    const entry = thirdDegree.get(cp);
                    entry.via.add(intermediary.address);
                    entry.txCount++;
                    intermediary.trackedLinks.forEach((w) => entry.trackedLinks.add(w));
                    // Store the 2nd-degree intermediary so we can build the full chain
                    if (!thirdViaIntermediary.has(cp)) thirdViaIntermediary.set(cp, intermediary);
                  });
                  // Track amounts for 3rd-degree counterparties
                  (tx.nativeTransfers || []).forEach((t) => {
                    const solAmt = (t.amount || 0) / 1e9;
                    if (solAmt <= 0) return;
                    [t.fromUserAccount, t.toUserAccount].forEach((a) => {
                      if (a && thirdDegree.has(a)) thirdDegree.get(a).sol += solAmt;
                    });
                  });
                  (tx.tokenTransfers || []).forEach((t) => {
                    const amt = t.tokenAmount || 0;
                    if (amt <= 0 || !STABLES_LOCAL.has(t.mint)) return;
                    [t.fromUserAccount, t.toUserAccount].forEach((a) => {
                      if (a && thirdDegree.has(a)) thirdDegree.get(a).stable += amt;
                    });
                  });
                });
              } catch {}
            }, 3, 300);

            thirdDegree.forEach(({ via, trackedLinks, txCount, sol, stable }, addr) => {
              if (txCount < 1) return;
              // Build the full hop chain: [1st-hop, 2nd-hop] so UI can show tracked→hop1→hop2→addr
              const secondHopIntermediary = thirdViaIntermediary.get(addr);
              const firstHops = secondHopIntermediary ? [...(secondHopIntermediary.via || [])] : [];
              const fullVia = [...firstHops, ...[...via]];
              related.push({
                address: addr,
                sharedWith: [...trackedLinks],
                txCount,
                mints: [],
                degree: 3,
                via: fullVia,
                sol: Math.round(sol * 1000) / 1000,
                stable: Math.round(stable * 100) / 100,
                viaLabels: fullVia.map((v) => `${v.slice(0, 4)}…${v.slice(-4)}`),
                sharedWithLabels: [...trackedLinks].map((a) => {
                  const w = wallets.find((x) => x.address === a);
                  return w?.label || `${a.slice(0, 4)}…${a.slice(-4)}`;
                }),
              });
            });

            related.sort((a, b) => {
              if (a.degree !== b.degree) return a.degree - b.degree;
              const valA = (a.sol || 0) + (a.stable || 0) / 150;
              const valB = (b.sol || 0) + (b.stable || 0) / 150;
              if (valB !== valA) return valB - valA;
              return b.sharedWith.length - a.sharedWith.length || b.txCount - a.txCount;
            });
          }
        }
      }

      // ── Funding detection ──
      if (!cancelled) setScanStatus("Detecting funding sources…");
      const fundingMap = new Map();
      addrs.forEach((addr) => {
        (txsByWallet.get(addr) || []).forEach((tx) => {
          const excluded = buildExcluded(tx);
          const isValidFunder = (f) => f && f !== addr && !addrSet.has(f) && !excluded.has(f);
          (tx.nativeTransfers || []).forEach((t) => {
            const solAmt = (t.amount || 0) / 1e9;
            if (t.toUserAccount === addr && isValidFunder(t.fromUserAccount) && solAmt >= MIN_FUNDING_SOL) {
              const f = t.fromUserAccount;
              if (!fundingMap.has(f)) fundingMap.set(f, { walletsFunded: new Set(), totalSol: 0, totalUsdc: 0, txCount: 0 });
              const e = fundingMap.get(f);
              e.walletsFunded.add(addr);
              e.totalSol += solAmt;
              e.txCount++;
            }
          });
          (tx.tokenTransfers || []).forEach((t) => {
            if (t.toUserAccount === addr && isValidFunder(t.fromUserAccount) && t.mint === USDC_MINT && (t.tokenAmount || 0) >= MIN_FUNDING_USDC) {
              const f = t.fromUserAccount;
              if (!fundingMap.has(f)) fundingMap.set(f, { walletsFunded: new Set(), totalSol: 0, totalUsdc: 0, txCount: 0 });
              const e = fundingMap.get(f);
              e.walletsFunded.add(addr);
              e.totalUsdc += t.tokenAmount;
              e.txCount++;
            }
          });
        });
      });
      const fundingArr = [];
      fundingMap.forEach(({ walletsFunded, totalSol, totalUsdc, txCount }, funder) => {
        fundingArr.push({
          address: funder,
          walletsFunded: [...walletsFunded].map((a) => {
            const w = wallets.find((x) => x.address === a);
            return w?.label || `${a.slice(0, 4)}…${a.slice(-4)}`;
          }),
          totalSol: Math.round(totalSol * 1000) / 1000,
          totalUsdc: Math.round(totalUsdc * 100) / 100,
          txCount,
        });
      });
      fundingArr.sort((a, b) => (b.totalSol + b.totalUsdc / 150) - (a.totalSol + a.totalUsdc / 150));

      if (!cancelled) {
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
        setRelatedWallets(related.slice(0, 100));
        setFundingWallets(fundingArr.slice(0, 20));
        setLoading(false);
        setScanStatus("");
      }
    };

    run();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets.length, JSON.stringify(addrs), Object.keys(walletMintMap).length, scanKey]);

  return { links, relatedWallets, fundingWallets, loading, scanStatus, rescan };
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

function WalletGraph({ wallets, links, loading, onRescan }) {
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
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {loading && <div style={{ fontSize: 11, color: "#38bdf8", animation: "pulse-dot 1.5s infinite" }}>Analysing…</div>}
          {onRescan && !loading && (
            <button onClick={onRescan}
              title="Re-scan transactions to find connections"
              style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #334155", background: "transparent", color: "#64748b", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>
              ↺ Rescan
            </button>
          )}
        </div>
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
function RelatedWallets({ relatedWallets, fundingWallets = [], trackedAddrs, loading, scanStatus = "", onTrack, walletMintMap, onRescan }) {
  const DEFAULT_SHOWN = 15;
  const [showLimit, setShowLimit] = useState(DEFAULT_SHOWN);
  const [tracked, setTracked] = useState(new Set());
  const [addrSearch, setAddrSearch] = useState(""); // direct wallet address search
  const [deepScan, setDeepScan] = useState({ running: false, target: null, found: null, txsChecked: 0 });

  const runDeepScan = useCallback(async (targetAddress) => {
    setDeepScan({ running: true, target: targetAddress, found: null, txsChecked: 0 });
    const MAX_TXS = 5000;
    let totalChecked = 0;
    const foundTxs = [];
    for (const addr of [...trackedAddrs]) {
      let before;
      let fetched = 0;
      while (fetched < MAX_TXS) {
        const base = "https://api.helius.xyz/v0/addresses/" + addr + "/transactions";
        let params = "?api-key=" + HELIUS_KEY + "&limit=100";
        if (before) params += "&before=" + before;
        try {
          const res = await fetch(base + params);
          if (!res.ok) break;
          const page = await res.json();
          if (!Array.isArray(page) || !page.length) break;
          fetched += page.length;
          totalChecked += page.length;
          before = page[page.length - 1].signature;
          for (const tx of page) {
            const cps = extractCounterparties(tx, addr);
            if (cps.includes(targetAddress)) {
              foundTxs.push({ trackedAddr: addr, signature: tx.signature, type: tx.type, timestamp: tx.timestamp });
            }
          }
          setDeepScan((prev) => ({ ...prev, txsChecked: totalChecked }));
          if (page.length < 100) break;
        } catch { break; }
      }
    }
    setDeepScan({ running: false, target: targetAddress, found: foundTxs, txsChecked: totalChecked });
  }, [trackedAddrs]);

  const [pathFind, setPathFind] = useState({ running: false, target: null, path: null, status: "" });

  const runPathFinder = useCallback(async (targetAddress) => {
    setPathFind({ running: true, target: targetAddress, path: null, status: "Starting…" });

    const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
    const STABLES = new Set([USDC_MINT, USDT_MINT]);

    // Aggregate significant transfers per counterparty across a set of txs.
    // Tracks SOL, stablecoins (USDC+USDT), and any other token transfers.
    const getSignificantCPs = (txs, ownAddr, minSol = 1.0, minStable = 100) => {
      const totals = new Map(); // address → { sol, stable, tokenTxs }
      const ensure = (a) => { if (!totals.has(a)) totals.set(a, { sol: 0, stable: 0, tokenTxs: 0 }); return totals.get(a); };
      txs.forEach((tx) => {
        const excluded = buildExcluded(tx);
        const ok = (a) => a && a !== ownAddr && !excluded.has(a);
        (tx.nativeTransfers || []).forEach((t) => {
          const sol = (t.amount || 0) / 1e9;
          if (sol <= 0) return;
          [t.fromUserAccount, t.toUserAccount].forEach((a) => {
            if (ok(a)) ensure(a).sol += sol;
          });
        });
        (tx.tokenTransfers || []).forEach((t) => {
          const amt = t.tokenAmount || 0;
          if (amt <= 0) return;
          const isStable = STABLES.has(t.mint);
          [t.fromUserAccount, t.toUserAccount].forEach((a) => {
            if (!ok(a)) return;
            const e = ensure(a);
            if (isStable) e.stable += amt;
            else e.tokenTxs++;
          });
        });
      });
      return [...totals.entries()]
        // Significant = ≥ minSol SOL, OR ≥ minStable stablecoins, OR ≥ 2 other-token interactions
        .filter(([, v]) => v.sol >= minSol || v.stable >= minStable || v.tokenTxs >= 2)
        .sort((a, b) => (b[1].sol + b[1].stable / 150 + b[1].tokenTxs * 0.1) - (a[1].sol + a[1].stable / 150 + a[1].tokenTxs * 0.1))
        .map(([addr, v]) => ({ address: addr, sol: Math.round(v.sol * 100) / 100, stable: Math.round(v.stable), tokenTxs: v.tokenTxs }));
    };

    // BFS config per hop — fetch ALL tx types (no TRANSFER filter)
    const HOP_CONFIG = [
      { maxNodes: 15, txLimit: 500 }, // hop 1: deep scan of tracked wallets
      { maxNodes: 12, txLimit: 200 }, // hop 2: intermediaries
      { maxNodes:  8, txLimit: 100 }, // hop 3: 2nd intermediaries
      { maxNodes:  5, txLimit: 100 }, // hop 4: 3rd intermediaries
    ];
    const CONCURRENCY = 3; // max parallel wallet fetches to avoid Helius rate limits

    // Process items in throttled batches of CONCURRENCY with a delay between groups
    const throttledForEach = async (items, fn) => {
      for (let i = 0; i < items.length; i += CONCURRENCY) {
        if (found) return;
        const group = items.slice(i, i + CONCURRENCY);
        await Promise.all(group.map(fn));
        if (i + CONCURRENCY < items.length) await new Promise((r) => setTimeout(r, 400));
      }
    };

    const visited = new Set([...trackedAddrs]);
    let found = null;
    let queue = [...trackedAddrs].map((a) => ({ address: a, path: [a] }));

    for (let hop = 0; hop < HOP_CONFIG.length && !found; hop++) {
      const { maxNodes, txLimit } = HOP_CONFIG[hop];
      const batch = queue.slice(0, maxNodes);
      if (!batch.length) break;
      setPathFind((p) => ({ ...p, status: `Hop ${hop + 1} — scanning ${batch.length} wallet${batch.length !== 1 ? "s" : ""} (${CONCURRENCY} at a time)…` }));

      const nextQueue = [];
      await throttledForEach(batch, async (node) => {
        if (found) return;
        try {
          const txs = await fetchWalletTxs(node.address, txLimit); // ALL tx types
          if (found) return;
          const cps = getSignificantCPs(txs, node.address);
          for (const cp of cps) {
            if (cp.address === targetAddress) {
              found = { path: [...node.path, cp.address], edge: cp };
              return;
            }
            if (!visited.has(cp.address)) {
              visited.add(cp.address);
              nextQueue.push({ address: cp.address, path: [...node.path, cp.address], edge: cp });
            }
          }
        } catch { /* ignore failed nodes */ }
      });

      if (!found) {
        queue = nextQueue.sort((a, b) => (b.edge?.sol || 0) + (b.edge?.stable || 0) / 150 - (a.edge?.sol || 0) - (a.edge?.stable || 0) / 150);
      }
    }

    if (found) {
      setPathFind({ running: false, target: targetAddress, path: found.path, status: "Path found!" });
    } else {
      setPathFind({ running: false, target: targetAddress, path: null, status: `No path found within ${HOP_CONFIG.length} hops via significant transfers.` });
    }
  }, [trackedAddrs]);

  // ── Portfolio overlap scoring ──
  // For each related wallet, fetch all their SPL token mints and count overlap
  // with the set of mints held by any tracked wallet.
  const [overlapScores, setOverlapScores] = useState({}); // address → number

  const trackedMints = useMemo(() => new Set(Object.keys(walletMintMap || {})), [walletMintMap]);

  useEffect(() => {
    if (!relatedWallets.length || !trackedMints.size) return;
    let cancelled = false;
    const scores = {};

    const run = async () => {
      const BATCH = 5;
      for (let i = 0; i < relatedWallets.length; i += BATCH) {
        if (cancelled) return;
        const batch = relatedWallets.slice(i, i + BATCH);
        await Promise.all(batch.map(async (w) => {
          try {
            const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0", id: w.address,
                method: "getTokenAccountsByOwner",
                params: [w.address, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }],
              }),
            });
            const json = await res.json();
            const mints = new Set(
              (json?.result?.value || [])
                .map((a) => a.account?.data?.parsed?.info?.mint)
                .filter(Boolean)
            );
            let overlap = 0;
            mints.forEach((m) => { if (trackedMints.has(m)) overlap++; });
            scores[w.address] = overlap;
          } catch (_) {}
        }));
        if (!cancelled) setOverlapScores((prev) => ({ ...prev, ...scores }));
        // Throttle: wait between batches to avoid hitting RPC rate limits
        if (!cancelled && i + BATCH < relatedWallets.length) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    };

    run();
    return () => { cancelled = true; };
  // rerun when the list of related wallets changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relatedWallets.map((r) => r.address).join(","), trackedMints.size]);

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
    let errCount = 0;
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
          if (json?.error) { errCount++; return null; }
          const accounts = json?.result?.value || [];
          // Use uiAmount when available; fall back to raw amount / 10^decimals
          // (uiAmount can be null for very large token supplies)
          const tokenAmount = accounts.reduce((sum, a) => {
            const info = a.account?.data?.parsed?.info?.tokenAmount;
            if (!info) return sum;
            const ui = info.uiAmount;
            if (ui != null && ui > 0) return sum + ui;
            const raw = parseInt(info.amount || "0", 10);
            if (raw > 0) return sum + raw / Math.pow(10, info.decimals ?? 0);
            return sum;
          }, 0);
          return tokenAmount > 0 ? { ...w, tokenAmount } : null;
        } catch (_) { errCount++; return null; }
      }));
      found.push(...results.filter(Boolean));
      setFilterResults([...found]); // update incrementally
    }

    if (errCount > 0 && found.length === 0) {
      setFilterError(`Could not check ${errCount} wallet${errCount > 1 ? "s" : ""} — RPC error. Try again.`);
    }
    setFilterLoading(false);
  };

  const clearSearch = () => { setActiveCA(null); setCaInput(""); setFilterResults([]); setFilterMeta(null); setFilterError(null); };

  // Show a scanning panel while the hook is running so users can see progress.
  if (loading) {
    const phase = scanStatus || "Scanning…";
    return (
      <div style={{ background: "#0d1321", border: "1px solid #1e293b", borderRadius: 14, padding: "20px 24px", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Spinner */}
          <div style={{ width: 16, height: 16, border: "2px solid #334155", borderTopColor: "#6366f1", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>Tracing fund flows…</div>
            <div style={{ fontSize: 11, color: "#475569", marginTop: 3 }}>{phase}</div>
          </div>
          {relatedWallets.length > 0 && (
            <span style={{ marginLeft: "auto", background: "#6366f122", color: "#818cf8", border: "1px solid #6366f133", borderRadius: 4, fontSize: 10, fontWeight: 700, padding: "2px 8px" }}>
              {relatedWallets.length} found so far
            </span>
          )}
        </div>
      </div>
    );
  }
  if (!relatedWallets.length && !fundingWallets.length && !activeCA) return null;

  function renderFundingSection() {
    if (!fundingWallets.length) return null;
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: "#e2e8f0", letterSpacing: 0.3 }}>Funding Sources</span>
          <span style={{ background: "#f59e0b22", color: "#f59e0b", border: "1px solid #f59e0b44", borderRadius: 4, fontSize: 10, fontWeight: 700, padding: "1px 6px" }}>
            {fundingWallets.length}
          </span>
          <span style={{ fontSize: 10, color: "#475569" }}>≥0.01 SOL or ≥$5 USDC inbound</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {fundingWallets.map((f) => {
            const isAlreadyTracked = trackedAddrs.has(f.address) || tracked.has(f.address);
            return (
              <div key={f.address} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", background: "#111827", borderRadius: 8, border: "1px solid #f59e0b22" }}>
                {/* Funding dot */}
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#f59e0b", flexShrink: 0 }} />

                {/* Address */}
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {f.address}
                </span>

                {/* Amounts */}
                <div style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
                  {f.totalSol > 0 && (
                    <span style={{ background: "#6366f122", color: "#818cf8", border: "1px solid #6366f133", borderRadius: 4, fontSize: 9, fontWeight: 700, padding: "1px 6px", whiteSpace: "nowrap" }}>
                      {f.totalSol} SOL
                    </span>
                  )}
                  {f.totalUsdc > 0 && (
                    <span style={{ background: "#4ade8022", color: "#4ade80", border: "1px solid #4ade8044", borderRadius: 4, fontSize: 9, fontWeight: 700, padding: "1px 6px", whiteSpace: "nowrap" }}>
                      ${f.totalUsdc} USDC
                    </span>
                  )}
                  {f.walletsFunded.length > 0 && (
                    <span style={{ background: "#f59e0b11", color: "#f59e0b", borderRadius: 4, fontSize: 9, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      → {f.walletsFunded.join(", ")}
                    </span>
                  )}
                </div>

                {/* Copy + Solscan + Track */}
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button onClick={() => copyAddr(f.address)} title="Copy address"
                    style={{ width: 24, height: 24, borderRadius: 5, background: "#1e293b", border: "1px solid #334155", color: "#64748b", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    ⎘
                  </button>
                  <a href={`https://solscan.io/account/${f.address}`} target="_blank" rel="noopener noreferrer" title="View on Solscan"
                    style={{ width: 24, height: 24, borderRadius: 5, background: "#1e293b", border: "1px solid #334155", color: "#64748b", fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontWeight: 700 }}>
                    ↗
                  </a>
                  <button
                    onClick={() => { onTrack(f.address, ""); setTracked((prev) => new Set([...prev, f.address])); }}
                    disabled={isAlreadyTracked}
                    style={{ padding: "2px 8px", height: 24, borderRadius: 5, background: isAlreadyTracked ? "#1e293b" : "#4ade8022", border: `1px solid ${isAlreadyTracked ? "#334155" : "#4ade8044"}`, color: isAlreadyTracked ? "#334155" : "#4ade80", fontSize: 10, fontWeight: 700, cursor: isAlreadyTracked ? "default" : "pointer", whiteSpace: "nowrap" }}
                  >
                    {isAlreadyTracked ? "✓ tracked" : "+ Track"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

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
                    <button onClick={() => copyAddr(r.address)} title="Copy address"
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


  // Show all wallets — no hiding based on signal strength.
  // Sort: direct links first (sharedWith.length desc), then by txCount.
  // Collapse to showLimit rows; "Show more" reveals the rest.
  const shown = relatedWallets.slice(0, showLimit);
  const hiddenCount = relatedWallets.length - shown.length;

  return (
    <div className="animate-in" style={{ background: "#0d1321", border: "1px solid #1e293b", borderRadius: 14, padding: "16px 20px", marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
        <div style={{ flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "#e2e8f0", letterSpacing: 0.5 }}>
              Potentially Related Wallets
            </h3>
            <span style={{ background: "#f59e0b22", color: "#f59e0b", border: "1px solid #f59e0b44", borderRadius: 4, fontSize: 10, fontWeight: 700, padding: "1px 6px" }}>{relatedWallets.length}</span>
            {onRescan && (
              <button onClick={onRescan}
                title="Re-scan with deeper transaction history"
                style={{ padding: "2px 8px", borderRadius: 5, border: "1px solid #334155", background: "transparent", color: "#64748b", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>
                ↺ Rescan
              </button>
            )}
          </div>
          <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>
            1st &amp; 2nd degree connections — 200 recent + 500 TRANSFER txs per wallet · Deeper scan available via Rescan
          </div>
        </div>
        {renderCAFilter()}
      </div>

      {renderFundingSection()}

      {/* Direct address lookup — check if any specific wallet was detected */}
      {relatedWallets.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {/* Section label + search bar on same row */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b", letterSpacing: 0.3 }}>
              Transaction History Connections
            </span>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flex: 1, minWidth: 220 }}>
              <input
                value={addrSearch}
                onChange={(e) => setAddrSearch(e.target.value.trim())}
                placeholder="Search detected wallets by address…"
                style={{ flex: 1, padding: "4px 8px", background: "#111827", border: "1px solid #1e293b", borderRadius: 6, color: "#e2e8f0", fontSize: 11, outline: "none", fontFamily: "monospace" }}
              />
              {addrSearch && (
                <button onClick={() => setAddrSearch("")}
                  style={{ background: "transparent", border: "none", color: "#475569", fontSize: 12, cursor: "pointer", padding: "0 4px" }}>✕</button>
              )}
            </div>
          </div>

          {/* Search result */}
          {addrSearch.length > 10 && (() => {
            const rank = relatedWallets.findIndex((r) => r.address === addrSearch);
            if (rank === -1) {
              const isDeepTarget = deepScan.target === addrSearch;
              const deepResult = isDeepTarget ? deepScan.found : null;
              const isPathTarget = pathFind.target === addrSearch;
              const deepDone = isDeepTarget && !deepScan.running && deepResult !== null;
              const showPathBtn = !pathFind.running && !(isPathTarget && pathFind.path !== null) && !(isPathTarget && pathFind.status && !pathFind.running && pathFind.path === null && deepDone);
              return (
                <div style={{ background: "#7f1d1d22", border: "1px solid #991b1b44", borderRadius: 8, padding: "9px 14px", fontSize: 12, color: "#fca5a5", marginBottom: 8 }}>
                  {/* Header row */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span><strong>Not detected</strong> — <code style={{ fontSize: 11 }}>{addrSearch.slice(0, 16)}…</code> did not appear within the standard scan window.</span>
                  </div>

                  {/* Action buttons row */}
                  {!deepScan.running && !pathFind.running && (
                    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                      {deepResult === null && (
                        <button onClick={() => runDeepScan(addrSearch)}
                          style={{ background: "#1e1b4b", border: "1px solid #4f46e5", borderRadius: 5, color: "#a5b4fc", fontSize: 11, fontWeight: 700, padding: "4px 11px", cursor: "pointer", whiteSpace: "nowrap" }}>
                          🔍 Deep Scan — direct txs (up to 5 000)
                        </button>
                      )}
                      {!(isPathTarget && pathFind.status) && (
                        <button onClick={() => runPathFinder(addrSearch)}
                          style={{ background: "#1c1917", border: "1px solid #78716c", borderRadius: 5, color: "#d6d3d1", fontSize: 11, fontWeight: 700, padding: "4px 11px", cursor: "pointer", whiteSpace: "nowrap" }}>
                          🕸️ Trace Path — multi-hop ≥1 SOL / ≥$100
                        </button>
                      )}
                    </div>
                  )}

                  {/* Deep scan progress / result */}
                  {deepScan.running && isDeepTarget && (
                    <div style={{ marginTop: 7, fontSize: 11, color: "#fb923c" }}>🔍 Scanning… {deepScan.txsChecked.toLocaleString()} txs checked</div>
                  )}
                  {deepResult !== null && (
                    deepResult.length > 0 ? (
                      <div style={{ marginTop: 8, background: "#14532d33", border: "1px solid #16a34a55", borderRadius: 6, padding: "8px 12px", color: "#86efac" }}>
                        <strong>Direct link found — {deepResult.length} tx{deepResult.length > 1 ? "s" : ""}!</strong>
                        <span style={{ color: "#4ade8088", fontSize: 11 }}> ({deepScan.txsChecked.toLocaleString()} txs scanned)</span>
                        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                          {deepResult.slice(0, 5).map((t) => (
                            <div key={t.signature} style={{ fontFamily: "monospace", fontSize: 10, color: "#a7f3d0" }}>
                              <span style={{ color: "#6ee7b7" }}>{t.type || "tx"}</span>{" "}
                              {new Date((t.timestamp || 0) * 1000).toLocaleDateString()}{" "}
                              — <a href={"https://solscan.io/tx/" + t.signature} target="_blank" rel="noopener noreferrer" style={{ color: "#34d399" }}>{t.signature.slice(0, 20)}…</a>
                            </div>
                          ))}
                          {deepResult.length > 5 && <span style={{ fontSize: 10, color: "#6ee7b7" }}>…and {deepResult.length - 5} more</span>}
                        </div>
                      </div>
                    ) : (
                      <div style={{ marginTop: 6, fontSize: 11, color: "#ef4444aa" }}>
                        Deep scan done — {deepScan.txsChecked.toLocaleString()} txs checked, no direct tx found. Try Trace Path to find an indirect link.
                      </div>
                    )
                  )}

                  {/* Path finder progress */}
                  {pathFind.running && isPathTarget && (
                    <div style={{ marginTop: 7, fontSize: 11, color: "#fb923c" }}>🕸️ {pathFind.status}</div>
                  )}

                  {/* Path finder result */}
                  {!pathFind.running && isPathTarget && pathFind.path && (
                    <div style={{ marginTop: 8, background: "#1e3a5f33", border: "1px solid #3b82f655", borderRadius: 6, padding: "10px 12px", color: "#93c5fd" }}>
                      <strong style={{ color: "#60a5fa" }}>Path found — {pathFind.path.length - 1} hop{pathFind.path.length - 2 !== 1 ? "s" : ""}!</strong>
                      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap" }}>
                        {pathFind.path.map((addr, i) => (
                          <span key={addr} style={{ display: "flex", alignItems: "center" }}>
                            <span style={{
                              fontFamily: "monospace", fontSize: 10,
                              background: i === 0 || i === pathFind.path.length - 1 ? "#1d4ed822" : "#1e293b",
                              border: `1px solid ${i === 0 || i === pathFind.path.length - 1 ? "#3b82f6" : "#334155"}`,
                              borderRadius: 5, padding: "3px 7px", color: i === 0 || i === pathFind.path.length - 1 ? "#93c5fd" : "#94a3b8",
                              whiteSpace: "nowrap",
                            }}>
                              {addr.slice(0, 6)}…{addr.slice(-4)}
                            </span>
                            {i < pathFind.path.length - 1 && (
                              <span style={{ color: "#475569", fontSize: 13, padding: "0 4px" }}>→</span>
                            )}
                          </span>
                        ))}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 10, color: "#60a5fa88" }}>
                        Each arrow = ≥1 SOL or ≥$100 USDC transferred between those wallets.
                      </div>
                    </div>
                  )}
                  {!pathFind.running && isPathTarget && pathFind.path === null && pathFind.status && (
                    <div style={{ marginTop: 6, fontSize: 11, color: "#ef4444aa" }}>{pathFind.status}</div>
                  )}
                </div>
              );
            }
            const r = relatedWallets[rank];
            const isShown = rank < showLimit;
            return (
              <div style={{ background: "#14532d22", border: "1px solid #16a34a44", borderRadius: 8, padding: "9px 14px", fontSize: 12, color: "#86efac", marginBottom: 8 }}>
                <strong>Found</strong> at rank #{rank + 1} of {relatedWallets.length}
                {!isShown && <span style={{ color: "#4ade80", fontWeight: 700 }}> (hidden — click "Show more" to reveal)</span>}
                <span style={{ display: "flex", gap: 10, marginTop: 5, flexWrap: "wrap", fontSize: 11 }}>
                  <span>Degree: <strong>{r.degree === 3 ? "3rd°" : r.degree === 2 ? "2nd°" : "1st°"}</strong></span>
                  <span>Tx appearances: <strong>{r.txCount}</strong></span>
                  {r.sol > 0 && <span>SOL: <strong>{r.sol}</strong></span>}
                  {r.stable > 0 && <span>Stables: <strong>${r.stable}</strong></span>}
                  <span>Linked to: <strong>{r.sharedWithLabels?.join(", ") || "—"}</strong></span>
                  {r.via?.length > 0 && <span>Via: <strong>{r.via[0].slice(0, 8)}…</strong></span>}
                </span>
              </div>
            );
          })()}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {shown.map((r) => {
          const isAlreadyTracked = trackedAddrs.has(r.address) || tracked.has(r.address);
          const isStrong = r.sharedWith.length >= 2;
          const is2nd = r.degree === 2;
          const is3rd = r.degree === 3;
          const degreeColor = is3rd ? "#f472b6" : is2nd ? "#a78bfa" : null; // pink=3rd, purple=2nd
          const borderColor = is3rd ? "#f472b633" : is2nd ? "#a78bfa33" : isStrong ? "#f59e0b33" : "#1e293b";

          // Resolve token icons for mints this address transacted with
          const tokenIcons = (r.mints || [])
            .map((mint) => ({ mint, ...mintMeta.get(mint) }))
            .filter((t) => t.icon || t.symbol)
            .slice(0, 6);

          return (
            <div key={r.address} style={{ background: "#111827", borderRadius: 8, border: `1px solid ${borderColor}`, overflow: "hidden" }}>
              {/* Main row */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px" }}>
                {/* Signal dot */}
                <div style={{ flexShrink: 0, width: 6, height: 6, borderRadius: "50%", background: degreeColor || (isStrong ? "#f59e0b" : "#334155") }}
                  title={is3rd ? "3rd-degree connection (2 hops via intermediaries)" : is2nd ? "2nd-degree connection (via intermediary)" : isStrong ? "Linked to multiple tracked wallets" : "Linked to 1 tracked wallet"} />

                {/* Address */}
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.address}
                </span>

                {/* Tags */}
                <div style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
                  {is3rd && (
                    <span title={r.via?.length ? `Via: ${r.via.map((v) => v.slice(0, 6) + "…").join(", ")}` : "3rd-degree connection"} style={{ background: "#f472b622", color: "#f472b6", border: "1px solid #f472b644", borderRadius: 4, fontSize: 9, fontWeight: 700, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      3rd°
                    </span>
                  )}
                  {is2nd && !is3rd && (
                    <span title={r.via?.length ? `Via: ${r.via.map((v) => v.slice(0, 6) + "…").join(", ")}` : "2nd-degree connection"} style={{ background: "#a78bfa22", color: "#a78bfa", border: "1px solid #a78bfa44", borderRadius: 4, fontSize: 9, fontWeight: 700, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      2nd°
                    </span>
                  )}
                  {isStrong && (
                    <span style={{ background: "#f59e0b22", color: "#f59e0b", border: "1px solid #f59e0b44", borderRadius: 4, fontSize: 9, fontWeight: 700, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      {r.sharedWith.length} wallets
                    </span>
                  )}
                  <span style={{ background: "#1e293b", color: "#475569", borderRadius: 4, fontSize: 9, padding: "1px 5px", whiteSpace: "nowrap" }}>
                    {r.txCount} tx{r.txCount !== 1 ? "s" : ""}
                  </span>
                  {/* SOL/stablecoin transfer amounts */}
                  {r.sol > 0 && (
                    <span style={{ background: "#6366f122", color: "#818cf8", border: "1px solid #6366f133", borderRadius: 4, fontSize: 9, fontWeight: 700, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      {r.sol >= 1000 ? `${(r.sol / 1000).toFixed(1)}K` : r.sol.toFixed(r.sol < 1 ? 3 : 1)} SOL
                    </span>
                  )}
                  {r.stable > 0 && (
                    <span style={{ background: "#4ade8022", color: "#4ade80", border: "1px solid #4ade8044", borderRadius: 4, fontSize: 9, fontWeight: 700, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      ${r.stable >= 1000 ? `${(r.stable / 1000).toFixed(1)}K` : r.stable.toFixed(0)}
                    </span>
                  )}
                  {r.sharedWithLabels.slice(0, 2).map((lbl, i) => (
                    <span key={i} style={{ background: "#6366f122", color: "#818cf8", border: "1px solid #6366f133", borderRadius: 4, fontSize: 9, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      {lbl}
                    </span>
                  ))}
                  {/* Portfolio overlap badge */}
                  {overlapScores[r.address] > 0 && (
                    <span title="Shared tokens with your tracked wallet(s)" style={{ background: "#f59e0b22", color: "#fbbf24", border: "1px solid #f59e0b44", borderRadius: 4, fontSize: 9, fontWeight: 700, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      {overlapScores[r.address]} shared tokens
                    </span>
                  )}
                </div>

                {/* Copy + Solscan + Track */}
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button
                    onClick={() => copyAddr(r.address)}
                    title="Copy address"
                    style={{ width: 24, height: 24, borderRadius: 5, background: "#1e293b", border: "1px solid #334155", color: "#64748b", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                  >
                    ⎘
                  </button>
                  <a href={`https://solscan.io/account/${r.address}`} target="_blank" rel="noopener noreferrer"
                    title="View on Solscan"
                    style={{ width: 24, height: 24, borderRadius: 5, background: "#1e293b", border: "1px solid #334155", color: "#64748b", fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontWeight: 700 }}>
                    ↗
                  </a>
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

              {/* Fund flow chain — show the hop path for 2nd and 3rd-degree connections */}
              {(is2nd || is3rd) && r.via?.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 3, padding: "3px 10px 5px 22px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 9, color: "#334155" }}>via</span>
                  {r.via.map((hop, i) => (
                    <span key={hop} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                      <span style={{ fontFamily: "monospace", fontSize: 9, color: degreeColor, background: `${degreeColor}11`, border: `1px solid ${degreeColor}33`, borderRadius: 3, padding: "1px 4px" }}>
                        {hop.slice(0, 4)}…{hop.slice(-4)}
                      </span>
                      {i < r.via.length - 1 && <span style={{ fontSize: 9, color: "#334155" }}>→</span>}
                    </span>
                  ))}
                </div>
              )}

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

      {hiddenCount > 0 && (
        <button
          onClick={() => setShowLimit((v) => v + 25)}
          style={{ marginTop: 10, width: "100%", padding: "6px 0", background: "transparent", border: "1px dashed #1e293b", borderRadius: 6, color: "#475569", fontSize: 11, cursor: "pointer" }}
        >
          Show {Math.min(hiddenCount, 25)} more ({hiddenCount} remaining)
        </button>
      )}
      {showLimit > DEFAULT_SHOWN && (
        <button
          onClick={() => setShowLimit(DEFAULT_SHOWN)}
          style={{ marginTop: 4, width: "100%", padding: "4px 0", background: "transparent", border: "none", color: "#334155", fontSize: 10, cursor: "pointer" }}
        >
          Collapse
        </button>
      )}

      {/* Token holder filter results */}
      {activeCA && renderTokenHolders()}

      <div style={{ fontSize: 10, color: "#334155", marginTop: 8 }}>
        Auto-traces fund flow chains up to 3 hops • 200 recent + 500 TRANSFER txs per wallet • High-value intermediaries probed deeper • Amber = 2+ wallets • Purple = 2nd° • Pink = 3rd°
      </div>
    </div>
  );
}

// ─── Wallet Card ───
const WalletHoldingRow = ({ holding, allocPct, onPin, isPinned }) => {
  const { pair, amount, mint } = holding;
  const symbol = pair.baseToken?.symbol || "???";
  const name = pair.baseToken?.name || "Unknown";
  const chain = getChainLabel(pair.chainId);
  const price = pair.priceUsd ? parseFloat(pair.priceUsd) : 0;
  const usdValue = price * amount;
  const iconUrl = pair.icon || pair.info?.imageUrl || null;
  const dexUrl = pair.url || `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`;
  const bubbleMapsUrl = getBubbleMapsUrl(pair.chainId, mint);
  const ch24 = pair?.priceChange?.h24;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid #1e293b" }}>
      {/* Token icon */}
      <div style={{ position: "relative", width: 32, height: 32, flexShrink: 0 }}>
        {iconUrl && (
          <img src={iconUrl} alt={symbol} style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid #ffffff11", objectFit: "cover", position: "absolute", top: 0, left: 0 }} onError={(e) => { e.target.style.display = "none"; }} />
        )}
        <div style={{ width: 32, height: 32, borderRadius: 8, background: hashColor(symbol), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#e2e8f0" }}>
          {symbol.slice(0, 2)}
        </div>
      </div>

      {/* Symbol + name */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 13 }}>{symbol}</span>
          <ChainBadge chain={chain} />
          {Number.isFinite(allocPct) && allocPct >= 1 && (
            <span style={{ fontSize: 9, color: "#475569", fontWeight: 600 }}>{allocPct.toFixed(0)}%</span>
          )}
        </div>
        <div style={{ color: "#64748b", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
      </div>

      {/* Value + change */}
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, justifyContent: "flex-end" }}>
          <span style={{ color: "#f1f5f9", fontSize: 13, fontWeight: 600 }}>{usdValue >= 0.01 ? formatVolume(usdValue) : "< $0.01"}</span>
          {Number.isFinite(ch24) && (
            <span style={{ fontSize: 10, fontWeight: 700, color: ch24 >= 0 ? "#4ade80" : "#f87171", background: ch24 >= 0 ? "#4ade8011" : "#f8717111", padding: "1px 4px", borderRadius: 4, whiteSpace: "nowrap" }}>
              {ch24 >= 0 ? "+" : ""}{ch24.toFixed(1)}%
            </span>
          )}
        </div>
        <div style={{ color: "#64748b", fontSize: 11 }}>{formatTokenAmount(amount)} · {formatPrice(price)}</div>
      </div>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
        {onPin && (
          <button
            onClick={() => onPin(mint, pair.chainId || "solana")}
            title={isPinned ? "Already pinned" : "Pin token to Discover tab"}
            aria-label={isPinned ? "Pinned" : "Pin token"}
            style={{ width: 26, height: 26, borderRadius: 5, background: isPinned ? "#6366f122" : "#1e293b", border: `1px solid ${isPinned ? "#6366f144" : "#334155"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: isPinned ? "#818cf8" : "#64748b", cursor: isPinned ? "default" : "pointer" }}
          >
            {isPinned ? "✓" : "📌"}
          </button>
        )}
        <a href={dexUrl} target="_blank" rel="noopener noreferrer" title="View on DexScreener" style={{ width: 26, height: 26, borderRadius: 5, background: "#1e293b", border: "1px solid #334155", display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontSize: 12, color: "#94a3b8" }}>↗</a>
        <a href={bubbleMapsUrl} target="_blank" rel="noopener noreferrer" title="BubbleMaps" style={{ width: 26, height: 26, borderRadius: 5, background: "#1e293b", border: "1px solid #334155", display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontSize: 12, color: "#60a5fa" }}>🫧</a>
      </div>
    </div>
  );
};

const WALLET_SORTS = [
  { key: "value",  label: "Value"  },
  { key: "change", label: "24h %"  },
  { key: "name",   label: "Name"   },
];

const WalletCard = memo(({ wallet, onRemove, onHoldingsLoaded, pinnedMints, onPin, onUpdateLabel, compact = false, walletStats, note = "", onNoteChange, externalSearch = "", expansionSignal }) => {
  const { holdings, loading, error, lastFetchedAt, refetch } = useWalletTokens(wallet.address);
  const [expanded, setExpanded]         = useState(true);
  const [confirmingRemove, setConfirming] = useState(false);
  const [sort, setSort]                 = useState("value"); // value | change | name
  const [search, setSearch]             = useState("");
  const [showSearch, setShowSearch]     = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft]     = useState(wallet.label || "");
  const labelInputRef                   = useRef(null);

  // Tick every 30s so "X ago" stays fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  // Report loaded holdings back to parent for the mint→wallets map
  useEffect(() => {
    if (!loading && !error && holdings.length > 0) {
      onHoldingsLoaded?.(wallet.address, wallet.label || "", holdings);
    }
  }, [holdings, loading, error, wallet.address, wallet.label, onHoldingsLoaded]);

  // Auto-expand when a global holdings search is active
  useEffect(() => {
    if (externalSearch.trim()) setExpanded(true);
  }, [externalSearch]);

  // Respond to expand/collapse-all signal from parent
  useEffect(() => {
    if (expansionSignal && expansionSignal.v > 0) setExpanded(expansionSignal.expanded);
  }, [expansionSignal?.v]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalUsd = useMemo(
    () => holdings.reduce((s, h) => s + (parseFloat(h.pair?.priceUsd || 0) * h.amount), 0),
    [holdings]
  );

  // Sorted + filtered view of holdings
  const displayed = useMemo(() => {
    let list = holdings;
    // Per-card search overrides external search when both present
    const activeQ = (search.trim() || externalSearch.trim()).toLowerCase();
    if (activeQ) {
      list = list.filter((h) => {
        const sym  = (h.pair?.baseToken?.symbol || "").toLowerCase();
        const name = (h.pair?.baseToken?.name   || "").toLowerCase();
        const mint = (h.mint || "").toLowerCase();
        return sym.includes(activeQ) || name.includes(activeQ) || mint.includes(activeQ);
      });
    }
    if (sort === "value")  return [...list].sort((a, b) => {
      const uA = parseFloat(a.pair?.priceUsd || 0) * a.amount;
      const uB = parseFloat(b.pair?.priceUsd || 0) * b.amount;
      return uB - uA;
    });
    if (sort === "change") return [...list].sort((a, b) => (b.pair?.priceChange?.h24 ?? -999) - (a.pair?.priceChange?.h24 ?? -999));
    if (sort === "name")   return [...list].sort((a, b) => (a.pair?.baseToken?.symbol || "").localeCompare(b.pair?.baseToken?.symbol || ""));
    return list;
  }, [holdings, sort, search, externalSearch]);

  // ── Compact list row ──
  if (compact) {
    const wValue  = walletStats?.[wallet.address]?.value      || 0;
    const wTokens = walletStats?.[wallet.address]?.tokenCount || 0;
    return (
      <div className="animate-in" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", background: "#111827", border: "1px solid #1e293b", borderRadius: 10, marginBottom: 4 }}>
        {/* Status dot */}
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: loading ? "#f59e0b" : wValue > 0 ? "#4ade80" : "#334155", flexShrink: 0 }} title={loading ? "Loading…" : "Ready"} />

        {/* Label + address */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
          {editingLabel ? (
            <input
              ref={labelInputRef}
              value={labelDraft}
              autoFocus
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={() => { setEditingLabel(false); if (onUpdateLabel) onUpdateLabel(wallet.address, labelDraft.trim()); }}
              onKeyDown={(e) => {
                if (e.key === "Enter")  e.target.blur();
                if (e.key === "Escape") { setLabelDraft(wallet.label || ""); setEditingLabel(false); }
              }}
              style={{ background: "#0d1321", border: "1px solid #6366f1", borderRadius: 5, color: "#e2e8f0", fontSize: 12, fontWeight: 600, padding: "2px 7px", outline: "none", width: 130 }}
            />
          ) : (
            <span
              onClick={() => { setLabelDraft(wallet.label || ""); setEditingLabel(true); }}
              title="Click to edit label"
              style={{ color: wallet.label ? "#e2e8f0" : "#334155", fontWeight: 600, fontSize: 13, cursor: "text", flexShrink: 0, fontStyle: wallet.label ? "normal" : "italic" }}
            >
              {wallet.label || "Add label"}
            </span>
          )}
          <span
            style={{ color: "#475569", fontSize: 11, fontFamily: "monospace", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={wallet.address}
            onClick={() => copyAddr(wallet.address)}
          >
            {truncateAddr(wallet.address)}
          </span>
        </div>

        {/* Value */}
        <span style={{ color: wValue > 0 ? "#f1f5f9" : "#475569", fontWeight: 700, fontSize: 13, flexShrink: 0, minWidth: 64, textAlign: "right" }}>
          {loading ? <span style={{ color: "#334155", fontWeight: 400 }}>…</span> : wValue > 0 ? formatVolume(wValue) : "—"}
        </span>

        {/* Token count */}
        <span style={{ color: "#475569", fontSize: 11, flexShrink: 0, minWidth: 52, textAlign: "right" }}>
          {wTokens > 0 ? `${wTokens} token${wTokens !== 1 ? "s" : ""}` : ""}
        </span>

        {/* Actions */}
        <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
          <button onClick={() => copyAddr(wallet.address)} title="Copy address" style={{ width: 24, height: 24, borderRadius: 5, border: "1px solid #1e293b", background: "transparent", color: "#475569", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>⎘</button>
          <a href={`https://solscan.io/account/${wallet.address}`} target="_blank" rel="noopener noreferrer" title="View on Solscan" style={{ width: 24, height: 24, borderRadius: 5, border: "1px solid #1e293b", background: "transparent", color: "#475569", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}>↗</a>
          {!confirmingRemove ? (
            <button onClick={() => setConfirming(true)} title="Remove wallet" style={{ width: 24, height: 24, borderRadius: 5, border: "1px solid #7f1d1d33", background: "transparent", color: "#7f1d1d", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
          ) : (
            <>
              <button onClick={() => { onRemove(wallet.address); setConfirming(false); }} style={{ padding: "2px 8px", borderRadius: 5, border: "1px solid #991b1b", background: "#7f1d1d44", color: "#f87171", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Remove</button>
              <button onClick={() => setConfirming(false)} style={{ padding: "2px 8px", borderRadius: 5, border: "1px solid #1e293b", background: "transparent", color: "#64748b", fontSize: 11, cursor: "pointer" }}>Cancel</button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="card-hover animate-in" style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 14, padding: "16px 20px", marginBottom: 12 }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: expanded ? 12 : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => setExpanded(!expanded)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14, padding: 0 }} aria-label={expanded ? "Collapse" : "Expand"}>
            {expanded ? "▾" : "▸"}
          </button>
          <div>
            {/* Label — click to edit inline */}
            {editingLabel ? (
              <input
                ref={labelInputRef}
                value={labelDraft}
                autoFocus
                onChange={(e) => setLabelDraft(e.target.value)}
                onBlur={() => { setEditingLabel(false); if (onUpdateLabel) onUpdateLabel(wallet.address, labelDraft.trim()); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter")  { e.target.blur(); }
                  if (e.key === "Escape") { setLabelDraft(wallet.label || ""); setEditingLabel(false); }
                }}
                placeholder="Add a label…"
                style={{ background: "#0d1321", border: "1px solid #6366f1", borderRadius: 6, color: "#e2e8f0", fontSize: 13, fontWeight: 600, padding: "2px 8px", outline: "none", width: 160 }}
              />
            ) : (
              <div
                onClick={() => { setLabelDraft(wallet.label || ""); setEditingLabel(true); }}
                title="Click to edit label"
                style={{ color: wallet.label ? "#f1f5f9" : "#334155", fontWeight: 600, fontSize: 14, cursor: "text", minHeight: 20 }}
              >
                {wallet.label || <span style={{ fontStyle: "italic", fontSize: 12 }}>Add label…</span>}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#64748b", fontSize: 12, fontFamily: "monospace", cursor: "pointer" }} title={wallet.address} onClick={() => copyAddr(wallet.address)}>
                {truncateAddr(wallet.address)}
              </span>
              {lastFetchedAt && !loading && (
                <span style={{ fontSize: 10, color: "#334155" }}>{timeAgo(lastFetchedAt)}</span>
              )}
            </div>
          </div>
          <span style={{ background: "#9945FF22", color: "#c084fc", border: "1px solid #9945FF44", fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, fontFamily: "monospace" }}>SOL</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {totalUsd > 0 && <span style={{ color: "#4ade80", fontWeight: 700, fontSize: 14 }}>{formatVolume(totalUsd)}</span>}
          {/* Search toggle */}
          {holdings.length > 5 && (
            <button
              onClick={() => { setShowSearch((v) => !v); if (showSearch) setSearch(""); }}
              aria-label="Search holdings"
              title="Search holdings"
              style={{ background: showSearch ? "#6366f122" : "none", border: showSearch ? "1px solid #6366f144" : "none", borderRadius: 5, color: showSearch ? "#818cf8" : "#64748b", cursor: "pointer", fontSize: 13, padding: "2px 6px" }}
            >
              🔍
            </button>
          )}
          <button onClick={refetch} title="Refresh" aria-label="Refresh holdings" style={{ background: "none", border: "none", color: loading ? "#6366f1" : "#64748b", cursor: loading ? "default" : "pointer", fontSize: 14, animation: loading ? "spin 0.8s linear infinite" : "none" }}>↺</button>
          <button onClick={() => setConfirming(true)} title="Remove wallet" aria-label="Remove wallet" style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 14 }}>✕</button>
        </div>
      </div>

      {expanded && (
        <>
          {/* Search + Sort controls */}
          {(showSearch || sort !== "value") && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              {showSearch && (
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search tokens…"
                  style={{ flex: 1, background: "#0d1321", border: "1px solid #334155", borderRadius: 7, color: "#e2e8f0", fontSize: 12, padding: "6px 10px", outline: "none" }}
                />
              )}
              <div style={{ display: "flex", gap: 3, marginLeft: "auto", flexShrink: 0 }}>
                {WALLET_SORTS.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setSort(s.key)}
                    style={{ padding: "3px 9px", borderRadius: 5, border: "1px solid #334155", background: sort === s.key ? "#6366f122" : "transparent", color: sort === s.key ? "#818cf8" : "#64748b", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Default sort tab strip (only when search not open) */}
          {!showSearch && sort === "value" && holdings.length > 1 && (
            <div style={{ display: "flex", gap: 3, marginBottom: 10, justifyContent: "flex-end" }}>
              {WALLET_SORTS.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setSort(s.key)}
                  style={{ padding: "3px 9px", borderRadius: 5, border: "1px solid #334155", background: sort === s.key ? "#6366f122" : "transparent", color: sort === s.key ? "#818cf8" : "#64748b", fontSize: 11, fontWeight: 600, cursor: "pointer" }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {/* Allocation bar — coloured strip showing portfolio breakdown */}
          {totalUsd > 0 && holdings.length > 1 && (
            <div style={{ display: "flex", height: 4, borderRadius: 4, overflow: "hidden", marginBottom: 12, gap: 1 }}>
              {[...holdings]
                .sort((a, b) => parseFloat(b.pair?.priceUsd || 0) * b.amount - parseFloat(a.pair?.priceUsd || 0) * a.amount)
                .slice(0, 12)
                .map((h) => {
                  const usd = parseFloat(h.pair?.priceUsd || 0) * h.amount;
                  const pct = totalUsd > 0 ? (usd / totalUsd) * 100 : 0;
                  const sym = h.pair?.baseToken?.symbol || "?";
                  return (
                    <div
                      key={h.mint}
                      title={`${sym}: ${pct.toFixed(1)}%`}
                      style={{ flex: pct, background: hashColor(sym), minWidth: 2, borderRadius: 2 }}
                    />
                  );
                })}
            </div>
          )}

          {/* Holdings rows */}
          {loading && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "#475569", fontSize: 13, padding: 16 }}>
              <div style={{ width: 14, height: 14, border: "2px solid #334155", borderTopColor: "#6366f1", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
              Loading holdings…
            </div>
          )}
          {error && <div style={{ color: "#fca5a5", fontSize: 13, padding: 8 }}>⚠ {error} — <button onClick={refetch} style={{ background: "none", border: "none", color: "#818cf8", cursor: "pointer", fontSize: 13, padding: 0 }}>Retry</button></div>}
          {!loading && !error && displayed.length === 0 && (
            <div style={{ color: "#475569", fontSize: 13, textAlign: "center", padding: 16 }}>
              {search ? `No tokens matching "${search}"` : "No tradeable tokens found. Only tokens listed on DexScreener are shown."}
            </div>
          )}
          {displayed.map((h, i) => {
            const usd = parseFloat(h.pair?.priceUsd || 0) * h.amount;
            const allocPct = totalUsd > 0 ? (usd / totalUsd) * 100 : 0;
            const isPin = pinnedMints?.has(h.mint);
            return <WalletHoldingRow key={i} holding={h} allocPct={allocPct} onPin={onPin} isPinned={isPin} />;
          })}

          {!loading && !error && displayed.length > 0 && (
            <div style={{ paddingTop: 8, fontSize: 10, color: "#334155", textAlign: "right" }}>
              {displayed.length} token{displayed.length !== 1 ? "s" : ""}
              {search && ` matching "${search}"`}
            </div>
          )}

          {/* Notes */}
          <div style={{ marginTop: 8, borderTop: "1px solid #0f172a", paddingTop: 8 }}>
            <textarea
              value={note}
              onChange={(e) => onNoteChange?.(e.target.value)}
              placeholder="Notes about this wallet…"
              rows={note ? Math.max(2, (note.match(/\n/g) || []).length + 1) : 1}
              style={{ width: "100%", background: "transparent", border: "none", outline: "none", color: note ? "#64748b" : "#1e293b", fontSize: 11, resize: "none", fontFamily: "inherit", boxSizing: "border-box", padding: 0, lineHeight: 1.5 }}
            />
          </div>
        </>
      )}

      {/* Confirm remove dialog */}
      {confirmingRemove && (
        <div className="confirm-overlay" onClick={() => setConfirming(false)}>
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#f1f5f9", marginBottom: 8 }}>Remove wallet?</div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 16, lineHeight: 1.5 }}>
              This will stop tracking <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{wallet.label || truncateAddr(wallet.address)}</span>. You can re-add it later.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirming(false)} style={{ padding: "7px 16px", borderRadius: 8, border: "1px solid #334155", background: "transparent", color: "#94a3b8", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => { setConfirming(false); onRemove(wallet.address); }} style={{ padding: "7px 16px", borderRadius: 8, border: "1px solid #f8717144", background: "#f8717122", color: "#f87171", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

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
      // Try new endpoint first, then legacy — pump.fun tokens often only on legacy
      let found = false;
      const r1 = await fetch(`https://api.dexscreener.com/tokens/v1/${chainId}/${trimmed}`);
      if (r1.ok) { const d = await r1.json(); if (Array.isArray(d) && d.length > 0) found = true; }
      if (!found) {
        const r2 = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${trimmed}`);
        if (r2.ok) { const d = await r2.json(); if (Array.isArray(d?.pairs) && d.pairs.length > 0) found = true; }
      }
      // If neither returned data, validate address format before allowing the pin
      if (!found) {
        const validSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
        const validEvm    = /^0x[0-9a-fA-F]{40}$/.test(trimmed);
        if (!validSolana && !validEvm) throw new Error("Address not recognised — check the CA and chain");
      }
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

const CoinCard = memo(function CoinCard({ coin, data, sparkline, allNews, newsLoading }) {
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
});

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

// ─── Portfolio history (persisted snapshots for sparkline) ───
function usePortfolioHistory(totalValue) {
  const KEY = "portfolioHistory";
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
  });
  useEffect(() => {
    if (!(totalValue > 0)) return;
    setHistory((prev) => {
      const now   = Date.now();
      const last  = prev[prev.length - 1];
      if (last) {
        const elapsedMin = (now - last.t) / 60000;
        const changePct  = Math.abs((totalValue - last.v) / last.v);
        // Only save if ≥5 min elapsed OR value changed >1%
        if (elapsedMin < 5 && changePct < 0.01) return prev;
      }
      const cutoff = now - 7 * 24 * 60 * 60 * 1000; // keep 7 days
      const next = [...prev.filter((p) => p.t >= cutoff), { t: now, v: totalValue }].slice(-288);
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, [totalValue]);
  return history;
}

function MiniSparkline({ data, width = 120, height = 36 }) {
  if (!data || data.length < 2) return null;
  const vals  = data.map((d) => d.v);
  const min   = Math.min(...vals);
  const max   = Math.max(...vals);
  const range = max - min || 1;
  const pts   = data.map((d, i) => [
    (i / (data.length - 1)) * width,
    height - ((d.v - min) / range) * (height - 4) - 2,
  ]);
  const path  = "M " + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L ");
  const area  = `${path} L ${width},${height} L 0,${height} Z`;
  const isUp  = vals[vals.length - 1] >= vals[0];
  const c     = isUp ? "#4ade80" : "#f87171";
  return (
    <svg width={width} height={height} style={{ overflow: "visible", display: "block" }}>
      <defs>
        <linearGradient id="pfGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={c} stopOpacity="0.25" />
          <stop offset="100%" stopColor={c} stopOpacity="0"    />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#pfGrad)" />
      <path d={path} stroke={c} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.5" fill={c} />
    </svg>
  );
}

// ─── Countdown to next token refresh ───
function CountdownToRefresh({ fetchedAt, interval = 120000 }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!fetchedAt) return null;
  const remaining = Math.max(0, Math.round((fetchedAt + interval - now) / 1000));
  const mins = Math.floor(remaining / 60);
  const secs = String(remaining % 60).padStart(2, "0");
  return (
    <span style={{ color: "#334155", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
      {remaining > 0 ? `↺ ${mins}:${secs}` : "↺ soon…"}
    </span>
  );
}

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

const FilterBar = ({ sortBy, sortDir, onSort, minVol, onMinVol, minMcap, onMinMcap, minChange1h, onMinChange1h, count, total, onClear }) => (
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

    {/* Clear filters + token count */}
    {onClear && (minVol || minMcap || minChange1h) && (
      <button onClick={onClear} title="Clear all filters" style={{ padding: "3px 9px", borderRadius: 6, border: "1px solid #f8717133", background: "#f8717111", color: "#f87171", fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>✕ Clear</button>
    )}
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

// ─── Wallet Monitor Engine (Autonomous Discovery) ───
// Discovers wallets autonomously by scanning recent transactions on watched tokens
// (pinned CAs + optionally trending). Flags fresh wallets (new/low-activity) and
// dormant wallets (inactive for N+ days then suddenly active).
// Sends alerts via Discord webhook, Telegram bot, and browser notifications.

const MONITOR_DEFAULTS = {
  enabled: true,
  intervalSec: 180,           // scan every 3 minutes
  freshMaxAgeDays: 7,         // wallet with history < N days = fresh
  freshMaxTxs: 15,            // wallet with < N total txs = fresh
  dormantMinDays: 30,         // gap of N+ days between txs = dormant
  maxTxsPerToken: 25,         // recent txs to pull per source token
  maxWalletsPerScan: 6,       // max new wallets to deeply analyze per cycle
  includeTrending: false,     // also scan trending tokens (noisier)
  discordWebhook: "",
  telegramBotToken: "",
  telegramChatId: "",
  browserNotifications: true,
};

function loadMonitorSettings() {
  try { return { ...MONITOR_DEFAULTS, ...JSON.parse(localStorage.getItem("monitorSettings") || "{}") }; }
  catch { return { ...MONITOR_DEFAULTS }; }
}
function saveMonitorSettings(s) {
  try { localStorage.setItem("monitorSettings", JSON.stringify(s)); } catch {}
}
function loadMonitorAlerts() {
  try { return JSON.parse(localStorage.getItem("monitorAlerts") || "[]"); } catch { return []; }
}
function saveMonitorAlerts(alerts) {
  try { localStorage.setItem("monitorAlerts", JSON.stringify(alerts.slice(0, 300))); } catch {}
}
// scannedWallets: { address → { checkedAt, type } } — prevents re-analyzing wallets this session
function loadScannedWallets() {
  try { return JSON.parse(localStorage.getItem("monitorScanned") || "{}"); } catch { return {}; }
}
function saveScannedWallets(m) {
  try { localStorage.setItem("monitorScanned", JSON.stringify(m)); } catch {}
}

// Fetch recent transactions for a token mint or any address via Helius.
// Returns array of tx objects. Used both to discover wallets (mint) and to analyze them (wallet addr).
async function fetchHeliusTxs(address, limit = 25) {
  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=${limit}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

// Given an address and its recent transactions (newest first), determine if it's fresh or dormant.
// Returns { type: "fresh"|"dormant"|null, txCount, ageDays, inactiveDays, latestTs }
function analyzeWalletTxs(txs, settings) {
  if (!txs.length) return null;

  const latestTs = txs[0].timestamp * 1000;
  const txCount = txs.length; // 0–limit; if < freshMaxTxs it's a strong signal

  // Fresh: low tx count relative to threshold
  if (txCount < settings.freshMaxTxs) {
    // Approximate age from oldest tx we have
    const oldestTs = txs[txs.length - 1].timestamp * 1000;
    const ageDays = (Date.now() - oldestTs) / 86400000;
    return { type: "fresh", txCount, ageDays, latestTs };
  }

  // Dormant: long gap between the most recent tx and the one before it
  if (txs.length >= 2) {
    const prevTs = txs[1].timestamp * 1000;
    const gapDays = (latestTs - prevTs) / 86400000;
    if (gapDays >= settings.dormantMinDays) {
      return { type: "dormant", txCount, inactiveDays: gapDays, latestTs };
    }
  }

  return null;
}

// Dispatch alert to all configured channels
async function dispatchAlert(alert, settings) {
  const label = alert.sourceSymbol ? `${alert.sourceSymbol} trader` : alert.address.slice(0, 8) + "…";

  // Discord webhook
  if (settings.discordWebhook) {
    try {
      const color = alert.type === "fresh" ? 0x60a5fa : 0xf59e0b;
      const fields = [
        { name: "Wallet", value: `\`${alert.address}\``, inline: false },
        ...(alert.sourceSymbol ? [{ name: "Found via token", value: alert.sourceSymbol, inline: true }] : []),
        ...(alert.txCount != null ? [{ name: "Transactions", value: String(alert.txCount) + (alert.txCount >= 50 ? "+" : ""), inline: true }] : []),
        ...(alert.ageDays != null ? [{ name: "Approx age", value: `${alert.ageDays.toFixed(1)} days`, inline: true }] : []),
        ...(alert.inactiveDays != null ? [{ name: "Inactive for", value: `${alert.inactiveDays.toFixed(0)} days`, inline: true }] : []),
      ];
      await fetch(settings.discordWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title: alert.type === "fresh" ? "🆕 Fresh Wallet Detected" : "💤 Dormant Wallet Woke Up",
            description: alert.message,
            color, fields,
            timestamp: new Date(alert.time).toISOString(),
            footer: { text: "CryptoDawn Monitor" },
          }],
        }),
      });
    } catch {}
  }

  // Telegram
  if (settings.telegramBotToken && settings.telegramChatId) {
    try {
      const icon = alert.type === "fresh" ? "🆕" : "💤";
      const text = `${icon} *${alert.type === "fresh" ? "Fresh Wallet" : "Dormant Wallet Active"}*\n${alert.message}\n\`${alert.address}\`${alert.sourceSymbol ? `\n_Found via: ${alert.sourceSymbol}_` : ""}`;
      await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: settings.telegramChatId, text, parse_mode: "Markdown" }),
      });
    } catch {}
  }

  // Browser
  if (settings.browserNotifications && typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification(alert.type === "fresh" ? "Fresh Wallet Detected" : "Dormant Wallet Active", {
        body: `${label} — ${alert.message}`,
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>",
      });
    } catch {}
  }
}

// ─── Autonomous Wallet Monitor Hook ───
// Discovers wallets from recent token transactions, analyzes them, and fires alerts.
function useWalletMonitor(pinnedCAs, trendingTokens) {
  const [settings, setSettings] = useState(loadMonitorSettings);
  const [alerts, setAlerts] = useState(loadMonitorAlerts);
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState(null);
  const [stats, setStats] = useState({ discovered: 0, analyzed: 0 });
  const scannedRef = useRef(loadScannedWallets());
  const timerRef = useRef(null);
  const scanningRef = useRef(false);

  const updateSettings = useCallback((patch) => {
    setSettings((prev) => { const next = { ...prev, ...patch }; saveMonitorSettings(next); return next; });
  }, []);

  const addAlert = useCallback((alert) => {
    setAlerts((prev) => { const next = [alert, ...prev].slice(0, 300); saveMonitorAlerts(next); return next; });
  }, []);

  const clearAlerts = useCallback(() => { setAlerts([]); saveMonitorAlerts([]); }, []);

  const clearScanned = useCallback(() => {
    scannedRef.current = {};
    saveScannedWallets({});
    setStats({ discovered: 0, analyzed: 0 });
  }, []);

  const runScan = useCallback(async () => {
    if (scanningRef.current) return;
    const settingsSnap = loadMonitorSettings();
    if (!settingsSnap.enabled) return;

    // Build source token list: pinned CAs (Solana only) + optionally trending Solana tokens
    const sourceCAs = pinnedCAs
      .filter((p) => p.chainId === "solana" || !p.chainId)
      .map((p) => ({ ca: p.ca, symbol: p.ca.slice(0, 6) }));

    if (settingsSnap.includeTrending) {
      const trendingSolana = (trendingTokens || []).filter((t) => t.chainId === "solana").slice(0, 5);
      trendingSolana.forEach((t) => sourceCAs.push({ ca: t.baseToken.address, symbol: t.baseToken.symbol }));
    }

    if (sourceCAs.length === 0) return;

    scanningRef.current = true;
    setScanning(true);
    const scanned = scannedRef.current;
    const now = Date.now();
    // Expire scanned entries older than 24h so wallets can be re-checked next day
    Object.keys(scanned).forEach((addr) => {
      if (now - (scanned[addr].checkedAt || 0) > 86400000) delete scanned[addr];
    });

    let newDiscovered = 0;
    let newAnalyzed = 0;
    const newWalletsToAnalyze = []; // { address, sourceSymbol }

    // Step 1: Collect new wallet addresses from token transaction history
    for (const src of sourceCAs) {
      try {
        const txs = await fetchHeliusTxs(src.ca, settingsSnap.maxTxsPerToken);
        await delay(250);
        for (const tx of txs) {
          const addr = tx.feePayer;
          if (!addr || PROTOCOL_BLACKLIST.has(addr) || scanned[addr]) continue;
          newWalletsToAnalyze.push({ address: addr, sourceSymbol: src.symbol, sourceCa: src.ca });
          scanned[addr] = { checkedAt: now }; // mark as seen so we don't queue twice
        }
      } catch { /* skip this source on error */ }
    }

    newDiscovered = newWalletsToAnalyze.length;

    // Step 2: Analyze up to maxWalletsPerScan new wallets
    const toAnalyze = newWalletsToAnalyze.slice(0, settingsSnap.maxWalletsPerScan);
    for (const { address, sourceSymbol } of toAnalyze) {
      try {
        // Fetch wallet's own tx history to classify it
        const walletTxs = await fetchHeliusTxs(address, 50);
        await delay(300);

        const result = analyzeWalletTxs(walletTxs, settingsSnap);
        scanned[address] = { checkedAt: now, type: result?.type || "normal" };
        newAnalyzed++;

        if (result?.type) {
          const isFresh = result.type === "fresh";
          const alert = {
            id: `${result.type}-${address}-${now}`,
            type: result.type,
            address,
            sourceSymbol,
            message: isFresh
              ? `Fresh wallet — only ${result.txCount} recorded transactions (approx ${result.ageDays?.toFixed(1) ?? "?"} days old). Spotted trading ${sourceSymbol}.`
              : `Dormant wallet woke up after ${result.inactiveDays?.toFixed(0) ?? "?"} days of inactivity. Now trading ${sourceSymbol}.`,
            txCount: result.txCount,
            ageDays: result.ageDays ?? null,
            inactiveDays: result.inactiveDays ?? null,
            latestTs: result.latestTs,
            time: now,
          };
          addAlert(alert);
          dispatchAlert(alert, settingsSnap);
        }
      } catch { /* skip this wallet */ }
    }

    scannedRef.current = scanned;
    saveScannedWallets(scanned);
    setStats((prev) => ({
      discovered: prev.discovered + newDiscovered,
      analyzed: prev.analyzed + newAnalyzed,
    }));
    setLastScan(now);
    scanningRef.current = false;
    setScanning(false);
  }, [pinnedCAs, trendingTokens, addAlert]);

  // Auto-scan on interval
  useEffect(() => {
    const settingsSnap = loadMonitorSettings();
    if (!settingsSnap.enabled) { clearInterval(timerRef.current); return; }
    const initTimer = setTimeout(runScan, 4000); // short delay on mount
    timerRef.current = setInterval(runScan, Math.max(settingsSnap.intervalSec, 60) * 1000);
    return () => { clearTimeout(initTimer); clearInterval(timerRef.current); };
  }, [settings.enabled, settings.intervalSec, runScan]);

  return { settings, updateSettings, alerts, clearAlerts, scanning, lastScan, stats, clearScanned, runScan };
}

// ─── Monitor Panel Component ───
const MonitorPanel = ({ pinnedCAs, pinnedTokens, trendingTokens, monitor }) => {
  const { settings, updateSettings, alerts, clearAlerts, scanning, lastScan, stats, clearScanned, runScan } = monitor;
  const [showSettings, setShowSettings] = useState(false);
  const [testStatus, setTestStatus] = useState(null);

  const hasSources = pinnedCAs.filter((p) => p.chainId === "solana" || !p.chainId).length > 0
    || (settings.includeTrending && (trendingTokens || []).some((t) => t.chainId === "solana"));

  const requestNotifPermission = () => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
  };

  const testDiscord = async () => {
    if (!settings.discordWebhook) return;
    setTestStatus("sending");
    try {
      const res = await fetch(settings.discordWebhook, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [{ title: "CryptoDawn Monitor — Test", description: "Connection successful!", color: 0x4ade80 }] }),
      });
      setTestStatus(res.ok ? "ok" : "fail");
    } catch { setTestStatus("fail"); }
    setTimeout(() => setTestStatus(null), 3000);
  };

  const testTelegram = async () => {
    if (!settings.telegramBotToken || !settings.telegramChatId) return;
    setTestStatus("sending");
    try {
      const res = await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: settings.telegramChatId, text: "CryptoDawn Monitor — test message!" }),
      });
      setTestStatus(res.ok ? "ok" : "fail");
    } catch { setTestStatus("fail"); }
    setTimeout(() => setTestStatus(null), 3000);
  };

  const freshAlerts = alerts.filter((a) => a.type === "fresh");
  const dormantAlerts = alerts.filter((a) => a.type === "dormant");

  const iStyle = { width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid #1e293b", background: "#0d1321", color: "#e2e8f0", fontSize: 13, outline: "none" };
  const lStyle = { fontSize: 11, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4, display: "block" };

  return (
    <>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: "#f59e0b", margin: 0 }}>Wallet Monitor</h2>
          <p style={{ color: "#475569", fontSize: 12, margin: "4px 0 0" }}>
            Autonomously discovers wallets from token transactions — flags fresh &amp; dormant activity
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {scanning && (
            <span style={{ color: "#f59e0b", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>↺</span> Scanning…
            </span>
          )}
          <button
            onClick={runScan}
            disabled={scanning || !hasSources}
            style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #f59e0b44", background: "transparent", color: "#f59e0b", fontSize: 12, fontWeight: 600, cursor: scanning || !hasSources ? "not-allowed" : "pointer", opacity: scanning || !hasSources ? 0.5 : 1 }}
          >
            Scan Now
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${showSettings ? "#f59e0b44" : "#334155"}`, background: showSettings ? "#f59e0b11" : "transparent", color: showSettings ? "#f59e0b" : "#64748b", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
          >
            Settings
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap", background: "#111827", border: "1px solid #1e293b", borderRadius: 12, padding: "14px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: settings.enabled && hasSources ? "#4ade80" : "#475569",
            boxShadow: settings.enabled && hasSources ? "0 0 8px #4ade8066" : "none",
            animation: settings.enabled && hasSources ? "pulse-dot 2s ease-in-out infinite" : "none",
          }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: settings.enabled && hasSources ? "#4ade80" : "#64748b" }}>
            {settings.enabled && hasSources ? "Active" : settings.enabled ? "No sources" : "Disabled"}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "#64748b" }}>Sources: <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{pinnedCAs.filter((p) => p.chainId === "solana" || !p.chainId).length} pinned{settings.includeTrending ? " + trending" : ""}</span></div>
        <div style={{ fontSize: 12, color: "#64748b" }}>Discovered: <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{stats.discovered}</span></div>
        <div style={{ fontSize: 12, color: "#64748b" }}>Analyzed: <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{stats.analyzed}</span></div>
        {lastScan && (
          <div style={{ fontSize: 12, color: "#64748b" }}>Last scan: <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{new Date(lastScan).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></div>
        )}
        <div style={{ fontSize: 12, color: "#64748b" }}>
          <span style={{ color: "#60a5fa", fontWeight: 600 }}>{freshAlerts.length} fresh</span>
          {" / "}
          <span style={{ color: "#f59e0b", fontWeight: 600 }}>{dormantAlerts.length} dormant</span>
        </div>
      </div>

      {/* Settings */}
      {showSettings && (
        <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 14, padding: 20, marginBottom: 20 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", margin: "0 0 16px" }}>Monitor Settings</h3>

          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 20 }}>
            {[
              { label: "Enable monitoring", key: "enabled", color: "#f59e0b" },
              { label: "Include trending tokens", key: "includeTrending", color: "#a78bfa" },
              { label: "Browser notifications", key: "browserNotifications", color: "#60a5fa", extra: () => requestNotifPermission() },
            ].map(({ label, key, color, extra }) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={!!settings[key]}
                  onChange={(e) => { updateSettings({ [key]: e.target.checked }); extra?.(); }}
                  style={{ accentColor: color }} />
                <span style={{ fontSize: 13, color: "#e2e8f0", fontWeight: 600 }}>{label}</span>
              </label>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(155px, 1fr))", gap: 16, marginBottom: 20 }}>
            {[
              { label: "Scan interval (sec)", key: "intervalSec", min: 60, max: 3600, def: 180 },
              { label: "Fresh max age (days)", key: "freshMaxAgeDays", min: 1, max: 90, def: 7 },
              { label: "Fresh max TXs", key: "freshMaxTxs", min: 1, max: 500, def: 15 },
              { label: "Dormant min days", key: "dormantMinDays", min: 1, max: 365, def: 30 },
              { label: "TXs per token", key: "maxTxsPerToken", min: 5, max: 100, def: 25 },
              { label: "Wallets per scan", key: "maxWalletsPerScan", min: 1, max: 20, def: 6 },
            ].map(({ label, key, min, max, def }) => (
              <div key={key}>
                <label style={lStyle}>{label}</label>
                <input type="number" min={min} max={max} value={settings[key]}
                  onChange={(e) => updateSettings({ [key]: Math.max(min, parseInt(e.target.value) || def) })}
                  style={{ ...iStyle, width: 90, textAlign: "center" }} />
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={lStyle}>Discord Webhook URL</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="text" placeholder="https://discord.com/api/webhooks/…" value={settings.discordWebhook}
                onChange={(e) => updateSettings({ discordWebhook: e.target.value.trim() })}
                style={{ ...iStyle, flex: 1 }} />
              {settings.discordWebhook && (
                <button onClick={testDiscord} disabled={testStatus === "sending"}
                  style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #7c3aed44", background: "transparent", color: "#a78bfa", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                  {testStatus === "sending" ? "…" : testStatus === "ok" ? "Sent!" : testStatus === "fail" ? "Failed" : "Test"}
                </button>
              )}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={lStyle}>Telegram Bot Token</label>
            <input type="text" placeholder="123456:ABCdef…" value={settings.telegramBotToken}
              onChange={(e) => updateSettings({ telegramBotToken: e.target.value.trim() })} style={iStyle} />
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={lStyle}>Telegram Chat ID</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="text" placeholder="-1001234567890" value={settings.telegramChatId}
                onChange={(e) => updateSettings({ telegramChatId: e.target.value.trim() })}
                style={{ ...iStyle, flex: 1 }} />
              {settings.telegramBotToken && settings.telegramChatId && (
                <button onClick={testTelegram} disabled={testStatus === "sending"}
                  style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #0ea5e944", background: "transparent", color: "#38bdf8", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                  {testStatus === "sending" ? "…" : testStatus === "ok" ? "Sent!" : testStatus === "fail" ? "Failed" : "Test"}
                </button>
              )}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, paddingTop: 14, borderTop: "1px solid #1e293b" }}>
            <span style={{ fontSize: 11, color: "#475569" }}>Credentials stored locally only — never sent to any server except Discord/Telegram.</span>
            <button onClick={clearScanned}
              style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid #334155", background: "transparent", color: "#64748b", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
              Reset seen wallets
            </button>
          </div>
        </div>
      )}

      {/* No sources state */}
      {!hasSources && (
        <div style={{ textAlign: "center", color: "#475569", padding: 64, fontSize: 14, border: "1px dashed #1e293b", borderRadius: 14 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📡</div>
          <div style={{ fontWeight: 600, marginBottom: 6, color: "#64748b" }}>No Solana tokens pinned</div>
          <div>Pin a Solana token in the Discover tab — the monitor will scan its recent transactions for suspicious wallets</div>
        </div>
      )}

      {/* Source tokens */}
      {hasSources && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", margin: "0 0 10px" }}>Scanning Transactions For</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {pinnedCAs.filter((p) => p.chainId === "solana" || !p.chainId).map((p) => {
              const meta = pinnedTokens?.find((t) => t.baseToken?.address === p.ca);
              const sym = meta?.baseToken?.symbol || p.ca.slice(0, 6) + "…";
              const icon = meta?.icon || meta?.info?.imageUrl || null;
              return (
                <div key={p.ca} style={{ display: "flex", alignItems: "center", gap: 6, background: "#111827", border: "1px solid #1e293b", borderRadius: 8, padding: "5px 10px" }}>
                  {icon && <img src={icon} alt="" style={{ width: 16, height: 16, borderRadius: "50%", objectFit: "cover" }} onError={(e) => { e.target.style.display = "none"; }} />}
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0" }}>{sym}</span>
                  <span style={{ fontSize: 10, color: "#475569" }}>pinned</span>
                </div>
              );
            })}
            {settings.includeTrending && (trendingTokens || []).filter((t) => t.chainId === "solana").slice(0, 5).map((t) => (
              <div key={t.baseToken.address} style={{ display: "flex", alignItems: "center", gap: 6, background: "#111827", border: "1px solid #7c3aed33", borderRadius: 8, padding: "5px 10px" }}>
                {t.icon && <img src={t.icon} alt="" style={{ width: 16, height: 16, borderRadius: "50%", objectFit: "cover" }} onError={(e) => { e.target.style.display = "none"; }} />}
                <span style={{ fontSize: 12, fontWeight: 600, color: "#c4b5fd" }}>{t.baseToken.symbol}</span>
                <span style={{ fontSize: 10, color: "#5b21b6" }}>trending</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Alert Feed */}
      {alerts.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", margin: 0 }}>Alert Feed</h3>
            <button onClick={clearAlerts}
              style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid #334155", background: "transparent", color: "#64748b", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
              Clear All
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 520, overflowY: "auto" }}>
            {alerts.map((a) => {
              const isFresh = a.type === "fresh";
              return (
                <div key={a.id} style={{
                  background: "#111827",
                  border: `1px solid ${isFresh ? "#3b82f622" : "#f59e0b22"}`,
                  borderLeft: `3px solid ${isFresh ? "#60a5fa" : "#f59e0b"}`,
                  borderRadius: 10, padding: "12px 16px",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase",
                        color: isFresh ? "#60a5fa" : "#f59e0b",
                        background: isFresh ? "#3b82f622" : "#f59e0b22",
                        padding: "2px 8px", borderRadius: 4,
                      }}>
                        {isFresh ? "FRESH" : "DORMANT"}
                      </span>
                      {a.sourceSymbol && (
                        <span style={{ fontSize: 11, color: "#64748b" }}>via <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{a.sourceSymbol}</span></span>
                      )}
                    </div>
                    <span style={{ fontSize: 11, color: "#475569" }}>
                      {new Date(a.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {new Date(a.time).toLocaleDateString([], { month: "short", day: "numeric" })}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.45, marginBottom: 5 }}>{a.message}</div>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "#475569", fontFamily: "monospace" }}>{a.address}</span>
                    <a href={`https://solscan.io/account/${a.address}`} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: 10, color: "#6366f1", fontWeight: 600, textDecoration: "none" }}>Solscan ↗</a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {alerts.length === 0 && hasSources && (
        <div style={{ textAlign: "center", color: "#475569", padding: "32px 0", fontSize: 13 }}>
          No suspicious wallets found yet — the monitor will alert you when fresh or dormant wallets are detected.
        </div>
      )}

      {hasSources && (
        <div style={{ color: "#334155", fontSize: 11, marginTop: 12, textAlign: "center" }}>
          Discovers wallets from token transaction history via Helius API • Analyzes up to {settings.maxWalletsPerScan} new wallets per scan
        </div>
      )}
    </>
  );
};

// ─── Main App ───
export default function App() {
  const greeting = getGreeting();
  const [activeChain, setActiveChain] = useState("All Chains");
  const [activeSection, setActiveSection] = useState("discover"); // "discover" | "wallets" | "monitor"
  const chains = ["All Chains", "Solana", "Base"];

  const { prices, sparklines, loading: priceLoading, error: priceError } = useCryptoPrices();
  const { articles: newsArticles, loading: newsLoading, error: newsError } = useCryptoNews();
  const { tokens, loading: tokenLoading, refreshing: tokenRefreshing, fetchedAt: tokenFetchedAt, error: tokenError, refetch: refetchTokens } = useTrendingTokens(activeChain);

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
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);

  // ── Search refs (for '/' shortcut focus) ──
  const tokenSearchRef   = useRef(null);
  const holdingsSearchRef = useRef(null);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e) => {
      // Never hijack when user is typing in an input or textarea
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "Escape") {
        if (showShortcutsHelp) { setShowShortcutsHelp(false); e.preventDefault(); return; }
        if (showAddCA)     { setShowAddCA(false);     e.preventDefault(); return; }
        if (showAddWallet) { setShowAddWallet(false);  e.preventDefault(); return; }
        const overlay = document.querySelector(".confirm-overlay");
        if (overlay) { overlay.click(); e.preventDefault(); }
        return;
      }
      if (e.key === "?") { setShowShortcutsHelp((v) => !v); e.preventDefault(); return; }
      if (e.key === "/") {
        // Focus the contextual search bar for the active section
        const ref = activeSection === "discover" ? tokenSearchRef : holdingsSearchRef;
        if (ref.current) { ref.current.focus(); ref.current.select(); e.preventDefault(); }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return; // don't steal browser shortcuts
      const k = e.key.toLowerCase();
      if (k === "d") { setActiveSection("discover"); window.scrollTo({ top: 0, behavior: "smooth" }); e.preventDefault(); }
      else if (k === "w") { setActiveSection("wallets");  window.scrollTo({ top: 0, behavior: "smooth" }); e.preventDefault(); }
      else if (k === "m") { setActiveSection("monitor");  window.scrollTo({ top: 0, behavior: "smooth" }); e.preventDefault(); }
      else if (k === "g") { setActiveSection("guide");   window.scrollTo({ top: 0, behavior: "smooth" }); e.preventDefault(); }
      else if (k === "r") { refetchTokens?.(); e.preventDefault(); }
      else if (k === "n") {
        if (activeSection === "wallets")  { setShowAddWallet(true); e.preventDefault(); }
        if (activeSection === "discover") { setShowAddCA(true);     e.preventDefault(); }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showAddCA, showAddWallet, showShortcutsHelp, activeSection, refetchTokens]);

  // Wallet Monitor — discovers wallets from pinned CA token transactions
  const monitor = useWalletMonitor(pinnedCAs, tokens);

  // mint → [{address, label, amount, usdValue}] across all tracked wallets
  const [walletMintMap, setWalletMintMap] = useState({});
  const { links: walletLinks, relatedWallets: relatedWalletList, fundingWallets: fundingWalletList, loading: walletLinksLoading, scanStatus: walletScanStatus, rescan: rescanWalletLinks } = useWalletLinks(wallets, walletMintMap);
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
        const priceChange24h = h.pair?.priceChange?.h24 ?? null;
        const entry = { address: walletAddr, label: walletLabel, amount: h.amount, usdValue: price * h.amount, icon, symbol, priceChange24h };
        next[h.mint] = [...(next[h.mint] || []), entry];
      });
      return next;
    });
  }, []);

  // ── Price alerts ──
  const [priceAlerts, setPriceAlerts] = useState(() => {
    try { return JSON.parse(localStorage.getItem("priceAlerts") || "[]"); } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem("priceAlerts", JSON.stringify(priceAlerts)); } catch { /* quota */ }
  }, [priceAlerts]);

  // Check alerts whenever prices update (tokens or pinnedTokens refresh)
  useEffect(() => {
    if (!priceAlerts.length) return;
    const allPairs = [...tokens, ...pinnedTokens];
    let changed = false;
    const updated = priceAlerts.map((alert) => {
      if (alert.triggered) return alert;
      const pair = allPairs.find((t) => t.baseToken?.address === alert.ca);
      if (!pair?.priceUsd) return alert;
      const price = parseFloat(pair.priceUsd);
      const hit = alert.direction === "above" ? price >= alert.targetPrice : price <= alert.targetPrice;
      if (hit) {
        changed = true;
        showCopyToast(`🔔 ${alert.symbol} ${alert.direction === "above" ? "↑" : "↓"} $${alert.targetPrice.toPrecision(4)}`);
        return { ...alert, triggered: true, triggeredAt: Date.now() };
      }
      return alert;
    });
    if (changed) setPriceAlerts(updated);
  }, [tokens, pinnedTokens, priceAlerts]); // priceAlerts included so new alerts are checked immediately

  const addPriceAlert = useCallback((ca, chainId, symbol, targetPrice, direction) => {
    setPriceAlerts((prev) => {
      const deduped = prev.filter((a) => !(a.ca === ca && a.direction === direction));
      return [...deduped, { ca, chainId, symbol, targetPrice, direction, triggered: false, createdAt: Date.now() }];
    });
  }, []);

  const removePriceAlert = useCallback((ca) => {
    setPriceAlerts((prev) => prev.filter((a) => a.ca !== ca));
  }, []);

  // ── Wallet notes ──
  const [walletNotes, setWalletNotes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("walletNotes") || "{}"); } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem("walletNotes", JSON.stringify(walletNotes)); } catch { /* quota */ }
  }, [walletNotes]);

  const updateWalletNote = useCallback((address, note) => {
    setWalletNotes((prev) => ({ ...prev, [address]: note }));
  }, []);

  // ── Pinned token notes ──
  const [pinnedNotes, setPinnedNotes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pinnedNotes") || "{}"); } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem("pinnedNotes", JSON.stringify(pinnedNotes)); } catch { /* quota */ }
  }, [pinnedNotes]);
  const updatePinnedNote = useCallback((ca, note) => {
    setPinnedNotes((prev) => ({ ...prev, [ca]: note }));
  }, []);

  // ── Alerts panel + wallet import ──
  const [showAlertsPanel, setShowAlertsPanel] = useState(false);
  // Auto-close the alerts panel when there are no alerts left
  useEffect(() => {
    if (!priceAlerts.length) setShowAlertsPanel(false);
  }, [priceAlerts.length]);
  const [holdingsSearch, setHoldingsSearch] = useState("");
  // { v: number, expanded: bool } — increment v to broadcast expand/collapse to all WalletCards
  const [walletExpansionSignal, setWalletExpansionSignal] = useState({ v: 0, expanded: true });
  const importFileRef = useRef(null);

  const handleWalletImport = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        const items = Array.isArray(parsed) ? parsed : [];
        let added = 0;
        items.forEach((item) => {
          const addr = typeof item === "string" ? item : (item.address || "");
          const label = typeof item === "object" ? (item.label || item.name || "") : "";
          if (addr) { addWallet(addr, label); added++; }
        });
        showCopyToast(`Imported ${added} wallet${added !== 1 ? "s" : ""}`);
      } catch {
        showCopyToast("Import failed — invalid JSON");
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  }, [addWallet]);

  // ── Derived wallet stats (value + token count per wallet address) ──
  const walletStats = useMemo(() => {
    const stats = {};
    Object.values(walletMintMap).flat().forEach((h) => {
      if (!stats[h.address]) stats[h.address] = { value: 0, tokenCount: 0 };
      stats[h.address].value      += h.usdValue || 0;
      stats[h.address].tokenCount += 1;
    });
    return stats;
  }, [walletMintMap]);

  const portfolioTotalValue = useMemo(
    () => Object.values(walletStats).reduce((s, w) => s + w.value, 0),
    [walletStats]
  );
  const portfolioHistory = usePortfolioHistory(portfolioTotalValue);

  // Wallet list display options
  const [walletView,  setWalletView]  = useState("cards"); // "cards" | "list"
  const [walletOrder, setWalletOrder] = useState("added"); // "added" | "value"

  const sortedWallets = useMemo(() => {
    if (walletOrder === "value") {
      return [...wallets].sort((a, b) => (walletStats[b.address]?.value || 0) - (walletStats[a.address]?.value || 0));
    }
    return wallets;
  }, [wallets, walletOrder, walletStats]);

  // Filters & sort
  const [sortBy, setSortBy] = useState("vol");
  const [sortDir, setSortDir] = useState("desc");
  const [minVol, setMinVol] = useState("");
  const [minMcap, setMinMcap] = useState("");
  const [minChange1h, setMinChange1h] = useState("");
  const [tokenSearch, setTokenSearch] = useState("");

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

  // Set of CA addresses already pinned — passed down to WalletCard so holdings can show pin state
  const pinnedMints = useMemo(() => new Set(pinnedCAs.map((p) => p.ca)), [pinnedCAs]);

  const addWallet = (address, label) => {
    setWallets((prev) => prev.find((w) => w.address === address) ? prev : [...prev, { address, label }]);
  };

  const updateWalletLabel = useCallback((address, label) => {
    setWallets((prev) => prev.map((w) => w.address === address ? { ...w, label } : w));
  }, []);

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

  // Memoised so filter+sort only runs when inputs actually change, not every keystroke.
  const filteredTokens = useMemo(() => {
    const q = tokenSearch.trim().toLowerCase();
    const base = tokens.filter(chainFilter).filter((t) => {
      if (!q) return true;
      return (
        (t.baseToken?.symbol || "").toLowerCase().includes(q) ||
        (t.baseToken?.name   || "").toLowerCase().includes(q) ||
        (t.baseToken?.address || "").toLowerCase().startsWith(q)
      );
    });
    return applyFilters(base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens, activeChain, sortBy, sortDir, minVol, minMcap, minChange1h, tokenSearch]);

  const filteredPinned = useMemo(
    () => applyFilters(pinnedTokens.filter(chainFilter)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pinnedTokens, activeChain, sortBy, sortDir, minVol, minMcap, minChange1h]
  );

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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
          {/* Alerts bell */}
          {priceAlerts.length > 0 && (
            <button
              onClick={() => setShowAlertsPanel((v) => !v)}
              title={`${priceAlerts.length} price alert${priceAlerts.length !== 1 ? "s" : ""}`}
              style={{ position: "relative", width: 34, height: 34, borderRadius: 8, background: showAlertsPanel ? "#f59e0b22" : priceAlerts.some((a) => a.triggered) ? "#f59e0b18" : "#1e293b", border: `1px solid ${showAlertsPanel || priceAlerts.some((a) => a.triggered) ? "#f59e0b55" : "#334155"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, cursor: "pointer", color: priceAlerts.some((a) => a.triggered) ? "#f59e0b" : "#64748b", flexShrink: 0 }}
            >
              🔔
              <span style={{ position: "absolute", top: -5, right: -5, background: priceAlerts.some((a) => a.triggered) ? "#f59e0b" : "#6366f1", color: "#0d1321", borderRadius: "50%", fontSize: 9, fontWeight: 800, minWidth: 15, height: 15, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
                {priceAlerts.length}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Alerts Management Panel */}
      {showAlertsPanel && priceAlerts.length > 0 && (
        <div className="animate-in" style={{ background: "#111827", border: "1px solid #f59e0b44", borderRadius: 12, padding: "14px 18px", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#f59e0b", display: "flex", alignItems: "center", gap: 6 }}>🔔 Price Alerts ({priceAlerts.length})</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => { setPriceAlerts((prev) => prev.filter((a) => !a.triggered)); }}
                style={{ fontSize: 11, color: "#475569", background: "transparent", border: "1px solid #1e293b", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}
              >
                Clear triggered
              </button>
              <button
                onClick={() => { setPriceAlerts([]); setShowAlertsPanel(false); }}
                style={{ fontSize: 11, color: "#7f1d1d", background: "#7f1d1d11", border: "1px solid #7f1d1d33", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}
              >
                Clear all
              </button>
              <button onClick={() => setShowAlertsPanel(false)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 16, padding: "0 4px", lineHeight: 1 }}>✕</button>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {priceAlerts.map((alert) => (
              <div key={`${alert.ca}-${alert.direction}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: alert.triggered ? "#4ade8011" : "#0d1321", border: `1px solid ${alert.triggered ? "#4ade8033" : "#1e293b"}`, borderRadius: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: alert.triggered ? "#4ade80" : "#f59e0b", flexShrink: 0 }}>
                  {alert.triggered ? "✓" : "◉"}
                </span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0", flexShrink: 0 }}>{alert.symbol}</span>
                <span style={{ fontSize: 11, color: "#64748b" }}>
                  {alert.direction === "above" ? "↑ above" : "↓ below"} <span style={{ color: "#94a3b8", fontWeight: 600 }}>${alert.targetPrice.toPrecision(4)}</span>
                </span>
                <span style={{ marginLeft: "auto", fontSize: 10, color: alert.triggered ? "#4ade80" : "#475569", flexShrink: 0 }}>
                  {alert.triggered ? `Triggered ${new Date(alert.triggeredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Watching"}
                </span>
                <button
                  onClick={() => removePriceAlert(alert.ca)}
                  style={{ width: 20, height: 20, borderRadius: 4, border: "1px solid #334155", background: "transparent", color: "#475569", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Market Overview Panel */}
      <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 16, padding: 24, marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>Market Overview</span>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <LiveIndicator />
            {tokenRefreshing ? (
              <span style={{ color: "#475569", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>↺</span> Refreshing…
              </span>
            ) : (
              <CountdownToRefresh fetchedAt={tokenFetchedAt} />
            )}
            <button
              onClick={() => refetchTokens?.()}
              title="Refresh trending tokens now (R)"
              style={{ padding: "3px 8px", borderRadius: 6, border: "1px solid #1e293b", background: "transparent", color: "#334155", fontSize: 12, cursor: "pointer", lineHeight: 1 }}
            >↺</button>
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
            { key: "monitor",  label: `📡 Monitor${monitor.alerts.length > 0 ? ` (${monitor.alerts.length})` : ""}` },
            { key: "guide",    label: "📖 Guide" },
          ].map((s) => (
            <button
              key={s.key}
              onClick={() => { setActiveSection(s.key); window.scrollTo({ top: 0, behavior: "smooth" }); }}
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
            onClear={() => { setMinVol(""); setMinMcap(""); setMinChange1h(""); }}
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
                  {filteredPinned.map((pair, i) => {
                    const pinnedCA = pair.baseToken?.address || "";
                    return (
                    <TokenCard
                      key={`pinned-${pair.pairAddress}-${i}`}
                      pair={pair}
                      isPinned={true}
                      onPin={pinToken}
                      onUnpin={unpinToken}
                      walletHolders={(pinnedCA && walletMintMap[pinnedCA]) || []}
                      allNews={newsArticles}
                      newsLoading={newsLoading}
                      priceAlerts={priceAlerts}
                      onSetAlert={addPriceAlert}
                      onRemoveAlert={removePriceAlert}
                      note={pinnedNotes[pinnedCA] || ""}
                      onNoteChange={(n) => updatePinnedNote(pinnedCA, n)}
                    />
                    );
                  })}
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
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: "#f1f5f9", margin: 0, flexShrink: 0 }}>Trending</h2>
            {/* Token search */}
            <div style={{ position: "relative", flex: 1, minWidth: 160, maxWidth: 280 }}>
              <input
                ref={tokenSearchRef}
                value={tokenSearch}
                onChange={(e) => setTokenSearch(e.target.value)}
                placeholder="Search symbol, name, CA…"
                style={{ width: "100%", background: "#0d1321", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 12, padding: "6px 10px 6px 28px", outline: "none", boxSizing: "border-box" }}
              />
              <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "#475569", pointerEvents: "none" }}>🔍</span>
              {tokenSearch && (
                <button onClick={() => setTokenSearch("")} style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}>✕</button>
              )}
            </div>
            <span style={{ color: "#334155", fontSize: 11, marginLeft: "auto", flexShrink: 0 }}>Powered by GeckoTerminal</span>
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
                      priceAlerts={priceAlerts}
                      onSetAlert={addPriceAlert}
                      onRemoveAlert={removePriceAlert}
                      note={pinnedNotes[ca] || ""}
                      onNoteChange={(n) => updatePinnedNote(ca, n)}
                    />
                  );
                })}
          </div>

          {!tokenLoading && filteredTokens.length === 0 && !tokenError && (
            <div className="animate-in" style={{ textAlign: "center", color: "#475569", padding: 48, fontSize: 14 }}>
              {tokenSearch
                ? <>No tokens matching <strong style={{ color: "#94a3b8" }}>"{tokenSearch}"</strong>. <button onClick={() => setTokenSearch("")} style={{ background: "none", border: "none", color: "#818cf8", cursor: "pointer", fontSize: 14, padding: 0 }}>Clear search</button></>
                : "No trending tokens found for this chain right now. Try adjusting your filters or switching chains."
              }
            </div>
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
                <div style={{ display: "flex", gap: 6 }}>
                  {/* Holdings CSV — all token positions across all wallets */}
                  {Object.keys(walletMintMap).length > 0 && (
                    <button
                      onClick={() => {
                        const rows = [["Wallet Address", "Wallet Label", "Token", "USD Value", "Amount", "24h Change %"]];
                        Object.entries(walletMintMap).forEach(([, entries]) => {
                          entries.forEach((e) => {
                            const price = e.amount > 0 ? e.usdValue / e.amount : 0;
                            rows.push([
                              e.address,
                              e.label || "",
                              e.symbol || "",
                              e.usdValue.toFixed(2),
                              e.amount.toFixed(6),
                              Number.isFinite(e.priceChange24h) ? e.priceChange24h.toFixed(2) : "",
                            ]);
                          });
                        });
                        const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
                        const blob = new Blob([csv], { type: "text/csv" });
                        const url = URL.createObjectURL(blob);
                        Object.assign(document.createElement("a"), { href: url, download: "portfolio-holdings.csv" }).click();
                        URL.revokeObjectURL(url);
                        showCopyToast("Holdings exported!");
                      }}
                      title="Export all holdings as CSV"
                      style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #334155", background: "transparent", color: "#64748b", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                    >
                      ↓ CSV
                    </button>
                  )}
                  {/* Wallets JSON */}
                  <button
                    onClick={() => {
                      const data = wallets.map((w) => ({ address: w.address, name: w.label || "", emoji: "", groups: [] }));
                      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      Object.assign(document.createElement("a"), { href: url, download: "cryptodawn-wallets.json" }).click();
                      URL.revokeObjectURL(url);
                      showCopyToast("Wallets exported!");
                    }}
                    title="Export wallet list as JSON"
                    style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #334155", background: "transparent", color: "#64748b", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                  >
                    ↓ JSON
                  </button>
                </div>
              )}
              {/* View toggle: Cards / List */}
              {wallets.length > 0 && (
                <div style={{ display: "flex", gap: 1, background: "#1e293b", borderRadius: 8, padding: 2 }}>
                  {[{ v: "cards", icon: "⊞", title: "Card view" }, { v: "list", icon: "≡", title: "List view" }].map(({ v, icon, title }) => (
                    <button key={v} onClick={() => setWalletView(v)} title={title} style={{ padding: "4px 10px", borderRadius: 6, border: "none", background: walletView === v ? "#334155" : "transparent", color: walletView === v ? "#e2e8f0" : "#475569", fontSize: 14, cursor: "pointer", lineHeight: 1 }}>{icon}</button>
                  ))}
                </div>
              )}

              {/* Expand / collapse all */}
              {wallets.length > 1 && walletView === "cards" && (
                <button
                  onClick={() => setWalletExpansionSignal((s) => ({ v: s.v + 1, expanded: !s.expanded }))}
                  title={walletExpansionSignal.expanded ? "Collapse all wallet cards" : "Expand all wallet cards"}
                  style={{ padding: "4px 10px", borderRadius: 8, border: "1px solid #334155", background: "transparent", color: "#475569", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
                >
                  {walletExpansionSignal.expanded ? "⊟ Collapse all" : "⊞ Expand all"}
                </button>
              )}

              {/* Sort toggle: Added / Value */}
              {wallets.length > 1 && (
                <div style={{ display: "flex", gap: 1, background: "#1e293b", borderRadius: 8, padding: 2 }}>
                  {[{ v: "added", label: "Added" }, { v: "value", label: "$ Value" }].map(({ v, label }) => (
                    <button key={v} onClick={() => setWalletOrder(v)} style={{ padding: "4px 9px", borderRadius: 6, border: "none", background: walletOrder === v ? "#334155" : "transparent", color: walletOrder === v ? "#e2e8f0" : "#475569", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{label}</button>
                  ))}
                </div>
              )}

              <button
                onClick={() => setShowAddWallet(!showAddWallet)}
                style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #4ade8044", background: showAddWallet ? "#4ade8022" : "transparent", color: "#4ade80", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
              >
                + Add Wallet
              </button>
              {/* Import wallets from JSON — always visible */}
              <input
                ref={importFileRef}
                type="file"
                accept=".json"
                style={{ display: "none" }}
                onChange={handleWalletImport}
              />
              <button
                onClick={() => importFileRef.current?.click()}
                title="Import wallets from a JSON file (array of {address, label} objects)"
                style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #334155", background: "transparent", color: "#64748b", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
              >
                ↑ Import
              </button>
            </div>
          </div>

          {showAddWallet && <AddWalletPanel onAdd={addWallet} onClose={() => setShowAddWallet(false)} />}

          {wallets.length === 0 && !showAddWallet && (
            <div className="animate-in" style={{ textAlign: "center", color: "#475569", padding: 64, fontSize: 14, border: "1px dashed #1e293b", borderRadius: 14 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>👜</div>
              <div style={{ fontWeight: 600, marginBottom: 6, color: "#64748b" }}>No wallets tracked yet</div>
              <div style={{ marginBottom: 16 }}>Add a Solana wallet address to see its token positions</div>
              <button
                onClick={() => setShowAddWallet(true)}
                style={{ padding: "8px 20px", borderRadius: 8, border: "1px solid #4ade8044", background: "#4ade8011", color: "#4ade80", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
              >
                + Add Your First Wallet
              </button>
            </div>
          )}

          {/* ── Portfolio Summary ── */}
          {wallets.length > 0 && (() => {
            const allEntries = Object.values(walletMintMap).flat();
            const totalValue = allEntries.reduce((sum, h) => sum + (h.usdValue || 0), 0);
            const uniqueTokens = new Set(Object.keys(walletMintMap)).size;

            // Daily P&L: sum of (usdValue × priceChange24h / 100) for entries with change data
            const dailyPnl = allEntries.reduce((sum, h) => {
              if (!Number.isFinite(h.priceChange24h) || !h.usdValue) return sum;
              // h.usdValue = currentValue; yesterdayValue = currentValue / (1 + h24/100)
              // pnl = currentValue - yesterdayValue = currentValue × h24/100 / (1 + h24/100)
              return sum + h.usdValue * (h.priceChange24h / 100) / (1 + h.priceChange24h / 100);
            }, 0);
            const pnlKnown = allEntries.some((h) => Number.isFinite(h.priceChange24h));
            const pnlPct = totalValue > 0 ? (dailyPnl / (totalValue - dailyPnl)) * 100 : 0;

            // Token summary: per-token rolled up (used for movers + allocation bar)
            const tokenSummary = {};
            allEntries.forEach((h) => {
              const k = h.symbol || "???";
              if (!tokenSummary[k]) tokenSummary[k] = { symbol: k, icon: h.icon, usdValue: 0, priceChange24h: h.priceChange24h };
              tokenSummary[k].usdValue += h.usdValue || 0;
            });
            const movers = Object.values(tokenSummary)
              .filter((m) => Number.isFinite(m.priceChange24h) && m.usdValue >= 1)
              .sort((a, b) => Math.abs(b.priceChange24h) - Math.abs(a.priceChange24h))
              .slice(0, 5);
            const gainers = movers.filter((m) => m.priceChange24h > 0);
            const losers  = movers.filter((m) => m.priceChange24h < 0);

            // Allocation bar: top-6 holdings by value + "Others"
            const BAR_COLORS = ["#818cf8", "#4ade80", "#f59e0b", "#f87171", "#34d399", "#a78bfa"];
            const byValue = Object.values(tokenSummary).sort((a, b) => b.usdValue - a.usdValue);
            const top6 = byValue.slice(0, 6);
            const othersValue = byValue.slice(6).reduce((s, t) => s + t.usdValue, 0);
            const barSlices = othersValue > 0 ? [...top6, { symbol: "Others", usdValue: othersValue, icon: null }] : top6;
            const barTotal = barSlices.reduce((s, t) => s + t.usdValue, 0);

            return (
              <div className="animate-in" style={{ background: "linear-gradient(135deg, #111827 0%, #0d1321 100%)", border: "1px solid #1e293b", borderRadius: 14, padding: "18px 24px", marginBottom: 16 }}>
                {/* Row 1: Value + stats */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16, marginBottom: movers.length > 0 ? 14 : 0 }}>
                  <div style={{ display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: "#475569", marginBottom: 4 }}>Total Portfolio Value</div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                        <span style={{ fontSize: 28, fontWeight: 800, color: totalValue > 0 ? "#f1f5f9" : "#64748b", letterSpacing: -0.5 }}>
                          {totalValue > 0 ? formatVolume(totalValue) : "—"}
                        </span>
                        {pnlKnown && totalValue > 0 && (
                          <span style={{ fontSize: 13, fontWeight: 700, color: dailyPnl >= 0 ? "#4ade80" : "#f87171" }}>
                            {dailyPnl >= 0 ? "+" : ""}{formatVolume(Math.abs(dailyPnl))} ({dailyPnl >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%) today
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Portfolio history sparkline */}
                    {portfolioHistory.length >= 2 && (
                      <div style={{ paddingBottom: 4 }}>
                        <MiniSparkline data={portfolioHistory} width={110} height={32} />
                        <div style={{ fontSize: 9, color: "#334155", textAlign: "center", marginTop: 3 }}>
                          {(() => {
                            const span = portfolioHistory[portfolioHistory.length - 1].t - portfolioHistory[0].t;
                            return span > 3600000 ? `${(span / 3600000).toFixed(0)}h history` : `${Math.round(span / 60000)}m history`;
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 20, paddingTop: 4 }}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: "#e2e8f0" }}>{wallets.length}</div>
                      <div style={{ fontSize: 10, color: "#475569", fontWeight: 600 }}>wallet{wallets.length !== 1 ? "s" : ""}</div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: "#818cf8" }}>{uniqueTokens}</div>
                      <div style={{ fontSize: 10, color: "#475569", fontWeight: 600 }}>token{uniqueTokens !== 1 ? "s" : ""}</div>
                    </div>
                    {relatedWalletList.length > 0 && (
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 18, fontWeight: 800, color: "#f59e0b" }}>{relatedWalletList.length}</div>
                        <div style={{ fontSize: 10, color: "#475569", fontWeight: 600 }}>related</div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Row 2: Top movers */}
                {movers.length > 0 && (
                  <div style={{ marginBottom: barSlices.length > 0 ? 14 : 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#334155", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Top movers today</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {[...gainers.slice(0, 3), ...losers.slice(0, 3)].map((m) => (
                        <div key={m.symbol} style={{ display: "flex", alignItems: "center", gap: 5, background: m.priceChange24h >= 0 ? "#4ade8011" : "#f8717111", border: `1px solid ${m.priceChange24h >= 0 ? "#4ade8033" : "#f8717133"}`, borderRadius: 8, padding: "4px 10px" }}>
                          {m.icon && <img src={m.icon} alt={m.symbol} style={{ width: 14, height: 14, borderRadius: "50%", objectFit: "cover" }} onError={(e) => { e.target.style.display = "none"; }} />}
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#e2e8f0" }}>{m.symbol}</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: m.priceChange24h >= 0 ? "#4ade80" : "#f87171" }}>
                            {m.priceChange24h >= 0 ? "+" : ""}{m.priceChange24h.toFixed(1)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Row 3: Allocation bar */}
                {barSlices.length > 1 && barTotal > 0 && (
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#334155", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Allocation</div>
                    {/* Stacked horizontal bar */}
                    <div style={{ height: 8, borderRadius: 4, overflow: "hidden", display: "flex", gap: 1, marginBottom: 8 }}>
                      {barSlices.map((t, i) => (
                        <div
                          key={t.symbol}
                          title={`${t.symbol}: ${formatVolume(t.usdValue)} (${((t.usdValue / barTotal) * 100).toFixed(0)}%)`}
                          style={{ flex: t.usdValue / barTotal, background: i < BAR_COLORS.length ? BAR_COLORS[i] : "#475569", minWidth: 4 }}
                        />
                      ))}
                    </div>
                    {/* Legend */}
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      {barSlices.map((t, i) => (
                        <span key={t.symbol} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#64748b" }}>
                          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: i < BAR_COLORS.length ? BAR_COLORS[i] : "#475569", flexShrink: 0 }} />
                          <span style={{ color: "#94a3b8", fontWeight: 600 }}>{t.symbol}</span>
                          <span>{((t.usdValue / barTotal) * 100).toFixed(0)}%</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Row 4: Per-wallet breakdown */}
                {wallets.length > 1 && totalValue > 0 && (
                  <div style={{ marginTop: 14, borderTop: "1px solid #1e293b", paddingTop: 12 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#334155", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Per Wallet</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      {[...wallets]
                        .map((w) => ({ ...w, value: walletStats[w.address]?.value || 0 }))
                        .sort((a, b) => b.value - a.value)
                        .map((w) => {
                          const pct = (w.value / totalValue) * 100;
                          return (
                            <div key={w.address} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ flex: 1, fontSize: 11, color: "#94a3b8", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {w.label || truncateAddr(w.address)}
                              </span>
                              <span style={{ fontSize: 11, color: "#f1f5f9", fontWeight: 700, flexShrink: 0, minWidth: 52, textAlign: "right" }}>
                                {formatVolume(w.value)}
                              </span>
                              <div style={{ width: 56, height: 4, background: "#1e293b", borderRadius: 2, overflow: "hidden", flexShrink: 0 }}>
                                <div style={{ width: `${pct}%`, height: "100%", background: "#6366f1", borderRadius: 2 }} />
                              </div>
                              <span style={{ fontSize: 10, color: "#475569", flexShrink: 0, minWidth: 26, textAlign: "right" }}>
                                {pct.toFixed(0)}%
                              </span>
                            </div>
                          );
                        })
                      }
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          <WalletGraph wallets={wallets} links={walletLinks} loading={walletLinksLoading} onRescan={rescanWalletLinks} />

          <RelatedWallets
            relatedWallets={relatedWalletList}
            fundingWallets={fundingWalletList}
            trackedAddrs={new Set(wallets.map((w) => w.address))}
            loading={walletLinksLoading}
            scanStatus={walletScanStatus}
            onTrack={addWallet}
            walletMintMap={walletMintMap}
            onRescan={rescanWalletLinks}
          />

          {/* Cross-wallet holdings search */}
          {wallets.length > 0 && (() => {
            const q = holdingsSearch.trim().toLowerCase();
            const visibleWallets = q
              ? sortedWallets.filter((w) => {
                  // label / address match
                  if ((w.label || "").toLowerCase().includes(q)) return true;
                  if (w.address.toLowerCase().includes(q)) return true;
                  // any holding symbol or mint match
                  return Object.entries(walletMintMap).some(([mint, entries]) => {
                    const sym = entries[0]?.symbol || "";
                    if (sym.toLowerCase().includes(q)) return entries.some((e) => e.address === w.address);
                    if (mint.toLowerCase().includes(q)) return entries.some((e) => e.address === w.address);
                    return false;
                  });
                })
              : sortedWallets;

            return (
              <>
                <div style={{ position: "relative", marginBottom: 14, maxWidth: 400 }}>
                  <input
                    ref={holdingsSearchRef}
                    value={holdingsSearch}
                    onChange={(e) => setHoldingsSearch(e.target.value)}
                    placeholder="Search wallets & holdings (symbol, address, label)…"
                    style={{ width: "100%", background: "#0d1321", border: "1px solid #334155", borderRadius: 9, color: "#e2e8f0", fontSize: 12, padding: "7px 10px 7px 30px", outline: "none", boxSizing: "border-box" }}
                  />
                  <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "#475569", pointerEvents: "none" }}>🔍</span>
                  {holdingsSearch && (
                    <button onClick={() => setHoldingsSearch("")} style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}>✕</button>
                  )}
                  {holdingsSearch && (
                    <span style={{ position: "absolute", right: holdingsSearch ? 26 : 8, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: "#475569", pointerEvents: "none", whiteSpace: "nowrap" }}>
                      {visibleWallets.length}/{sortedWallets.length} wallets
                    </span>
                  )}
                </div>
                {visibleWallets.map((wallet) => (
                  <WalletCard
                    key={wallet.address}
                    wallet={wallet}
                    onRemove={removeWallet}
                    onHoldingsLoaded={handleHoldingsLoaded}
                    pinnedMints={pinnedMints}
                    onPin={pinToken}
                    onUpdateLabel={updateWalletLabel}
                    compact={walletView === "list"}
                    walletStats={walletStats}
                    note={walletNotes[wallet.address] || ""}
                    onNoteChange={(n) => updateWalletNote(wallet.address, n)}
                    externalSearch={holdingsSearch.trim()}
                    expansionSignal={walletExpansionSignal}
                  />
                ))}
                {q && visibleWallets.length === 0 && (
                  <div style={{ color: "#475569", fontSize: 13, padding: "24px 0", textAlign: "center" }}>
                    No wallets or holdings match <strong style={{ color: "#64748b" }}>"{holdingsSearch}"</strong>
                  </div>
                )}
              </>
            );
          })()}

          {wallets.length > 0 && (
            <div style={{ color: "#334155", fontSize: 11, marginTop: 16, textAlign: "center" }}>
              Token holdings fetched from Solana RPC • Prices from DexScreener • Only tokens listed on DexScreener shown
            </div>
          )}
        </>
      )}

      {/* ─── Monitor Section ─── */}
      {activeSection === "monitor" && (
        <MonitorPanel pinnedCAs={pinnedCAs} pinnedTokens={pinnedTokens} trendingTokens={tokens} monitor={monitor} />
      )}

      {/* ─── Guide Section ─── */}
      {activeSection === "guide" && (() => {
        const S = ({ children, color = "#818cf8" }) => (
          <span style={{ color, fontWeight: 700 }}>{children}</span>
        );
        const Kbd = ({ children }) => (
          <kbd style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 5, padding: "1px 7px", fontFamily: "monospace", fontSize: 11, color: "#94a3b8" }}>{children}</kbd>
        );
        const Badge = ({ children, color = "#6366f1" }) => (
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", background: `${color}22`, border: `1px solid ${color}55`, borderRadius: 6, padding: "2px 8px", fontSize: 12, fontWeight: 700, color, margin: "0 2px" }}>{children}</span>
        );
        const Section = ({ icon, title, color, children }) => (
          <div style={{ background: "#111827", border: `1px solid ${color}33`, borderRadius: 14, padding: "20px 24px", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, borderBottom: `1px solid ${color}22`, paddingBottom: 12 }}>
              <span style={{ fontSize: 20 }}>{icon}</span>
              <span style={{ fontSize: 14, fontWeight: 800, color, letterSpacing: 0.5, textTransform: "uppercase" }}>{title}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
          </div>
        );
        const Row = ({ icon, label, desc }) => (
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span style={{ fontSize: 16, flexShrink: 0, width: 22, textAlign: "center", marginTop: 1 }}>{icon}</span>
            <div>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0" }}>{label}</span>
              {desc && <span style={{ fontSize: 12, color: "#64748b" }}> — {desc}</span>}
            </div>
          </div>
        );
        const Tip = ({ children }) => (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "#0d1321", border: "1px solid #1e293b", borderRadius: 8, padding: "10px 14px" }}>
            <span style={{ fontSize: 14, flexShrink: 0 }}>💡</span>
            <span style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>{children}</span>
          </div>
        );
        return (
          <div className="animate-in" style={{ maxWidth: 760, margin: "0 auto" }}>
            {/* Header */}
            <div style={{ marginBottom: 28 }}>
              <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: "#818cf8", margin: "0 0 6px" }}>📖 CryptoDawn Guide</h2>
              <p style={{ color: "#475569", fontSize: 13, margin: 0 }}>
                Everything runs locally in your browser — no logins, no servers, no wallet connections required.
              </p>
            </div>

            <Section icon="🔥" title="Discover" color="#f59e0b">
              <Row icon="📋" label="Trending tokens" desc="Auto-fetched from GeckoTerminal every 60 seconds. Filter by chain with the buttons at the top right." />
              <Row icon="🔍" label="Token search" desc="Type to filter by symbol, name, or contract address. Press / to jump straight to the search box." />
              <Row icon="📌" label="Pin a token" desc="Click the 🔖 bookmark icon on any card. Pinned tokens appear at the top and keep refreshing even if they fall off trending." />
              <Row icon="🔔" label="Price alerts" desc="Click the 🔔 bell on any card. Set a target price (above or below). A toast fires the moment the price crosses. Manage all alerts from the bell icon in the header." />
              <Row icon="📈" label="Mini chart" desc="Click 📈 to expand a 1H/12H/1D price or market-cap chart built from live OHLCV data." />
              <Row icon="👥" label="Holder analysis" desc="Click 👥 (Solana only) to see the top 20 holder accounts, their share of supply, and a concentration bar. Whale-heavy tokens (top 10 > 60%) are flagged red." />
              <Row icon="🫧" label="BubbleMaps" desc="Click 🫧 to open the token on BubbleMaps for cluster analysis." />
              <Row icon="DS" label="DexScreener" desc="Click DS to open the token's DexScreener page in a new tab." />
              <Row icon="📝" label="Token notes" desc="Pinned tokens have a notes textarea at the bottom. Write entry targets, risk notes, anything. Auto-saved." />
              <Row icon="➕" label="Track a custom CA" desc="Press N (or click + Track CA) to pin any token by contract address directly, even before it's trending." />
              <Tip>Pin your watchlist first, then check the 👜 badge on each card — it shows how many of your tracked wallets hold that token.</Tip>
            </Section>

            <Section icon="👜" title="Wallets" color="#4ade80">
              <Row icon="➕" label="Add a wallet" desc="Press N, paste any Solana or EVM address. Holdings load automatically with live USD values." />
              <Row icon="📥" label="Import wallets" desc="Click ↑ Import to load a JSON file. Accepts arrays of addresses or {address, label} objects — including exports from this app." />
              <Row icon="📤" label="Export" desc="↓ CSV exports all token positions across all wallets. ↓ JSON exports your wallet list for backup or sharing." />
              <Row icon="🔍" label="Cross-wallet search" desc="Type in the search bar above the wallet list to filter by token symbol, mint address, or wallet label/address. All matching cards auto-expand." />
              <Row icon="📝" label="Wallet notes" desc="Expand any wallet card — there's a freeform notes area at the bottom. Auto-saved per wallet address." />
              <Row icon="✏️" label="Wallet labels" desc="Click the wallet label (or 'Add label') to rename it inline. Press Enter or click away to save." />
              <Row icon="↕" label="Sort & view" desc="Sort wallets by value or by added order. Toggle between card view and compact list view with the ⊞/≡ buttons." />
              <Row icon="📊" label="Portfolio summary" desc="Appears above your wallet list. Shows total value, 24h P&L, top movers, allocation bar, sparkline history, and a per-wallet breakdown." />
              <Tip>Use '/' to jump to the search box and type a token symbol to instantly find which of your wallets hold it — all matching cards expand automatically.</Tip>
            </Section>

            <Section icon="📡" title="Monitor" color="#f59e0b">
              <Row icon="🔭" label="What it does" desc="Scans the on-chain transactions of your pinned tokens and discovers wallets that traded them recently." />
              <Row icon="▶️" label="Scan Now" desc="Click Scan Now to trigger a manual scan. The monitor looks for fresh wallets (new to trading) and dormant wallets (suddenly active)." />
              <Row icon="⚙️" label="Settings" desc="Configure which chains to scan, how many transactions to analyze, and alert thresholds." />
              <Row icon="🚨" label="Alerts" desc="Discovered wallets appear as alerts — you can inspect them, track them directly, or dismiss." />
              <Tip>Combine Monitor with Wallets: when Monitor finds an interesting whale wallet, click Track to add it — then see its full holdings in the Wallets tab.</Tip>
            </Section>

            <Section icon="🔔" title="Price Alerts" color="#f59e0b">
              <Row icon="1️⃣" label="Set an alert" desc="Click 🔔 on any token card → choose 'above' or 'below' → enter your target price → click Set." />
              <Row icon="2️⃣" label="Alert fires" desc="When the token price crosses your target, a toast notification appears immediately. The alert is marked ✓ triggered." />
              <Row icon="3️⃣" label="Manage alerts" desc="Click the 🔔 bell in the top-right of the header to open the alerts panel. Per-alert dismiss, 'Clear triggered', or 'Clear all'." />
              <Tip>Alerts are checked every time price data refreshes (~60 seconds). For best results, pin the token so its price data stays current even off trending.</Tip>
            </Section>

            <Section icon="⌨️" title="Keyboard Shortcuts" color="#818cf8">
              {[
                ["D", "Switch to Discover"],
                ["W", "Switch to Wallets"],
                ["M", "Switch to Monitor"],
                ["G", "Switch to Guide (this page)"],
                ["N", "Add wallet (Wallets tab) or Track CA (Discover tab)"],
                ["R", "Refresh trending token data now"],
                ["/", "Focus the search bar for the current tab"],
                ["?", "Toggle the keyboard shortcuts modal"],
                ["Esc", "Close any open panel or dialog"],
              ].map(([key, desc]) => (
                <div key={key} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <Kbd>{key}</Kbd>
                  <span style={{ fontSize: 12, color: "#64748b" }}>{desc}</span>
                </div>
              ))}
            </Section>

            <Section icon="💡" title="Tips & Tricks" color="#34d399">
              <Tip>
                <S color="#4ade80">Best workflow:</S> Pin the tokens you're researching → open the 👥 holder panel to check concentration → track the top holder wallets → use the portfolio summary to see your total exposure.
              </Tip>
              <Tip>
                <S color="#4ade80">Research notes:</S> Pin a token, scroll to the bottom of its card, and write notes directly there. Great for entry price targets, risk flags, or news context. Notes survive page reloads.
              </Tip>
              <Tip>
                <S color="#4ade80">Backup wallets:</S> Click ↓ JSON in the Wallets tab to download your wallet list. To restore later, use ↑ Import. Duplicate wallets are silently skipped.
              </Tip>
              <Tip>
                <S color="#4ade80">Cross-wallet search:</S> Want to know which of your wallets hold BONK? Press <Kbd>/</Kbd> in the Wallets tab and type "BONK". All matching wallets expand instantly.
              </Tip>
              <Tip>
                <S color="#4ade80">Price alert strategy:</S> Pin a token, set a "below" alert at your stop-loss price and an "above" alert at your take-profit target. The toast fires whether the tab is active or not (as long as the page is open).
              </Tip>
            </Section>

            <div style={{ textAlign: "center", color: "#1e293b", fontSize: 11, marginTop: 8, marginBottom: 24 }}>
              All data is stored locally in your browser via localStorage. Nothing is sent to any server.
            </div>
          </div>
        );
      })()}

      {/* ── Keyboard shortcuts help modal ── */}
      {showShortcutsHelp && (
        <div
          style={{ position: "fixed", inset: 0, background: "#000000cc", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setShowShortcutsHelp(false)}
        >
          <div
            className="animate-in"
            style={{ background: "#111827", border: "1px solid #334155", borderRadius: 16, padding: "28px 32px", minWidth: 300, maxWidth: 420 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <span style={{ fontWeight: 800, fontSize: 15, color: "#f1f5f9" }}>Keyboard Shortcuts</span>
              <button onClick={() => setShowShortcutsHelp(false)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0 }}>✕</button>
            </div>
            {[
              ["D", "Switch to Discover tab"],
              ["W", "Switch to Wallets tab"],
              ["M", "Switch to Monitor tab"],
              ["G", "Switch to Guide tab"],
              ["N", "Add wallet / Track CA (tab-sensitive)"],
              ["R", "Refresh trending tokens now"],
              ["/", "Focus search bar for current tab"],
              ["?", "Toggle this shortcuts panel"],
              ["Esc", "Close any open panel or dialog"],
            ].map(([key, desc]) => (
              <div key={key} style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
                <kbd style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: "3px 10px", fontFamily: "monospace", fontSize: 12, color: "#94a3b8", minWidth: 32, textAlign: "center", flexShrink: 0 }}>{key}</kbd>
                <span style={{ color: "#64748b", fontSize: 13 }}>{desc}</span>
              </div>
            ))}
            <div style={{ marginTop: 16, fontSize: 11, color: "#334155", textAlign: "center" }}>Shortcuts disabled while typing in an input</div>
          </div>
        </div>
      )}

      <div className="gradient-divider" style={{ marginTop: 40, marginBottom: 16 }} />
      <div style={{ textAlign: "center", color: "#1e293b", fontSize: 11, paddingBottom: 24, letterSpacing: 0.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
        <span>CryptoDawn • Prices via CoinGecko • Tokens via GeckoTerminal • Auto-refreshes every 2 min</span>
        <button onClick={() => setShowShortcutsHelp(true)} title="Keyboard shortcuts (?)" style={{ background: "#1e293b", border: "1px solid #1e293b", borderRadius: 6, color: "#334155", fontSize: 11, cursor: "pointer", padding: "2px 7px", fontFamily: "monospace" }}>?</button>
      </div>
    </div>
  );
}

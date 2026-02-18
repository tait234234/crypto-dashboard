import { useState, useEffect, useCallback, useRef } from "react";

// ─── Live Price Hook (CoinGecko) ───
function useCryptoPrices() {
  const [prices, setPrices] = useState(null);
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

  useEffect(() => {
    fetchPrices();
    const interval = setInterval(fetchPrices, 60000);
    return () => clearInterval(interval);
  }, [fetchPrices]);

  return { prices, loading, error, refetch: fetchPrices };
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
      volume:     { h24: vol24 },
      liquidity:  { usd: liq },
      priceChange: {
        h1: parseFloat(pool.attributes.price_change_percentage?.h1 || 0),
        h6: parseFloat(pool.attributes.price_change_percentage?.h6 || 0),
      },
      txns: {
        h1:  { buys: h1Buys  || 0, sells: h1Sells  || 0 },
        h24: { buys: h24Buys || 0, sells: h24Sells || 0 },
      },
      pairCreatedAt: pool.attributes.pool_created_at ? new Date(pool.attributes.pool_created_at).getTime() : null,
      priceUsd:    pool.attributes.base_token_price_usd,
      icon:        tokenAttrs.image_url || null,
      pairAddress: pool.attributes.address,
      boostAmount: 0,
      url: `https://dexscreener.com/${chainId}/${pool.attributes.address}`,
    });
  });
}

function dedupeAndSlice(tokens, sortByVol = false) {
  const arr  = sortByVol ? [...tokens].sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0)) : tokens;
  const seen = new Set();
  return arr.filter((t) => {
    if (!t.baseToken.address || seen.has(t.baseToken.address)) return false;
    seen.add(t.baseToken.address);
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
      const networksToFetch =
        activeChain === "Solana" ? ["solana"]
        : activeChain === "Base" ? ["base"]
        : ["solana", "base"];

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

// ─── Top Volume Tokens Hook (GeckoTerminal) ───
function useTopVolumeTokens(activeChain) {
  const cacheKey = `gt_topvol_${activeChain}`;
  const [tokens, setTokens] = useState(() => readCache(cacheKey));
  const [loading, setLoading] = useState(() => readCache(cacheKey).length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(() => readCacheTs(cacheKey));
  const [error, setError] = useState(null);
  const fetchIdRef = useRef(0);
  const hasDataRef = useRef(readCache(cacheKey).length > 0);

  const fetchTopVol = useCallback(async () => {
    const myId = ++fetchIdRef.current;
    if (!hasDataRef.current) { setLoading(true); setError(null); }
    else setRefreshing(true);
    try {
      const networksToFetch =
        activeChain === "Solana" ? ["solana"]
        : activeChain === "Base" ? ["base"]
        : ["solana", "base"];

      const allTokens = [];
      let successPages = 0;

      for (const network of networksToFetch) {
        for (const page of [1, 2]) {
          try {
            const res = await fetch(
              `https://api.geckoterminal.com/api/v2/networks/${network}/pools?page=${page}&sort=h24_volume_usd_desc&include=base_token`
            );
            if (!res.ok) continue;
            fetchPoolsIntoList(await res.json(), network, allTokens, { volMin: 1000, liqMin: 10000, h1Min: 50, h24HrMin: 75 });
            successPages++;
          } catch {}
        }
      }

      if (successPages === 0) throw new Error("GeckoTerminal unreachable — rate limited or offline.");
      const deduped = dedupeAndSlice(allTokens, true);

      if (fetchIdRef.current !== myId) return;
      const now = Date.now();
      setTokens(deduped);
      setFetchedAt(now);
      setError(null);
      hasDataRef.current = true;
      writeCache(cacheKey, deduped);
    } catch (err) {
      if (fetchIdRef.current !== myId) return;
      if (!hasDataRef.current) setError(err.message);
    } finally {
      if (fetchIdRef.current !== myId) return;
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeChain]);

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
    fetchTopVol();
    const interval = setInterval(fetchTopVol, 120000);
    return () => { fetchIdRef.current++; clearInterval(interval); };
  }, [fetchTopVol]);

  return { tokens, loading, refreshing, fetchedAt, error, refetch: fetchTopVol };
}

// ─── Solana RPC helper — tries endpoints in order, handles 403 / 429 ───
const SOLANA_RPCS = [
  "https://mainnet.helius-rpc.com/?api-key=0dd8f0ec-f2a5-4f9e-b275-379afa3e73cd",
  "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana",
];

async function postRPC(body) {
  let lastErr = new Error("All RPC endpoints failed");
  for (const rpc of SOLANA_RPCS) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 403) { lastErr = new Error("RPC access denied — try again later"); continue; }
      if (res.status === 429) { lastErr = new Error("Rate limited — try again in a moment"); continue; }
      if (!res.ok)            { lastErr = new Error(`RPC error HTTP ${res.status}`); continue; }
      const data = await res.json();
      // RPC-level error is the same on all nodes, so don't retry
      if (data.error) throw new Error(data.error.message || "RPC error");
      return data;
    } catch (e) {
      lastErr = e;
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
      const rpcData = await postRPC({
        jsonrpc: "2.0", id: 1,
        method: "getTokenAccountsByOwner",
        params: [address, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }],
      });

      const accounts = rpcData.result?.value || [];
      const rawHoldings = accounts
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
  const diffMs = Date.now() - createdAt;
  const diffMins = Math.round(diffMs / 60000);
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
const TokenCard = ({ pair, isPinned, onPin, onUnpin, walletHolders = [] }) => {
  const symbol = pair.baseToken?.symbol || "???";
  const name = pair.baseToken?.name || "Unknown";
  const chain = getChainLabel(pair.chainId);
  const ca = pair.baseToken?.address || "";
  const mcap = pair.marketCap || pair.fdv || 0;
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

  const [hovered, setHovered] = useState(false);
  const [showHolders, setShowHolders] = useState(false);
  const [showWalletHolders, setShowWalletHolders] = useState(false);
  const [caCopied, setCaCopied] = useState(false);
  const { holders, loading: holdersLoading, error: holdersError, refetch: refetchHolders } = useTokenHolders(ca, pair.chainId, showHolders);

  return (
    <div
      style={{ background: "#111827", border: `1px solid ${hovered ? "#334155" : "#1e293b"}`, borderRadius: 14, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 4, transition: "border-color 0.2s", position: "relative", height: "100%", boxSizing: "border-box" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Action buttons — top right */}
      <div style={{ position: "absolute", top: 12, right: 12, display: "flex", gap: 4, zIndex: 2 }}>
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

      {/* Clickable area → DexScreener */}
      <a href={dexUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", color: "inherit" }}>
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
          <div style={{ display: "flex", gap: 12, color: "#64748b", fontSize: 12, marginTop: 6 }}>
            <span>Vol <span style={{ color: "#94a3b8" }}>{formatVolume(vol24)}</span></span>
            <span>Liq <span style={{ color: "#94a3b8" }}>{formatVolume(liq)}</span></span>
          </div>
        </div>
      </a>

      <BuySellBar buys={buys24} sells={sells24} />

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
          {pair.chainId === "solana" && (
            <a
              href={`https://jup.ag/token/${ca}`}
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
    </div>
  );
};

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

const LiveIndicator = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
    <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ade80", boxShadow: "0 0 8px #4ade8088", animation: "pulse 2s ease-in-out infinite" }} />
    <span style={{ color: "#4ade80", fontSize: 11, fontWeight: 600, letterSpacing: 0.5 }}>LIVE</span>
    <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
  </div>
);

// ─── Filter / Sort Bar ───
const SORT_OPTIONS = [
  { key: "vol",      label: "Vol" },
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
      <span style={{ color: "#475569", fontSize: 11 }}>Vol≥</span>
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
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      // support: "address,label"  or  "address label"
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
            placeholder={"Paste one address per line.\nOptional label after comma or space:\n\nABC...XYZ, My main wallet\nDEF...UVW whale"}
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

  const { prices, loading: priceLoading, error: priceError } = useCryptoPrices();
  const { tokens, loading: tokenLoading, refreshing: tokenRefreshing, fetchedAt: tokenFetchedAt, error: tokenError } = useTrendingTokens(activeChain);

  // Pinned CAs: [{ca, chainId}]
  const [pinnedCAs, setPinnedCAs] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pinnedCAs") || "[]"); } catch { return []; }
  });

  const { tokens: pinnedTokens, loading: pinnedLoading, refetch: refetchPinned } = usePinnedTokens(pinnedCAs);
  const { tokens: topVolTokens, loading: topVolLoading, refreshing: topVolRefreshing, fetchedAt: topVolFetchedAt, error: topVolError } = useTopVolumeTokens(activeChain);

  // Wallets: [{address, label}]
  const [wallets, setWallets] = useState(() => {
    try { return JSON.parse(localStorage.getItem("trackedWallets") || "[]"); } catch { return []; }
  });

  const [showAddCA, setShowAddCA] = useState(false);
  const [showAddWallet, setShowAddWallet] = useState(false);

  // mint → [{address, label, amount, usdValue}] across all tracked wallets
  const [walletMintMap, setWalletMintMap] = useState({});
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
        const entry = { address: walletAddr, label: walletLabel, amount: h.amount, usdValue: price * h.amount };
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
      .filter((t) => !volMin || (t.volume?.h24 || 0) >= volMin)
      .filter((t) => !mcapMin || (t.marketCap || t.fdv || 0) >= mcapMin)
      .filter((t) => change1hMin === null || (t.priceChange?.h1 ?? -Infinity) >= change1hMin)
      .sort((a, b) => {
        let aVal, bVal;
        if (sortBy === "vol")      { aVal = a.volume?.h24 || 0;          bVal = b.volume?.h24 || 0; }
        else if (sortBy === "mcap") { aVal = a.marketCap || a.fdv || 0;   bVal = b.marketCap || b.fdv || 0; }
        else if (sortBy === "change1h") { aVal = a.priceChange?.h1 ?? -999; bVal = b.priceChange?.h1 ?? -999; }
        else if (sortBy === "change6h") { aVal = a.priceChange?.h6 ?? -999; bVal = b.priceChange?.h6 ?? -999; }
        else if (sortBy === "age") { aVal = a.pairCreatedAt || 0;         bVal = b.pairCreatedAt || 0; }
        else { aVal = 0; bVal = 0; }
        return sortDir === "desc" ? bVal - aVal : aVal - bVal;
      });
  };

  // Most recent successful API fetch across both data sources
  const lastFetchedAt = tokenFetchedAt || topVolFetchedAt
    ? new Date(Math.max(tokenFetchedAt || 0, topVolFetchedAt || 0))
    : null;

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
  };

  const chainFilter = (t) =>
    activeChain === "Solana" ? t.chainId === "solana" :
    activeChain === "Base"   ? t.chainId === "base"   : true;

  const filteredTokens = applyFilters(tokens.filter(chainFilter));
  const filteredPinned = applyFilters(pinnedTokens.filter(chainFilter));
  // topVolTokens already fetched per-chain by the hook; still apply sort/filter controls
  const filteredTopVol = applyFilters(topVolTokens);

  const coinConfigs = [
    { id: "bitcoin", symbol: "BTC", color: "#F7931A" },
    { id: "ethereum", symbol: "ETH", color: "#627EEA" },
    { id: "solana", symbol: "SOL", color: "#9945FF" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#0a0e1a", color: "#e2e8f0", fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', padding: "32px 24px", maxWidth: 1120, margin: "0 auto" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } @keyframes shimmer { 0%,100% { opacity: 0.4; } 50% { opacity: 0.8; } }`}</style>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 32, fontWeight: 800, margin: 0, color: "#f8fafc", fontStyle: "italic", letterSpacing: -0.5 }}>{greeting.title}</h1>
          <p style={{ color: "#64748b", fontSize: 14, margin: "4px 0 0" }}>{greeting.sub}</p>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {chains.map((chain) => (
            <button key={chain} onClick={() => setActiveChain(chain)} style={{ padding: "7px 16px", borderRadius: 20, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.2s", background: activeChain === chain ? "#6366f1" : "transparent", color: activeChain === chain ? "#fff" : "#94a3b8" }}>{chain}</button>
          ))}
        </div>
      </div>

      {/* Good Morning Panel */}
      <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 16, padding: 24, marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 28 }}>{greeting.emoji}</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 17, color: "#f1f5f9" }}>{greeting.panel}</div>
              <div style={{ color: "#64748b", fontSize: 13 }}>{greeting.sub}</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <LiveIndicator />
            {(tokenRefreshing || topVolRefreshing) && (
              <span style={{ color: "#475569", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>↺</span> Refreshing…
              </span>
            )}
            {lastFetchedAt && !tokenRefreshing && !topVolRefreshing && (
              <span style={{ color: "#475569", fontSize: 11 }}>Data from {lastFetchedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            )}
          </div>
        </div>

        {priceError && (
          <div style={{ background: "#7f1d1d33", border: "1px solid #991b1b", borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: "#fca5a5", fontSize: 13 }}>⚠ Price fetch failed: {priceError}</div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 16 }}>
          {priceLoading
            ? [1, 2, 3].map((i) => <PriceSkeleton key={i} />)
            : coinConfigs.map((coin) => {
                const data = prices?.[coin.id];
                const price = data?.usd || 0;
                const change = data?.usd_24h_change || 0;
                const vol = data?.usd_24h_vol || 0;
                const mcap = data?.usd_market_cap || 0;
                const positive = change >= 0;
                return (
                  <div key={coin.symbol} style={{ background: "#0d1321", border: "1px solid #1e293b", borderRadius: 12, padding: "16px 18px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <CryptoIcon symbol={coin.symbol} color={coin.color} />
                      <span style={{ fontWeight: 700, fontSize: 14, color: "#e2e8f0" }}>{coin.symbol}</span>
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: "#f8fafc", marginBottom: 4 }}>{formatPrice(price)}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: positive ? "#4ade80" : "#f87171", marginBottom: 12 }}>{formatChange(change)}</div>
                    <div style={{ color: "#64748b", fontSize: 12, lineHeight: 1.6, borderTop: "1px solid #1e293b", paddingTop: 10, display: "flex", flexDirection: "column", gap: 2 }}>
                      <span>Vol 24h: <span style={{ color: "#94a3b8" }}>{formatVolume(vol)}</span></span>
                      <span>MCap: <span style={{ color: "#94a3b8" }}>{formatVolume(mcap)}</span></span>
                    </div>
                  </div>
                );
              })}
        </div>
      </div>

      {/* Section Nav */}
      <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid #1e293b", paddingBottom: 0 }}>
        {[
          { key: "discover", label: "🔥 Discover" },
          { key: "topvol",   label: "📊 Top Vol" },
          { key: "wallets",  label: `👜 Wallets${wallets.length > 0 ? ` (${wallets.length})` : ""}` },
        ].map((s) => (
          <button
            key={s.key}
            onClick={() => setActiveSection(s.key)}
            style={{ padding: "8px 18px", border: "none", background: "none", color: activeSection === s.key ? "#6366f1" : "#64748b", fontWeight: 700, fontSize: 14, cursor: "pointer", borderBottom: `2px solid ${activeSection === s.key ? "#6366f1" : "transparent"}`, marginBottom: -1, transition: "all 0.15s" }}
          >
            {s.label}
          </button>
        ))}
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
                      walletHolders={walletMintMap[pair.baseToken?.address || ""] || []}
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
                      isPinned={pinnedCAs.some((p) => p.ca === ca)}
                      onPin={pinToken}
                      onUnpin={unpinToken}
                      walletHolders={walletMintMap[ca] || []}
                    />
                  );
                })}
          </div>

          {!tokenLoading && filteredTokens.length === 0 && !tokenError && (
            <div style={{ textAlign: "center", color: "#475569", padding: 48, fontSize: 14 }}>No trending tokens found for this chain right now.</div>
          )}
        </>
      )}

      {/* ─── Top Vol Section ─── */}
      {activeSection === "topvol" && (
        <>
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
            count={filteredTopVol.length}
            total={topVolTokens.length}
          />

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
            <h2 style={{ fontSize: 14, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: "#f59e0b", margin: 0 }}>📊 Top Volume Today</h2>
            <span style={{ color: "#64748b", fontSize: 12 }}>Powered by GeckoTerminal • Sorted by 24h Vol</span>
          </div>

          {topVolError && (
            <div style={{ background: "#7f1d1d33", border: "1px solid #991b1b", borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: "#fca5a5", fontSize: 13 }}>⚠ Fetch failed: {topVolError}</div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
            {topVolLoading
              ? [1, 2, 3, 4, 5, 6].map((i) => <TokenSkeleton key={i} />)
              : filteredTopVol.map((pair, i) => {
                  const ca = pair.baseToken?.address || "";
                  return (
                    <TokenCard
                      key={`topvol-${pair.pairAddress}-${i}`}
                      pair={pair}
                      isPinned={pinnedCAs.some((p) => p.ca === ca)}
                      onPin={pinToken}
                      onUnpin={unpinToken}
                      walletHolders={walletMintMap[ca] || []}
                    />
                  );
                })}
          </div>

          {!topVolLoading && filteredTopVol.length === 0 && !topVolError && (
            <div style={{ textAlign: "center", color: "#475569", padding: 48, fontSize: 14 }}>No tokens found for this chain / filter combination.</div>
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
            <button
              onClick={() => setShowAddWallet(!showAddWallet)}
              style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #4ade8044", background: showAddWallet ? "#4ade8022" : "transparent", color: "#4ade80", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            >
              + Add Wallet
            </button>
          </div>

          {showAddWallet && <AddWalletPanel onAdd={addWallet} onClose={() => setShowAddWallet(false)} />}

          {wallets.length === 0 && !showAddWallet && (
            <div style={{ textAlign: "center", color: "#475569", padding: 64, fontSize: 14, border: "1px dashed #1e293b", borderRadius: 14 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>👜</div>
              <div style={{ fontWeight: 600, marginBottom: 6, color: "#64748b" }}>No wallets tracked yet</div>
              <div>Add a Solana wallet address to see its token positions</div>
            </div>
          )}

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

      <div style={{ textAlign: "center", color: "#334155", fontSize: 11, marginTop: 40, paddingBottom: 20 }}>
        Prices from CoinGecko • Tokens from GeckoTerminal • Auto-refreshes every 2 min
      </div>
    </div>
  );
}

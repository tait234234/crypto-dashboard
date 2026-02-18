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

// ─── DexScreener Trending Tokens Hook ───
function useTrendingTokens() {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchTrending = useCallback(async () => {
    try {
      const boostRes = await fetch("https://api.dexscreener.com/token-boosts/top/v1");
      if (!boostRes.ok) throw new Error("DexScreener boost API failed (" + boostRes.status + ")");
      const boostData = await boostRes.json();

      const seen = new Set();
      const relevantTokens = (Array.isArray(boostData) ? boostData : [])
        .filter((t) => t.chainId === "solana" || t.chainId === "base")
        .filter((t) => {
          if (seen.has(t.tokenAddress)) return false;
          seen.add(t.tokenAddress);
          return true;
        })
        .slice(0, 24);

      if (relevantTokens.length === 0) {
        setTokens([]);
        setError(null);
        setLoading(false);
        return;
      }

      const byChain = {};
      relevantTokens.forEach((t) => {
        if (!byChain[t.chainId]) byChain[t.chainId] = [];
        byChain[t.chainId].push(t);
      });

      const allPairs = [];
      for (const [chainId, chainTokens] of Object.entries(byChain)) {
        const addresses = chainTokens.map((t) => t.tokenAddress).join(",");
        try {
          const res = await fetch(`https://api.dexscreener.com/tokens/v1/${chainId}/${addresses}`);
          if (res.ok) {
            const pairs = await res.json();
            if (Array.isArray(pairs)) allPairs.push(...pairs);
          }
        } catch (e) {
          console.warn(`Failed to fetch ${chainId} tokens:`, e);
        }
      }

      const tokenMap = new Map();
      allPairs.forEach((pair) => {
        const addr = pair.baseToken?.address;
        if (!addr) return;
        const existing = tokenMap.get(addr);
        if (!existing || (pair.volume?.h24 || 0) > (existing.volume?.h24 || 0)) {
          tokenMap.set(addr, pair);
        }
      });

      const boostMap = new Map();
      relevantTokens.forEach((t) => boostMap.set(t.tokenAddress, t));

      const enrichedTokens = relevantTokens
        .map((boost) => {
          const pair = tokenMap.get(boost.tokenAddress);
          if (!pair) return null;
          return {
            ...pair,
            boostAmount: boost.totalAmount || 0,
            icon: boost.icon || pair.info?.imageUrl || null,
          };
        })
        .filter(Boolean)
        .filter((t) => (t.volume?.h24 || 0) > 500)
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
        .slice(0, 12);

      setTokens(enrichedTokens);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTrending();
    const interval = setInterval(fetchTrending, 120000);
    return () => clearInterval(interval);
  }, [fetchTrending]);

  return { tokens, loading, error, refetch: fetchTrending };
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
          } catch (e) { console.warn("Pinned fetch error:", e); }
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
    } catch (e) {
      console.warn("usePinnedTokens error:", e);
    } finally {
      setLoading(false);
    }
  }, [pinnedCAs]);

  useEffect(() => { fetchPinned(); }, [fetchPinned]);
  return { tokens, loading, refetch: fetchPinned };
}

// ─── Top Volume Tokens Hook (GeckoTerminal) ───
function useTopVolumeTokens(activeChain) {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchTopVol = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const networksToFetch =
        activeChain === "Solana" ? ["solana"]
        : activeChain === "Base" ? ["base"]
        : ["solana", "base"];

      const allTokens = [];

      for (const network of networksToFetch) {
        try {
          const res = await fetch(
            `https://api.geckoterminal.com/api/v2/networks/${network}/pools?page=1&sort=h24_volume_usd_desc&include=base_token`
          );
          if (!res.ok) continue;
          const data = await res.json();

          // Build token lookup from included array
          const tokenMap = new Map();
          (data.included || []).forEach((item) => {
            if (item.type === "token") tokenMap.set(item.id, item.attributes);
          });

          const chainId = network === "solana" ? "solana" : "base";

          (data.data || []).forEach((pool) => {
            const baseTokenId = pool.relationships?.base_token?.data?.id;
            const tokenAttrs = tokenMap.get(baseTokenId);
            if (!tokenAttrs) return;

            const ca = baseTokenId?.replace(`${network}_`, "") || "";
            const vol24 = parseFloat(pool.attributes.volume_usd?.h24 || 0);
            const liq = parseFloat(pool.attributes.reserve_in_usd || 0);

            // ── Dead pool filters ──────────────────────────────
            if (vol24 < 1000) return; // skip dust volume
            if (liq < 5000) return;   // no liquidity → skip

            // Require ≥50 trades in the last hour.
            // Use h1 txns when present; fall back to 24h avg if the API
            // hasn't returned the shorter bucket yet.
            const h1Buys  = pool.attributes.transactions?.h1?.buys  || 0;
            const h1Sells = pool.attributes.transactions?.h1?.sells || 0;
            const h24Buys  = pool.attributes.transactions?.h24?.buys  || 0;
            const h24Sells = pool.attributes.transactions?.h24?.sells || 0;
            const h1Txns = h1Buys + h1Sells;
            const h24Txns = h24Buys + h24Sells;
            // Use real h1 count; if not available, estimate from 24h avg
            const effectiveH1Txns = h1Txns > 0 ? h1Txns : Math.round(h24Txns / 24);
            if (effectiveH1Txns < 50) return; // no active traders → skip
            // ──────────────────────────────────────────────────

            allTokens.push({
              baseToken: {
                symbol: tokenAttrs.symbol || "???",
                name: tokenAttrs.name || "Unknown",
                address: ca,
              },
              chainId,
              marketCap: parseFloat(pool.attributes.market_cap_usd || pool.attributes.fdv_usd || 0),
              fdv: parseFloat(pool.attributes.fdv_usd || 0),
              volume: { h24: vol24 },
              liquidity: { usd: liq },
              priceChange: {
                h1: parseFloat(pool.attributes.price_change_percentage?.h1 || 0),
                h6: parseFloat(pool.attributes.price_change_percentage?.h6 || 0),
              },
              txns: {
                h1:  { buys: h1Buys,  sells: h1Sells  },
                h24: { buys: h24Buys, sells: h24Sells },
              },
              pairCreatedAt: pool.attributes.pool_created_at
                ? new Date(pool.attributes.pool_created_at).getTime()
                : null,
              priceUsd: pool.attributes.base_token_price_usd,
              icon: tokenAttrs.image_url || null,
              pairAddress: pool.attributes.address,
              boostAmount: 0,
              url: `https://dexscreener.com/${chainId}/${pool.attributes.address}`,
            });
          });
        } catch (e) {
          console.warn(`GeckoTerminal ${network} fetch error:`, e);
        }
      }

      // Deduplicate by CA, already sorted by volume desc from API
      const seen = new Set();
      const deduped = allTokens
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
        .filter((t) => {
          const ca = t.baseToken.address;
          if (!ca || seen.has(ca)) return false;
          seen.add(ca);
          return true;
        })
        .slice(0, 24);

      setTokens(deduped);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeChain]);

  useEffect(() => {
    fetchTopVol();
    const interval = setInterval(fetchTopVol, 120000);
    return () => clearInterval(interval);
  }, [fetchTopVol]);

  return { tokens, loading, error, refetch: fetchTopVol };
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
      const rpcRes = await fetch("https://api.mainnet-beta.solana.com", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTokenAccountsByOwner",
          params: [address, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }],
        }),
      });
      const rpcData = await rpcRes.json();
      if (rpcData.error) throw new Error(rpcData.error.message || "RPC error");

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
        } catch (e) { console.warn("Wallet pair fetch error:", e); }
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
  if (num >= 1e9) return "$" + (num / 1e9).toFixed(1) + "B";
  if (num >= 1e6) return "$" + (num / 1e6).toFixed(1) + "M";
  if (num >= 1e3) return "$" + (num / 1e3).toFixed(1) + "K";
  return "$" + num.toFixed(0);
}

function formatAge(createdAt) {
  if (!createdAt) return "—";
  const diffMs = Date.now() - createdAt;
  const diffMins = diffMs / 60000;
  if (diffMins < 60) return Math.round(diffMins) + "m";
  const diffHrs = diffMins / 60;
  if (diffHrs < 24) return diffHrs.toFixed(1) + "h";
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
  return `hsl(${Math.abs(hash) % 360}, 40%, 15%)`;
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

// ─── Token Card ───
const TokenCard = ({ pair, isPinned, onPin, onUnpin }) => {
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
  const holdersUrl = pair.chainId === "solana"
    ? `https://solscan.io/token/${ca}#holders`
    : `https://basescan.org/token/${ca}#balances`;

  const [hovered, setHovered] = useState(false);

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
        {/* Top Holders */}
        <a
          href={holdersUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="View top holders"
          style={{ width: 28, height: 28, borderRadius: 6, background: "#1e293b", border: "1px solid #334155", display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontSize: 14, color: "#94a3b8", cursor: "pointer", flexShrink: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          👥
        </a>
        {/* Bookmark / Pin */}
        <button
          onClick={(e) => { e.stopPropagation(); isPinned ? onUnpin(ca, pair.chainId) : onPin(ca, pair.chainId); }}
          title={isPinned ? "Unpin" : "Pin / Bookmark"}
          style={{ width: 28, height: 28, borderRadius: 6, background: isPinned ? "#6366f122" : "#1e293b", border: `1px solid ${isPinned ? "#6366f1" : "#334155"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: isPinned ? "#818cf8" : "#64748b", cursor: "pointer", flexShrink: 0 }}
        >
          {isPinned ? "📌" : "🔖"}
        </button>
      </div>

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
              <div style={{ color: "#64748b", fontSize: 11, marginTop: 2 }}>
                Age <span style={{ color: "#94a3b8" }}>{age}</span>
                {"  "}Price <span style={{ color: "#94a3b8" }}>{pair.priceUsd ? formatPrice(parseFloat(pair.priceUsd)) : "—"}</span>
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
          <div style={{ color: "#64748b", fontSize: 12, marginTop: 6 }}>
            Vol <span style={{ color: "#94a3b8" }}>{formatVolume(vol24)}</span>
            {"   "}Liq <span style={{ color: "#94a3b8" }}>{formatVolume(liq)}</span>
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
            onClick={() => navigator.clipboard?.writeText(ca)}
            title="Copy CA"
            style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 11, padding: "1px 4px" }}
          >
            copy
          </button>
        </div>
      )}

      {/* Trade buttons */}
      {ca && (
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          {pair.chainId === "solana" && (
            <a
              href={`https://jup.ag/swap/SOL-${ca}`}
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
        <div style={{ color: "#64748b", fontSize: 11 }}>{amount >= 1e6 ? (amount / 1e6).toFixed(2) + "M" : amount >= 1e3 ? (amount / 1e3).toFixed(2) + "K" : amount.toFixed(2)}</div>
      </div>
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        <a href={dexUrl} target="_blank" rel="noopener noreferrer" title="DexScreener" style={{ width: 26, height: 26, borderRadius: 5, background: "#1e293b", border: "1px solid #334155", display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontSize: 12, color: "#94a3b8" }}>↗</a>
        <a href={bubbleMapsUrl} target="_blank" rel="noopener noreferrer" title="BubbleMaps" style={{ width: 26, height: 26, borderRadius: 5, background: "#1e293b", border: "1px solid #334155", display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", fontSize: 12, color: "#60a5fa" }}>🫧</a>
      </div>
    </div>
  );
};

const WalletCard = ({ wallet, onRemove }) => {
  const { holdings, loading, error, refetch } = useWalletTokens(wallet.address);
  const [expanded, setExpanded] = useState(true);

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
            <div style={{ color: "#64748b", fontSize: 12, fontFamily: "monospace" }}>{wallet.address}</div>
          </div>
          <span style={{ background: "#0052FF22", color: "#60a5fa", border: "1px solid #0052FF44", fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, fontFamily: "monospace" }}>SOL</span>
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
      setTimeout(onClose, 800);
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
          style={{ background: "#6366f1", border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 600, padding: "8px 16px", cursor: "pointer", opacity: !ca.trim() ? 0.5 : 1 }}
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
    <style>{`@keyframes shimmer { 0%,100% { opacity: 0.4; } 50% { opacity: 0.8; } }`}</style>
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
    <style>{`@keyframes shimmer { 0%,100% { opacity: 0.4; } 50% { opacity: 0.8; } }`}</style>
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
const AddWalletPanel = ({ onAdd, onClose }) => {
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleAdd = () => {
    const trimmed = address.trim();
    if (!trimmed) return;
    onAdd(trimmed, label.trim());
    onClose();
  };

  return (
    <div style={{ background: "#111827", border: "1px solid #4ade8044", borderRadius: 12, padding: "16px 20px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ color: "#4ade80", fontWeight: 700, fontSize: 14 }}>Add a Solana wallet</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 16 }}>✕</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          ref={inputRef}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="Wallet address (Solana)…"
          style={{ background: "#0d1321", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 13, padding: "8px 12px", outline: "none" }}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional, e.g. 'My wallet')"
            style={{ flex: 1, background: "#0d1321", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 13, padding: "8px 12px", outline: "none" }}
          />
          <button
            onClick={handleAdd}
            disabled={!address.trim()}
            style={{ background: "#4ade8022", border: "1px solid #4ade8044", borderRadius: 8, color: "#4ade80", fontSize: 13, fontWeight: 600, padding: "8px 16px", cursor: "pointer", opacity: !address.trim() ? 0.5 : 1 }}
          >
            Add
          </button>
        </div>
      </div>
      <div style={{ color: "#475569", fontSize: 11, marginTop: 8 }}>Only Solana wallets supported. Shows tokens listed on DexScreener.</div>
    </div>
  );
};

// ─── Main App ───
export default function App() {
  const [activeChain, setActiveChain] = useState("All Chains");
  const [activeSection, setActiveSection] = useState("discover"); // "discover" | "wallets"
  const chains = ["All Chains", "Solana", "Base"];

  const { prices, loading: priceLoading, error: priceError, refetch: refetchPrices } = useCryptoPrices();
  const { tokens, loading: tokenLoading, error: tokenError, refetch: refetchTokens } = useTrendingTokens();
  const [lastUpdated, setLastUpdated] = useState(null);

  // Pinned CAs: [{ca, chainId}]
  const [pinnedCAs, setPinnedCAs] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pinnedCAs") || "[]"); } catch { return []; }
  });

  const { tokens: pinnedTokens, loading: pinnedLoading, refetch: refetchPinned } = usePinnedTokens(pinnedCAs);
  const { tokens: topVolTokens, loading: topVolLoading, error: topVolError, refetch: refetchTopVol } = useTopVolumeTokens(activeChain);

  // Wallets: [{address, label}]
  const [wallets, setWallets] = useState(() => {
    try { return JSON.parse(localStorage.getItem("trackedWallets") || "[]"); } catch { return []; }
  });

  const [showAddCA, setShowAddCA] = useState(false);
  const [showAddWallet, setShowAddWallet] = useState(false);

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

  useEffect(() => {
    if (prices || tokens.length > 0) setLastUpdated(new Date());
  }, [prices, tokens]);

  useEffect(() => {
    localStorage.setItem("pinnedCAs", JSON.stringify(pinnedCAs));
  }, [pinnedCAs]);

  useEffect(() => {
    localStorage.setItem("trackedWallets", JSON.stringify(wallets));
  }, [wallets]);

  const handleRefresh = () => { refetchPrices(); refetchTokens(); refetchPinned(); refetchTopVol(); };

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

  const chainFilter = (t) => {
    if (activeChain === "All Chains") return true;
    if (activeChain === "Solana") return t.chainId === "solana";
    if (activeChain === "Base") return t.chainId === "base";
    return true;
  };

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
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 32, fontWeight: 800, margin: 0, color: "#f8fafc", fontStyle: "italic", letterSpacing: -0.5 }}>Morning</h1>
          <p style={{ color: "#64748b", fontSize: 14, margin: "4px 0 0" }}>What happened while you slept</p>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {chains.map((chain) => (
            <button key={chain} onClick={() => setActiveChain(chain)} style={{ padding: "7px 16px", borderRadius: 20, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.2s", background: activeChain === chain ? "#6366f1" : "transparent", color: activeChain === chain ? "#fff" : "#94a3b8" }}>{chain}</button>
          ))}
          <button onClick={handleRefresh} style={{ padding: "7px 14px", borderRadius: 20, border: "none", background: "transparent", color: "#94a3b8", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Refresh</button>
        </div>
      </div>

      {/* Good Morning Panel */}
      <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 16, padding: 24, marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 28 }}>☕</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 17, color: "#f1f5f9" }}>Good morning</div>
              <div style={{ color: "#64748b", fontSize: 13 }}>Here's what happened overnight</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <LiveIndicator />
            {lastUpdated && <span style={{ color: "#475569", fontSize: 11 }}>Updated {lastUpdated.toLocaleTimeString()}</span>}
          </div>
        </div>

        {priceError && (
          <div style={{ background: "#7f1d1d33", border: "1px solid #991b1b", borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: "#fca5a5", fontSize: 13 }}>⚠ Price fetch failed: {priceError}</div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
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
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
                  {[1, 2].map((i) => <TokenSkeleton key={i} />)}
                </div>
              )}
              {!pinnedLoading && filteredPinned.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
                  {filteredPinned.map((pair, i) => (
                    <TokenCard
                      key={`pinned-${pair.pairAddress}-${i}`}
                      pair={pair}
                      isPinned={true}
                      onPin={pinToken}
                      onUnpin={unpinToken}
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
            <span style={{ color: "#64748b", fontSize: 12 }}>Powered by DexScreener • Click card to view</span>
          </div>

          {tokenError && (
            <div style={{ background: "#7f1d1d33", border: "1px solid #991b1b", borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: "#fca5a5", fontSize: 13 }}>⚠ Token fetch failed: {tokenError}. Will retry…</div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
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

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
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
            <WalletCard key={wallet.address} wallet={wallet} onRemove={removeWallet} />
          ))}

          {wallets.length > 0 && (
            <div style={{ color: "#334155", fontSize: 11, marginTop: 16, textAlign: "center" }}>
              Token holdings fetched from Solana RPC • Prices from DexScreener • Only tokens listed on DexScreener shown
            </div>
          )}
        </>
      )}

      <div style={{ textAlign: "center", color: "#334155", fontSize: 11, marginTop: 40, paddingBottom: 20 }}>
        Prices from CoinGecko • Tokens from DexScreener • Auto-refreshes every 2 min
      </div>
    </div>
  );
}

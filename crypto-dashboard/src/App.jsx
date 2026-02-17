import { useState, useEffect, useCallback } from "react";

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
      // Step 1: Get top boosted tokens (these are trending)
      const boostRes = await fetch("https://api.dexscreener.com/token-boosts/top/v1");
      if (!boostRes.ok) throw new Error("DexScreener boost API failed");
      const boostData = await boostRes.json();

      // Filter for Solana and Base chains, get unique token addresses
      const seen = new Set();
      const relevantTokens = boostData
        .filter((t) => t.chainId === "solana" || t.chainId === "base")
        .filter((t) => {
          if (seen.has(t.tokenAddress)) return false;
          seen.add(t.tokenAddress);
          return true;
        })
        .slice(0, 20);

      if (relevantTokens.length === 0) {
        setTokens([]);
        setError(null);
        setLoading(false);
        return;
      }

      // Step 2: Fetch detailed pair data for each token
      // DexScreener allows batch token lookups (comma separated, max 30)
      const tokenAddresses = relevantTokens.map((t) => t.tokenAddress).join(",");
      const detailRes = await fetch(
        `https://api.dexscreener.com/tokens/v1/${tokenAddresses}`
      );
      if (!detailRes.ok) throw new Error("DexScreener token API failed");
      const pairs = await detailRes.json();

      // Group pairs by token, pick the highest volume pair per token
      const tokenMap = new Map();
      (Array.isArray(pairs) ? pairs : []).forEach((pair) => {
        const addr = pair.baseToken?.address;
        if (!addr) return;
        const existing = tokenMap.get(addr);
        if (!existing || (pair.volume?.h24 || 0) > (existing.volume?.h24 || 0)) {
          tokenMap.set(addr, pair);
        }
      });

      // Build token list with boost info
      const enrichedTokens = relevantTokens
        .map((boost) => {
          const pair = tokenMap.get(boost.tokenAddress);
          if (!pair) return null;
          return {
            ...pair,
            boostAmount: boost.totalAmount || 0,
            icon: boost.icon || pair.info?.imageUrl || null,
            chainId: boost.chainId,
          };
        })
        .filter(Boolean)
        .filter((t) => t.volume?.h24 > 1000) // Filter out dead tokens
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
    const interval = setInterval(fetchTrending, 120000); // Refresh every 2 min
    return () => clearInterval(interval);
  }, [fetchTrending]);

  return { tokens, loading, error, refetch: fetchTrending };
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
  const now = Date.now();
  const diffMs = now - createdAt;
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

// Generate a color from token name for avatar bg
function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < (str || "").length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 40%, 15%)`;
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

const TokenCard = ({ pair }) => {
  const symbol = pair.baseToken?.symbol || "???";
  const name = pair.baseToken?.name || "Unknown";
  const chain = getChainLabel(pair.chainId);
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

  return (
    <a
      href={dexUrl}
      target="_blank"
      rel="noopener noreferrer"
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <div
        style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 14, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 4, transition: "border-color 0.2s", cursor: "pointer", height: "100%" }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#334155")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#1e293b")}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {iconUrl ? (
              <img
                src={iconUrl}
                alt={symbol}
                style={{ width: 40, height: 40, borderRadius: 10, border: "1px solid #ffffff11", objectFit: "cover" }}
                onError={(e) => { e.target.style.display = "none"; e.target.nextSibling.style.display = "flex"; }}
              />
            ) : null}
            <div
              style={{
                width: 40, height: 40, borderRadius: 10, background: hashColor(symbol),
                display: iconUrl ? "none" : "flex", alignItems: "center", justifyContent: "center",
                fontSize: 14, fontWeight: 700, color: "#e2e8f0", border: "1px solid #ffffff11",
              }}
            >
              {symbol.slice(0, 2)}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 15, letterSpacing: 0.3 }}>{symbol}</span>
                <ChainBadge chain={chain} />
              </div>
              <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 2, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
              <div style={{ color: "#64748b", fontSize: 11, marginTop: 2 }}>
                Age <span style={{ color: "#94a3b8" }}>{age}</span>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <span style={{ color: "#94a3b8", fontSize: 11, fontWeight: 600 }}>
              {pair.priceUsd ? formatPrice(parseFloat(pair.priceUsd)) : "—"}
            </span>
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

        <BuySellBar buys={buys24} sells={sells24} />
      </div>
    </a>
  );
};

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

// ─── Main App ───
export default function App() {
  const [activeChain, setActiveChain] = useState("All Chains");
  const chains = ["All Chains", "Solana", "Base"];
  const { prices, loading: priceLoading, error: priceError, refetch: refetchPrices } = useCryptoPrices();
  const { tokens, loading: tokenLoading, error: tokenError, refetch: refetchTokens } = useTrendingTokens();
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    if (prices || tokens.length > 0) setLastUpdated(new Date());
  }, [prices, tokens]);

  const handleRefresh = () => {
    refetchPrices();
    refetchTokens();
  };

  const filteredTokens = tokens.filter((t) => {
    if (activeChain === "All Chains") return true;
    if (activeChain === "Solana") return t.chainId === "solana";
    if (activeChain === "Base") return t.chainId === "base";
    return true;
  });

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
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {chains.map((chain) => (
            <button key={chain} onClick={() => setActiveChain(chain)} style={{ padding: "7px 16px", borderRadius: 20, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.2s", background: activeChain === chain ? "#6366f1" : "transparent", color: activeChain === chain ? "#fff" : "#94a3b8" }}>{chain}</button>
          ))}
          <button onClick={handleRefresh} style={{ padding: "7px 14px", borderRadius: 20, border: "none", background: "transparent", color: "#94a3b8", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Refresh</button>
          <button style={{ width: 34, height: 34, borderRadius: "50%", border: "1px solid #1e293b", background: "transparent", color: "#94a3b8", fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>⚙</button>
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
          <div style={{ background: "#7f1d1d33", border: "1px solid #991b1b", borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: "#fca5a5", fontSize: 13 }}>
            ⚠ Price fetch failed: {priceError}
          </div>
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

      {/* Trending Tokens */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: "#f1f5f9", margin: 0 }}>
          🔥 Trending Tokens
        </h2>
        <span style={{ color: "#64748b", fontSize: 12 }}>
          Powered by DexScreener • Updates every 2 min
        </span>
      </div>

      {tokenError && (
        <div style={{ background: "#7f1d1d33", border: "1px solid #991b1b", borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: "#fca5a5", fontSize: 13 }}>
          ⚠ Token fetch failed: {tokenError}. Will retry...
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
        {tokenLoading
          ? [1, 2, 3, 4, 5, 6].map((i) => <TokenSkeleton key={i} />)
          : filteredTokens.map((pair, i) => (
              <TokenCard key={`${pair.pairAddress}-${i}`} pair={pair} />
            ))}
      </div>

      {!tokenLoading && filteredTokens.length === 0 && !tokenError && (
        <div style={{ textAlign: "center", color: "#475569", padding: 48, fontSize: 14 }}>
          No trending tokens found for this chain right now.
        </div>
      )}

      {/* Footer */}
      <div style={{ textAlign: "center", color: "#334155", fontSize: 11, marginTop: 40, paddingBottom: 20 }}>
        Prices from CoinGecko • Token data from DexScreener • Click any token to view on DexScreener
      </div>
    </div>
  );
}

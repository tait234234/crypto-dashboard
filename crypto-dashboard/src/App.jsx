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

  const fetchTrending = useCallback(async (hardReset = false) => {
    try {
      if (hardReset) {
        setTokens([]);
        setLoading(true);
      }
      // Step 1: Fetch from 3 endpoints in parallel for maximum coverage
      const [topBoostRes, latestBoostRes, latestProfileRes] = await Promise.allSettled([
        fetch("https://api.dexscreener.com/token-boosts/top/v1"),
        fetch("https://api.dexscreener.com/token-boosts/latest/v1"),
        fetch("https://api.dexscreener.com/token-profiles/latest/v1"),
      ]);

      const parseRes = async (settled) => {
        if (settled.status !== "fulfilled" || !settled.value.ok) return [];
        try {
          const data = await settled.value.json();
          return Array.isArray(data) ? data : [];
        } catch { return []; }
      };

      const topBoosts = await parseRes(topBoostRes);
      const latestBoosts = await parseRes(latestBoostRes);
      const latestProfiles = await parseRes(latestProfileRes);

      // Step 2: Merge all sources, deduplicate, keep Solana + Base
      const seen = new Set();
      const allRaw = [...topBoosts, ...latestBoosts, ...latestProfiles];
      const relevantTokens = allRaw
        .filter((t) => t.chainId === "solana" || t.chainId === "base")
        .filter((t) => {
          const addr = t.tokenAddress;
          if (!addr || seen.has(`${t.chainId}:${addr}`)) return false;
          seen.add(`${t.chainId}:${addr}`);
          return true;
        });

      if (relevantTokens.length === 0) {
        setTokens([]);
        setError(null);
        setLoading(false);
        return;
      }

      // Step 3: Group by chain, then batch into chunks of 30 (API limit)
      const byChain = {};
      relevantTokens.forEach((t) => {
        if (!byChain[t.chainId]) byChain[t.chainId] = [];
        byChain[t.chainId].push(t);
      });

      const allPairs = [];
      for (const [chainId, chainTokens] of Object.entries(byChain)) {
        // Chunk into groups of 30
        for (let i = 0; i < chainTokens.length; i += 30) {
          const chunk = chainTokens.slice(i, i + 30);
          const addresses = chunk.map((t) => t.tokenAddress).join(",");
          try {
            const res = await fetch(
              `https://api.dexscreener.com/tokens/v1/${chainId}/${addresses}`
            );
            if (res.ok) {
              const pairs = await res.json();
              if (Array.isArray(pairs)) allPairs.push(...pairs);
            }
          } catch (e) {
            console.warn(`Failed to fetch ${chainId} chunk:`, e);
          }
        }
      }

      // Step 4: Pick highest volume pair per token
      // Index by BOTH baseToken and quoteToken address to catch all matches
      const tokenMap = new Map();
      allPairs.forEach((pair) => {
        const addrs = [pair.baseToken?.address, pair.quoteToken?.address].filter(Boolean);
        addrs.forEach((addr) => {
          const key = `${pair.chainId}:${addr}`;
          const existing = tokenMap.get(key);
          if (!existing || (pair.volume?.h24 || 0) > (existing.volume?.h24 || 0)) {
            tokenMap.set(key, pair);
          }
        });
      });

      // Step 5: Build icon map from all source endpoints (profiles have best icons)
      const iconMap = new Map();
      // Profiles first (best quality), then boosts
      [...latestProfiles, ...topBoosts, ...latestBoosts].forEach((t) => {
        if (t.icon && t.chainId && t.tokenAddress) {
          const key = `${t.chainId}:${t.tokenAddress}`;
          if (!iconMap.has(key)) iconMap.set(key, t.icon);
        }
      });

      // Step 6: Build enriched token list — no artificial limits
      const enrichedTokens = relevantTokens
        .map((boost) => {
          const key = `${boost.chainId}:${boost.tokenAddress}`;
          const pair = tokenMap.get(key);
          if (!pair) return null;
          // Resolve icon: profile icon > boost icon > pair imageUrl > header
          const icon = iconMap.get(key)
            || boost.icon
            || pair.info?.imageUrl
            || pair.info?.header
            || null;
          return {
            ...pair,
            boostAmount: boost.totalAmount || 0,
            icon,
          };
        })
        .filter(Boolean)
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));

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

  const hardRefetch = useCallback(() => fetchTrending(true), [fetchTrending]);
  return { tokens, loading, error, refetch: hardRefetch };
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

// ─── Health Score ───
function calculateHealthScore(pair) {
  let score = 0;

  // Liquidity depth (0-25 pts) — low liquidity = easy to rug
  const liq = pair.liquidity?.usd || 0;
  if (liq >= 200000) score += 25;
  else if (liq >= 50000) score += 18;
  else if (liq >= 10000) score += 10;
  else if (liq >= 1000) score += 4;

  // Pair age (0-20 pts) — older = more battle-tested
  const ageMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 0;
  const ageHrs = ageMs / 3600000;
  if (ageHrs >= 168) score += 20;       // 7d+
  else if (ageHrs >= 24) score += 15;   // 1d+
  else if (ageHrs >= 6) score += 8;
  else if (ageHrs >= 1) score += 3;

  // Volume/Liquidity ratio (0-20 pts) — sweet spot is 0.5-3x, too high = wash trading
  if (liq > 0) {
    const vlRatio = (pair.volume?.h24 || 0) / liq;
    if (vlRatio >= 0.5 && vlRatio <= 3) score += 20;
    else if (vlRatio > 3 && vlRatio <= 10) score += 10;
    else if (vlRatio > 10) score += 2;  // suspicious
    else if (vlRatio > 0.1) score += 12;
  }

  // Buy/sell balance (0-15 pts) — extreme imbalance = manipulation
  const buys = pair.txns?.h24?.buys || 0;
  const sells = pair.txns?.h24?.sells || 0;
  const totalTxns = buys + sells;
  if (totalTxns > 0) {
    const buyRatio = buys / totalTxns;
    const balance = 1 - Math.abs(buyRatio - 0.5) * 2; // 1 = perfectly balanced, 0 = all one side
    score += Math.round(balance * 15);
  }

  // Transaction count (0-10 pts) — more unique txns = more real users
  if (totalTxns >= 500) score += 10;
  else if (totalTxns >= 100) score += 7;
  else if (totalTxns >= 30) score += 4;
  else if (totalTxns >= 5) score += 2;

  // Has info / socials (0-10 pts) — legit projects fill out their profile
  const info = pair.info;
  if (info) {
    if (info.websites?.length > 0) score += 4;
    if (info.socials?.length > 0) score += 3;
    if (info.imageUrl) score += 3;
  }

  return Math.min(score, 100);
}

function getHealthLabel(score) {
  if (score >= 75) return { label: "Strong", color: "#4ade80", bg: "#4ade8018" };
  if (score >= 55) return { label: "Solid", color: "#a3e635", bg: "#a3e63518" };
  if (score >= 35) return { label: "Moderate", color: "#fbbf24", bg: "#fbbf2418" };
  if (score >= 20) return { label: "Risky", color: "#fb923c", bg: "#fb923c18" };
  return { label: "High Risk", color: "#f87171", bg: "#f8717118" };
}

// ─── Bot / Wash Trade Detection ───
function detectSuspicious(pair) {
  const vol24 = pair.volume?.h24 || 0;
  const vol6h = pair.volume?.h6 || 0;
  const vol1h = pair.volume?.h1 || 0;
  const liq = pair.liquidity?.usd || 0;
  const buys = pair.txns?.h24?.buys || 0;
  const sells = pair.txns?.h24?.sells || 0;
  const totalTxns = buys + sells;
  const reasons = [];

  // Extreme vol/liq ratio — likely wash trading
  if (liq > 0 && vol24 / liq > 40) reasons.push("vol/liq >40x");

  // Avg transaction size under $8 — micro-bot pattern
  if (totalTxns > 50 && vol24 / totalTxns < 8) reasons.push("avg tx <$8");

  // Suspiciously uniform volume across timeframes (bot keeps steady cadence)
  // If 1h vol * 24 ≈ h24 vol within 5%, it's too perfect
  if (vol1h > 0 && vol24 > 0) {
    const projected = vol1h * 24;
    const deviation = Math.abs(projected - vol24) / vol24;
    if (deviation < 0.05 && totalTxns > 100) reasons.push("uniform vol");
  }

  // Near-100% buy ratio with huge volume = pump without organic sell pressure
  if (totalTxns > 30 && buys / totalTxns > 0.92 && vol24 > 50000) reasons.push(">92% buys");

  return { isSuspicious: reasons.length >= 2, reasons };
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

const HealthBadge = ({ score }) => {
  const { label, color, bg } = getHealthLabel(score);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ background: bg, border: `1px solid ${color}33`, borderRadius: 6, padding: "3px 8px", display: "flex", alignItems: "center", gap: 5 }}>
        <div style={{ width: 18, height: 18, borderRadius: "50%", background: `conic-gradient(${color} ${score * 3.6}deg, #1e293b ${score * 3.6}deg)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#111827" }} />
        </div>
        <span style={{ color, fontSize: 11, fontWeight: 700 }}>{score}</span>
        <span style={{ color, fontSize: 10, fontWeight: 600, opacity: 0.8 }}>{label}</span>
      </div>
    </div>
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
  const vol5m = pair.volume?.m5 || 0;
  const vol1h = pair.volume?.h1 || 0;
  const vol6h = pair.volume?.h6 || 0;
  const vol24 = pair.volume?.h24 || 0;
  const liq = pair.liquidity?.usd || 0;
  const change1h = pair.priceChange?.h1 ?? null;
  const change6h = pair.priceChange?.h6 ?? null;
  const buys24 = pair.txns?.h24?.buys || 0;
  const sells24 = pair.txns?.h24?.sells || 0;
  const age = formatAge(pair.pairCreatedAt);
  const tokenAddr = pair.baseToken?.address || "";
  // Icon sources in priority order — CDN URL always works as last resort
  const iconSources = [
    pair.icon,
    pair.info?.imageUrl,
    tokenAddr ? `https://dd.dexscreener.com/ds-data/tokens/${pair.chainId}/${tokenAddr}/icon.png` : null,
  ].filter(Boolean);
  const [iconIdx, setIconIdx] = useState(0);
  const dexUrl = pair.url || `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`;
  const healthScore = pair._healthScore ?? calculateHealthScore(pair);
  const isSuspicious = pair._isSuspicious || false;

  return (
    <a href={dexUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", color: "inherit" }}>
      <div
        style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 14, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 4, transition: "border-color 0.2s", cursor: "pointer", height: "100%" }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#334155")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#1e293b")}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flex: 1, minWidth: 0 }}>
            <div style={{ position: "relative", width: 44, height: 44, flexShrink: 0 }}>
              {iconIdx < iconSources.length && (
                <img
                  src={iconSources[iconIdx]}
                  alt={symbol}
                  style={{ width: 44, height: 44, borderRadius: "50%", border: "2px solid #ffffff15", objectFit: "cover", position: "absolute", top: 0, left: 0, zIndex: 1, background: "#111827" }}
                  onError={() => setIconIdx((i) => i + 1)}
                />
              )}
              <div style={{ width: 44, height: 44, borderRadius: "50%", background: hashColor(symbol), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, color: "#e2e8f0", border: "2px solid #ffffff15" }}>
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
              <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 2, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
              <div style={{ color: "#64748b", fontSize: 11, marginTop: 2 }}>
                Age <span style={{ color: "#94a3b8" }}>{age}</span>
                {"  "}Price <span style={{ color: "#94a3b8" }}>{pair.priceUsd ? formatPrice(parseFloat(pair.priceUsd)) : "—"}</span>
              </div>
            </div>
          </div>
          <HealthBadge score={healthScore} />
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
          <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
            {[
              { label: "5m", val: vol5m },
              { label: "1h", val: vol1h },
              { label: "6h", val: vol6h },
              { label: "24h", val: vol24 },
            ].map((v) => (
              <div key={v.label} style={{ background: "#0d1321", borderRadius: 6, padding: "3px 8px", display: "flex", flexDirection: "column", alignItems: "center", minWidth: 52 }}>
                <span style={{ color: "#475569", fontSize: 9, fontWeight: 600, letterSpacing: 0.5 }}>VOL {v.label}</span>
                <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 700 }}>{formatVolume(v.val)}</span>
              </div>
            ))}
            <div style={{ background: "#0d1321", borderRadius: 6, padding: "3px 8px", display: "flex", flexDirection: "column", alignItems: "center", minWidth: 52 }}>
              <span style={{ color: "#475569", fontSize: 9, fontWeight: 600, letterSpacing: 0.5 }}>LIQ</span>
              <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 700 }}>{formatVolume(liq)}</span>
            </div>
          </div>
        </div>

        <BuySellBar buys={buys24} sells={sells24} />

        {isSuspicious && (
          <div style={{ marginTop: 8, background: "#f8717111", border: "1px solid #f8717133", borderRadius: 6, padding: "4px 10px", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11 }}>🤖</span>
            <span style={{ color: "#f87171", fontSize: 11, fontWeight: 600 }}>Suspicious: {pair._suspiciousReasons?.join(", ")}</span>
          </div>
        )}
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
  const [sortBy, setSortBy] = useState("volume");
  const [minHealth, setMinHealth] = useState(0);
  const [hideBots, setHideBots] = useState(true);

  useEffect(() => {
    if (prices || tokens.length > 0) setLastUpdated(new Date());
  }, [prices, tokens]);

  const handleRefresh = () => {
    refetchPrices();
    refetchTokens();
  };

  // Pre-compute health scores + bot detection once per render
  const scoredTokens = tokens.map((t) => {
    const { isSuspicious, reasons } = detectSuspicious(t);
    return {
      ...t,
      _healthScore: calculateHealthScore(t),
      _isSuspicious: isSuspicious,
      _suspiciousReasons: reasons,
    };
  });

  const filteredTokens = scoredTokens
    .filter((t) => {
      if (activeChain === "Solana" && t.chainId !== "solana") return false;
      if (activeChain === "Base" && t.chainId !== "base") return false;
      if (t._healthScore < minHealth) return false;
      if (hideBots && t._isSuspicious) return false;
      return true;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case "volume": return (b.volume?.h24 || 0) - (a.volume?.h24 || 0);
        case "vol6h": return (b.volume?.h6 || 0) - (a.volume?.h6 || 0);
        case "vol1h": return (b.volume?.h1 || 0) - (a.volume?.h1 || 0);
        case "mcap": return (b.marketCap || b.fdv || 0) - (a.marketCap || a.fdv || 0);
        case "health": return b._healthScore - a._healthScore;
        case "1h": return (b.priceChange?.h1 || 0) - (a.priceChange?.h1 || 0);
        case "6h": return (b.priceChange?.h6 || 0) - (a.priceChange?.h6 || 0);
        case "newest": return (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0);
        case "liquidity": return (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0);
        default: return 0;
      }
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

      {/* Trending Tokens */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: "#f1f5f9", margin: 0 }}>🔥 Trending Tokens</h2>
          {!tokenLoading && <span style={{ background: "#6366f122", color: "#a5b4fc", border: "1px solid #6366f144", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>{filteredTokens.length}/{tokens.length}</span>}
        </div>
        <span style={{ color: "#64748b", fontSize: 12 }}>Powered by DexScreener • Click to view</span>
      </div>

      {/* Filter Bar */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16, alignItems: "center" }}>
        <span style={{ color: "#64748b", fontSize: 12, fontWeight: 600, marginRight: 4 }}>Sort:</span>
        {[
          { key: "volume", label: "Vol 24h" },
          { key: "vol6h", label: "Vol 6h" },
          { key: "vol1h", label: "Vol 1h" },
          { key: "mcap", label: "MCap" },
          { key: "health", label: "Health" },
          { key: "1h", label: "1h Chg" },
          { key: "6h", label: "6h Chg" },
          { key: "liquidity", label: "Liquidity" },
          { key: "newest", label: "Newest" },
        ].map((opt) => (
          <button
            key={opt.key}
            onClick={() => setSortBy(opt.key)}
            style={{
              padding: "5px 12px", borderRadius: 8, border: "1px solid",
              fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s",
              background: sortBy === opt.key ? "#6366f122" : "transparent",
              borderColor: sortBy === opt.key ? "#6366f1" : "#1e293b",
              color: sortBy === opt.key ? "#a5b4fc" : "#64748b",
            }}
          >{opt.label}</button>
        ))}

        <div style={{ width: 1, height: 20, background: "#1e293b", margin: "0 6px" }} />

        <button
          onClick={() => setHideBots((v) => !v)}
          style={{
            padding: "5px 12px", borderRadius: 8, border: "1px solid",
            fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s",
            background: hideBots ? "#f8717118" : "transparent",
            borderColor: hideBots ? "#f87171" : "#1e293b",
            color: hideBots ? "#f87171" : "#64748b",
          }}
        >{hideBots ? "🤖 Bots Hidden" : "🤖 Show Bots"}</button>

        <div style={{ width: 1, height: 20, background: "#1e293b", margin: "0 6px" }} />

        <span style={{ color: "#64748b", fontSize: 12, fontWeight: 600, marginRight: 4 }}>Min Health:</span>
        {[
          { value: 0, label: "All" },
          { value: 35, label: "35+" },
          { value: 55, label: "55+" },
          { value: 75, label: "75+" },
        ].map((opt) => (
          <button
            key={opt.value}
            onClick={() => setMinHealth(opt.value)}
            style={{
              padding: "5px 10px", borderRadius: 8, border: "1px solid",
              fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s",
              background: minHealth === opt.value ? "#4ade8018" : "transparent",
              borderColor: minHealth === opt.value ? "#4ade8044" : "#1e293b",
              color: minHealth === opt.value ? "#4ade80" : "#64748b",
            }}
          >{opt.label}</button>
        ))}
      </div>

      {tokenError && (
        <div style={{ background: "#7f1d1d33", border: "1px solid #991b1b", borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: "#fca5a5", fontSize: 13 }}>⚠ Token fetch failed: {tokenError}. Will retry...</div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
        {tokenLoading
          ? [1, 2, 3, 4, 5, 6].map((i) => <TokenSkeleton key={i} />)
          : filteredTokens.map((pair, i) => (
              <TokenCard key={`${pair.pairAddress}-${i}`} pair={pair} />
            ))}
      </div>

      {!tokenLoading && filteredTokens.length === 0 && !tokenError && (
        <div style={{ textAlign: "center", color: "#475569", padding: 48, fontSize: 14 }}>No trending tokens found for this chain right now.</div>
      )}

      <div style={{ textAlign: "center", color: "#334155", fontSize: 11, marginTop: 40, paddingBottom: 20 }}>
        Prices from CoinGecko • Tokens from DexScreener • Auto-refreshes every 2 min
      </div>
    </div>
  );
}

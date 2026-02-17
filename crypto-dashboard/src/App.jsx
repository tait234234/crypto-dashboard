import { useState, useEffect } from "react";

// ─── Live Price Hook ───
function useCryptoPrices() {
  const [prices, setPrices] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchPrices = async () => {
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true"
      );
      if (!res.ok) throw new Error("API request failed");
      const data = await res.json();
      setPrices(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPrices();
    const interval = setInterval(fetchPrices, 60000);
    return () => clearInterval(interval);
  }, []);

  return { prices, loading, error, refetch: fetchPrices };
}

// ─── Static launches (will be replaced with DexScreener later) ───
const newLaunches = [
  { ticker: "MOMO", chain: "SOL", name: "もも", age: "1.9h", score: 10.1, mcap: "$371.9K", vol: "$3.1M", liq: "$52.8K", change1h: "-48.5%", change6h: "+946.0%", buys: 6778, sells: 5616, tag: "Other", avatar: "🍑", avatarBg: "#2a1a2e" },
  { ticker: "LIBTARD", chain: "SOL", name: "Libtard", age: "1.0h", score: 10.1, mcap: "$276.5K", vol: "$950.5K", liq: "$42.3K", change1h: "+545.0%", change6h: "+545.0%", buys: 1770, sells: 1342, tag: "Other", avatar: "🦅", avatarBg: "#1a2a1e" },
  { ticker: "ATEAM", chain: "BASE", name: "SynthCEO ATEAM", age: "3.4h", score: 10.1, mcap: "$393.0K", vol: "$2.9M", liq: "$179.3K", change1h: "-26.3%", change6h: "+1517.0%", buys: 862, sells: 731, tag: "Other", avatar: "AT", avatarBg: "#7c3aed" },
  { ticker: "Dogs", chain: "SOL", name: "DONT TREAD ON ME", age: "1.0h", score: 10.0, mcap: "$121.7K", vol: "$389.8K", liq: "$27.6K", change1h: "+249.0%", change6h: "+249.0%", buys: 4786, sells: 3455, tag: "Other", avatar: "🐕", avatarBg: "#2a2a1e" },
  { ticker: "SELFCLAW", chain: "BASE", name: "SelfClaw", age: "3.1h", score: 10.0, mcap: "$81.3K", vol: "$829.8K", liq: "$53.2K", change1h: "-0.4%", change6h: "+880.0%", buys: 234, sells: 316, tag: "Other", avatar: "SE", avatarBg: "#dc2626" },
  { ticker: "Clav", chain: "SOL", name: "Clavicular", age: "3.0h", score: 9.9, mcap: "$47.6K", vol: "$393.6K", liq: "$17.5K", change1h: "-7.5%", change6h: "+34.5%", buys: 401, sells: 332, tag: "Other", avatar: "🦴", avatarBg: "#1e293b" },
  { ticker: "Dreamcore", chain: "SOL", name: "Dreamcore", age: "4.8h", score: 9.9, mcap: "$71.0K", vol: "$952.3K", liq: "$22.4K", change1h: "-41.6%", change6h: "+104.0%", buys: 883, sells: 650, tag: "Other", avatar: "🌙", avatarBg: "#1e1a2e" },
  { ticker: "island", chain: "SOL", name: "what's on that island", age: "2.3h", score: 9.9, mcap: "$61.9K", vol: "$237.5K", liq: "$19.5K", change1h: "+78.5%", change6h: "+78.4%", buys: 986, sells: 713, tag: "Other", avatar: "🏝️", avatarBg: "#1a2e2a" },
];

// ─── Helpers ───
function formatPrice(num) {
  if (num >= 1000) return "$" + num.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (num >= 1) return "$" + num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return "$" + num.toFixed(4);
}

function formatChange(num) {
  const sign = num >= 0 ? "+" : "";
  return sign + num.toFixed(1) + "%";
}

function formatVolume(num) {
  if (num >= 1e12) return "$" + (num / 1e12).toFixed(2) + "T";
  if (num >= 1e9) return "$" + (num / 1e9).toFixed(1) + "B";
  if (num >= 1e6) return "$" + (num / 1e6).toFixed(1) + "M";
  if (num >= 1e3) return "$" + (num / 1e3).toFixed(1) + "K";
  return "$" + num.toFixed(0);
}

// ─── Components ───
const ChainBadge = ({ chain }) => {
  const colors = { SOL: { bg: "#9945FF22", text: "#c084fc", border: "#9945FF44" }, BASE: { bg: "#0052FF22", text: "#60a5fa", border: "#0052FF44" } };
  const c = colors[chain] || colors.SOL;
  return <span style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}`, fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, letterSpacing: 0.5, fontFamily: "monospace" }}>{chain}</span>;
};

const BuySellBar = ({ buys, sells }) => {
  const total = buys + sells;
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

const PriceChange = ({ value }) => {
  const positive = value.startsWith("+");
  return <span style={{ color: positive ? "#4ade80" : "#f87171", fontSize: 13, fontWeight: 600 }}>{value}</span>;
};

const TokenCard = ({ token }) => (
  <div
    style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 14, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 4, transition: "border-color 0.2s", cursor: "pointer" }}
    onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#334155")}
    onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#1e293b")}
  >
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: token.avatarBg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: token.avatar.length <= 2 && !/\p{Emoji}/u.test(token.avatar) ? 14 : 20, fontWeight: 700, color: "#e2e8f0", border: "1px solid #ffffff11" }}>{token.avatar}</div>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 15, letterSpacing: 0.3 }}>{token.ticker}</span>
            <ChainBadge chain={token.chain} />
          </div>
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 2 }}>{token.name}</div>
          <div style={{ color: "#64748b", fontSize: 11, marginTop: 2 }}>Age <span style={{ color: "#94a3b8" }}>{token.age}</span>{"  "}Score <span style={{ color: token.score >= 10 ? "#4ade80" : "#facc15" }}>{token.score}</span></div>
        </div>
      </div>
      <span style={{ color: "#64748b", fontSize: 11, background: "#1e293b", padding: "2px 10px", borderRadius: 6, fontWeight: 500 }}>{token.tag}</span>
    </div>
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div style={{ color: "#64748b", fontSize: 11, fontWeight: 500, letterSpacing: 0.5 }}>MCAP</div>
          <div style={{ color: "#f1f5f9", fontSize: 22, fontWeight: 700, marginTop: 2 }}>{token.mcap}</div>
        </div>
        <div style={{ display: "flex", gap: 16, textAlign: "right" }}>
          <div><div style={{ color: "#64748b", fontSize: 10, marginBottom: 2 }}>1h</div><PriceChange value={token.change1h} /></div>
          <div><div style={{ color: "#64748b", fontSize: 10, marginBottom: 2 }}>6h</div><PriceChange value={token.change6h} /></div>
        </div>
      </div>
      <div style={{ color: "#64748b", fontSize: 12, marginTop: 6 }}>Vol <span style={{ color: "#94a3b8" }}>{token.vol}</span>{"   "}Liq <span style={{ color: "#94a3b8" }}>{token.liq}</span></div>
    </div>
    <BuySellBar buys={token.buys} sells={token.sells} />
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
  const { prices, loading, error, refetch } = useCryptoPrices();
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    if (prices) setLastUpdated(new Date());
  }, [prices]);

  const filteredLaunches = newLaunches.filter((t) => {
    if (activeChain === "All Chains") return true;
    if (activeChain === "Solana") return t.chain === "SOL";
    if (activeChain === "Base") return t.chain === "BASE";
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
          <button onClick={refetch} style={{ padding: "7px 14px", borderRadius: 20, border: "none", background: "transparent", color: "#94a3b8", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Refresh</button>
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

        {error && (
          <div style={{ background: "#7f1d1d33", border: "1px solid #991b1b", borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: "#fca5a5", fontSize: 13 }}>
            ⚠ Failed to fetch prices: {error}. Retrying in 60s...
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          {loading
            ? [1, 2, 3].map((i) => <PriceSkeleton key={i} />)
            : coinConfigs.map((coin) => {
                const data = prices?.[coin.id];
                const price = data?.usd || 0;
                const change = data?.usd_24h_change || 0;
                const vol = data?.usd_24h_vol || 0;
                const mcap = data?.usd_market_cap || 0;
                const positive = change >= 0;
                return (
                  <div key={coin.symbol} style={{ background: "#0d1321", border: "1px solid #1e293b", borderRadius: 12, padding: "16px 18px", transition: "border-color 0.2s" }}>
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

      {/* New Launches */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: "#f1f5f9", margin: 0 }}>New Launches</h2>
        <span style={{ color: "#64748b", fontSize: 12 }}>Tokens created in the last 24h</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
        {filteredLaunches.map((token, i) => (
          <TokenCard key={`${token.ticker}-${i}`} token={token} />
        ))}
      </div>

      {filteredLaunches.length === 0 && (
        <div style={{ textAlign: "center", color: "#475569", padding: 48, fontSize: 14 }}>No tokens found for this chain.</div>
      )}
    </div>
  );
}

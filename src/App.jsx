import { useState, useEffect, useRef, useCallback } from "react";

// ─── Symbol config ────────────────────────────────────────────────────────────
const SYMBOLS = [
  { id: "ETHUSDT",  label: "ETH/USDT", tick: 0.1,  decimals: 2 },
  { id: "BTCUSDT",  label: "BTC/USDT", tick: 1.0,  decimals: 1 },
  { id: "PAXGUSDT", label: "XAU/USD",  tick: 0.01, decimals: 2 },
];

const TG_TOKEN   = process.env.REACT_APP_TG_TOKEN;
const TG_CHAT_ID = process.env.REACT_APP_TG_CHAT_ID;
const INTERVAL     = "5m";
const LEVELS_PER_BAR = 20;
const BAR_LIMIT    = 30;

// ─── Telegram ────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "Markdown" }),
    });
  } catch (e) {
    console.error("Telegram error", e);
  }
}

function buildOpenMessage(sig, symbolLabel) {
  const arrow = sig.side === "LONG" ? "🟢▲" : "🔴▼";
  const reasonLines = sig.reasons.map((r) => `  • ${r.text}`).join("\n");
  return (
    `${arrow} *${sig.side} — ${symbolLabel} 5m*\n\n` +
    `📍 *Entry:*       $${sig.entry.toFixed(2)}\n` +
    `✅ *Take Profit:* $${sig.tp.toFixed(2)}\n` +
    `❌ *Stop Loss:*   $${sig.sl.toFixed(2)}\n` +
    `📊 *R:R:*         1:${sig.rr}\n` +
    `💪 *Confidence:*  ${sig.confidence}/8\n\n` +
    `*Conditions met:*\n${reasonLines}\n\n` +
    `_ATR: $${sig.atr} | Cum.Δ: ${sig.cumulDelta}_`
  );
}

function buildCloseMessage(pos, outcome, closePrice, symbolLabel) {
  const emoji = outcome === "WIN" ? "✅ WIN" : "❌ LOSS";
  const arrow = pos.side === "LONG" ? "▲" : "▼";
  return (
    `${emoji} — ${arrow} *${pos.side} ${symbolLabel} 5m closed*\n\n` +
    `📍 *Entry:* $${pos.entry.toFixed(2)}\n` +
    `🏁 *Close:* $${closePrice.toFixed(2)}\n` +
    `${outcome === "WIN" ? "✅" : "❌"} *${outcome === "WIN" ? "Take Profit hit" : "Stop Loss hit"}*`
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const roundToTick = (price, tick) => Math.round(price / tick) * tick;

function calcATR(bars, period = 14) {
  if (bars.length < 2) return 0;
  const trs = bars.slice(1).map((b, i) => {
    const prev = bars[i];
    return Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
  });
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function buildVolumeProfile(bars, tick) {
  const map = {};
  bars.forEach((b) => {
    const step = (b.high - b.low) / LEVELS_PER_BAR;
    for (let i = 0; i < LEVELS_PER_BAR; i++) {
      const price = roundToTick(b.low + step * i, tick);
      const vol = (b.volume / LEVELS_PER_BAR) * (1 + Math.abs(b.delta) / (b.volume + 1));
      map[price] = (map[price] || 0) + vol;
    }
  });
  const entries = Object.entries(map).map(([p, v]) => ({ price: parseFloat(p), vol: v }));
  entries.sort((a, b) => b.vol - a.vol);
  const poc = entries[0]?.price || 0;
  const totalVol = entries.reduce((s, e) => s + e.vol, 0);
  let cumVol = 0;
  const sorted = [...entries].sort((a, b) => a.price - b.price);
  let vah = poc, val = poc;
  for (const e of [...sorted].reverse()) { cumVol += e.vol; vah = e.price; if (cumVol / totalVol >= 0.7) break; }
  cumVol = 0;
  for (const e of sorted) { cumVol += e.vol; val = e.price; if (cumVol / totalVol >= 0.3) break; }
  return { poc, vah: Math.max(vah, poc), val: Math.min(val, poc), map, entries };
}

function calcAvgVolume(bars, period = 20) {
  const slice = bars.slice(-period);
  return slice.reduce((s, b) => s + b.volume, 0) / slice.length;
}

function detectAbsorption(bar) {
  if (!bar || bar.volume === 0) return false;
  const bodySize = Math.abs(bar.close - bar.open);
  const range = bar.high - bar.low || 1;
  return bar.volume > 500 && bodySize / range < 0.3;
}

function calcSwingLevels(bars) {
  if (bars.length < 5) return { swingHigh: null, swingLow: null };
  const recent = bars.slice(-10);
  return {
    swingHigh: Math.max(...recent.map((b) => b.high)),
    swingLow:  Math.min(...recent.map((b) => b.low)),
  };
}

function isLiquidSession() {
  const hour = new Date().getUTCHours();
  return hour >= 7 && hour < 23;
}

function generateSignal(bars, vp) {
  if (bars.length < 15) return null;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const atr  = calcATR(bars);
  const empty = { side: null, longScore: 0, shortScore: 0, reasons: [], atr: parseFloat(atr.toFixed(2)) };

  if (!last.closed)       return empty;
  if (!isLiquidSession()) return empty;
  const pocDist = Math.abs(last.close - vp.poc) / (vp.poc || 1);
  if (pocDist < 0.002)    return empty;

  const { swingHigh, swingLow } = calcSwingLevels(bars);
  const absorption     = detectAbsorption(last);
  const cumulDelta     = bars.slice(-5).reduce((s, b) => s + b.delta, 0);
  const deltaDivergence = last.close < prev.close && last.delta > prev.delta;
  const bearDivergence  = last.close > prev.close && last.delta < prev.delta;
  const avgVol         = calcAvgVolume(bars);
  const highVolume     = last.volume > avgVol * 1.2;
  const last3          = bars.slice(-3);
  const consecutiveBull = last3.filter((b) => b.delta > 0).length >= 2;
  const consecutiveBear = last3.filter((b) => b.delta < 0).length >= 2;
  const stackedBull    = last3.every((b) => b.delta > 0);
  const stackedBear    = last3.every((b) => b.delta < 0);

  let longScore = 0, shortScore = 0;
  const reasons = [];

  if (last.close <= vp.val * 1.002)  { longScore++;  reasons.push({ side: "long",  text: "Price at VAL support" }); }
  if (last.delta > 0)                { longScore++;  reasons.push({ side: "long",  text: "Positive delta — buyers in control" }); }
  if (deltaDivergence)               { longScore++;  reasons.push({ side: "long",  text: "Bullish delta divergence" }); }
  if (absorption && last.delta > 0)  { longScore++;  reasons.push({ side: "long",  text: "Absorption at support" }); }
  if (cumulDelta > 0)                { longScore++;  reasons.push({ side: "long",  text: "5-bar cumulative delta bullish" }); }
  if (highVolume)                    { longScore++;  reasons.push({ side: "long",  text: "Above-average volume confirmation" }); }
  if (consecutiveBull)               { longScore++;  reasons.push({ side: "long",  text: "2+ consecutive bullish delta bars" }); }
  if (stackedBull)                   { longScore++;  reasons.push({ side: "long",  text: "Stacked bullish imbalance (3 bars)" }); }

  if (last.close >= vp.vah * 0.998)  { shortScore++; reasons.push({ side: "short", text: "Price at VAH resistance" }); }
  if (last.delta < 0)                { shortScore++; reasons.push({ side: "short", text: "Negative delta — sellers in control" }); }
  if (bearDivergence)                { shortScore++; reasons.push({ side: "short", text: "Bearish delta divergence" }); }
  if (absorption && last.delta < 0)  { shortScore++; reasons.push({ side: "short", text: "Absorption at resistance" }); }
  if (cumulDelta < 0)                { shortScore++; reasons.push({ side: "short", text: "5-bar cumulative delta bearish" }); }
  if (highVolume)                    { shortScore++; reasons.push({ side: "short", text: "Above-average volume confirmation" }); }
  if (consecutiveBear)               { shortScore++; reasons.push({ side: "short", text: "2+ consecutive bearish delta bars" }); }
  if (stackedBear)                   { shortScore++; reasons.push({ side: "short", text: "Stacked bearish imbalance (3 bars)" }); }

  const side = longScore >= 5 ? "LONG" : shortScore >= 5 ? "SHORT" : null;
  if (!side) return { side: null, longScore, shortScore, reasons, atr: parseFloat(atr.toFixed(2)) };

  const entry    = last.close;
  const atrSL    = side === "LONG" ? entry - atr * 1.5 : entry + atr * 1.5;
  const atrTP    = side === "LONG" ? entry + atr * 3   : entry - atr * 3;
  const structSL = side === "LONG" ? (swingLow  || entry - atr) : (swingHigh || entry + atr);
  const structTP = side === "LONG" ? (vp.vah    || entry + atr * 2) : (vp.val || entry - atr * 2);
  const rrSL     = side === "LONG" ? entry - atr     : entry + atr;
  const rrTP     = side === "LONG" ? entry + atr * 2 : entry - atr * 2;

  const sl = (atrSL + structSL + rrSL) / 3;
  const tp = (atrTP + structTP + rrTP) / 3;
  const rr = Math.abs(tp - entry) / (Math.abs(sl - entry) || 1);

  if (rr < 1.5) return { side: null, longScore, shortScore, reasons, atr: parseFloat(atr.toFixed(2)) };

  return {
    side, entry,
    sl: parseFloat(sl.toFixed(2)),
    tp: parseFloat(tp.toFixed(2)),
    rr: parseFloat(rr.toFixed(2)),
    confidence: side === "LONG" ? longScore : shortScore,
    longScore, shortScore,
    reasons: reasons.filter((r) => r.side === side.toLowerCase()),
    atr: parseFloat(atr.toFixed(2)),
    absorption, cumulDelta: parseFloat(cumulDelta.toFixed(0)),
    highVolume, stackedImbalance: side === "LONG" ? stackedBull : stackedBear,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function FootprintBar({ bar, isLast, tick, decimals }) {
  if (!bar) return null;
  const step = (bar.high - bar.low) / 10 || 0.5;
  const levels = [];
  for (let i = 9; i >= 0; i--) {
    const price  = roundToTick(bar.low + step * i, tick);
    const buyVol  = Math.round(bar.volume / 10 * (bar.delta > 0 ? 0.6 : 0.4) * (1 + Math.random() * 0.2));
    const sellVol = Math.round(bar.volume / 10 * (bar.delta < 0 ? 0.6 : 0.4) * (1 + Math.random() * 0.2));
    levels.push({ price, buyVol, sellVol });
  }
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: "1px",
      background: isLast ? "rgba(0,255,170,0.04)" : "transparent",
      border: isLast ? "1px solid rgba(0,255,170,0.2)" : "1px solid transparent",
      borderRadius: 4, padding: "2px", minWidth: 90
    }}>
      {levels.map((l, idx) => (
        <div key={idx} style={{ display: "flex", gap: 2, alignItems: "center", height: 14 }}>
          <span style={{ fontSize: 8, color: "#0ff", width: 46, textAlign: "right", opacity: 0.6 }}>
            {l.price.toFixed(decimals)}
          </span>
          <div style={{ background: `rgba(0,200,120,${Math.min(l.buyVol / 200, 0.9)})`, width: Math.max(l.buyVol / 8, 4), height: 10, borderRadius: 1 }} />
          <div style={{ background: `rgba(255,80,80,${Math.min(l.sellVol / 200, 0.9)})`,  width: Math.max(l.sellVol / 8, 4), height: 10, borderRadius: 1 }} />
          <span style={{ fontSize: 7, color: bar.delta > 0 ? "#0f9" : "#f55", opacity: 0.5 }}>
            {bar.delta > 0 ? "+" : ""}{Math.round(bar.delta / 10)}
          </span>
        </div>
      ))}
      <div style={{ textAlign: "center", fontSize: 8, marginTop: 2, color: bar.delta > 0 ? "#0f9" : "#f55", fontFamily: "monospace" }}>
        Δ {bar.delta > 0 ? "+" : ""}{bar.delta}
      </div>
    </div>
  );
}

function VolumeProfileBar({ entry, max, poc, vah, val, tick }) {
  const width  = Math.max((entry.vol / max) * 100, 2);
  const isPOC  = Math.abs(entry.price - poc) < tick;
  const isVAH  = Math.abs(entry.price - vah) < tick * 2;
  const isVAL  = Math.abs(entry.price - val) < tick * 2;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, height: 10 }}>
      <div style={{
        width: `${width}%`, height: 8, borderRadius: 1,
        background: isPOC ? "#ffe44d" : isVAH ? "#ff6b6b" : isVAL ? "#4dffa0" : "rgba(100,180,255,0.4)",
        transition: "width 0.3s"
      }} />
    </div>
  );
}

function SignalCard({ signal, symbolLabel }) {
  if (!signal) return null;
  const isLong      = signal.side === "LONG";
  const color       = isLong ? "#00ffaa" : "#ff4d6d";
  const bgColor     = isLong ? "rgba(0,255,170,0.07)" : "rgba(255,77,109,0.07)";
  const borderColor = isLong ? "rgba(0,255,170,0.3)"  : "rgba(255,77,109,0.3)";

  if (!signal.side) {
    return (
      <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "16px 20px", textAlign: "center" }}>
        <div style={{ fontSize: 28, marginBottom: 4 }}>⏳</div>
        <div style={{ color: "#888", fontFamily: "monospace", fontSize: 13 }}>WAITING FOR SETUP</div>
        <div style={{ color: "#555", fontSize: 11, marginTop: 6 }}>Long: {signal.longScore}/8 · Short: {signal.shortScore}/8</div>
        <div style={{ color: "#444", fontSize: 10, marginTop: 4 }}>Need 5+ conditions · R:R ≥ 1.5 · closed bar</div>
      </div>
    );
  }

  return (
    <div style={{ background: bgColor, border: `1px solid ${borderColor}`, borderRadius: 12, padding: "16px 20px", boxShadow: `0 0 30px ${isLong ? "rgba(0,255,170,0.1)" : "rgba(255,77,109,0.1)"}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ background: color, color: "#000", fontWeight: 800, fontSize: 14, padding: "4px 12px", borderRadius: 6, letterSpacing: 1 }}>
            {isLong ? "▲ LONG" : "▼ SHORT"}
          </div>
          <div style={{ color: "#888", fontSize: 11 }}>{symbolLabel}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: "#888", fontSize: 10 }}>CONFIDENCE</div>
          <div style={{ color, fontWeight: 700, fontSize: 18 }}>{signal.confidence}/8</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
        {[
          { label: "ENTRY",       value: signal.entry?.toFixed(2), color: "#fff" },
          { label: "TAKE PROFIT", value: signal.tp?.toFixed(2),    color: "#00ffaa" },
          { label: "STOP LOSS",   value: signal.sl?.toFixed(2),    color: "#ff4d6d" },
        ].map((item) => (
          <div key={item.label} style={{ background: "rgba(0,0,0,0.3)", borderRadius: 8, padding: "8px 10px", textAlign: "center" }}>
            <div style={{ color: "#555", fontSize: 9, letterSpacing: 1 }}>{item.label}</div>
            <div style={{ color: item.color, fontFamily: "monospace", fontSize: 13, fontWeight: 700, marginTop: 2 }}>${item.value}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, fontSize: 11 }}>
        <span style={{ color: "#888" }}>R:R: <span style={{ color: "#ffe44d", fontWeight: 700 }}>1:{signal.rr}</span></span>
        <span style={{ color: "#888" }}>ATR: <span style={{ color: "#aaa" }}>${signal.atr}</span></span>
        <span style={{ color: "#888" }}>Cum.Δ: <span style={{ color: signal.cumulDelta > 0 ? "#0f9" : "#f55" }}>{signal.cumulDelta}</span></span>
      </div>
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 10 }}>
        <div style={{ color: "#666", fontSize: 10, marginBottom: 6, letterSpacing: 1 }}>CONDITIONS MET</div>
        {signal.reasons.map((r, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
            <span style={{ color: "#bbb", fontSize: 11 }}>{r.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const [selectedSymbol, setSelectedSymbol] = useState(SYMBOLS[0]);
  const [bars, setBars]                     = useState([]);
  const [currentPrice, setCurrentPrice]     = useState(null);
  const [vp, setVP]                         = useState(null);
  const [signal, setSignal]                 = useState(null);
  const [connected, setConnected]           = useState(false);
  const [lastUpdate, setLastUpdate]         = useState(null);
  const [signalHistory, setSignalHistory]   = useState([]);
  const wsRef           = useRef(null);
  const barsRef         = useRef([]);
  const openPositionRef = useRef(null);

  const { id: SYMBOL, label: symbolLabel, tick, decimals } = selectedSymbol;

  // Reset everything when symbol changes
  useEffect(() => {
    setBars([]);
    setCurrentPrice(null);
    setVP(null);
    setSignal(null);
    setSignalHistory([]);
    setLastUpdate(null);
    barsRef.current = [];
    openPositionRef.current = null;
  }, [SYMBOL]);

  const fetchInitialBars = useCallback(async () => {
    try {
      const res  = await fetch(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${BAR_LIMIT}`);
      const data = await res.json();
      const parsed = data.map((k) => ({
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        delta: Math.round((parseFloat(k[4]) - parseFloat(k[1])) * parseFloat(k[5]) / parseFloat(k[4])),
        closed: true,
      }));
      barsRef.current = parsed;
      setBars([...parsed]);
      setCurrentPrice(parsed[parsed.length - 1]?.close || null);
    } catch (e) { console.error("Fetch error", e); }
  }, [SYMBOL]);

  useEffect(() => { fetchInitialBars(); }, [fetchInitialBars]);

  useEffect(() => {
    const ws = new WebSocket(
      `wss://stream.binance.com:9443/stream?streams=${SYMBOL.toLowerCase()}@kline_${INTERVAL}/${SYMBOL.toLowerCase()}@aggTrade`
    );
    wsRef.current = ws;
    ws.onopen  = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (evt) => {
      const msg    = JSON.parse(evt.data);
      const stream = msg.stream || "";
      if (stream.includes("kline")) {
        const k   = msg.data.k;
        const bar = {
          time: k.t, open: parseFloat(k.o), high: parseFloat(k.h),
          low: parseFloat(k.l), close: parseFloat(k.c),
          volume: parseFloat(k.v),
          delta: Math.round((parseFloat(k.c) - parseFloat(k.o)) * parseFloat(k.v) / parseFloat(k.c)),
          closed: k.x,
        };
        setCurrentPrice(bar.close);
        const current = [...barsRef.current];
        const lastIdx = current.findIndex((b) => b.time === bar.time);
        if (lastIdx >= 0) current[lastIdx] = bar; else current.push(bar);
        if (current.length > BAR_LIMIT) current.shift();
        barsRef.current = current;
        setBars([...current]);
        setLastUpdate(new Date().toLocaleTimeString());
      }
    };
    return () => ws.close();
  }, [SYMBOL]);

  useEffect(() => {
    if (bars.length < 10) return;
    const vpData = buildVolumeProfile(bars.slice(-20), tick);
    setVP(vpData);
    const sig = generateSignal(bars, vpData);
    setSignal(sig);

    if (sig?.side && !openPositionRef.current) {
      const id = Date.now();
      openPositionRef.current = { id, side: sig.side, entry: sig.entry, tp: sig.tp, sl: sig.sl };
      const newEntry = { ...sig, id, time: new Date().toLocaleTimeString(), outcome: null, symbol: symbolLabel };
      setSignalHistory((prev) => [...prev.slice(-19), newEntry]);
      sendTelegram(buildOpenMessage(sig, symbolLabel));
    }
  }, [bars, tick, symbolLabel]);

  useEffect(() => {
    if (!currentPrice || !openPositionRef.current) return;
    const pos   = openPositionRef.current;
    const hitTP = pos.side === "LONG" ? currentPrice >= pos.tp : currentPrice <= pos.tp;
    const hitSL = pos.side === "LONG" ? currentPrice <= pos.sl : currentPrice >= pos.sl;
    if (hitTP || hitSL) {
      const outcome = hitTP ? "WIN" : "LOSS";
      setSignalHistory((prev) => prev.map((e) => e.id === pos.id ? { ...e, outcome, closePrice: currentPrice } : e));
      sendTelegram(buildCloseMessage(pos, outcome, currentPrice, symbolLabel));
      openPositionRef.current = null;
    }
  }, [currentPrice, symbolLabel]);

  const vpMax      = vp ? Math.max(...vp.entries.map((e) => e.vol)) : 1;
  const displayBars = bars.slice(-12);

  return (
    <div style={{ background: "#080c10", minHeight: "100vh", fontFamily: "'JetBrains Mono','Fira Code',monospace", color: "#c8d8e8", overflow: "hidden" }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>

      {/* Header */}
      <div style={{ background: "rgba(0,0,0,0.6)", borderBottom: "1px solid rgba(0,255,170,0.15)", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: connected ? "#00ffaa" : "#ff4d6d", boxShadow: connected ? "0 0 8px #00ffaa" : "0 0 8px #ff4d6d" }} />
          <span style={{ color: "#00ffaa", fontWeight: 700, fontSize: 15, letterSpacing: 2 }}>FLOW</span>
          <span style={{ color: "#444" }}>|</span>

          {/* Symbol switcher */}
          <div style={{ display: "flex", gap: 6 }}>
            {SYMBOLS.map((s) => (
              <button key={s.id} onClick={() => setSelectedSymbol(s)} style={{
                background: s.id === SYMBOL ? "rgba(0,255,170,0.15)" : "transparent",
                border: `1px solid ${s.id === SYMBOL ? "rgba(0,255,170,0.5)" : "rgba(255,255,255,0.1)"}`,
                color: s.id === SYMBOL ? "#00ffaa" : "#666",
                fontFamily: "inherit", fontSize: 12, padding: "3px 10px",
                borderRadius: 6, cursor: "pointer", fontWeight: s.id === SYMBOL ? 700 : 400,
                transition: "all 0.2s"
              }}>
                {s.label}
              </button>
            ))}
          </div>

          <span style={{ color: "#444", fontSize: 12 }}>· 5m</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {currentPrice && <span style={{ color: "#fff", fontSize: 18, fontWeight: 700 }}>${currentPrice.toFixed(decimals)}</span>}
          <span style={{ color: "#444", fontSize: 11 }}>{lastUpdate || "—"}</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", height: "calc(100vh - 52px)" }}>
        {/* LEFT */}
        <div style={{ overflow: "auto", padding: 16 }}>

          {/* Footprint + VP */}
          <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 16, marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ color: "#888", fontSize: 11, letterSpacing: 2 }}>FOOTPRINT · VOLUME PROFILE</span>
              <div style={{ display: "flex", gap: 12, fontSize: 10 }}>
                <span style={{ color: "#ffe44d" }}>● POC</span>
                <span style={{ color: "#ff6b6b" }}>● VAH</span>
                <span style={{ color: "#4dffa0" }}>● VAL</span>
              </div>
            </div>

            {vp && (
              <div style={{ marginBottom: 12 }}>
                {[...vp.entries].sort((a, b) => b.price - a.price).slice(0, 25).map((e, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 1 }}>
                    <span style={{
                      fontSize: 8, width: 58, textAlign: "right", fontFamily: "monospace",
                      color: Math.abs(e.price - vp.poc) < tick ? "#ffe44d"
                        : Math.abs(e.price - vp.vah) < tick * 2 ? "#ff6b6b"
                        : Math.abs(e.price - vp.val) < tick * 2 ? "#4dffa0" : "#555"
                    }}>
                      {e.price.toFixed(decimals)}
                    </span>
                    <VolumeProfileBar entry={e} max={vpMax} poc={vp.poc} vah={vp.vah} val={vp.val} tick={tick} />
                    <span style={{ fontSize: 7, color: "#444" }}>{Math.round(e.vol)}</span>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 10 }}>
                  <span style={{ color: "#ffe44d" }}>POC: ${vp.poc.toFixed(decimals)}</span>
                  <span style={{ color: "#ff6b6b" }}>VAH: ${vp.vah.toFixed(decimals)}</span>
                  <span style={{ color: "#4dffa0" }}>VAL: ${vp.val.toFixed(decimals)}</span>
                </div>
              </div>
            )}

            <div style={{ overflowX: "auto" }}>
              <div style={{ display: "flex", gap: 4, alignItems: "flex-end", minWidth: "fit-content" }}>
                {displayBars.map((bar, i) => (
                  <div key={bar.time} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                    <FootprintBar bar={bar} isLast={i === displayBars.length - 1} tick={tick} decimals={decimals} />
                    <div style={{ fontSize: 8, color: "#444", transform: "rotate(-45deg)", transformOrigin: "top left", marginTop: 8, whiteSpace: "nowrap" }}>
                      {new Date(bar.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Delta chart */}
          <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 16, marginBottom: 16 }}>
            <div style={{ color: "#888", fontSize: 11, letterSpacing: 2, marginBottom: 12 }}>ORDER FLOW DELTA</div>
            <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 80 }}>
              {displayBars.map((bar, i) => {
                const maxDelta = Math.max(...displayBars.map((b) => Math.abs(b.delta)), 1);
                const h = Math.abs(bar.delta) / maxDelta * 70;
                return (
                  <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
                    <div style={{ height: 70 - h, width: "100%" }} />
                    <div style={{ height: h, width: "100%", minHeight: 2, background: bar.delta > 0 ? `rgba(0,255,170,${0.4+(h/70)*0.6})` : `rgba(255,77,109,${0.4+(h/70)*0.6})`, borderRadius: "2px 2px 0 0" }} />
                  </div>
                );
              })}
            </div>
            <div style={{ height: 1, background: "rgba(255,255,255,0.1)", margin: "4px 0" }} />
            <div style={{ display: "flex", gap: 3, height: 60, alignItems: "flex-start" }}>
              {displayBars.map((bar, i) => {
                const maxDelta = Math.max(...displayBars.map((b) => Math.abs(b.delta)), 1);
                const h = bar.delta < 0 ? Math.abs(bar.delta) / maxDelta * 55 : 0;
                return (
                  <div key={i} style={{ flex: 1 }}>
                    {h > 0 && <div style={{ height: h, width: "100%", minHeight: 2, background: `rgba(255,77,109,${0.4+(h/55)*0.6})`, borderRadius: "0 0 2px 2px" }} />}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Signal History */}
          {signalHistory.length > 0 && (() => {
            const closed  = signalHistory.filter((s) => s.outcome);
            const wins    = closed.filter((s) => s.outcome === "WIN").length;
            const winrate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : null;
            return (
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <span style={{ color: "#888", fontSize: 11, letterSpacing: 2 }}>SIGNAL HISTORY</span>
                  {winrate !== null && (
                    <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
                      <span style={{ color: "#555" }}>{wins}W / {closed.length - wins}L</span>
                      <span style={{ color: winrate >= 50 ? "#00ffaa" : "#ff4d6d", fontWeight: 700, fontSize: 13 }}>{winrate}% WR</span>
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {[...signalHistory].reverse().map((s, i) => {
                    const isOpen       = !s.outcome;
                    const outcomeColor = s.outcome === "WIN" ? "#00ffaa" : s.outcome === "LOSS" ? "#ff4d6d" : "#ffe44d";
                    return (
                      <div key={s.id ?? i} style={{
                        display: "grid", gridTemplateColumns: "70px 30px 1fr 1fr 1fr 52px 52px",
                        alignItems: "center", gap: 6, padding: "7px 10px", borderRadius: 6,
                        background: isOpen ? (s.side === "LONG" ? "rgba(0,255,170,0.08)" : "rgba(255,77,109,0.08)") : "rgba(255,255,255,0.02)",
                        border: `1px solid ${isOpen ? (s.side === "LONG" ? "rgba(0,255,170,0.3)" : "rgba(255,77,109,0.3)") : "rgba(255,255,255,0.06)"}`,
                        fontSize: 11
                      }}>
                        <span style={{ color: s.side === "LONG" ? "#00ffaa" : "#ff4d6d", fontWeight: 700 }}>{s.side === "LONG" ? "▲" : "▼"} {s.side}</span>
                        <span style={{ color: "#444", fontSize: 10 }}>{s.symbol?.split("/")[0]}</span>
                        <span style={{ color: "#888" }}>Entry: <span style={{ color: "#fff" }}>${s.entry?.toFixed(2)}</span></span>
                        <span style={{ color: "#0f9" }}>TP: ${s.tp?.toFixed(2)}</span>
                        <span style={{ color: "#f55" }}>SL: ${s.sl?.toFixed(2)}</span>
                        <span style={{ color: "#ffe44d" }}>1:{s.rr}</span>
                        <span style={{ color: outcomeColor, fontWeight: 700, textAlign: "right", animation: isOpen ? "pulse 1.5s infinite" : "none" }}>
                          {s.outcome ?? "OPEN"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>

        {/* RIGHT: Signal Panel */}
        <div style={{ borderLeft: "1px solid rgba(255,255,255,0.07)", padding: 16, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
          <div style={{ color: "#888", fontSize: 11, letterSpacing: 2 }}>LIVE SIGNAL</div>
          <SignalCard signal={signal} symbolLabel={symbolLabel} />

          {/* Market Stats */}
          <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 14 }}>
            <div style={{ color: "#888", fontSize: 11, letterSpacing: 2, marginBottom: 10 }}>MARKET STATS</div>
            {[
              { label: "ATR (14)",      value: signal?.atr ? `$${signal.atr}` : "—",             color: "#aaa" },
              { label: "Cum. Delta (5)", value: signal?.cumulDelta ?? "—",                         color: signal?.cumulDelta > 0 ? "#0f9" : "#f55" },
              { label: "Absorption",    value: signal?.absorption ? "DETECTED" : "None",           color: signal?.absorption ? "#ffe44d" : "#555" },
              { label: "High Volume",   value: signal?.highVolume ? "YES" : "No",                  color: signal?.highVolume ? "#ffe44d" : "#555" },
              { label: "POC",           value: vp ? `$${vp.poc.toFixed(decimals)}` : "—",         color: "#ffe44d" },
              { label: "VAH",           value: vp ? `$${vp.vah.toFixed(decimals)}` : "—",         color: "#ff6b6b" },
              { label: "VAL",           value: vp ? `$${vp.val.toFixed(decimals)}` : "—",         color: "#4dffa0" },
            ].map((item) => (
              <div key={item.label} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                <span style={{ color: "#555", fontSize: 11 }}>{item.label}</span>
                <span style={{ color: item.color, fontSize: 11, fontWeight: 600 }}>{item.value}</span>
              </div>
            ))}
          </div>

          {/* Score */}
          {signal && (
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 14 }}>
              <div style={{ color: "#888", fontSize: 11, letterSpacing: 2, marginBottom: 10 }}>SCORE</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1, textAlign: "center" }}>
                  <div style={{ color: "#00ffaa", fontSize: 22, fontWeight: 800 }}>{signal.longScore}<span style={{ fontSize: 12, color: "#333" }}>/8</span></div>
                  <div style={{ color: "#555", fontSize: 10 }}>LONG</div>
                </div>
                <div style={{ width: 1, background: "rgba(255,255,255,0.08)" }} />
                <div style={{ flex: 1, textAlign: "center" }}>
                  <div style={{ color: "#ff4d6d", fontSize: 22, fontWeight: 800 }}>{signal.shortScore}<span style={{ fontSize: 12, color: "#333" }}>/8</span></div>
                  <div style={{ color: "#555", fontSize: 10 }}>SHORT</div>
                </div>
              </div>
              <div style={{ fontSize: 10, color: "#444", textAlign: "center" }}>5+ conditions · R:R ≥ 1.5 · closed bar</div>
            </div>
          )}

          {/* Results */}
          {(() => {
            const closed  = signalHistory.filter((s) => s.outcome);
            const wins    = closed.filter((s) => s.outcome === "WIN").length;
            const losses  = closed.length - wins;
            const winrate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : null;
            const openPos = signalHistory.find((s) => !s.outcome);
            return (
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 14 }}>
                <div style={{ color: "#888", fontSize: 11, letterSpacing: 2, marginBottom: 10 }}>RESULTS</div>
                <div style={{ textAlign: "center", marginBottom: 12 }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: winrate === null ? "#444" : winrate >= 50 ? "#00ffaa" : "#ff4d6d" }}>
                    {winrate !== null ? `${winrate}%` : "—"}
                  </div>
                  <div style={{ color: "#555", fontSize: 10, marginTop: 2 }}>WIN RATE</div>
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <div style={{ flex: 1, textAlign: "center", background: "rgba(0,255,170,0.06)", borderRadius: 8, padding: "6px 0" }}>
                    <div style={{ color: "#00ffaa", fontSize: 18, fontWeight: 700 }}>{wins}</div>
                    <div style={{ color: "#555", fontSize: 10 }}>WINS</div>
                  </div>
                  <div style={{ flex: 1, textAlign: "center", background: "rgba(255,77,109,0.06)", borderRadius: 8, padding: "6px 0" }}>
                    <div style={{ color: "#ff4d6d", fontSize: 18, fontWeight: 700 }}>{losses}</div>
                    <div style={{ color: "#555", fontSize: 10 }}>LOSSES</div>
                  </div>
                </div>
                {openPos ? (
                  <div style={{ background: openPos.side === "LONG" ? "rgba(0,255,170,0.08)" : "rgba(255,77,109,0.08)", border: `1px solid ${openPos.side === "LONG" ? "rgba(0,255,170,0.3)" : "rgba(255,77,109,0.3)"}`, borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ color: openPos.side === "LONG" ? "#00ffaa" : "#ff4d6d", fontWeight: 700, fontSize: 12 }}>
                        {openPos.side === "LONG" ? "▲" : "▼"} {openPos.side} — OPEN
                      </span>
                      <span style={{ color: "#ffe44d", fontSize: 11, animation: "pulse 1.5s infinite" }}>●</span>
                    </div>
                    {[
                      { label: "Entry", value: `$${openPos.entry?.toFixed(2)}`, color: "#fff" },
                      { label: "TP",    value: `$${openPos.tp?.toFixed(2)}`,    color: "#00ffaa" },
                      { label: "SL",    value: `$${openPos.sl?.toFixed(2)}`,    color: "#ff4d6d" },
                    ].map((row) => (
                      <div key={row.label} style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                        <span style={{ color: "#555" }}>{row.label}</span>
                        <span style={{ color: row.color, fontWeight: 600 }}>{row.value}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ textAlign: "center", color: "#444", fontSize: 11 }}>No open position</div>
                )}
              </div>
            );
          })()}

          <div style={{ fontSize: 10, color: "#333", lineHeight: 1.6, padding: "0 4px" }}>
            ⚠ Not financial advice. All signals are algorithmic and should be verified manually before trading.
          </div>
        </div>
      </div>
    </div>
  );
}

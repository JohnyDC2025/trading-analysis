// daily-screener.mjs
// Análise diária: Yahoo Finance (OHLCV + indicadores) + TradingView Screener (rating)
// Corre via GitHub Actions — gera report.html com o top 15

import { writeFileSync, readFileSync } from 'fs';

const WATCHLIST = JSON.parse(readFileSync('./watchlist.json', 'utf8'));
const REPORT_PATH = './report.html';

// ─── Helpers técnicos ─────────────────────────────────────────────────────────
function ema(src, p) {
  const k = 2 / (p + 1); let v = src[0]; const o = [v];
  for (let i = 1; i < src.length; i++) { v = src[i] * k + v * (1 - k); o.push(v); }
  return o;
}
function rsi(src, p) {
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = src[i] - src[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / p, al = l / p;
  const o = new Array(p).fill(null);
  o.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  for (let i = p + 1; i < src.length; i++) {
    const d = src[i] - src[i - 1], gi = d > 0 ? d : 0, li = d < 0 ? -d : 0;
    ag = (ag * (p - 1) + gi) / p; al = (al * (p - 1) + li) / p;
    o.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return o;
}
function macd(src) {
  const fast = ema(src, 12), slow = ema(src, 26);
  const line = fast.map((v, i) => v - slow[i]);
  const signal = ema(line, 9);
  return { line, signal, hist: line.map((v, i) => v - signal[i]) };
}
function bb(src, p, m) {
  return src.map((_, i) => {
    if (i < p - 1) return null;
    const sl = src.slice(i - p + 1, i + 1);
    const mn = sl.reduce((a, b) => a + b, 0) / p;
    const sd = Math.sqrt(sl.reduce((a, b) => a + (b - mn) ** 2, 0) / p);
    return { upper: mn + m * sd, mid: mn, lower: mn - m * sd };
  });
}
function atrFn(h, l, c, p) {
  const tr = [h[0] - l[0]];
  for (let i = 1; i < h.length; i++)
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  let v = tr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const o = new Array(p - 1).fill(null); o.push(v);
  for (let i = p; i < tr.length; i++) { v = (v * (p - 1) + tr[i]) / p; o.push(v); }
  return o;
}
function stoch(h, l, c, kp, dp) {
  const k = c.map((_, i) => {
    if (i < kp - 1) return null;
    const hh = Math.max(...h.slice(i - kp + 1, i + 1)), ll = Math.min(...l.slice(i - kp + 1, i + 1));
    return hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100;
  });
  const d = k.map((_, i) => {
    if (i < kp + dp - 2) return null;
    const sl = k.slice(i - dp + 1, i + 1).filter(x => x !== null);
    return sl.length === dp ? sl.reduce((a, b) => a + b, 0) / dp : null;
  });
  return { k, d };
}
function adxFn(h, l, c, p) {
  const tr = [], pdm = [], ndm = [];
  for (let i = 1; i < h.length; i++) {
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    pdm.push(Math.max(h[i] - h[i - 1], 0) > Math.max(l[i - 1] - l[i], 0) ? Math.max(h[i] - h[i - 1], 0) : 0);
    ndm.push(Math.max(l[i - 1] - l[i], 0) > Math.max(h[i] - h[i - 1], 0) ? Math.max(l[i - 1] - l[i], 0) : 0);
  }
  function sm(a, p) { let s = a.slice(0, p).reduce((x, y) => x + y, 0); const o = [s]; for (let i = p; i < a.length; i++) { s = s - s / p + a[i]; o.push(s); } return o; }
  const a14 = sm(tr, p), sp = sm(pdm, p), sn = sm(ndm, p);
  const pdi = sp.map((v, i) => v / a14[i] * 100), ndi = sn.map((v, i) => v / a14[i] * 100);
  const dx = pdi.map((v, i) => Math.abs(v - ndi[i]) / (v + ndi[i]) * 100);
  return { pdi, ndi, adx: ema(dx, p) };
}

// ─── Análise técnica ──────────────────────────────────────────────────────────
function buildAnalysis(stock, bars) {
  const C = bars.map(b => b.close), H = bars.map(b => b.high), L = bars.map(b => b.low), V = bars.map(b => b.volume);
  const n = C.length, i = n - 1;
  const e9 = ema(C, 9), e21 = ema(C, 21), e50 = ema(C, 50), e100 = ema(C, 100), e200 = ema(C, 200);
  const r = rsi(C, 14), m = macd(C), bl = bb(C, 20, 2), a = atrFn(H, L, C, 14), st = stoch(H, L, C, 14, 3), adx = adxFn(H, L, C, 14);
  const ai = adx.adx.length - 1;
  const bLast = bl[i];
  const avgVol = V.slice(-20).reduce((a, b) => a + b, 0) / 20;

  const rsiVal = r[i];
  const bbPos = (C[i] - bLast.lower) / (bLast.upper - bLast.lower) * 100;
  const rsiSig = rsiVal > 70 ? 'overbought' : rsiVal < 30 ? 'oversold' : rsiVal >= 50 ? 'bullish_zone' : 'bearish_zone';
  const bbSig  = bbPos > 80 ? 'overbought' : bbPos < 20 ? 'oversold' : 'normal';
  const macdTrend  = m.hist[i] > m.hist[i - 1] ? 'improving' : 'deteriorating';
  const macdCross  = m.line[i] > m.signal[i] ? 'bullish' : 'bearish';
  const priceAbove = C[i] > e9[i] && C[i] > e21[i] && C[i] > e50[i] && C[i] > e100[i] && C[i] > e200[i];
  const bullAlign  = e9[i] > e21[i] && e21[i] > e50[i] && e50[i] > e100[i] && e100[i] > e200[i];
  const dominant   = adx.pdi[ai] > adx.ndi[ai] ? 'buyers' : 'sellers';
  const stochK     = st.k[i] ?? 0;
  const week2Pct   = (C[i] - C[i - 10]) / C[i - 10] * 100;

  let score = 0, signals = [];
  if (rsiSig === 'bullish_zone') { score += 2; signals.push('RSI zona bullish'); }
  if (rsiSig === 'oversold')     { score += 2; signals.push('RSI sobrevendido'); }
  if (macdTrend === 'improving') { score += 2; signals.push('MACD a melhorar'); }
  if (macdCross === 'bullish')   { score += 1; signals.push('MACD bullish'); }
  if (priceAbove)                { score += 2; signals.push('Acima de todas as EMAs'); }
  if (bullAlign)                 { score += 1; signals.push('EMAs alinhadas'); }
  if (dominant === 'buyers')     { score += 1; signals.push('Compradores dominantes'); }
  if (bbSig === 'oversold')      { score += 2; signals.push('BB sobrevendido'); }
  if (rsiSig === 'overbought')   { score -= 2; signals.push('RSI sobrecomprado'); }
  if (bbSig === 'overbought')    { score -= 1; signals.push('BB sobrecomprado'); }
  if (stochK > 80)               { score -= 1; signals.push('Stoch sobrecomprado'); }
  if (week2Pct < -3)             { score -= 1; signals.push('Tendência baixa 2sem'); }

  return {
    symbol: stock.symbol,
    name: stock.name,
    sector: stock.sector,
    price: {
      current: C[i],
      change_pct: +((C[i] - C[i - 1]) / C[i - 1] * 100).toFixed(2)
    },
    rsi: +rsiVal.toFixed(1),
    volume_ratio: +(V[i] / avgVol).toFixed(2),
    composite: { score, signals }
  };
}

// ─── Yahoo Finance OHLCV ──────────────────────────────────────────────────────
async function fetchBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  const res = json.chart.result[0];
  const ts = res.timestamp, q = res.indicators.quote[0];
  const raw = ts.map((t, i) => ({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] ?? 0 }));
  const clean = raw.filter(b =>
    b.close != null && b.close > 0 && b.high != null && b.low != null &&
    b.high >= b.low && b.high >= b.close && b.low <= b.close
  );
  clean.sort((a, b) => a.time - b.time);
  return clean.slice(-300);
}

// ─── TradingView Screener ─────────────────────────────────────────────────────
async function fetchTVScreener(stocks) {
  const tickers = stocks.map(s => s.tv);
  const columns = [
    'close', 'change', 'RSI', 'MACD.macd', 'MACD.signal',
    'EMA50', 'EMA200', 'Recommend.All', 'Recommend.MA', 'Recommend.Other',
    'volume', 'relative_volume_10d_calc', 'market_cap_basic'
  ];
  const resp = await fetch('https://scanner.tradingview.com/global/scan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      'Origin': 'https://www.tradingview.com',
      'Referer': 'https://www.tradingview.com/'
    },
    body: JSON.stringify({ symbols: { tickers }, columns })
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  const map = {};
  for (const item of (json.data || [])) {
    const vals = {};
    columns.forEach((col, i) => { vals[col] = item.d[i]; });
    map[item.s] = vals;
  }
  return map;
}

// ─── Labels e cores ───────────────────────────────────────────────────────────
function tvLabel(val) {
  if (val == null)  return { text: 'N/D',         color: '#999999' };
  if (val >= 0.5)   return { text: '🟢 Forte Compra', color: '#00897b' };
  if (val >= 0.1)   return { text: '🟩 Compra',   color: '#43a047' };
  if (val > -0.1)   return { text: '⚪ Neutro',   color: '#fb8c00' };
  if (val > -0.5)   return { text: '🟥 Venda',    color: '#e53935' };
  return               { text: '🔴 Forte Venda', color: '#b71c1c' };
}
function combinedLabel(score) {
  if (score >= 10)  return { text: '🟢 Forte Compra', color: '#00897b', bg: '#e0f2f1' };
  if (score >= 6)   return { text: '🟡 Compra',       color: '#558b2f', bg: '#f1f8e9' };
  if (score >= 2)   return { text: '⚪ Neutro',       color: '#e65100', bg: '#fff3e0' };
  return               { text: '🔴 Evitar',           color: '#c62828', bg: '#ffebee' };
}

// ─── HTML do email ─────────────────────────────────────────────────────────────
function generateHTML(top15, dateStr, totalAnalyzed) {
  const rows = top15.map((r, idx) => {
    const tv   = tvLabel(r.tvRecommend);
    const verd = combinedLabel(r.combined);
    const chgColor = r.price.change_pct >= 0 ? '#2e7d32' : '#c62828';
    const chgSign  = r.price.change_pct >= 0 ? '+' : '';
    const topSignals = r.composite.signals.slice(0, 3).join(' · ') || '—';
    const volStyle = r.volume_ratio >= 1.5 ? 'font-weight:bold; color:#1565c0;' : 'color:#555;';

    return `
    <tr style="border-bottom:1px solid #e0e0e0; background:${idx % 2 === 0 ? '#fafafa' : '#fff'};">
      <td style="padding:9px 10px; text-align:center; font-weight:bold; color:#1565c0; font-size:15px;">${idx + 1}</td>
      <td style="padding:9px 10px;">
        <div style="font-weight:bold; font-size:14px; color:#212121;">${r.symbol}</div>
        <div style="font-size:11px; color:#555; margin-top:1px;">${r.name}</div>
        <div style="font-size:10px; color:#999; margin-top:1px;">${r.sector}</div>
      </td>
      <td style="padding:9px 10px; text-align:right; white-space:nowrap;">
        <div style="font-weight:bold; font-size:13px;">${r.price.current.toFixed(2)}</div>
        <div style="color:${chgColor}; font-size:11px;">${chgSign}${r.price.change_pct}%</div>
      </td>
      <td style="padding:9px 10px; text-align:center; font-size:13px; color:#37474f;">${r.rsi}</td>
      <td style="padding:9px 10px; text-align:center; font-size:11px; ${volStyle}">${r.volume_ratio}x</td>
      <td style="padding:9px 10px; text-align:center; font-size:11px; color:${tv.color}; white-space:nowrap;">${tv.text}</td>
      <td style="padding:9px 10px; text-align:center; font-weight:bold; font-size:15px; color:${verd.color};">${r.combined.toFixed(1)}</td>
      <td style="padding:9px 10px; text-align:center; font-size:12px; color:${verd.color}; background:${verd.bg}; border-radius:4px; white-space:nowrap;">${verd.text}</td>
      <td style="padding:9px 10px; font-size:10px; color:#616161; max-width:180px;">${topSignals}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="pt">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0; padding:16px; background:#eeeeee; font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:960px; margin:0 auto; background:#fff; border-radius:10px; overflow:hidden; box-shadow:0 3px 12px rgba(0,0,0,.15);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1565c0,#0d47a1); color:#fff; padding:22px 28px;">
      <h1 style="margin:0; font-size:21px; letter-spacing:.3px;">📈 Análise Diária de Acções</h1>
      <p style="margin:6px 0 0; font-size:13px; opacity:.85;">
        Top 15 de ${totalAnalyzed} acções analisadas &nbsp;·&nbsp; ${dateStr}
        &nbsp;·&nbsp; Yahoo Finance + TradingView Screener
      </p>
    </div>

    <!-- Tabela -->
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:12px;">
        <thead>
          <tr style="background:#e3f2fd; color:#0d47a1; font-size:11px; text-transform:uppercase; letter-spacing:.4px;">
            <th style="padding:10px; text-align:center;">#</th>
            <th style="padding:10px; text-align:left;">Acção</th>
            <th style="padding:10px; text-align:right;">Preço</th>
            <th style="padding:10px; text-align:center;">RSI</th>
            <th style="padding:10px; text-align:center;">Vol.</th>
            <th style="padding:10px; text-align:center;">TV Rating</th>
            <th style="padding:10px; text-align:center;">Score</th>
            <th style="padding:10px; text-align:center;">Avaliação</th>
            <th style="padding:10px; text-align:left;">Sinais principais</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <!-- Legenda -->
    <div style="padding:16px 24px; background:#f5f5f5; border-top:1px solid #e0e0e0;">
      <p style="margin:0; font-size:11px; color:#757575; line-height:1.7;">
        <strong>Score</strong> = análise técnica Yahoo Finance (RSI, MACD, EMAs, Bollinger, ADX, Stochastic)
        + TradingView Recommend × 5 &nbsp;|&nbsp;
        <strong>Forte Compra</strong> ≥ 10 &nbsp;·&nbsp; <strong>Compra</strong> ≥ 6 &nbsp;·&nbsp;
        <strong>Neutro</strong> ≥ 2 &nbsp;·&nbsp; <strong>Evitar</strong> &lt; 2<br>
        Gerado automaticamente via GitHub Actions. Apenas para fins informativos — não constitui conselho financeiro.
      </p>
    </div>

  </div>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const dateStr = new Date().toLocaleDateString('pt-PT', {
    timeZone: 'Europe/Lisbon', day: '2-digit', month: '2-digit', year: 'numeric'
  });

  // 1. TradingView Screener
  console.log('📡 A obter TradingView Screener…');
  let tvData = {};
  try {
    tvData = await fetchTVScreener(WATCHLIST);
    console.log(`   ✓ Dados TV para ${Object.keys(tvData).length} acções`);
  } catch (e) {
    console.warn(`   ⚠ TV Screener falhou: ${e.message} — a continuar sem rating TV`);
  }

  // 2. Yahoo Finance + análise técnica
  console.log('\n📊 A obter Yahoo Finance OHLCV…');
  const results = [];
  for (const stock of WATCHLIST) {
    try {
      process.stdout.write(`   ${stock.yahoo.padEnd(10)}`);
      const bars = await fetchBars(stock.yahoo);
      const analysis = buildAnalysis(stock, bars);
      const tv = tvData[stock.tv] ?? {};
      const tvRec = tv['Recommend.All'] ?? null;
      const tvScore = tvRec != null ? tvRec * 5 : 0;
      const combined = analysis.composite.score + tvScore;
      results.push({ ...analysis, tvRecommend: tvRec, combined });
      console.log(`score=${analysis.composite.score.toString().padStart(3)}  tv=${tvRec != null ? tvRec.toFixed(2) : ' N/D'}  combined=${combined.toFixed(1)}`);
    } catch (e) {
      console.warn(`   ✗ SKIP ${stock.yahoo}: ${e.message}`);
    }
  }

  if (results.length === 0) {
    console.error('Nenhuma acção analisada com sucesso.');
    process.exit(1);
  }

  // 3. Ordenar e seleccionar top 15
  results.sort((a, b) => b.combined - a.combined);
  const top15 = results.slice(0, 15);

  // 4. Gerar HTML e guardar
  const html = generateHTML(top15, dateStr, results.length);
  writeFileSync(REPORT_PATH, html, 'utf8');

  console.log(`\n✅ Report escrito em ${REPORT_PATH}`);
  console.log('\n📋 Top 15:');
  top15.forEach((r, i) =>
    console.log(`   ${String(i + 1).padStart(2)}. ${r.symbol.padEnd(6)} ${r.name.padEnd(28)} combined=${r.combined.toFixed(1).padStart(5)}`)
  );
}

main().catch(e => { console.error('ERRO:', e); process.exit(1); });

// screener.mjs — v3: Dynamic criteria-based screener
// Europa: 08:10h Lisboa | EUA: 22:10h Lisboa
// Uso: MARKET=europe node screener.mjs   |   MARKET=us node screener.mjs

import { writeFileSync } from 'fs';

const MARKET = (process.env.MARKET || 'europe').toLowerCase();
const REPORT_PATH = './report.html';

const CFG = {
  europe: {
    endpoint:   'https://scanner.tradingview.com/europe/scan',
    rsiMin: 40, rsiMax: 75,
    changeMin:  0.5, changeMax: 3,
    volumeMin:  100_000,
    label:      '🇪🇺 Mercado Europeu',
    timeNote:   '08:10h Lisboa · Mercado europeu a abrir'
  },
  us: {
    endpoint:   'https://scanner.tradingview.com/america/scan',
    rsiMin: 40, rsiMax: 75,
    changeMin:  1,   changeMax: 5,
    volumeMin:  500_000,
    label:      '🇺🇸 Mercado Americano',
    timeNote:   '22:10h Lisboa · Após fecho (21h Lisboa)'
  }
}[MARKET];

if (!CFG) { console.error('MARKET deve ser "europe" ou "us"'); process.exit(1); }

// ─── Indicator helpers ────────────────────────────────────────────────────────
function ema(src, p) {
  const k = 2/(p+1); let v = src[0]; const o = [v];
  for (let i=1; i<src.length; i++) { v = src[i]*k + v*(1-k); o.push(v); }
  return o;
}
function rsi(src, p) {
  let g=0, l=0;
  for (let i=1; i<=p; i++) { const d=src[i]-src[i-1]; if(d>0) g+=d; else l-=d; }
  let ag=g/p, al=l/p;
  const o = new Array(p).fill(null);
  o.push(al===0 ? 100 : 100-100/(1+ag/al));
  for (let i=p+1; i<src.length; i++) {
    const d=src[i]-src[i-1], gi=d>0?d:0, li=d<0?-d:0;
    ag=(ag*(p-1)+gi)/p; al=(al*(p-1)+li)/p;
    o.push(al===0 ? 100 : 100-100/(1+ag/al));
  }
  return o;
}
function macd(src) {
  const fast=ema(src,12), slow=ema(src,26);
  const line=fast.map((v,i)=>v-slow[i]);
  const signal=ema(line,9);
  return { line, signal, hist: line.map((v,i)=>v-signal[i]) };
}
function bb(src, p, m) {
  return src.map((_,i) => {
    if(i<p-1) return null;
    const sl=src.slice(i-p+1,i+1);
    const mn=sl.reduce((a,b)=>a+b,0)/p;
    const sd=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/p);
    return {upper:mn+m*sd, mid:mn, lower:mn-m*sd};
  });
}
function atrFn(h, l, c, p) {
  const tr=[h[0]-l[0]];
  for(let i=1; i<h.length; i++) tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
  let v=tr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  const o=new Array(p-1).fill(null); o.push(v);
  for(let i=p; i<tr.length; i++) { v=(v*(p-1)+tr[i])/p; o.push(v); }
  return o;
}
function stoch(h, l, c, kp, dp) {
  const k=c.map((_,i) => {
    if(i<kp-1) return null;
    const hh=Math.max(...h.slice(i-kp+1,i+1)), ll=Math.min(...l.slice(i-kp+1,i+1));
    return hh===ll ? 50 : (c[i]-ll)/(hh-ll)*100;
  });
  const d=k.map((_,i) => {
    if(i<kp+dp-2) return null;
    const sl=k.slice(i-dp+1,i+1).filter(x=>x!==null);
    return sl.length===dp ? sl.reduce((a,b)=>a+b,0)/dp : null;
  });
  return {k,d};
}
function adxFn(h, l, c, p) {
  const tr=[],pdm=[],ndm=[];
  for(let i=1; i<h.length; i++) {
    tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
    pdm.push(Math.max(h[i]-h[i-1],0)>Math.max(l[i-1]-l[i],0)?Math.max(h[i]-h[i-1],0):0);
    ndm.push(Math.max(l[i-1]-l[i],0)>Math.max(h[i]-h[i-1],0)?Math.max(l[i-1]-l[i],0):0);
  }
  function sm(a,p){let s=a.slice(0,p).reduce((x,y)=>x+y,0);const o=[s];for(let i=p;i<a.length;i++){s=s-s/p+a[i];o.push(s);}return o;}
  const a14=sm(tr,p),sp=sm(pdm,p),sn=sm(ndm,p);
  const pdi=sp.map((v,i)=>v/a14[i]*100),ndi=sn.map((v,i)=>v/a14[i]*100);
  const dx=pdi.map((v,i)=>Math.abs(v-ndi[i])/(v+ndi[i])*100);
  return {pdi,ndi,adx:ema(dx,p)};
}

// ─── Multi-timeframe helpers ──────────────────────────────────────────────────
function aggregate4H(bars) {
  const result = [];
  for(let i=0; i<bars.length; i+=4) {
    const chunk = bars.slice(i, i+4);
    if(chunk.length < 4) break;
    result.push({
      time:   chunk[0].time,
      open:   chunk[0].open,
      high:   Math.max(...chunk.map(b=>b.high)),
      low:    Math.min(...chunk.map(b=>b.low)),
      close:  chunk[chunk.length-1].close,
      volume: chunk.reduce((s,b)=>s+b.volume, 0)
    });
  }
  return result;
}
function calcVWAP(hourlyBars) {
  if(!hourlyBars || !hourlyBars.length) return null;
  const lastD = new Date(hourlyBars.at(-1).time * 1000);
  const key = `${lastD.getUTCFullYear()}-${lastD.getUTCMonth()}-${lastD.getUTCDate()}`;
  const session = hourlyBars.filter(b => {
    const d = new Date(b.time*1000);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}` === key;
  });
  if(!session.length) return null;
  const tpv = session.reduce((s,b)=>s+(b.high+b.low+b.close)/3*b.volume, 0);
  const vol = session.reduce((s,b)=>s+b.volume, 0);
  return vol > 0 ? tpv/vol : null;
}
function computeTF(bars) {
  if(!bars || bars.length < 35) return null;
  const C = bars.map(b=>b.close);
  const n=C.length, i=n-1;
  const r=rsi(C,14), m=macd(C);
  const rv=r[i], rp=r[i-1];
  if(rv==null || rp==null) return null;
  return {
    rsi:  { value: +rv.toFixed(1), trend: rv>rp+0.2?'↑':rv<rp-0.2?'↓':'→' },
    macd: { trend: m.hist[i]>m.hist[i-1]?'↑':'↓', cross: m.line[i]>m.signal[i]?'bull':'bear' }
  };
}

// ─── TV Symbol → Yahoo Finance ─────────────────────────────────────────────────
function tvToYahoo(tvSym) {
  const [exch, ticker] = tvSym.split(':');
  if (['NASDAQ','NYSE','AMEX','BATS','CBOE'].includes(exch)) return ticker;
  const map = {
    LSE:'.L', XETRA:'.DE', AMS:'.AS', EPA:'.PA', BIT:'.MI',
    BME:'.MC', OSL:'.OL', STO:'.ST', HEL:'.HE', CPH:'.CO',
    VIE:'.VI', SWX:'.SW', FWB:'.F', IST:'.IS', WSE:'.WA', ATH:'.AT'
  };
  return ticker + (map[exch] || '');
}

// ─── TradingView Screener com filtros ─────────────────────────────────────────
async function scanTV() {
  const body = {
    filter: [
      { left: 'RSI',       operation: 'in_range', right: [CFG.rsiMin, CFG.rsiMax] },
      { left: 'MACD.hist', operation: 'greater',  right: 0 },
      { left: 'change',    operation: 'in_range', right: [CFG.changeMin, CFG.changeMax] },
      { left: 'volume',    operation: 'egreater', right: CFG.volumeMin }
    ],
    options: { lang: 'en' },
    columns: [
      'close','change','RSI','RSI[1]','MACD.macd','MACD.signal','MACD.hist',
      'EMA50','EMA200','Recommend.All','volume','relative_volume_10d_calc',
      'market_cap_basic','description','sector'
    ],
    sort:  { sortBy: 'Recommend.All', sortOrder: 'desc' },
    range: [0, 60]
  };
  const resp = await fetch(CFG.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0',
      'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/'
    },
    body: JSON.stringify(body)
  });
  if(!resp.ok) throw new Error(`TV scan HTTP ${resp.status}`);
  const json  = await resp.json();
  const cols  = body.columns;
  return (json.data || []).map(item => {
    const d = {}; cols.forEach((c,i) => d[c] = item.d[i]);
    return { tvSymbol: item.s, yahoo: tvToYahoo(item.s), ...d };
  }).filter(c => c.close != null && c.EMA50 != null && c.close > c.EMA50); // Preço > EMA50
}

// ─── Pré-score com dados TV (para seleccionar top 20 candidatos) ───────────────
function tvPreScore(c) {
  let s = 0;
  const rsiVal = c['RSI'], rsi1 = c['RSI[1]'];
  if (rsiVal >= 50 && rsiVal <= 65) s += 2;   // zona óptima
  else if (rsiVal > 65) s += 1;
  if (rsi1 != null && rsiVal > rsi1 + 0.2) s += 1;  // RSI a subir
  if (c['Recommend.All'] != null) s += c['Recommend.All'] * 3;
  if ((c['relative_volume_10d_calc'] || 0) >= 1.5) s += 1; // volume acima da média
  return s;
}

// ─── Yahoo Finance OHLCV ──────────────────────────────────────────────────────
async function fetchBars(symbol, interval='1d', range='1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if(!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
  const json = await resp.json();
  const res  = json.chart.result[0];
  const ts=res.timestamp, q=res.indicators.quote[0];
  const raw = ts.map((t,i)=>({time:t,open:q.open[i],high:q.high[i],low:q.low[i],close:q.close[i],volume:q.volume[i]??0}));
  const clean = raw.filter(b=>b.close!=null&&b.close>0&&b.high!=null&&b.low!=null&&b.high>=b.low&&b.high>=b.close&&b.low<=b.close);
  clean.sort((a,b)=>a.time-b.time);
  return interval==='1d' ? clean.slice(-300) : clean.slice(-600);
}

// ─── Análise completa (multi-TF) ──────────────────────────────────────────────
function buildAnalysis(cand, dailyBars, hourlyBars) {
  const C=dailyBars.map(b=>b.close), H=dailyBars.map(b=>b.high),
        L=dailyBars.map(b=>b.low),   V=dailyBars.map(b=>b.volume);
  const n=C.length, i=n-1;
  const e9=ema(C,9),e21=ema(C,21),e50=ema(C,50),e100=ema(C,100),e200=ema(C,200);
  const r=rsi(C,14), m=macd(C), blArr=bb(C,20,2),
        st=stoch(H,L,C,14,3), adx=adxFn(H,L,C,14);
  const ai=adx.adx.length-1, bLast=blArr[i];
  const avgVol=V.slice(-20).reduce((a,b)=>a+b,0)/20;

  const rsiVal=r[i], rsiPrev=r[i-1];
  const bbPos=(C[i]-bLast.lower)/(bLast.upper-bLast.lower)*100;
  const rsiSig=rsiVal>70?'overbought':rsiVal<30?'oversold':rsiVal>=50?'bullish_zone':'bearish_zone';
  const bbSig=bbPos>80?'overbought':bbPos<20?'oversold':'normal';
  const macdTrend=m.hist[i]>m.hist[i-1]?'improving':'deteriorating';
  const macdCross=m.line[i]>m.signal[i]?'bullish':'bearish';
  const priceAbove=C[i]>e9[i]&&C[i]>e21[i]&&C[i]>e50[i]&&C[i]>e100[i]&&C[i]>e200[i];
  const bullAlign=e9[i]>e21[i]&&e21[i]>e50[i]&&e50[i]>e100[i]&&e100[i]>e200[i];
  const dominant=adx.pdi[ai]>adx.ndi[ai]?'buyers':'sellers';
  const stochK=st.k[i]??0;
  const week2Pct=(C[i]-C[i-10])/C[i-10]*100;

  const bars4h=aggregate4H(hourlyBars||[]);
  const tf4h=computeTF(bars4h);
  const tf1h=computeTF(hourlyBars||[]);
  const vwap=calcVWAP(hourlyBars||[]);
  const vwapPct=vwap?+((C[i]-vwap)/vwap*100).toFixed(2):null;

  let score=0, signals=[];

  if(rsiSig==='bullish_zone') { score+=2; signals.push('RSI D zona bullish'); }
  if(rsiSig==='oversold')     { score+=2; signals.push('RSI D sobrevendido'); }
  if(macdTrend==='improving') { score+=2; signals.push('MACD D a melhorar'); }
  if(macdCross==='bullish')   { score+=1; signals.push('MACD D bullish'); }
  if(priceAbove)              { score+=2; signals.push('Acima todas as EMAs'); }
  if(bullAlign)               { score+=1; signals.push('EMAs alinhadas'); }
  if(dominant==='buyers')     { score+=1; signals.push('Compradores dominantes'); }
  if(bbSig==='oversold')      { score+=2; signals.push('BB sobrevendido'); }
  if(rsiSig==='overbought')   { score-=2; signals.push('RSI D sobrecomprado'); }
  if(bbSig==='overbought')    { score-=1; signals.push('BB sobrecomprado'); }
  if(stochK>80)               { score-=1; signals.push('Stoch sobrecomprado'); }
  if(week2Pct<-3)             { score-=1; signals.push('Tendência baixa 2sem'); }

  if(tf4h) {
    if(tf4h.rsi.value>=50&&tf4h.rsi.value<70) { score+=1; signals.push('RSI 4H zona bullish'); }
    if(tf4h.rsi.value<30)                      { score+=1; signals.push('RSI 4H sobrevendido'); }
    if(tf4h.rsi.value>70)                      { score-=1; signals.push('RSI 4H sobrecomprado'); }
    if(tf4h.macd.trend==='↑')                  { score+=1; signals.push('MACD 4H a melhorar'); }
  }
  if(tf1h) {
    if(tf1h.rsi.value<30)     { score+=1; signals.push('RSI 1H sobrevendido'); }
    if(tf1h.rsi.value>70)     { score-=1; signals.push('RSI 1H sobrecomprado'); }
    if(tf1h.macd.trend==='↑') { score+=1; signals.push('MACD 1H a melhorar'); }
  }
  if(vwapPct!=null&&vwapPct>0) { score+=1; signals.push(`Acima VWAP +${vwapPct}%`); }

  const tvRec   = cand['Recommend.All'];
  const combined = score + (tvRec != null ? tvRec * 5 : 0);

  return {
    symbol:      cand.tvSymbol.split(':')[1],
    tvSymbol:    cand.tvSymbol,
    name:        cand.description || cand.tvSymbol,
    sector:      cand.sector || '—',
    price: { current: C[i], change_pct: +((C[i]-C[i-1])/C[i-1]*100).toFixed(2) },
    rsi_d:   { value: +rsiVal.toFixed(1), trend: rsiVal>rsiPrev+0.2?'↑':rsiVal<rsiPrev-0.2?'↓':'→' },
    rsi_4h:  tf4h ? tf4h.rsi  : null,
    rsi_1h:  tf1h ? tf1h.rsi  : null,
    macd_d:  { trend: macdTrend==='improving'?'↑':'↓' },
    macd_4h: tf4h ? tf4h.macd : null,
    macd_1h: tf1h ? tf1h.macd : null,
    vwap_pct:     vwapPct,
    volume_ratio: +(V[i]/avgVol).toFixed(2),
    tvRecommend:  tvRec,
    composite:    { score, signals },
    combined
  };
}

// ─── Labels e cores ────────────────────────────────────────────────────────────
function tvLabel(val) {
  if(val==null) return {text:'N/D',             color:'#9e9e9e'};
  if(val>=0.5)  return {text:'🟢 Forte Compra', color:'#00897b'};
  if(val>=0.1)  return {text:'🟩 Compra',       color:'#43a047'};
  if(val>-0.1)  return {text:'⚪ Neutro',       color:'#fb8c00'};
  if(val>-0.5)  return {text:'🟥 Venda',        color:'#e53935'};
  return              {text:'🔴 Forte Venda',   color:'#b71c1c'};
}
function combinedLabel(score) {
  if(score>=12) return {text:'🟢 Forte Compra', color:'#00897b', bg:'#e0f2f1'};
  if(score>=7)  return {text:'🟡 Compra',       color:'#558b2f', bg:'#f1f8e9'};
  if(score>=3)  return {text:'⚪ Neutro',       color:'#e65100', bg:'#fff3e0'};
  return             {text:'🔴 Evitar',         color:'#c62828', bg:'#ffebee'};
}
function rsiColor(v) { return v>70?'#c62828':v<30?'#2e7d32':'#37474f'; }
function trendColor(t) { return t==='↑'?'#2e7d32':t==='↓'?'#c62828':'#9e9e9e'; }

// ─── HTML ──────────────────────────────────────────────────────────────────────
function generateHTML(top15, dateStr, totalFound, totalAnalyzed) {
  function rsiCell(tf) {
    if(!tf) return '<span style="color:#bbb;font-size:10px">N/D</span>';
    return `<span style="color:${rsiColor(tf.value)};font-weight:bold">${tf.value}</span>`
         + `<span style="color:${trendColor(tf.trend)};font-size:14px;font-weight:bold"> ${tf.trend}</span>`;
  }
  function macdCell(tf) {
    if(!tf) return '<span style="color:#bbb;font-size:10px">N/D</span>';
    const c = tf.trend==='↑'?'#2e7d32':'#c62828';
    return `<span style="color:${c};font-size:14px;font-weight:bold">${tf.trend}</span>`;
  }

  const criteriaHtml = `
    <div style="padding:14px 28px;background:#f0f4ff;border-bottom:1px solid #dce3f5;font-size:11px;color:#3949ab">
      <strong>Critérios de entrada:</strong> &nbsp;
      RSI D [${CFG.rsiMin}–${CFG.rsiMax}] &nbsp;·&nbsp;
      MACD Hist &gt; 0 &nbsp;·&nbsp;
      Preço &gt; EMA50 &nbsp;·&nbsp;
      Variação [${CFG.changeMin}%–${CFG.changeMax}%] &nbsp;·&nbsp;
      Volume ≥ ${CFG.volumeMin.toLocaleString('pt-PT')}
      &nbsp;&nbsp;|&nbsp;&nbsp;
      <strong>${totalFound}</strong> candidatas encontradas · <strong>${totalAnalyzed}</strong> analisadas em profundidade
    </div>`;

  if(!top15.length) {
    return `<!DOCTYPE html><html><body style="font-family:Arial;padding:30px">
      <h2>${CFG.label} — ${dateStr}</h2>
      <p>⚠️ Nenhuma acção encontrou os critérios hoje.</p>
      ${criteriaHtml}
    </body></html>`;
  }

  const rows = top15.map((r, idx) => {
    const tv   = tvLabel(r.tvRecommend);
    const verd = combinedLabel(r.combined);
    const chgColor = r.price.change_pct>=0?'#2e7d32':'#c62828';
    const chgSign  = r.price.change_pct>=0?'+':'';
    const topSignals = r.composite.signals.slice(0,3).join(' · ') || '—';
    const volStyle = r.volume_ratio>=1.5?'font-weight:bold;color:#1565c0':'color:#555';
    const vwapStr = r.vwap_pct!=null
      ? `<div style="margin-top:3px;font-size:10px;color:${r.vwap_pct>=0?'#2e7d32':'#c62828'}">VWAP ${r.vwap_pct>=0?'+':''}${r.vwap_pct}%</div>` : '';

    return `
    <tr style="border-bottom:1px solid #e0e0e0;background:${idx%2===0?'#fafafa':'#fff'}">
      <td style="padding:9px 10px;text-align:center;font-weight:bold;color:#1565c0;font-size:15px">${idx+1}</td>
      <td style="padding:9px 10px">
        <div style="font-weight:bold;font-size:14px;color:#212121">${r.symbol}</div>
        <div style="font-size:11px;color:#555;margin-top:1px">${r.name}</div>
        <div style="font-size:10px;color:#999">${r.sector}</div>
      </td>
      <td style="padding:9px 10px;text-align:right;white-space:nowrap">
        <div style="font-weight:bold;font-size:13px">${r.price.current.toFixed(2)}</div>
        <div style="color:${chgColor};font-size:11px">${chgSign}${r.price.change_pct}%</div>
      </td>
      <td style="padding:9px 10px;font-size:12px;white-space:nowrap;line-height:1.9">
        <div><span style="color:#9e9e9e;font-size:10px">D &nbsp;</span>${rsiCell(r.rsi_d)}</div>
        <div><span style="color:#9e9e9e;font-size:10px">4H </span>${rsiCell(r.rsi_4h)}</div>
        <div><span style="color:#9e9e9e;font-size:10px">1H </span>${rsiCell(r.rsi_1h)}</div>
      </td>
      <td style="padding:9px 10px;font-size:12px;white-space:nowrap;line-height:1.9">
        <div><span style="color:#9e9e9e;font-size:10px">D &nbsp;</span>${macdCell(r.macd_d)}</div>
        <div><span style="color:#9e9e9e;font-size:10px">4H </span>${macdCell(r.macd_4h)}</div>
        <div><span style="color:#9e9e9e;font-size:10px">1H </span>${macdCell(r.macd_1h)}</div>
        ${vwapStr}
      </td>
      <td style="padding:9px 10px;text-align:center;font-size:12px;${volStyle}">${r.volume_ratio}x</td>
      <td style="padding:9px 10px;text-align:center;font-size:11px;color:${tv.color};white-space:nowrap">${tv.text}</td>
      <td style="padding:9px 10px;text-align:center;font-weight:bold;font-size:16px;color:${verd.color}">${r.combined.toFixed(1)}</td>
      <td style="padding:9px 10px;text-align:center;font-size:11px;color:${verd.color};background:${verd.bg};border-radius:4px;white-space:nowrap">${verd.text}</td>
      <td style="padding:9px 10px;font-size:10px;color:#616161;max-width:160px">${topSignals}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="pt">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:16px;background:#eeeeee;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:1100px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 3px 12px rgba(0,0,0,.15)">
  <div style="background:linear-gradient(135deg,#1565c0,#0d47a1);color:#fff;padding:22px 28px">
    <h1 style="margin:0;font-size:21px">📈 ${CFG.label} — Top ${top15.length}</h1>
    <p style="margin:6px 0 0;font-size:13px;opacity:.85">${dateStr} &nbsp;·&nbsp; ${CFG.timeNote} &nbsp;·&nbsp; Yahoo Finance (D+4H+1H) + TradingView Screener</p>
  </div>
  ${criteriaHtml}
  <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr style="background:#e3f2fd;color:#0d47a1;font-size:10px;text-transform:uppercase;letter-spacing:.5px">
          <th style="padding:10px;text-align:center">#</th>
          <th style="padding:10px;text-align:left">Acção</th>
          <th style="padding:10px;text-align:right">Preço</th>
          <th style="padding:10px;text-align:left">RSI</th>
          <th style="padding:10px;text-align:left">MACD / VWAP</th>
          <th style="padding:10px;text-align:center">Vol.</th>
          <th style="padding:10px;text-align:center">TV Rating</th>
          <th style="padding:10px;text-align:center">Score</th>
          <th style="padding:10px;text-align:center">Avaliação</th>
          <th style="padding:10px;text-align:left">Sinais principais</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div style="padding:16px 24px;background:#f5f5f5;border-top:1px solid #e0e0e0">
    <p style="margin:0;font-size:11px;color:#757575;line-height:1.9">
      <strong>RSI / MACD:</strong> D=Diário · 4H · 1H &nbsp;
      <span style="color:#2e7d32;font-weight:bold">↑ a subir</span> &nbsp;
      <span style="color:#c62828;font-weight:bold">↓ a descer</span> &nbsp;
      <span style="color:#9e9e9e;font-weight:bold">→ lateral</span>
      &nbsp;|&nbsp;
      <strong>Score</strong> = análise técnica multi-TF + TV Recommend × 5 &nbsp;|&nbsp;
      <strong>Forte Compra</strong> ≥ 12 · <strong>Compra</strong> ≥ 7 · <strong>Neutro</strong> ≥ 3 · <strong>Evitar</strong> &lt; 3<br>
      Apenas para fins informativos. Não constitui conselho financeiro.
    </p>
  </div>
</div>
</body></html>`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const dateStr = new Date().toLocaleDateString('pt-PT', {
    timeZone:'Europe/Lisbon', day:'2-digit', month:'2-digit', year:'numeric'
  });

  console.log(`\n🔍 ${CFG.label} — ${dateStr}`);
  console.log(`   RSI [${CFG.rsiMin}-${CFG.rsiMax}] · MACD.hist>0 · Preço>EMA50 · Var [${CFG.changeMin}%-${CFG.changeMax}%] · Vol≥${CFG.volumeMin.toLocaleString()}`);

  // 1. TV Screener com filtros
  console.log('\n📡 TradingView Screener…');
  let candidates = [];
  try {
    candidates = await scanTV();
    console.log(`   ✓ ${candidates.length} candidatas após filtros (incluindo Preço>EMA50)`);
  } catch(e) {
    console.error(`   ✗ TV Screener falhou: ${e.message}`);
    process.exit(1);
  }

  if(!candidates.length) {
    console.log('   ⚠ Nenhuma acção encontrou os critérios hoje.');
    writeFileSync(REPORT_PATH, generateHTML([], dateStr, 0, 0), 'utf8');
    return;
  }

  // 2. Pré-score com dados TV → top 20 para análise aprofundada
  candidates.forEach(c => { c._pre = tvPreScore(c); });
  candidates.sort((a,b) => b._pre - a._pre);
  const top20 = candidates.slice(0, 20);
  console.log(`   → Top ${top20.length} seleccionadas para análise multi-TF`);

  // 3. Yahoo Finance (daily + hourly em paralelo por acção)
  console.log('\n📊 Yahoo Finance (D+1H)…');
  const results = [];
  for(const cand of top20) {
    try {
      process.stdout.write(`   ${cand.yahoo.padEnd(12)}`);
      const [dailyBars, hourlyBars] = await Promise.all([
        fetchBars(cand.yahoo, '1d', '1y'),
        fetchBars(cand.yahoo, '1h', '60d').catch(()=>[])
      ]);
      const analysis = buildAnalysis(cand, dailyBars, hourlyBars);
      results.push(analysis);
      console.log(
        `RSI D:${analysis.rsi_d.value}${analysis.rsi_d.trend} ` +
        `4H:${analysis.rsi_4h?.value??'--'}${analysis.rsi_4h?.trend??''} ` +
        `1H:${analysis.rsi_1h?.value??'--'}${analysis.rsi_1h?.trend??''} ` +
        `combined=${analysis.combined.toFixed(1)}`
      );
    } catch(e) {
      console.warn(`   ✗ SKIP ${cand.yahoo}: ${e.message}`);
    }
  }

  if(!results.length) { console.error('Sem resultados com dados suficientes.'); process.exit(1); }

  // 4. Ordenar e seleccionar top 15
  results.sort((a,b) => b.combined - a.combined);
  const top15 = results.slice(0, 15);

  writeFileSync(REPORT_PATH, generateHTML(top15, dateStr, candidates.length, results.length), 'utf8');
  console.log(`\n✅ ${REPORT_PATH}`);
  console.log('\n📋 Top 15:');
  top15.forEach((r,i) =>
    console.log(`   ${String(i+1).padStart(2)}. ${r.symbol.padEnd(8)} ${(r.name||'').substring(0,24).padEnd(24)} combined=${r.combined.toFixed(1)}`)
  );
}

main().catch(e=>{ console.error('ERRO:', e); process.exit(1); });

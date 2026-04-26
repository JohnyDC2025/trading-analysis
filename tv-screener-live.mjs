// tv-screener-live.mjs — v6
// Dashboard profissional de decisão de entrada
// Gera: report.html  +  tradingview_analysis.json
// Pré-requisito: abrir "TradingView CDP.bat" antes de correr

import { writeFileSync, readFileSync, existsSync } from 'fs';

const CDP_HOST = 'localhost:9222';
const SCAN_URL = 'https://scanner.tradingview.com/global/scan';

// ─── Configuração por mercado ─────────────────────────────────────────────────
const MARKET = (process.argv[2] || 'eu').toLowerCase();
const MARKETS = {
  eu: {
    name:        'GTP screener - UE',
    screenerUrl: 'https://www.tradingview.com/screener/OM3tQYWa/',
    tickersFile: './tickers-eu.json',
    htmlLocal:   './report.html',
    jsonLocal:   './tradingview_analysis.json',
    htmlDrive:   'G:/O meu disco/Claude ações/report.html',
    jsonDrive:   'G:/O meu disco/Claude ações/tradingview_analysis.json',
    fallback:    ['LSE:IMI','LSE:GNC','LSE:PFD','LSE:TRST','LSE:MONY','LSE:FCH'],
  },
  us: {
    name:        'GTP screener - EUA',
    screenerUrl: 'https://www.tradingview.com/screener/7ftBbPtc/',
    tickersFile: './tickers-us.json',
    htmlLocal:   './report-us.html',
    jsonLocal:   './tradingview_analysis_us.json',
    htmlDrive:   'G:/O meu disco/Claude ações/report-us.html',
    jsonDrive:   'G:/O meu disco/Claude ações/tradingview_analysis_us.json',
    fallback:    ['NASDAQ:AAPL','NASDAQ:MSFT','NASDAQ:GOOGL','NYSE:JPM','NYSE:JNJ','NASDAQ:NVDA'],
  },
};

if (!MARKETS[MARKET]) {
  console.error(`❌ Mercado desconhecido: "${MARKET}". Use "eu" ou "us".`);
  process.exit(1);
}

const CFG            = MARKETS[MARKET];
const GDRIVE_PATH    = CFG.htmlDrive;
const GDRIVE_JSON_PATH = CFG.jsonDrive;
const SCREENER_URL   = CFG.screenerUrl;
const SCREENER_NAME  = CFG.name;
const SYMBOLS_FALLBACK = CFG.fallback;

// ─── Colunas TV ───────────────────────────────────────────────────────────────
const TV_COLS = [
  'close','open','change','change|1W','change|2W','change|1M',
  'RSI','RSI[1]',
  'MACD.macd','MACD.signal','MACD.hist','MACD.hist[1]','MACD.hist[2]',
  'EMA9','EMA20','EMA50','EMA100','EMA200',
  'BB.upper','BB.lower','BB.basis',
  'Stoch.K','Stoch.D',
  'ADX','ADX+DI','ADX-DI',
  'ATR','VWAP',
  'RSI|240','RSI[1]|240',
  'MACD.macd|240','MACD.signal|240','MACD.hist|240','MACD.hist[1]|240','MACD.hist[2]|240',
  'RSI|60','RSI[1]|60',
  'MACD.macd|60','MACD.signal|60','MACD.hist|60','MACD.hist[1]|60','MACD.hist[2]|60',
  'Recommend.All','volume','relative_volume_10d_calc','average_volume_10d_calc',
  'market_cap_basic','dividends_yield','earnings_release_next_date',
  'description','sector'
];

// ─── CDP: ler tickers do screener ────────────────────────────────────────────
async function getSymbolsViaCDP() {
  let tabs;
  try {
    const r = await fetch(`http://${CDP_HOST}/json`, { signal: AbortSignal.timeout(3000) });
    tabs = await r.json();
  } catch { return null; }
  const tab = tabs.find(t => t.type === 'page' && t.url?.includes('tradingview.com'));
  if (!tab) return null;
  // Navegar se não estiver exactamente no screener correcto (verifica o ID)
  const screenerId = SCREENER_URL.split('/screener/')[1]?.replace('/', '') || '';
  const needsNav = !tab.url.includes(screenerId);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let msgId = 0;
  function send(expr) {
    const id = ++msgId;
    return new Promise(res => {
      const h = e => { const m = JSON.parse(e.data); if (m.id===id){ws.removeEventListener('message',h);res(m.result?.result?.value);} };
      ws.addEventListener('message', h);
      ws.send(JSON.stringify({id, method:'Runtime.evaluate', params:{expression:expr, returnByValue:true}}));
    });
  }
  if (needsNav) {
    let nid = ++msgId;
    await new Promise(res => {
      const h = e => { const m = JSON.parse(e.data); if(m.id===nid){ws.removeEventListener('message',h);res();} };
      ws.addEventListener('message', h);
      ws.send(JSON.stringify({id:nid, method:'Page.navigate', params:{url:SCREENER_URL}}));
    });
    await new Promise(r => setTimeout(r, 4000));
  }
  await send('window.scrollTo(0,document.body.scrollHeight)');
  await new Promise(r => setTimeout(r, 2000));
  await send('window.scrollTo(0,document.body.scrollHeight)');
  await new Promise(r => setTimeout(r, 1000));
  const hrefs = await send(`[...document.querySelectorAll('a[href*="/symbols/"]')].map(a=>a.href).join('|')`);
  ws.close();
  const seen = new Set(), syms = [];
  for (const url of (hrefs||'').split('|').filter(Boolean)) {
    const m = url.match(/\/symbols\/([A-Z0-9]+)-([A-Z0-9.]+)\//);
    if (m) { const s=m[1]+':'+m[2]; if(!seen.has(s)){seen.add(s);syms.push(s);} }
  }
  return syms.length > 0 ? syms : null;
}

async function getSymbolsFromScreener() {
  // 1. Tentar via CDP (browser aberto localmente)
  const cdpSyms = await getSymbolsViaCDP();
  if (cdpSyms) {
    // Guardar no ficheiro de tickers para uso em CI (GitHub Actions)
    try {
      writeFileSync(CFG.tickersFile, JSON.stringify(cdpSyms, null, 2), 'utf8');
      console.log(`   💾 Tickers guardados em ${CFG.tickersFile} (${cdpSyms.length} acções)`);
    } catch(e) { console.warn(`   ⚠ Não foi possível guardar tickers: ${e.message}`); }
    return cdpSyms;
  }
  // 2. Fallback: ler do ficheiro guardado (CI / browser fechado)
  if (existsSync(CFG.tickersFile)) {
    try {
      const saved = JSON.parse(readFileSync(CFG.tickersFile, 'utf8'));
      if (Array.isArray(saved) && saved.length > 0) {
        console.log(`   📋 Tickers do ficheiro ${CFG.tickersFile} (${saved.length} acções)`);
        return saved;
      }
    } catch(e) {}
  }
  // 3. Último recurso: hardcoded
  console.warn(`   ⚠ Sem CDP nem ficheiro — a usar fallback hardcoded`);
  return null;
}

// ─── TV Screener API ──────────────────────────────────────────────────────────
async function fetchTVData(symbols) {
  const body = { symbols:{tickers:symbols}, columns:TV_COLS };
  const resp = await fetch(SCAN_URL, {
    method:'POST',
    headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0','Origin':'https://www.tradingview.com','Referer':'https://www.tradingview.com/'},
    body:JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`TV HTTP ${resp.status}`);
  const json = await resp.json();
  return (json.data||[]).map(item => {
    const d={}; TV_COLS.forEach((c,i)=>{d[c]=item.d[i];}); return {tvSymbol:item.s, yahoo:tvToYahoo(item.s), ...d};
  });
}

// ─── MACD local: cálculo a partir de OHLCV 1H (Yahoo Finance) ───────────────
// O TV scanner não suporta MACD.hist[2]|TF — calculamos localmente.

function calcMacdHist3(closes) {
  // Devolve [hist_2barrasAtras, hist_1barraAtras, hist_atual] ou null se insuficiente
  if (!closes || closes.length < 40) return null;
  function emaArr(src, p) {
    const k = 2/(p+1), out = new Array(p-1).fill(null);
    out.push(src.slice(0,p).reduce((a,b)=>a+b,0)/p);
    for (let i=p; i<src.length; i++) out.push(src[i]*k + out[i-1]*(1-k));
    return out;
  }
  const e12=emaArr(closes,12), e26=emaArr(closes,26);
  const macdLine=closes.map((_,i)=>e12[i]!=null&&e26[i]!=null?e12[i]-e26[i]:null).filter(v=>v!=null);
  if (macdLine.length<9) return null;
  const sig=emaArr(macdLine,9);
  const hist=macdLine.map((v,i)=>sig[i]!=null?+(v-sig[i]).toFixed(4):null).filter(v=>v!=null);
  return hist.length>=3 ? hist.slice(-3) : null;
}

function aggTo4H(bars) {
  // Agrega barras 1H em 4H (usa UTC — adequado para comparar tendência)
  const groups = new Map();
  for (const b of bars) {
    const dt = new Date(b.t*1000);
    const key = dt.toISOString().slice(0,10) + '_' + Math.floor(dt.getUTCHours()/4);
    if (!groups.has(key)) groups.set(key, {t:b.t, c:b.c});
    else groups.get(key).c = b.c; // close = último do bloco 4H
  }
  return [...groups.values()].sort((a,b)=>a.t-b.t);
}

async function fetchIntradayMacdHist(yahooSymbol) {
  // Devolve {h1:[h2,h1,h0], h4:[h2,h1,h0]} com os últimos 3 valores do histograma MACD
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1h&range=60d`;
    const resp = await fetch(url, {headers:{'User-Agent':'Mozilla/5.0'}});
    if (!resp.ok) return null;
    const json = await resp.json();
    const res = json.chart?.result?.[0];
    if (!res?.timestamp) return null;
    const q = res.indicators.quote[0];
    const bars = res.timestamp.map((t,i)=>({t, c:+(q.close[i]||0).toFixed(4)})).filter(b=>b.c>0);
    if (bars.length < 40) return null;
    const h1 = calcMacdHist3(bars.map(b=>b.c));
    const h4 = calcMacdHist3(aggTo4H(bars).map(b=>b.c));
    return {h1, h4};
  } catch { return null; }
}

function tvToYahoo(tvSym) {
  const [exch, ticker] = tvSym.split(':');
  if (['NASDAQ','NYSE','AMEX','BATS','CBOE'].includes(exch)) return ticker;
  const map={LSE:'.L',XETRA:'.DE',AMS:'.AS',EPA:'.PA',BIT:'.MI',BME:'.MC',OSL:'.OL',STO:'.ST',HEL:'.HE',CPH:'.CO',VIE:'.VI',SWX:'.SW',FWB:'.F',IST:'.IS',WSE:'.WA',ATH:'.AT',EURONEXT:'.PA'};
  return ticker+(map[exch]||'');
}

// ─── Yahoo Finance: 300 velas diárias ────────────────────────────────────────
async function fetchDailyOHLCV(yahooSymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=2y`;
  const resp = await fetch(url, {headers:{'User-Agent':'Mozilla/5.0'}});
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  const res = json.chart?.result?.[0];
  if (!res?.timestamp) throw new Error('Sem dados');
  const ts=res.timestamp, q=res.indicators.quote[0];
  const raw = ts.map((t,i)=>({t,o:+(q.open[i]||0).toFixed(4),h:+(q.high[i]||0).toFixed(4),l:+(q.low[i]||0).toFixed(4),c:+(q.close[i]||0).toFixed(4),v:q.volume[i]||0}));
  return raw.filter(b=>b.c>0&&b.h>=b.l).sort((a,b)=>a.t-b.t).slice(-300);
}

// ─── Utilitários ─────────────────────────────────────────────────────────────
const r2 = v => v!=null ? +v.toFixed(2) : null;
const r1 = v => v!=null ? +v.toFixed(1) : null;
const pct = (a,b) => b>0 ? r2((a-b)/b*100) : null;

function formatMktCap(v) {
  if (!v) return null;
  if (v>=1e12) return (v/1e12).toFixed(2)+'T';
  if (v>=1e9)  return (v/1e9).toFixed(2)+'B';
  if (v>=1e6)  return (v/1e6).toFixed(2)+'M';
  return String(Math.round(v));
}
function tvRating(v) {
  if (v==null) return null;
  if (v>=0.5) return 'Strong buy'; if (v>=0.1) return 'Buy';
  if (v>-0.1) return 'Neutral';   if (v>-0.5) return 'Sell';
  return 'Strong sell';
}
function rsiSignal(v) { return v>70?'overbought':v<30?'oversold':v>=50?'bullish_zone':'bearish_zone'; }
function rsiDir(v, prev) {
  if (v==null||prev==null) return '→';
  return v>prev+0.3?'↑':v<prev-0.3?'↓':'→';
}
function adxStrength(v) { return !v?'unknown':v>=40?'strong':v>=25?'moderate':'weak'; }
function stochSignal(k) { return k>80?'overbought':k<20?'oversold':'neutral'; }
function bbSignal(pos) { return pos>80?'overbought':pos<20?'oversold':'normal'; }
function scoreVerdict(s) { return s>=5?'strong_buy':s>=3?'buy':s>=0?'neutral':'avoid'; }
function formatEarnings(ts) { if(!ts)return null; return new Date(ts*1000).toISOString().split('T')[0]; }
function calcVWAPFromDaily(bars,n=5) {
  if (!bars?.length) return null;
  const r=bars.slice(-n);
  const tpv=r.reduce((a,b)=>a+(b.h+b.l+b.c)/3*b.v,0);
  const vol=r.reduce((a,b)=>a+b.v,0);
  return vol>0?r2(tpv/vol):null;
}

// ─── ANÁLISE: indicadores base ────────────────────────────────────────────────

function getVwapClass(vwapPct) {
  if (vwapPct==null) return {label:'N/D',   color:'#9e9e9e', score:0};
  if (vwapPct>1.5)   return {label:'Esticado',    color:'#ef5350', score:-2};
  if (vwapPct>0.5)   return {label:'Saudável',    color:'#26a69a', score:1};
  if (vwapPct>=0)    return {label:'Zona ideal',  color:'#00897b', score:2};
  if (vwapPct>-1.5)  return {label:'Abaixo VWAP', color:'#ff9800', score:0};
  return               {label:'Fraco',       color:'#ef5350', score:-1};
}

function getMacdHistTrend(h2, h1, h0) {
  if (h0==null||h1==null) return {bars:[h2,h1,h0], trend:'unknown', label:'N/D', color:'#9e9e9e'};
  const growing = h2!=null ? h0>h1&&h1>h2 : h0>h1;
  const falling = h2!=null ? h0<h1&&h1<h2 : h0<h1;
  if (growing) return {bars:[h2,h1,h0], trend:'growing',  label:'Crescente ↑', color:'#26a69a'};
  if (falling) return {bars:[h2,h1,h0], trend:'falling',  label:'Decrescente ↓', color:'#ef5350'};
  return          {bars:[h2,h1,h0], trend:'mixed',    label:'Misto →',      color:'#ff9800'};
}

function getAlignment(c) {
  function tfBull(rsi,rsiP,hist,histP) {
    let s=0;
    if (rsi!=null) { if(rsi>55&&rsi<72)s+=1; else if(rsi>=72)s+=0.5; else if(rsi<45)s-=1; }
    if (rsi!=null&&rsiP!=null) s+=rsi>rsiP+0.3?0.5:rsi<rsiP-0.3?-0.5:0;
    if (hist!=null&&histP!=null) s+=hist>histP?0.5:-0.5;
    return s;
  }
  const sD  = tfBull(c['RSI'],     c['RSI[1]'],     c['MACD.hist'],    c['MACD.hist[1]']);
  const s4h = tfBull(c['RSI|240'], c['RSI[1]|240'], c['MACD.hist|240'],c['MACD.hist[1]|240']);
  const s1h = tfBull(c['RSI|60'],  c['RSI[1]|60'],  c['MACD.hist|60'], c['MACD.hist[1]|60']);
  const pos=[sD,s4h,s1h].filter(s=>s>0).length;
  const neg=[sD,s4h,s1h].filter(s=>s<0).length;
  if (pos===3) return {label:'Alinhado ↑', short:'Alinhado', color:'#26a69a', score:3, bullish:true};
  if (neg===3) return {label:'Alinhado ↓', short:'Alinhado', color:'#ef5350', score:-1, bullish:false};
  if (pos===2) return {label:'Parcial ↑',  short:'Parcial',  color:'#ff9800', score:1,  bullish:true};
  if (neg===2) return {label:'Parcial ↓',  short:'Parcial',  color:'#ff9800', score:0,  bullish:false};
  return        {label:'Desalinhado', short:'Desalinhado', color:'#ef5350', score:-1, bullish:false};
}

// ─── Prioridade de Timeframe (D dominante · 4H confirmação · 1H timing) ──────
function getTfPriority(c) {
  const rsi=c['RSI']??50, rsiPrev=c['RSI[1]']??rsi;
  const macdH=c['MACD.hist']??0, macdHP=c['MACD.hist[1]']??macdH;
  const close=c['close'], ema50=c['EMA50'];

  // Condições estruturalmente bearish no Diário
  const rsiBelow45   = rsi < 45;
  const macdNegDec   = macdH < 0 && macdH < macdHP;
  const belowEma50   = ema50 != null && close < ema50;
  const bearishCount = [rsiBelow45, macdNegDec, belowEma50].filter(Boolean).length;
  const isDailyBearish = bearishCount >= 2;

  // Perda de momentum diário (RSI a cair E MACD a cair, mas não necessariamente bearish)
  const rsiDecline       = rsi < rsiPrev - 0.5;
  const macdDecline      = macdH < macdHP;
  const isLosingMomentum = !isDailyBearish && rsiDecline && macdDecline;

  if (isDailyBearish)   return {label:'D Bearish',    bearish:true,  losingMomentum:false, color:'#ef5350'};
  if (isLosingMomentum) return {label:'D Momentum ↓', bearish:false, losingMomentum:true,  color:'#ff9800'};
  return                       {label:'D OK',          bearish:false, losingMomentum:false, color:'#26a69a'};
}

// ─── Correcção de Risco Automática ───────────────────────────────────────────
// ≥2 condições → mínimo 🟡 | ≥3 condições → 🔴
function getRiskCorrection(c, priceZone, vwapPct) {
  const rsi=c['RSI']??50;
  const macdH=c['MACD.hist']??0, macdHP=c['MACD.hist[1]']??macdH;
  const factors=[];
  if (priceZone.label==='Resistência')     factors.push('Zona Resistência');
  if (rsi > 65)                             factors.push('RSI > 65');
  if (macdH < macdHP)                       factors.push('MACD D ↓');
  if (vwapPct!=null && vwapPct > 1)         factors.push('VWAP > +1%');
  return {factors, count:factors.length};
}

// ─── PRICE ACTION: Padrão detectado ──────────────────────────────────────────
function detectPattern(dailyBars, close, atr) {
  if (!dailyBars || dailyBars.length < 25)
    return {label:'Sem padrão claro', color:'#6b7a99', score:0, bearish:null};

  const bars = dailyBars.slice(-50);
  const n    = bars.length;
  const atrEst = atr || (Math.max(...bars.slice(-10).map(b=>b.h)) - Math.min(...bars.slice(-10).map(b=>b.l))) / 10;

  // Detectar pivôs (swing highs/lows com lookback=2)
  const peaks=[], troughs=[];
  for (let i=2; i<n-2; i++) {
    if (bars[i].h>bars[i-1].h && bars[i].h>bars[i-2].h && bars[i].h>bars[i+1].h && bars[i].h>bars[i+2].h)
      peaks.push({i, price:bars[i].h});
    if (bars[i].l<bars[i-1].l && bars[i].l<bars[i-2].l && bars[i].l<bars[i+1].l && bars[i].l<bars[i+2].l)
      troughs.push({i, price:bars[i].l});
  }

  // ── Double Top (bearish) ──
  if (peaks.length >= 2) {
    const [p1, p2] = peaks.slice(-2);
    const similar  = Math.abs(p1.price-p2.price)/p1.price < 0.025;
    const separated= p2.i - p1.i >= 5;
    const recent   = n - p2.i <= 12;
    const belowPeak= close < p2.price * 0.985;
    if (similar && separated && recent && belowPeak)
      return {label:'Double Top', color:'#ef5350', score:-2, bearish:true};
  }

  // ── Double Bottom (bullish) ──
  if (troughs.length >= 2) {
    const [t1, t2] = troughs.slice(-2);
    const similar  = Math.abs(t1.price-t2.price)/t1.price < 0.025;
    const separated= t2.i - t1.i >= 5;
    const recent   = n - t2.i <= 12;
    const aboveTrough = close > t2.price * 1.015;
    if (similar && separated && recent && aboveTrough)
      return {label:'Double Bottom', color:'#26a69a', score:2, bearish:false};
  }

  // ── Higher Highs / Higher Lows (uptrend) ──
  if (peaks.length >= 2 && troughs.length >= 2) {
    const [p1,p2] = peaks.slice(-2);
    const [t1,t2] = troughs.slice(-2);
    if (p2.price > p1.price*1.005 && t2.price > t1.price*1.005)
      return {label:'Higher Highs / Higher Lows', color:'#26a69a', score:2, bearish:false};
    if (p2.price < p1.price*0.995 && t2.price < t1.price*0.995)
      return {label:'Lower Highs / Lower Lows', color:'#ef5350', score:-2, bearish:true};
  }

  // ── Range (oscila entre dois níveis) ──
  if (peaks.length >= 3 && troughs.length >= 3) {
    const recentHighs = peaks.slice(-3).map(p=>p.price);
    const recentLows  = troughs.slice(-3).map(t=>t.price);
    const highSpread  = (Math.max(...recentHighs)-Math.min(...recentHighs)) / Math.max(...recentHighs);
    const lowSpread   = (Math.max(...recentLows) -Math.min(...recentLows))  / Math.max(...recentLows);
    if (highSpread < 0.03 && lowSpread < 0.03)
      return {label:'Range', color:'#ff9800', score:0, bearish:null};
  }

  return {label:'Sem padrão claro', color:'#6b7a99', score:0, bearish:null};
}

// ─── PRICE ACTION: Zona do preço ─────────────────────────────────────────────
function getPriceZone(c, dailyBars) {
  const close=c['close'], bbUp=c['BB.upper'], bbLo=c['BB.lower'];
  const bbRange=bbUp!=null&&bbLo!=null&&(bbUp-bbLo)>0;
  const bbPos=bbRange?(close-bbLo)/(bbUp-bbLo)*100:50;
  const ema50=c['EMA50'];

  if (!dailyBars || dailyBars.length < 15) {
    if (bbPos>75) return {label:'Resistência', color:'#ef5350'};
    if (bbPos<25) return {label:'Suporte',     color:'#26a69a'};
    return          {label:'Meio do range',  color:'#9e9e9e'};
  }

  const last20  = dailyBars.slice(-20);
  const high20  = Math.max(...last20.map(b=>b.h));
  const low20   = Math.min(...last20.map(b=>b.l));
  const range20 = high20 - low20;
  const posInRange = range20>0 ? (close-low20)/range20*100 : 50;
  const pctFromHigh = (close-high20)/high20*100;

  if (Math.abs(pctFromHigh)<1.5 && bbPos>68) return {label:'Breakout zone', color:'#2196f3'};
  if (pctFromHigh>-4 && bbPos>65)             return {label:'Resistência',   color:'#ef5350'};
  const nearEMA50 = ema50!=null && Math.abs(close-ema50)/close < 0.025;
  if (posInRange<30 || nearEMA50)             return {label:'Suporte',       color:'#26a69a'};
  if (posInRange>=30 && posInRange<=70)        return {label:'Meio do range', color:'#9e9e9e'};
  return {label:'Resistência', color:'#ef5350'};
}

// ─── PRICE ACTION: Estrutura ──────────────────────────────────────────────────
function getStructure(c, dailyBars, pattern) {
  const close=c['close'], rsi=c['RSI']??50, stochK=c['Stoch.K']??50;
  const bbUp=c['BB.upper'], bbLo=c['BB.lower'];
  const bbPos=bbUp!=null&&bbLo!=null&&(bbUp-bbLo)>0?(close-bbLo)/(bbUp-bbLo)*100:50;
  const ema9=c['EMA9'],ema20=c['EMA20'],ema50=c['EMA50'],ema100=c['EMA100'],ema200=c['EMA200'];
  const allEmas=[ema9,ema20,ema50,ema100,ema200].every(e=>e!=null);
  const bullAlign=allEmas?ema9>ema20&&ema20>ema50&&ema50>ema100&&ema100>ema200:false;
  const atr=c['ATR'];

  // Possível reversão: padrão bearish + sinais de topo
  if (pattern?.bearish===true || (stochK>85&&rsi>67&&bbPos>80))
    return {label:'⚠️ Possível reversão', color:'#ff6f00', icon:'⚠️', score:-3};

  // Extensão: sobrecomprado
  if (rsi>73||bbPos>92)
    return {label:'Extensão', color:'#ef5350', icon:'🚀', score:-2};

  // Resistência: próximo de topo de Bollinger + stoch alto
  if (bbPos>82&&stochK>80)
    return {label:'Resistência', color:'#ff9800', icon:'🧱', score:-1};

  if (dailyBars?.length>=10) {
    const last10=dailyBars.slice(-10), last5=dailyBars.slice(-5), last3=dailyBars.slice(-3);
    const high10=Math.max(...last10.map(b=>b.h));
    const pctHigh=(close-high10)/high10*100;
    const atrEst=atr||(Math.max(...last10.map(b=>b.h))-Math.min(...last10.map(b=>b.l)))/10;

    // Consolidação: range estreito
    const l5Range=Math.max(...last5.map(b=>b.h))-Math.min(...last5.map(b=>b.l));
    if (l5Range<atrEst*2.5&&rsi>=42&&rsi<=60)
      return {label:'Consolidação', color:'#9e9e9e', icon:'⬌', score:0};

    // Pullback: retracção saudável em tendência
    const bouncing=last3.length>=2&&last3.at(-1).c>=last3.at(-2).c;
    if (pctHigh<-1.5&&pctHigh>-9&&bouncing&&rsi>=40&&rsi<65)
      return {label:'Pullback', color:'#26a69a', icon:'↩', score:2};

    // Breakout: perto do high recente com momentum
    if (Math.abs(pctHigh)<2&&rsi>=55&&rsi<73)
      return {label:'Breakout', color:'#2196f3', icon:'📈', score:2};
  }

  // Tendência bullish limpa: EMAs alinhadas, RSI zona bullish
  if (bullAlign&&rsi>=50&&rsi<68&&close>(ema50||0))
    return {label:'Tendência bullish', color:'#00c853', icon:'📊', score:3};

  if (rsi>=55&&rsi<73&&close>(ema50||0)) return {label:'Breakout',    color:'#2196f3', icon:'📈', score:2};
  if (rsi>=42&&rsi<=58&&close>(ema50||0)) return {label:'Pullback',   color:'#26a69a', icon:'↩',  score:1};
  return {label:'Indefinido', color:'#9e9e9e', icon:'?', score:0};
}

// ─── PRICE ACTION: Risco estrutural ──────────────────────────────────────────
function getStructuralRisk(c, pattern, structure, alignment) {
  const rsi=c['RSI']??50, stochK=c['Stoch.K']??50;
  const bbUp=c['BB.upper'], bbLo=c['BB.lower'];
  const close=c['close'];
  const bbPos=bbUp!=null&&bbLo!=null&&(bbUp-bbLo)>0?(close-bbLo)/(bbUp-bbLo)*100:50;

  // 🔴 Alto
  if (pattern?.bearish===true ||
      structure.label==='⚠️ Possível reversão' ||
      structure.label==='Extensão' ||
      (rsi>70&&structure.label!=='Pullback') ||
      alignment.short==='Desalinhado')
    return {emoji:'🔴', label:'Alto', color:'#ef5350', bg:'#ffebee', score:-2};

  // 🟡 Médio
  if (structure.label==='Consolidação' ||
      structure.label==='Resistência'  ||
      alignment.short==='Parcial'&&!alignment.bullish ||
      pattern?.label==='Range')
    return {emoji:'🟡', label:'Médio', color:'#ff9800', bg:'#fff8e1', score:0};

  // 🟢 Baixo
  return {emoji:'🟢', label:'Baixo', color:'#26a69a', bg:'#e8f5e9', score:1};
}

// ─── Setup ────────────────────────────────────────────────────────────────────
function getSetup(c, structure, alignment, vwapPct, pattern, structuralRisk) {
  const rsi=c['RSI']??50;
  const mh=c['MACD.hist']??0, mhP=c['MACD.hist[1]']??0;
  const relVol=c['relative_volume_10d_calc']??1;
  const macdGrow=mh>mhP;
  const vwapOk=vwapPct==null||(vwapPct>-1.5&&vwapPct<1.5);

  if (pattern?.bearish===true || structure.label==='⚠️ Possível reversão')
    return {label:'⚠️ Possível reversão', color:'#ef5350', score:-1};

  if (structure.label==='Extensão')
    return {label:'Extensão (esperar)', color:'#ff9800', score:0};

  if (structure.label==='Pullback'&&alignment.bullish&&macdGrow&&vwapOk&&rsi>40&&rsi<68)
    return {label:'Pullback + continuação', color:'#26a69a', score:3};

  if (structure.label==='Tendência bullish'&&alignment.bullish&&vwapOk&&rsi<68)
    return {label:'Pullback + continuação', color:'#26a69a', score:3};

  if (structure.label==='Breakout'&&alignment.short!=='Desalinhado'&&mh>0&&macdGrow&&relVol>=1.1)
    return {label:'Breakout válido', color:'#2196f3', score:2};

  if (structure.label==='Consolidação'&&alignment.bullish&&vwapOk)
    return {label:'Consolidação (aguardar)', color:'#9c27b0', score:1};

  return {label:'Sem setup claro', color:'#9e9e9e', score:0};
}

// ─── Sinal Final ─────────────────────────────────────────────────────────────
function getSignal(c, setup, alignment, vwapPct, structure, structuralRisk, pattern) {
  const rsi=c['RSI']??50;
  const rsi1h=c['RSI|60'], rsi1hP=c['RSI[1]|60'];
  const mh=c['MACD.hist']??0, mhP=c['MACD.hist[1]']??0;

  // 🔴 Evitar — condições de exclusão directa
  if (pattern?.bearish===true ||
      structure.label==='⚠️ Possível reversão' ||
      structuralRisk.label==='Alto' ||
      rsi>70 ||
      structure.label==='Extensão' ||
      (vwapPct!=null&&vwapPct>1.5) ||
      alignment.short==='Desalinhado')
    return {emoji:'🔴', text:'Evitar', color:'#b71c1c', bg:'#ffebee', score:0};

  const rsi1hRising = rsi1h!=null&&rsi1hP!=null&&rsi1h>rsi1hP+0.3;
  const macdGrow    = mh>mhP;
  const goodSetup   = setup.label==='Pullback + continuação'||setup.label==='Breakout válido';
  const rsiOk       = rsi>40&&rsi<68;
  const vwapOk      = vwapPct==null||(vwapPct>-1.5&&vwapPct<1.5);
  const riskOk      = structuralRisk.label==='Baixo';

  // 🟢 Entrada possível — tudo tem de estar alinhado
  if (goodSetup&&rsiOk&&(rsi1hRising||macdGrow)&&vwapOk&&riskOk)
    return {emoji:'🟢', text:'Entrada possível', color:'#1b5e20', bg:'#e8f5e9', score:10};

  // 🟡 Esperar confirmação
  return {emoji:'🟡', text:'Esperar confirmação', color:'#e65100', bg:'#fff8e1', score:5};
}

// ─── Construir registo completo ───────────────────────────────────────────────
function buildRecord(cand, dailyBars, now) {
  const close=cand['close'], open=cand['open'];
  const prevClose=open!=null?r2(close/(1+(cand['change']||0)/100)):null;
  const ema9=cand['EMA9'],ema20=cand['EMA20'],ema50=cand['EMA50'],ema100=cand['EMA100'],ema200=cand['EMA200'];
  const allEmas=[ema9,ema20,ema50,ema100,ema200].every(e=>e!=null);
  const priceAboveAll=allEmas?close>ema9&&close>ema20&&close>ema50&&close>ema100&&close>ema200:close>(ema50||0);
  const bullAlign=allEmas?ema9>ema20&&ema20>ema50&&ema50>ema100&&ema100>ema200:false;
  const rsiVal=cand['RSI']??50, rsiPrev=cand['RSI[1]']??rsiVal;
  const macdLine=cand['MACD.macd']??0, macdSig=cand['MACD.signal']??0;
  const macdHist=cand['MACD.hist']??0, macdHistP=cand['MACD.hist[1]']??macdHist, macdHistP2=cand['MACD.hist[2]'];
  const bbUp=cand['BB.upper'],bbLo=cand['BB.lower'],bbMid=cand['BB.basis'];
  const bbRange=bbUp!=null&&bbLo!=null&&(bbUp-bbLo)>0;
  const bbPos=bbRange?(close-bbLo)/(bbUp-bbLo)*100:50;
  const stochK=cand['Stoch.K']??50, stochD=cand['Stoch.D']??50;
  const adxVal=cand['ADX'],adxPdi=cand['ADX+DI'],adxNdi=cand['ADX-DI'];
  const dominant=adxPdi!=null&&adxNdi!=null?(adxPdi>adxNdi?'buyers':'sellers'):'unknown';
  const atrVal=cand['ATR'];
  const sugStop=atrVal!=null?r2(close-2*atrVal):null;
  const riskPct=atrVal!=null&&close>0?r2((close-sugStop)/close*100):null;
  const volLast=cand['volume'],volAvg10=cand['average_volume_10d_calc'],relVol=cand['relative_volume_10d_calc']??1;
  const vwapTV=cand['VWAP'];
  const vwapVal=vwapTV??calcVWAPFromDaily(dailyBars,5);
  const vwapPct=vwapVal&&close?r2((close-vwapVal)/vwapVal*100):null;
  const rsi4h=cand['RSI|240'],rsi4hP=cand['RSI[1]|240'];
  const mh4h=cand['MACD.hist|240'],mh4hP1=cand['MACD.hist[1]|240'],mh4hP2=cand['MACD.hist[2]|240'];
  const ml4h=cand['MACD.macd|240'],ms4h=cand['MACD.signal|240'];
  const rsi1h=cand['RSI|60'],rsi1hP=cand['RSI[1]|60'];
  const mh1h=cand['MACD.hist|60'],mh1hP1=cand['MACD.hist[1]|60'],mh1hP2=cand['MACD.hist[2]|60'];
  const ml1h=cand['MACD.macd|60'],ms1h=cand['MACD.signal|60'];

  // ── Análise por camadas ──
  const vwapClass    = getVwapClass(vwapPct);
  const macdDTrend   = getMacdHistTrend(macdHistP2, macdHistP, macdHist);
  const macd4hTrend  = getMacdHistTrend(mh4hP2, mh4hP1, mh4h);
  const macd1hTrend  = getMacdHistTrend(mh1hP2??null, mh1hP1, mh1h);
  const alignment    = getAlignment(cand);
  const pattern      = detectPattern(dailyBars, close, atrVal);
  const priceZone    = getPriceZone(cand, dailyBars);
  const structure    = getStructure(cand, dailyBars, pattern);
  const structRisk   = getStructuralRisk(cand, pattern, structure, alignment);
  const setup        = getSetup(cand, structure, alignment, vwapPct, pattern, structRisk);
  const signal       = getSignal(cand, setup, alignment, vwapPct, structure, structRisk, pattern);

  // ── Prioridade TF + Correcção de Risco (aplicadas após o sinal base) ──
  const tfPriority     = getTfPriority(cand);
  const riskCorrection = getRiskCorrection(cand, priceZone, vwapPct);

  let finalSignal = {...signal};
  // Regras de TF (Diário é dominante — 1H só serve para timing)
  if (tfPriority.bearish && finalSignal.emoji==='🟢')
    finalSignal = {emoji:'🔴', text:'Evitar', color:'#b71c1c', bg:'#ffebee', score:0, reason:'D bearish'};
  else if (tfPriority.losingMomentum && finalSignal.emoji==='🟢')
    finalSignal = {emoji:'🟡', text:'Esperar confirmação', color:'#e65100', bg:'#fff8e1', score:5, reason:'D momentum ↓'};
  // Correcção de risco (aplicada em cima das regras de TF)
  if (riskCorrection.count >= 3 && finalSignal.emoji!=='🔴')
    finalSignal = {...finalSignal, emoji:'🔴', text:'Evitar', color:'#b71c1c', bg:'#ffebee', score:0, reason:`${riskCorrection.count} fatores risco`};
  else if (riskCorrection.count >= 2 && finalSignal.emoji==='🟢')
    finalSignal = {...finalSignal, emoji:'🟡', text:'Esperar confirmação', color:'#e65100', bg:'#fff8e1', score:5, reason:`${riskCorrection.count} fatores risco`};

  // ── Validação de Momentum (obrigatória para qualquer entrada) ──
  // RSI 1H a cair E RSI 4H a cair/neutro → nunca 🟢 nem 🟡
  const rsi1hFalling       = rsi1h!=null&&rsi1hP!=null&&rsi1h < rsi1hP-0.3;
  const rsi4hFallOrNeutral = rsi4h==null||rsi4hP==null||rsi4h <= rsi4hP+0.3;
  if (rsi1hFalling && rsi4hFallOrNeutral && finalSignal.emoji!=='🔴')
    finalSignal = {emoji:'🔴', text:'Evitar', color:'#b71c1c', bg:'#ffebee', score:0, reason:'Momentum 1H+4H ↓'};

  // ── Regra de Topo ──
  // Zona=Resistência + RSI 1H não sobe + MACD D a enfraquecer → 🔴
  const rsi1hNotRising = rsi1h==null||rsi1hP==null||rsi1h <= rsi1hP+0.3;
  const macdDWeakening = macdHist < macdHistP;
  if (priceZone.label==='Resistência' && rsi1hNotRising && macdDWeakening && finalSignal.emoji!=='🔴')
    finalSignal = {emoji:'🔴', text:'Evitar', color:'#b71c1c', bg:'#ffebee', score:0, reason:'Topo: resistência + sem momentum'};

  // ── Validação de 🟡 (condições mínimas obrigatórias) ──
  // 🟡 só é válido se: estrutura pullback/consolidação + RSI 1H não a cair + fora de resistência
  if (finalSignal.emoji==='🟡') {
    const validStruct = structure.label==='Pullback'||structure.label==='Consolidação';
    const rsi1hOk     = rsi1h==null||rsi1hP==null||rsi1h >= rsi1hP-0.3;
    const notResist   = priceZone.label!=='Resistência';
    if (!(validStruct && rsi1hOk && notResist)) {
      const why=[];
      if (!validStruct) why.push('estrutura inválida');
      if (!rsi1hOk)     why.push('RSI 1H ↓');
      if (!notResist)   why.push('em resistência');
      finalSignal = {...finalSignal, emoji:'🔴', text:'Evitar', color:'#b71c1c', bg:'#ffebee', score:0, reason:why.join(' · ')};
    }
  }

  // ── Prioridade do Diário — reforço: MACD D claramente decrescente ──
  // "Claramente decrescente" = 3 barras consecutivas a cair (trend==='falling')
  const macdDClearlyDecreasing = macdDTrend.trend === 'falling';
  if (macdDClearlyDecreasing) {
    // Nunca permite 🟢
    if (finalSignal.emoji==='🟢')
      finalSignal = {emoji:'🔴', text:'Evitar', color:'#b71c1c', bg:'#ffebee', score:0, reason:'MACD D decrescente'};
    // 🟡 só sobrevive se estrutura OK + RSI 1H claramente a subir (↑)
    if (finalSignal.emoji==='🟡') {
      const validStruct  = structure.label==='Pullback'||structure.label==='Consolidação';
      const rsi1hRising  = rsi1h!=null&&rsi1hP!=null&&rsi1h > rsi1hP+0.3;
      if (!(validStruct && rsi1hRising))
        finalSignal = {emoji:'🔴', text:'Evitar', color:'#b71c1c', bg:'#ffebee', score:0, reason:'MACD D ↓↓ · sem confirmação 1H'};
    }
  }

  const sortScore = finalSignal.score + setup.score + alignment.score + vwapClass.score + structure.score + structRisk.score + pattern.score;

  // ── Score técnico para JSON ──
  const rsiSig=rsiSignal(rsiVal), macdTrend=macdHist>macdHistP?'improving':'deteriorating', macdCross=macdLine>macdSig?'bullish':'bearish';
  const bbSig=bbSignal(bbPos);
  let score=0, signals=[];
  if(rsiSig==='bullish_zone'){score+=2;signals.push('RSI bullish zone');}
  if(rsiSig==='oversold'){score+=2;signals.push('RSI oversold');}
  if(macdTrend==='improving'){score+=2;signals.push('MACD improving');}
  if(macdCross==='bullish'){score+=1;signals.push('MACD line > signal');}
  if(priceAboveAll){score+=2;signals.push('Above all EMAs');}
  if(bullAlign){score+=1;signals.push('EMAs aligned');}
  if(dominant==='buyers'){score+=1;signals.push('Buyers dominant');}
  if(bbSig==='oversold'){score+=2;signals.push('BB oversold');}
  if(rsiSig==='overbought'){score-=2;signals.push('RSI overbought');}
  if(bbSig==='overbought'){score-=1;signals.push('BB overbought');}
  if(stochK>80){score-=1;signals.push('Stoch overbought');}
  if((cand['change|1W']??0)<-3){score-=1;signals.push('Weak weekly trend');}
  if(rsi4h!=null){
    if(rsi4h>=50&&rsi4h<70){score+=1;signals.push('RSI 4H bullish zone');}
    if(rsi4h<30){score+=1;signals.push('RSI 4H oversold');}
    if(rsi4h>70){score-=1;signals.push('RSI 4H overbought');}
    if(mh4h!=null&&mh4hP1!=null&&mh4h>mh4hP1){score+=1;signals.push('MACD 4H improving');}
  }
  if(rsi1h!=null){
    if(rsi1h<30){score+=1;signals.push('RSI 1H oversold');}
    if(rsi1h>70){score-=1;signals.push('RSI 1H overbought');}
    if(mh1h!=null&&mh1hP1!=null&&mh1h>mh1hP1){score+=1;signals.push('MACD 1H improving');}
  }
  if(vwapPct!=null&&vwapPct>0){score+=1;signals.push(`Above VWAP +${vwapPct}%`);}

  const [exchange, ticker] = cand.tvSymbol.split(':');
  return {
    _sortScore: sortScore,
    symbol:ticker, tvSymbol:cand.tvSymbol,
    name:cand.description||cand.tvSymbol, sector:cand.sector||'—',
    price:{current:close, change_pct:r2(cand.change||0), prev_close:prevClose},
    rsi:{
      d:  {value:r1(rsiVal), prev:r1(rsiPrev), dir:rsiDir(rsiVal,rsiPrev), signal:rsiSig},
      h4: rsi4h!=null?{value:r1(rsi4h), prev:r1(rsi4hP), dir:rsiDir(rsi4h,rsi4hP), signal:rsiSignal(rsi4h)}:null,
      h1: rsi1h!=null?{value:r1(rsi1h), prev:r1(rsi1hP), dir:rsiDir(rsi1h,rsi1hP), signal:rsiSignal(rsi1h)}:null,
    },
    macd:{d:macdDTrend, h4:macd4hTrend, h1:macd1hTrend},
    ema:{ema50:ema50!=null?{value:r2(ema50),pct:pct(close,ema50)}:null, ema100:ema100!=null?{value:r2(ema100),pct:pct(close,ema100)}:null, price_above_all:priceAboveAll, bullish_alignment:bullAlign},
    volume:{last:volLast?Math.round(volLast):null, avg10:volAvg10?Math.round(volAvg10):null, ratio:r2(relVol)},
    vwap:{value:vwapVal, pct:vwapPct, class:vwapClass, source:vwapTV!=null?'tv':'calc'},
    tvRecommend:cand['Recommend.All'],
    // ── Novos campos de price action ──
    pattern, priceZone, structRisk,
    // ── Análise existente + TF priority + risk correction ──
    alignment, structure, setup, signal:finalSignal, tfPriority, riskCorrection,
    // ── Para JSON ──
    _json:{
      symbol:ticker, name:cand.description||cand.tvSymbol, sector:cand.sector||null, analysis_date:now,
      screener:{exchange, price:r2(close), chg:r2(cand['change']), rsi:r2(rsiVal), macd:r2(macdHist), ema50:r2(ema50), ema100:r2(ema100), relVol:r2(relVol), mktCap:formatMktCap(cand['market_cap_basic']), rating:tvRating(cand['Recommend.All']), div:r2(cand['dividends_yield']), earnings:formatEarnings(cand['earnings_release_next_date'])},
      tv_symbol:cand.tvSymbol, price:{current:r2(close), prev_close:prevClose},
      price_action:{pattern:{label:pattern.label,bearish:pattern.bearish}, price_zone:priceZone.label, structural_risk:{level:structRisk.label}, structure:structure.label, setup:setup.label, signal:finalSignal.text, tf_priority:tfPriority.label, risk_correction:{count:riskCorrection.count, factors:riskCorrection.factors}},
      indicators:{
        ema:{ema9:ema9!=null?{value:r2(ema9),pct_from_price:r2(Math.abs(close-ema9)/close*100)}:null,ema20:ema20!=null?{value:r2(ema20),pct_from_price:r2(Math.abs(close-ema20)/close*100)}:null,ema50:ema50!=null?{value:r2(ema50),pct_from_price:r2(Math.abs(close-ema50)/close*100)}:null,ema100:ema100!=null?{value:r2(ema100),pct_from_price:r2(Math.abs(close-ema100)/close*100)}:null,ema200:ema200!=null?{value:r2(ema200),pct_from_price:r2(Math.abs(close-ema200)/close*100)}:null,price_above_all:priceAboveAll,bullish_alignment:bullAlign},
        rsi:{value:r2(rsiVal),prev:r2(rsiPrev),direction:rsiVal>rsiPrev+0.2?'rising':rsiVal<rsiPrev-0.2?'falling':'flat',signal:rsiSig},
        stochastic:{k:r2(stochK),d:r2(stochD),signal:stochSignal(stochK)},
        macd:{line:r2(macdLine),signal:r2(macdSig),hist:r2(macdHist),hist_prev:r2(macdHistP),trend:macdTrend,signal_cross:macdCross},
        bollinger:{upper:r2(bbUp),mid:r2(bbMid),lower:r2(bbLo),position_pct:r2(bbPos),signal:bbSig},
        adx:{value:r2(adxVal),plus_di:r2(adxPdi),minus_di:r2(adxNdi),strength:adxStrength(adxVal),dominant},
        atr:atrVal!=null?{value:r2(atrVal),suggested_stop:sugStop,risk_pct:riskPct}:null,
        price_trend:{week1_pct:r2(cand['change|1W']),week2_pct:r2(cand['change|2W']),month1_pct:r2(cand['change|1M'])},
        volume:{last:volLast?Math.round(volLast):null,avg10:volAvg10?Math.round(volAvg10):null,ratio:r2(relVol)},
        rsi_4h:rsi4h!=null?{value:r2(rsi4h),prev:r2(rsi4hP),direction:rsi4h>rsi4hP+0.2?'rising':rsi4h<rsi4hP-0.2?'falling':'flat',signal:rsiSignal(rsi4h)}:null,
        rsi_1h:rsi1h!=null?{value:r2(rsi1h),prev:r2(rsi1hP),direction:rsi1h>rsi1hP+0.2?'rising':rsi1h<rsi1hP-0.2?'falling':'flat',signal:rsiSignal(rsi1h)}:null,
        macd_4h:mh4h!=null?{hist:r2(mh4h),hist_prev1:r2(mh4hP1),hist_prev2:r2(mh4hP2),line:r2(ml4h),signal:r2(ms4h),trend:mh4hP1!=null?(mh4h>mh4hP1?'improving':'deteriorating'):'unknown',signal_cross:ml4h!=null&&ms4h!=null?(ml4h>ms4h?'bullish':'bearish'):'unknown'}:null,
        macd_1h:mh1h!=null?{hist:r2(mh1h),hist_prev1:r2(mh1hP1),hist_prev2:r2(mh1hP2),line:r2(ml1h),signal:r2(ms1h),trend:mh1hP1!=null?(mh1h>mh1hP1?'improving':'deteriorating'):'unknown',signal_cross:ml1h!=null&&ms1h!=null?(ml1h>ms1h?'bullish':'bearish'):'unknown'}:null,
        vwap:vwapVal!=null?{value:vwapVal,source:vwapTV!=null?'tradingview':'daily_bars_approx',price_vs_vwap:close>=vwapVal?'above':'below',pct_from_vwap:vwapPct}:null
      },
      composite:{score,signals,verdict:scoreVerdict(score)},
      ohlcv:dailyBars?{bars:dailyBars.length,data:dailyBars}:null
    }
  };
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
function generateHTML(records, dateStr) {
  const green  = records.filter(r=>r.signal.emoji==='🟢').length;
  const yellow = records.filter(r=>r.signal.emoji==='🟡').length;
  const red    = records.filter(r=>r.signal.emoji==='🔴').length;

  function rsiCell(rsiObj) {
    if (!rsiObj) return '<span class="nd">N/D</span>';
    const vc = rsiObj.value>70?'val-red':rsiObj.value<30?'val-green':'val-white';
    const dc = rsiObj.dir==='↑'?'dir-up':rsiObj.dir==='↓'?'dir-dn':'dir-neu';
    return `<span class="${vc}">${rsiObj.value}</span><span class="${dc}"> ${rsiObj.dir}</span>`;
  }

  function macdCell(macdObj) {
    if (!macdObj||macdObj.bars[1]==null||macdObj.bars[2]==null) return '<span class="nd">N/D</span>';
    const [h2,h1,h0]=[macdObj.bars[0],macdObj.bars[1],macdObj.bars[2]];
    const fmt = v => v==null?'?':v.toFixed(2);
    // Sempre 3 barras — h2 mostra '?' se o API não devolveu o valor
    return `<span class="macd-bars" style="color:${macdObj.color}">${fmt(h2)} → ${fmt(h1)} → ${fmt(h0)}</span><br><span class="tag" style="background:${macdObj.color}20;color:${macdObj.color}">${macdObj.label}</span>`;
  }

  function tvRecCell(v) {
    if (v==null) return '<span class="nd">N/D</span>';
    const c=v>=0.5?'#26a69a':v>=0.1?'#66bb6a':v>-0.1?'#ff9800':v>-0.5?'#ef9a9a':'#ef5350';
    return `<span style="color:${c};font-weight:600">${tvRating(v)}</span>`;
  }

  const rows = records.map((r,i) => {
    const chgC      = r.price.change_pct>=0?'val-green':'val-red';
    const chgS      = r.price.change_pct>=0?'+':'';
    const volC      = r.volume.ratio>=1.5?'val-blue':r.volume.ratio>=1?'val-white':'val-dim';
    const ema50pct  = r.ema.ema50?.pct;
    const ema100pct = r.ema.ema100?.pct;

    return `<tr class="row-${i%2===0?'even':'odd'}">

  <!-- SINAL FINAL (destacado) -->
  <td class="col-signal">
    <div class="signal-badge" style="background:${r.signal.bg};border-left:4px solid ${r.signal.color}">
      <span class="signal-emoji">${r.signal.emoji}</span>
      <div>
        <span class="signal-text" style="color:${r.signal.color}">${r.signal.text}</span>
        ${r.signal.reason?`<div class="signal-reason">${r.signal.reason}</div>`:''}
      </div>
    </div>
  </td>

  <!-- ACÇÃO -->
  <td class="col-stock">
    <div class="stock-ticker">${r.symbol}</div>
    <div class="stock-name">${r.name}</div>
    <div class="stock-sector">${r.sector}</div>
  </td>

  <!-- PREÇO -->
  <td class="col-price">
    <div class="price-val">${r.price.current.toFixed(2)}</div>
    <div class="${chgC} price-chg">${chgS}${r.price.change_pct}%</div>
  </td>

  <!-- RSI D / 4H / 1H -->
  <td class="col-rsi">
    <div class="tf-row"><span class="tf-lbl">D</span>${rsiCell(r.rsi.d)}</div>
    <div class="tf-row"><span class="tf-lbl">4H</span>${rsiCell(r.rsi.h4)}</div>
    <div class="tf-row"><span class="tf-lbl">1H</span>${rsiCell(r.rsi.h1)}</div>
  </td>

  <!-- MACD HIST -->
  <td class="col-macd">
    <div class="tf-section"><span class="tf-lbl-sm">D&nbsp;</span>${macdCell(r.macd.d)}</div>
    <div class="tf-section mt4"><span class="tf-lbl-sm">4H</span>${macdCell(r.macd.h4)}</div>
    <div class="tf-section mt4"><span class="tf-lbl-sm">1H</span>${macdCell(r.macd.h1)}</div>
  </td>

  <!-- EMA 50 / 100 -->
  <td class="col-ema">
    <div class="ema-row"><span class="tf-lbl">50</span>
      <span class="${ema50pct!=null&&ema50pct>0?'val-green':'val-red'}">${r.ema.ema50?`${r.ema.ema50.value.toFixed(0)} <small>(${ema50pct!=null?(ema50pct>0?'+':'')+ema50pct+'%':''})</small>`:'N/D'}</span>
    </div>
    <div class="ema-row mt2"><span class="tf-lbl">100</span>
      <span class="${ema100pct!=null&&ema100pct>0?'val-green':'val-red'}">${r.ema.ema100?`${r.ema.ema100.value.toFixed(0)} <small>(${ema100pct!=null?(ema100pct>0?'+':'')+ema100pct+'%':''})</small>`:'N/D'}</span>
    </div>
    <div class="mt4">${r.ema.price_above_all?'<span class="tag" style="background:#26a69a20;color:#26a69a">Acima todas</span>':'<span class="tag" style="background:#ef535020;color:#ef5350">Parcial</span>'}</div>
    ${r.ema.bullish_alignment?'<div><span class="tag" style="background:#2196f320;color:#2196f3">Alinhadas ↑</span></div>':''}
  </td>

  <!-- VOLUME -->
  <td class="col-vol">
    <div class="${volC} vol-ratio">${r.volume.ratio}×</div>
    <div class="vol-abs">${r.volume.last?Math.round(r.volume.last/1000)+'K':'—'}</div>
    ${r.volume.ratio>=1.5?'<div><span class="tag" style="background:#2196f320;color:#2196f3">Vol alto</span></div>':''}
  </td>

  <!-- VWAP -->
  <td class="col-vwap">
    <div class="vwap-pct" style="color:${r.vwap.class.color}">${r.vwap.pct!=null?(r.vwap.pct>0?'+':'')+r.vwap.pct+'%':'N/D'}</div>
    <div class="vwap-val">${r.vwap.value!=null?r.vwap.value.toFixed(2):''}</div>
    <div><span class="tag" style="background:${r.vwap.class.color}20;color:${r.vwap.class.color}">${r.vwap.class.label}</span></div>
  </td>

  <!-- ALINHAMENTO MULTI-TF -->
  <td class="col-align">
    <span class="align-badge" style="background:${r.alignment.color}20;color:${r.alignment.color}">${r.alignment.label}</span>
    ${r.tfPriority.label!=='D OK'?`<div class="mt4"><span class="tag" style="background:${r.tfPriority.color}20;color:${r.tfPriority.color}">${r.tfPriority.label}</span></div>`:''}
  </td>

  <!-- 🧠 PRICE ACTION: Estrutura + Padrão + Zona -->
  <td class="col-pa">
    <div class="pa-block">
      <div class="pa-label">Estrutura</div>
      <span class="pa-badge" style="background:${r.structure.color}20;color:${r.structure.color};border-left:3px solid ${r.structure.color}">${r.structure.icon} ${r.structure.label}</span>
    </div>
    <div class="pa-block mt6">
      <div class="pa-label">Padrão</div>
      <span class="tag" style="background:${r.pattern.color}20;color:${r.pattern.color}">${r.pattern.label}</span>
    </div>
    <div class="pa-block mt4">
      <div class="pa-label">Zona</div>
      <span class="tag" style="background:${r.priceZone.color}20;color:${r.priceZone.color}">${r.priceZone.label}</span>
    </div>
  </td>

  <!-- RISCO ESTRUTURAL -->
  <td class="col-risk">
    <div class="risk-badge" style="background:${r.structRisk.bg};border:1px solid ${r.structRisk.color}20">
      <span class="risk-emoji">${r.structRisk.emoji}</span>
      <span class="risk-label" style="color:${r.structRisk.color}">${r.structRisk.label}</span>
    </div>
    ${r.riskCorrection.count>=2?`<div class="mt4">${r.riskCorrection.factors.map(f=>`<div class="rc-factor">• ${f}</div>`).join('')}</div>`:''}
  </td>

  <!-- SETUP + TV RATING (destacado) -->
  <td class="col-setup">
    <div class="setup-wrap" style="border-left:3px solid ${r.setup.color}">
      <span class="setup-label" style="color:${r.setup.color}">${r.setup.label}</span>
    </div>
    <div class="tv-rec mt6">${tvRecCell(r.tvRecommend)}</div>
  </td>

</tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trading Dashboard — ${SCREENER_NAME}</title>
<style>
  :root {
    --bg:#0f1929;--bg2:#131c2e;--bg3:#1a2540;--bg4:#1e2d4a;
    --border:#2a3a5c;--text:#d1d4dc;--dim:#6b7a99;--white:#e8eaf0;
    --green:#26a69a;--green2:#00e676;--red:#ef5350;--yellow:#ff9800;
    --blue:#2196f3;--purple:#9c27b0;--orange:#ff6f00;
    --font:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:12px;line-height:1.4;}

  /* HEADER */
  .header{background:linear-gradient(135deg,#0d1b2e,#1a2d4a);padding:20px 28px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;}
  .header h1{font-size:18px;font-weight:700;color:var(--white);}
  .header p{font-size:11px;color:var(--dim);margin-top:4px;}

  /* SUMMARY */
  .summary{display:flex;gap:12px;padding:14px 28px;background:var(--bg2);border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center;}
  .summary-card{display:flex;align-items:center;gap:8px;background:var(--bg3);border-radius:8px;padding:10px 16px;border:1px solid var(--border);}
  .summary-emoji{font-size:20px;}
  .summary-label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;}
  .summary-count{font-size:22px;font-weight:700;line-height:1;}
  .sc-green{color:var(--green);}.sc-yellow{color:var(--yellow);}.sc-red{color:var(--red);}
  .summary-hint{margin-left:auto;font-size:11px;color:var(--dim);}

  /* TABLE */
  .table-wrap{overflow-x:auto;padding:0 0 20px;}
  table{width:100%;border-collapse:collapse;min-width:1400px;}
  thead tr{background:var(--bg2);border-bottom:2px solid var(--border);}
  thead th{padding:10px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);font-weight:600;white-space:nowrap;}
  thead th.th-highlight{color:var(--white);background:rgba(33,150,243,.08);}
  .row-even{background:var(--bg3);}.row-odd{background:var(--bg4);}
  tr{border-bottom:1px solid var(--border);transition:background .15s;}
  tr:hover{background:#233050!important;}
  td{padding:10px 12px;vertical-align:top;}

  /* SINAL */
  .col-signal{min-width:165px;}
  .signal-badge{border-radius:6px;padding:8px 12px;display:flex;align-items:center;gap:6px;}
  .signal-emoji{font-size:18px;flex-shrink:0;}
  .signal-text{font-size:12px;font-weight:700;}
  .signal-reason{font-size:9px;color:var(--dim);margin-top:2px;font-style:italic;}

  /* ACÇÃO */
  .col-stock{min-width:140px;}
  .stock-ticker{font-size:14px;font-weight:700;color:var(--white);}
  .stock-name{font-size:11px;color:var(--text);margin-top:2px;}
  .stock-sector{font-size:10px;color:var(--dim);margin-top:2px;}

  /* PREÇO */
  .col-price{min-width:80px;text-align:right;}
  .price-val{font-size:14px;font-weight:700;color:var(--white);}
  .price-chg{font-size:11px;margin-top:2px;}

  /* RSI */
  .col-rsi{min-width:110px;}
  .tf-row{display:flex;align-items:center;gap:4px;margin-bottom:3px;}
  .tf-lbl{font-size:9px;color:var(--dim);text-transform:uppercase;width:18px;flex-shrink:0;font-weight:600;}
  .tf-lbl-sm{font-size:9px;color:var(--dim);width:14px;flex-shrink:0;font-weight:600;}

  /* MACD */
  .col-macd{min-width:165px;}
  .tf-section{display:flex;align-items:flex-start;gap:4px;}
  .macd-bars{font-size:10px;font-family:'Courier New',monospace;}
  .mt4{margin-top:6px;}.mt2{margin-top:3px;}.mt6{margin-top:8px;}

  /* EMA */
  .col-ema{min-width:145px;}
  .ema-row{display:flex;align-items:center;gap:6px;}

  /* VOL */
  .col-vol{min-width:90px;text-align:center;}
  .vol-ratio{font-size:16px;font-weight:700;}
  .vol-abs{font-size:10px;color:var(--dim);margin-top:2px;}

  /* VWAP */
  .col-vwap{min-width:105px;}
  .vwap-pct{font-size:16px;font-weight:700;}
  .vwap-val{font-size:10px;color:var(--dim);margin-top:1px;}

  /* ALINHAMENTO */
  .col-align{min-width:115px;}
  .align-badge{display:inline-block;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;white-space:nowrap;}

  /* 🧠 PRICE ACTION */
  .col-pa{min-width:190px;background:rgba(33,150,243,.03);}
  .pa-block{}
  .pa-label{font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);margin-bottom:3px;}
  .pa-badge{display:block;padding:4px 8px;border-radius:4px;font-size:11px;font-weight:600;}

  /* RISCO */
  .col-risk{min-width:90px;text-align:center;background:rgba(33,150,243,.03);}
  .risk-badge{display:inline-flex;flex-direction:column;align-items:center;gap:3px;padding:8px 12px;border-radius:8px;width:100%;}
  .risk-emoji{font-size:20px;}
  .risk-label{font-size:11px;font-weight:700;}
  .rc-factor{font-size:9px;color:#ef9a9a;margin-top:2px;text-align:left;}

  /* SETUP */
  .col-setup{min-width:175px;background:rgba(33,150,243,.03);}
  .setup-wrap{padding:6px 10px;border-radius:4px;background:rgba(255,255,255,.03);}
  .setup-label{font-size:12px;font-weight:700;line-height:1.4;}
  .tv-rec{font-size:11px;}

  /* TAGS */
  .tag{display:inline-block;padding:2px 6px;border-radius:3px;font-size:9px;font-weight:600;white-space:nowrap;}
  .nd{color:var(--dim);font-size:10px;}

  /* CORES */
  .val-green{color:var(--green);font-weight:600;}
  .val-red{color:var(--red);font-weight:600;}
  .val-blue{color:var(--blue);font-weight:600;}
  .val-white{color:var(--white);}
  .val-dim{color:var(--dim);}
  .dir-up{color:var(--green);font-weight:700;}
  .dir-dn{color:var(--red);font-weight:700;}
  .dir-neu{color:var(--dim);}

  /* SECÇÕES DO CABEÇALHO */
  .th-pa{background:rgba(33,150,243,.12)!important;color:#90caf9!important;}
  .th-risk{background:rgba(33,150,243,.12)!important;color:#90caf9!important;}
  .th-setup{background:rgba(33,150,243,.12)!important;color:#90caf9!important;}
  .th-signal{background:rgba(38,166,154,.12)!important;color:#80cbc4!important;}

  /* LEGENDA */
  .legend{padding:20px 28px;background:var(--bg2);border-top:1px solid var(--border);display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;}
  .legend-section h4{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);margin-bottom:8px;border-bottom:1px solid var(--border);padding-bottom:4px;}
  .legend-item{display:flex;gap:8px;margin-bottom:5px;font-size:11px;}
  .legend-key{font-weight:600;min-width:110px;color:var(--white);}
  .legend-val{color:var(--dim);}
  .footer{padding:12px 28px;background:var(--bg);border-top:1px solid var(--border);font-size:10px;color:var(--dim);text-align:center;}
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>📊 Trading Dashboard — ${SCREENER_NAME}</h1>
    <p>${dateStr} &nbsp;·&nbsp; TradingView Screener (D + 4H + 1H nativos) + OHLCV 300 velas &nbsp;·&nbsp; ${records.length} acções</p>
  </div>
  <div style="text-align:right;font-size:10px;color:var(--dim)">Ordenado por: melhor sinal → setup → alinhamento → VWAP</div>
</div>

<div class="summary">
  <div class="summary-card">
    <span class="summary-emoji">🟢</span>
    <div><div class="summary-label">Entrada possível</div><div class="summary-count sc-green">${green}</div></div>
  </div>
  <div class="summary-card">
    <span class="summary-emoji">🟡</span>
    <div><div class="summary-label">Esperar confirmação</div><div class="summary-count sc-yellow">${yellow}</div></div>
  </div>
  <div class="summary-card">
    <span class="summary-emoji">🔴</span>
    <div><div class="summary-label">Evitar</div><div class="summary-count sc-red">${red}</div></div>
  </div>
  <div class="summary-hint">Apenas para fins informativos — não constitui conselho financeiro.</div>
</div>

<div class="table-wrap">
<table>
<thead>
  <tr>
    <th class="th-signal">🚦 Sinal de decisão</th>
    <th>Acção</th>
    <th style="text-align:right">Preço</th>
    <th>RSI (D / 4H / 1H)</th>
    <th>MACD Histograma (3 barras)</th>
    <th>EMA 50 / 100</th>
    <th style="text-align:center">Volume</th>
    <th>VWAP</th>
    <th>Alinhamento TF</th>
    <th class="th-pa">🧠 Estrutura · Padrão · Zona</th>
    <th class="th-risk">Risco estrutural</th>
    <th class="th-setup">🎯 Setup + TV Rating</th>
  </tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</div>

<div class="legend">
  <div class="legend-section">
    <h4>🚦 Sinal de decisão</h4>
    <div class="legend-item"><span class="legend-key">🟢 Entrada possível</span><span class="legend-val">Setup válido + RSI 1H ↑ + MACD crescente + VWAP OK + Risco baixo</span></div>
    <div class="legend-item"><span class="legend-key">🟡 Esperar</span><span class="legend-val">Condições parcialmente cumpridas — aguardar confirmação</span></div>
    <div class="legend-item"><span class="legend-key">🔴 Evitar</span><span class="legend-val">Padrão bearish, RSI>70, extensão, VWAP esticado ou risco alto</span></div>
  </div>
  <div class="legend-section">
    <h4>🧠 Estrutura</h4>
    <div class="legend-item"><span class="legend-key">Tendência bullish</span><span class="legend-val">EMAs alinhadas, RSI zona bullish, tendência limpa</span></div>
    <div class="legend-item"><span class="legend-key">Pullback</span><span class="legend-val">Retracção saudável em tendência — potencial entrada</span></div>
    <div class="legend-item"><span class="legend-key">Breakout</span><span class="legend-val">Rompimento com momentum</span></div>
    <div class="legend-item"><span class="legend-key">Consolidação</span><span class="legend-val">Range estreito — aguardar direcção</span></div>
    <div class="legend-item"><span class="legend-key">Resistência</span><span class="legend-val">Próximo de zona de resistência</span></div>
    <div class="legend-item"><span class="legend-key">Extensão</span><span class="legend-val">Sobrecomprado — aguardar retracção</span></div>
    <div class="legend-item"><span class="legend-key">⚠️ Possível reversão</span><span class="legend-val">Padrão de topo + sinais de fraqueza</span></div>
  </div>
  <div class="legend-section">
    <h4>🧩 Padrão detectado</h4>
    <div class="legend-item"><span class="legend-key">HH / HL</span><span class="legend-val">Máximos e mínimos crescentes — tendência bullish confirmada</span></div>
    <div class="legend-item"><span class="legend-key">Double Bottom</span><span class="legend-val">Dois mínimos similares — possível reversão bullish</span></div>
    <div class="legend-item"><span class="legend-key">Double Top</span><span class="legend-val">Dois máximos similares — risco de reversão bearish</span></div>
    <div class="legend-item"><span class="legend-key">LH / LL</span><span class="legend-val">Máximos e mínimos decrescentes — tendência bearish</span></div>
    <div class="legend-item"><span class="legend-key">Range</span><span class="legend-val">Oscila entre dois níveis — aguardar breakout</span></div>
  </div>
  <div class="legend-section">
    <h4>🎯 Setup</h4>
    <div class="legend-item"><span class="legend-key">Pullback + cont.</span><span class="legend-val">Retracção em tendência com MACD crescente</span></div>
    <div class="legend-item"><span class="legend-key">Breakout válido</span><span class="legend-val">Rompimento com volume e momentum</span></div>
    <div class="legend-item"><span class="legend-key">Consolidação</span><span class="legend-val">Aguardar breakout da zona de compressão</span></div>
    <div class="legend-item"><span class="legend-key">Extensão (esperar)</span><span class="legend-val">Muito esticado — aguardar retracção</span></div>
    <div class="legend-item"><span class="legend-key">⚠️ Possível reversão</span><span class="legend-val">Padrão de topo detectado — não entrar</span></div>
  </div>
  <div class="legend-section">
    <h4>VWAP</h4>
    <div class="legend-item"><span class="legend-key">Zona ideal</span><span class="legend-val">0% a +0.5% — entrada óptima</span></div>
    <div class="legend-item"><span class="legend-key">Saudável</span><span class="legend-val">+0.5% a +1.5% — ainda aceitável</span></div>
    <div class="legend-item"><span class="legend-key">Esticado</span><span class="legend-val">&gt;+1.5% — risco de reversão para VWAP</span></div>
    <div class="legend-item"><span class="legend-key">Abaixo VWAP</span><span class="legend-val">Fraqueza intraday — cautela</span></div>
  </div>
  <div class="legend-section">
    <h4>Risco estrutural</h4>
    <div class="legend-item"><span class="legend-key">🟢 Baixo</span><span class="legend-val">Tendência limpa, sinais alinhados</span></div>
    <div class="legend-item"><span class="legend-key">🟡 Médio</span><span class="legend-val">Consolidação, conflito parcial de sinais</span></div>
    <div class="legend-item"><span class="legend-key">🔴 Alto</span><span class="legend-val">Padrão de reversão, extensão, desalinhamento</span></div>
  </div>
  <div class="legend-section">
    <h4>⏱ Prioridade Timeframe</h4>
    <div class="legend-item"><span class="legend-key">D Bearish</span><span class="legend-val">≥2 condições bearish no Diário → nunca 🟢 entrada</span></div>
    <div class="legend-item"><span class="legend-key">D Momentum ↓</span><span class="legend-val">RSI e MACD D a cair → máximo 🟡 (aguardar)</span></div>
    <div class="legend-item"><span class="legend-key">1H = timing</span><span class="legend-val">RSI/MACD 1H afina o timing mas nunca invalida o Diário</span></div>
    <div class="legend-item"><span class="legend-key">4H = confirmação</span><span class="legend-val">4H valida a tendência diária antes de entrar</span></div>
  </div>
  <div class="legend-section">
    <h4>⚠️ Correcção de Risco</h4>
    <div class="legend-item"><span class="legend-key">Zona Resistência</span><span class="legend-val">Preço próximo do topo do range de 20 dias</span></div>
    <div class="legend-item"><span class="legend-key">RSI &gt; 65</span><span class="legend-val">Sobrecomprado moderado — reduzir expectativa</span></div>
    <div class="legend-item"><span class="legend-key">MACD D ↓</span><span class="legend-val">Histograma diário a diminuir — momentum a enfraquecer</span></div>
    <div class="legend-item"><span class="legend-key">VWAP &gt; +1%</span><span class="legend-val">Preço demasiado afastado do VWAP</span></div>
    <div class="legend-item"><span class="legend-key">≥ 2 factores</span><span class="legend-val">Mínimo 🟡 — 🟢 bloqueado automaticamente</span></div>
    <div class="legend-item"><span class="legend-key">≥ 3 factores</span><span class="legend-val">Sinal corrigido para 🔴 Evitar independentemente do setup</span></div>
  </div>
  <div class="legend-section">
    <h4>🔍 Validações obrigatórias</h4>
    <div class="legend-item"><span class="legend-key">Momentum 1H+4H ↓</span><span class="legend-val">RSI 1H a cair E RSI 4H a cair/neutro → nunca 🟢 nem 🟡</span></div>
    <div class="legend-item"><span class="legend-key">Regra de Topo</span><span class="legend-val">Resistência + RSI 1H não sobe + MACD D fraqueja → 🔴 mesmo sem padrão</span></div>
    <div class="legend-item"><span class="legend-key">🟡 válido apenas se</span><span class="legend-val">Estrutura pullback/consolidação + RSI 1H não cai + fora de resistência</span></div>
    <div class="legend-item"><span class="legend-key">estrutura inválida</span><span class="legend-val">🟡 só aceita Pullback ou Consolidação — qualquer outra → 🔴</span></div>
    <div class="legend-item"><span class="legend-key">MACD D ↓↓ (reforço)</span><span class="legend-val">3 barras consecutivas a cair: nunca 🟢 · 🟡 só se estrutura OK + RSI 1H ↑</span></div>
  </div>
</div>

<div class="footer">
  D / 4H / 1H = TradingView Screener nativo &nbsp;·&nbsp;
  OHLCV = Yahoo Finance (300 velas diárias) &nbsp;·&nbsp;
  VWAP = TradingView (sessão actual) &nbsp;·&nbsp;
  Padrões detectados por análise algorítmica das 300 velas — verificar sempre no gráfico &nbsp;·&nbsp;
  Apenas para fins informativos
</div>

</body></html>`;
}

// ─── Guardar ficheiros ────────────────────────────────────────────────────────
function saveFiles(html, jsonStr, dateStr) {
  writeFileSync(CFG.htmlLocal, html,    'utf8');
  writeFileSync(CFG.jsonLocal, jsonStr, 'utf8');
  console.log(`\n✅ Ficheiros gerados — ${dateStr}`);
  try {
    writeFileSync(GDRIVE_PATH,      html,   'utf8');
    writeFileSync(GDRIVE_JSON_PATH, jsonStr,'utf8');
    console.log(`   ☁️  Google Drive: ${CFG.htmlDrive.split('/').pop()} + ${CFG.jsonDrive.split('/').pop()}`);
  } catch(e) { console.warn(`   ⚠ Google Drive: ${e.message}`); }
  console.log(`   📁 Local: ${CFG.htmlLocal} + ${CFG.jsonLocal}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now     = new Date().toISOString();
  const dateStr = new Date().toLocaleDateString('pt-PT', {timeZone:'Europe/Lisbon',day:'2-digit',month:'2-digit',year:'numeric'});

  console.log(`\n📌 Mercado: ${MARKET.toUpperCase()} — ${SCREENER_NAME}`);
  console.log(`\n🔗 A ler tickers — "${SCREENER_NAME}"…`);
  const liveSyms = await getSymbolsFromScreener();
  const SYMBOLS  = liveSyms || SYMBOLS_FALLBACK;
  if (!liveSyms) console.log(`   ⚠ A usar fallback hardcoded (${SYMBOLS.length} tickers)`);
  console.log('   ' + SYMBOLS.join(' · '));

  console.log('\n📡 TradingView Screener API (D + 4H + 1H)…');
  const candidates = await fetchTVData(SYMBOLS);
  console.log(`   ✓ ${candidates.length} acções`);

  console.log('\n📊 OHLCV diário + MACD 1H/4H local (Yahoo Finance)…');
  const ohlcvMap = {};
  let okMacd4h=0, okMacd1h=0;
  for (const c of candidates) {
    process.stdout.write(`   ${c.yahoo.padEnd(10)}`);
    try {
      // OHLCV diário (300 velas)
      const b = await fetchDailyOHLCV(c.yahoo);
      ohlcvMap[c.tvSymbol] = b;
      // MACD hist[2] calculado localmente a partir de dados 1H
      // (TV scanner não suporta [2]|TF — o resolution param é ignorado)
      const intra = await fetchIntradayMacdHist(c.yahoo);
      if (intra?.h4?.[0] != null) { c['MACD.hist[2]|240'] = intra.h4[0]; okMacd4h++; }
      if (intra?.h1?.[0] != null) { c['MACD.hist[2]|60']  = intra.h1[0]; okMacd1h++; }
      console.log(`✓ ${b.length}d  MACD4H:${intra?.h4?.[0]!=null?'✓':'—'}  MACD1H:${intra?.h1?.[0]!=null?'✓':'—'}`);
    } catch(e) {
      console.log(`⚠ ${e.message}`);
      ohlcvMap[c.tvSymbol] = null;
    }
  }
  console.log(`   MACD hist[2] calculado — 4H: ${okMacd4h}/${candidates.length} · 1H: ${okMacd1h}/${candidates.length}`);

  console.log('\n🔢 A calcular análise avançada…');
  const records = candidates.map(c => buildRecord(c, ohlcvMap[c.tvSymbol], now));
  records.sort((a,b) => b._sortScore - a._sortScore);

  records.forEach(r => {
    console.log(`   ${r.signal.emoji} ${r.symbol.padEnd(8)} ${r.setup.label.padEnd(26)} Padrão: ${r.pattern.label.padEnd(28)} Risco:${r.structRisk.emoji}${r.structRisk.label}`);
  });

  const jsonOutput = JSON.stringify({
    generated_at: now,
    source: `TradingView Screener "${SCREENER_NAME}" + Yahoo Finance OHLCV — ${dateStr}`,
    stocks: records.map(r => r._json)
  }, null, 2);

  saveFiles(generateHTML(records, dateStr), jsonOutput, dateStr);
}

main().catch(e => { console.error('ERRO:', e); process.exit(1); });

// screener.mjs — v4
// Análise diária: indicadores via TradingView Screener (sem Yahoo daily)
// Multi-TF (4H/1H): Yahoo Finance horário (opcional — N/D se falhar)
// Europa: 08:10h Lisboa | EUA: 22:10h Lisboa
// Uso: MARKET=europe node screener.mjs   |   MARKET=us node screener.mjs

import { writeFileSync } from 'fs';

const MARKET = (process.env.MARKET || 'europe').toLowerCase();
const REPORT_PATH = './report.html';
const SCAN_URL = 'https://scanner.tradingview.com/global/scan';

const CFG = {
  europe: {
    rsiMin: 40, rsiMax: 75,
    changeMin: 0.5, changeMax: 3,
    volumeMin: 100_000,
    label:    '🇪🇺 Mercado Europeu',
    timeNote: '08:10h Lisboa · Mercado europeu a abrir',
    exchanges: new Set(['LSE','XETRA','AMS','EPA','BIT','BME','OSL','STO',
                        'HEL','CPH','VIE','SWX','FWB','EURONEXT','IST','ATH','WSE'])
  },
  us: {
    rsiMin: 40, rsiMax: 75,
    changeMin: 1, changeMax: 5,
    volumeMin: 500_000,
    label:    '🇺🇸 Mercado Americano',
    timeNote: '22:10h Lisboa · Após fecho (21h Lisboa)',
    exchanges: new Set(['NASDAQ','NYSE','AMEX','BATS','CBOE'])
  }
}[MARKET];

if (!CFG) { console.error('MARKET deve ser "europe" ou "us"'); process.exit(1); }

// ─── Multi-TF helpers ─────────────────────────────────────────────────────────
function ema(src, p) {
  const k=2/(p+1); let v=src[0]; const o=[v];
  for(let i=1;i<src.length;i++){v=src[i]*k+v*(1-k);o.push(v);}
  return o;
}
function rsi(src, p) {
  let g=0,l=0;
  for(let i=1;i<=p;i++){const d=src[i]-src[i-1];if(d>0)g+=d;else l-=d;}
  let ag=g/p,al=l/p;
  const o=new Array(p).fill(null);
  o.push(al===0?100:100-100/(1+ag/al));
  for(let i=p+1;i<src.length;i++){
    const d=src[i]-src[i-1],gi=d>0?d:0,li=d<0?-d:0;
    ag=(ag*(p-1)+gi)/p;al=(al*(p-1)+li)/p;
    o.push(al===0?100:100-100/(1+ag/al));
  }
  return o;
}
function macd(src) {
  const fast=ema(src,12),slow=ema(src,26);
  const line=fast.map((v,i)=>v-slow[i]);
  const signal=ema(line,9);
  return{line,signal,hist:line.map((v,i)=>v-signal[i])};
}
function aggregate4H(bars) {
  const r=[];
  for(let i=0;i<bars.length;i+=4){
    const c=bars.slice(i,i+4);if(c.length<4)break;
    r.push({time:c[0].time,open:c[0].open,high:Math.max(...c.map(b=>b.high)),
            low:Math.min(...c.map(b=>b.low)),close:c[c.length-1].close,
            volume:c.reduce((s,b)=>s+b.volume,0)});
  }
  return r;
}
function calcVWAP(bars) {
  if(!bars||!bars.length)return null;
  const ld=new Date(bars.at(-1).time*1000);
  const key=`${ld.getUTCFullYear()}-${ld.getUTCMonth()}-${ld.getUTCDate()}`;
  const s=bars.filter(b=>{const d=new Date(b.time*1000);return`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`===key;});
  if(!s.length)return null;
  const tpv=s.reduce((a,b)=>a+(b.high+b.low+b.close)/3*b.volume,0);
  const vol=s.reduce((a,b)=>a+b.volume,0);
  return vol>0?tpv/vol:null;
}
function computeTF(bars) {
  if(!bars||bars.length<35)return null;
  const C=bars.map(b=>b.close),n=C.length,i=n-1;
  const r=rsi(C,14),m=macd(C);
  const rv=r[i],rp=r[i-1];
  if(rv==null||rp==null)return null;
  return{
    rsi:{value:+rv.toFixed(1),trend:rv>rp+0.2?'↑':rv<rp-0.2?'↓':'→'},
    macd:{trend:m.hist[i]>m.hist[i-1]?'↑':'↓',cross:m.line[i]>m.signal[i]?'bull':'bear'}
  };
}

// ─── TV Symbol → Yahoo Finance ─────────────────────────────────────────────────
function tvToYahoo(tvSym) {
  const [exch, ticker] = tvSym.split(':');
  if(['NASDAQ','NYSE','AMEX','BATS','CBOE'].includes(exch)) return ticker;
  const map = {
    LSE:'.L', XETRA:'.DE', AMS:'.AS', EPA:'.PA',
    BIT:'.MI', BME:'.MC', OSL:'.OL', STO:'.ST',
    HEL:'.HE', CPH:'.CO', VIE:'.VI', SWX:'.SW',
    FWB:'.F',  IST:'.IS', WSE:'.WA', ATH:'.AT',
    EURONEXT:'.PA'   // maioria Euronext é Paris; .AS para holandesas falha no Yahoo → N/D 4H/1H
  };
  return ticker + (map[exch] || '');
}

// ─── TradingView Screener ─────────────────────────────────────────────────────
const TV_COLS = [
  'close','change','change|1W',
  'RSI','RSI[1]',
  'MACD.macd','MACD.signal','MACD.hist','MACD.hist[1]',
  'EMA9','EMA20','EMA50','EMA100','EMA200',
  'BB.upper','BB.lower',
  'Stoch.K','Stoch.D',
  'ADX','ADX+DI','ADX-DI',
  'Recommend.All','volume','relative_volume_10d_calc',
  'market_cap_basic','description','sector'
];

async function scanTV() {
  const body = {
    filter: [
      {left:'RSI',        operation:'in_range', right:[CFG.rsiMin,CFG.rsiMax]},
      {left:'MACD.hist',  operation:'greater',  right:0},
      {left:'change',     operation:'in_range', right:[CFG.changeMin,CFG.changeMax]},
      {left:'volume',     operation:'egreater', right:CFG.volumeMin}
    ],
    options: {lang:'en'},
    columns: TV_COLS,
    sort:  {sortBy:'Recommend.All', sortOrder:'desc'},
    range: [0, 100]
  };
  const resp = await fetch(SCAN_URL, {
    method:'POST',
    headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0',
             'Origin':'https://www.tradingview.com','Referer':'https://www.tradingview.com/'},
    body: JSON.stringify(body)
  });
  if(!resp.ok) throw new Error(`TV scan HTTP ${resp.status}`);
  const json = await resp.json();
  return (json.data||[]).map(item => {
    const d={}; TV_COLS.forEach((c,i)=>{ d[c]=item.d[i]; });
    return {tvSymbol:item.s, yahoo:tvToYahoo(item.s), ...d};
  }).filter(c => {
    const exch = c.tvSymbol.split(':')[0];
    return CFG.exchanges.has(exch)
        && c.close!=null && c['EMA50']!=null
        && c.close > c['EMA50'];   // Preço > EMA50
  });
}

// ─── Pré-score com dados TV ───────────────────────────────────────────────────
function tvPreScore(c) {
  let s=0;
  const rsiVal=c['RSI']??50, rsi1=c['RSI[1]'];
  if(rsiVal>=50&&rsiVal<=65) s+=2; else if(rsiVal>65) s+=1;
  if(rsi1!=null&&rsiVal>rsi1+0.2) s+=1;
  if(c['Recommend.All']!=null) s+=c['Recommend.All']*3;
  if((c['relative_volume_10d_calc']||0)>=1.5) s+=1;
  return s;
}

// ─── Yahoo Finance — apenas horário (opcional) ────────────────────────────────
async function fetchHourly(symbol) {
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1h&range=60d`;
  const resp=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}});
  if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json=await resp.json();
  const res=json.chart?.result?.[0];
  if(!res||!res.timestamp) throw new Error('Sem dados');
  const ts=res.timestamp,q=res.indicators.quote[0];
  const raw=ts.map((t,i)=>({time:t,open:q.open[i],high:q.high[i],low:q.low[i],close:q.close[i],volume:q.volume[i]??0}));
  const clean=raw.filter(b=>b.close!=null&&b.close>0&&b.high!=null&&b.low!=null&&b.high>=b.low&&b.high>=b.close&&b.low<=b.close);
  clean.sort((a,b)=>a.time-b.time);
  return clean.slice(-600);
}

// ─── Análise completa (TV daily + Yahoo hourly) ───────────────────────────────
function buildAnalysis(cand, hourlyBars) {
  // Indicadores diários — dados do TV Screener
  const close     = cand['close'];
  const rsiVal    = cand['RSI']??50;
  const rsiPrev   = cand['RSI[1]']??rsiVal;
  const macdHist  = cand['MACD.hist']??0;
  const macdHistP = cand['MACD.hist[1]']??macdHist;
  const macdLine  = cand['MACD.macd']??0;
  const macdSig   = cand['MACD.signal']??0;
  const ema9      = cand['EMA9'];
  const ema20     = cand['EMA20'];
  const ema50     = cand['EMA50'];
  const ema100    = cand['EMA100'];
  const ema200    = cand['EMA200'];
  const bbUp      = cand['BB.upper'];
  const bbLo      = cand['BB.lower'];
  const stochK    = cand['Stoch.K']??50;
  const adxPdi    = cand['ADX+DI'];
  const adxNdi    = cand['ADX-DI'];
  const relVol    = cand['relative_volume_10d_calc']??1;
  const weekChg   = cand['change|1W']??0;

  const rsiSig    = rsiVal>70?'overbought':rsiVal<30?'oversold':rsiVal>=50?'bullish_zone':'bearish_zone';
  const macdTrend = macdHist>macdHistP?'improving':'deteriorating';
  const macdCross = macdLine>macdSig?'bullish':'bearish';
  const bbRange   = bbUp!=null&&bbLo!=null&&(bbUp-bbLo)>0;
  const bbPos     = bbRange?(close-bbLo)/(bbUp-bbLo)*100:50;
  const bbSig     = bbPos>80?'overbought':bbPos<20?'oversold':'normal';
  const allEmas   = [ema9,ema20,ema50,ema100,ema200].every(e=>e!=null);
  const priceAbove= allEmas?close>ema9&&close>ema20&&close>ema50&&close>ema100&&close>ema200:close>ema50;
  const bullAlign = allEmas?ema9>ema20&&ema20>ema50&&ema50>ema100&&ema100>ema200:false;
  const dominant  = adxPdi!=null&&adxNdi!=null?(adxPdi>adxNdi?'buyers':'sellers'):'unknown';

  // Multi-timeframe — Yahoo Finance horário
  const bars4h  = aggregate4H(hourlyBars||[]);
  const tf4h    = computeTF(bars4h);
  const tf1h    = computeTF(hourlyBars||[]);
  const vwap    = calcVWAP(hourlyBars||[]);
  const vwapPct = vwap?+((close-vwap)/vwap*100).toFixed(2):null;

  let score=0, signals=[];

  // Diário (TV data)
  if(rsiSig==='bullish_zone')  {score+=2;signals.push('RSI D zona bullish');}
  if(rsiSig==='oversold')      {score+=2;signals.push('RSI D sobrevendido');}
  if(macdTrend==='improving')  {score+=2;signals.push('MACD D a melhorar');}
  if(macdCross==='bullish')    {score+=1;signals.push('MACD D bullish');}
  if(priceAbove)               {score+=2;signals.push('Acima todas as EMAs');}
  if(bullAlign)                {score+=1;signals.push('EMAs alinhadas');}
  if(dominant==='buyers')      {score+=1;signals.push('Compradores dominantes');}
  if(bbSig==='oversold')       {score+=2;signals.push('BB sobrevendido');}
  if(rsiSig==='overbought')    {score-=2;signals.push('RSI D sobrecomprado');}
  if(bbSig==='overbought')     {score-=1;signals.push('BB sobrecomprado');}
  if(stochK>80)                {score-=1;signals.push('Stoch sobrecomprado');}
  if(weekChg<-3)               {score-=1;signals.push('Tendência baixa semanal');}

  // 4H (Yahoo)
  if(tf4h){
    if(tf4h.rsi.value>=50&&tf4h.rsi.value<70){score+=1;signals.push('RSI 4H zona bullish');}
    if(tf4h.rsi.value<30)                     {score+=1;signals.push('RSI 4H sobrevendido');}
    if(tf4h.rsi.value>70)                     {score-=1;signals.push('RSI 4H sobrecomprado');}
    if(tf4h.macd.trend==='↑')                 {score+=1;signals.push('MACD 4H a melhorar');}
  }
  // 1H (Yahoo)
  if(tf1h){
    if(tf1h.rsi.value<30)     {score+=1;signals.push('RSI 1H sobrevendido');}
    if(tf1h.rsi.value>70)     {score-=1;signals.push('RSI 1H sobrecomprado');}
    if(tf1h.macd.trend==='↑') {score+=1;signals.push('MACD 1H a melhorar');}
  }
  if(vwapPct!=null&&vwapPct>0){score+=1;signals.push(`Acima VWAP +${vwapPct}%`);}

  const tvRec   = cand['Recommend.All'];
  const combined = score + (tvRec!=null?tvRec*5:0);

  return {
    symbol:   cand.tvSymbol.split(':')[1],
    tvSymbol: cand.tvSymbol,
    name:     cand.description||cand.tvSymbol,
    sector:   cand.sector||'—',
    price:    {current:close, change_pct:+(cand.change||0).toFixed(2)},
    rsi_d:    {value:+rsiVal.toFixed(1), trend:rsiVal>rsiPrev+0.2?'↑':rsiVal<rsiPrev-0.2?'↓':'→'},
    rsi_4h:   tf4h?tf4h.rsi:null,
    rsi_1h:   tf1h?tf1h.rsi:null,
    macd_d:   {trend:macdTrend==='improving'?'↑':'↓'},
    macd_4h:  tf4h?tf4h.macd:null,
    macd_1h:  tf1h?tf1h.macd:null,
    vwap_pct: vwapPct,
    volume_ratio: +relVol.toFixed(2),
    tvRecommend:  tvRec,
    composite:    {score,signals},
    combined
  };
}

// ─── Labels e cores ────────────────────────────────────────────────────────────
function tvLabel(val) {
  if(val==null) return{text:'N/D',color:'#9e9e9e'};
  if(val>=0.5)  return{text:'🟢 Forte Compra',color:'#00897b'};
  if(val>=0.1)  return{text:'🟩 Compra',color:'#43a047'};
  if(val>-0.1)  return{text:'⚪ Neutro',color:'#fb8c00'};
  if(val>-0.5)  return{text:'🟥 Venda',color:'#e53935'};
  return{text:'🔴 Forte Venda',color:'#b71c1c'};
}
function combinedLabel(s) {
  if(s>=12) return{text:'🟢 Forte Compra',color:'#00897b',bg:'#e0f2f1'};
  if(s>=7)  return{text:'🟡 Compra',color:'#558b2f',bg:'#f1f8e9'};
  if(s>=3)  return{text:'⚪ Neutro',color:'#e65100',bg:'#fff3e0'};
  return{text:'🔴 Evitar',color:'#c62828',bg:'#ffebee'};
}
function rsiColor(v){return v>70?'#c62828':v<30?'#2e7d32':'#37474f';}
function trendColor(t){return t==='↑'?'#2e7d32':t==='↓'?'#c62828':'#9e9e9e';}

// ─── HTML ──────────────────────────────────────────────────────────────────────
function generateHTML(top15, dateStr, totalFound, totalAnalyzed) {
  function rsiCell(tf) {
    if(!tf) return '<span style="color:#bbb;font-size:10px">N/D</span>';
    return `<span style="color:${rsiColor(tf.value)};font-weight:bold">${tf.value}</span>`
         + `<span style="color:${trendColor(tf.trend)};font-size:14px;font-weight:bold"> ${tf.trend}</span>`;
  }
  function macdCell(tf) {
    if(!tf) return '<span style="color:#bbb;font-size:10px">N/D</span>';
    const c=tf.trend==='↑'?'#2e7d32':'#c62828';
    return `<span style="color:${c};font-size:14px;font-weight:bold">${tf.trend}</span>`;
  }
  const criteriaBox = `
  <div style="padding:12px 28px;background:#f0f4ff;border-bottom:1px solid #dce3f5;font-size:11px;color:#3949ab">
    <strong>Critérios:</strong> &nbsp;
    RSI D [${CFG.rsiMin}–${CFG.rsiMax}] &nbsp;·&nbsp;
    MACD Hist &gt; 0 &nbsp;·&nbsp; Preço &gt; EMA50 &nbsp;·&nbsp;
    Variação [${CFG.changeMin}%–${CFG.changeMax}%] &nbsp;·&nbsp;
    Volume ≥ ${CFG.volumeMin.toLocaleString('pt-PT')}
    &nbsp;&nbsp;|&nbsp;&nbsp;
    <strong>${totalFound}</strong> candidatas · <strong>${totalAnalyzed}</strong> analisadas em profundidade
  </div>`;

  if(!top15.length) return `<!DOCTYPE html><html><body style="font-family:Arial;padding:30px">
    <h2>${CFG.label} — ${dateStr}</h2>
    <p>⚠️ Nenhuma acção encontrou os critérios hoje.</p>${criteriaBox}</body></html>`;

  const rows = top15.map((r,idx) => {
    const tv=tvLabel(r.tvRecommend), verd=combinedLabel(r.combined);
    const chgC=r.price.change_pct>=0?'#2e7d32':'#c62828';
    const chgS=r.price.change_pct>=0?'+':'';
    const sigs=r.composite.signals.slice(0,3).join(' · ')||'—';
    const volSt=r.volume_ratio>=1.5?'font-weight:bold;color:#1565c0':'color:#555';
    const vwapS=r.vwap_pct!=null?`<div style="margin-top:3px;font-size:10px;color:${r.vwap_pct>=0?'#2e7d32':'#c62828'}">VWAP ${r.vwap_pct>=0?'+':''}${r.vwap_pct}%</div>`:'';
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
        <div style="color:${chgC};font-size:11px">${chgS}${r.price.change_pct}%</div>
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
        ${vwapS}
      </td>
      <td style="padding:9px 10px;text-align:center;font-size:12px;${volSt}">${r.volume_ratio}x</td>
      <td style="padding:9px 10px;text-align:center;font-size:11px;color:${tv.color};white-space:nowrap">${tv.text}</td>
      <td style="padding:9px 10px;text-align:center;font-weight:bold;font-size:16px;color:${verd.color}">${r.combined.toFixed(1)}</td>
      <td style="padding:9px 10px;text-align:center;font-size:11px;color:${verd.color};background:${verd.bg};border-radius:4px;white-space:nowrap">${verd.text}</td>
      <td style="padding:9px 10px;font-size:10px;color:#616161;max-width:160px">${sigs}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="pt"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:16px;background:#eeeeee;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:1100px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 3px 12px rgba(0,0,0,.15)">
  <div style="background:linear-gradient(135deg,#1565c0,#0d47a1);color:#fff;padding:22px 28px">
    <h1 style="margin:0;font-size:21px">📈 ${CFG.label} — Top ${top15.length}</h1>
    <p style="margin:6px 0 0;font-size:13px;opacity:.85">${dateStr} &nbsp;·&nbsp; ${CFG.timeNote} &nbsp;·&nbsp; TradingView Screener (D) + Yahoo Finance (4H/1H)</p>
  </div>
  ${criteriaBox}
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
      <strong>D</strong> = dados TradingView Screener (diário) &nbsp;·&nbsp;
      <strong>4H / 1H</strong> = Yahoo Finance horário (N/D se não disponível) &nbsp;|&nbsp;
      <span style="color:#2e7d32;font-weight:bold">↑ a subir</span> &nbsp;
      <span style="color:#c62828;font-weight:bold">↓ a descer</span> &nbsp;
      <span style="color:#9e9e9e;font-weight:bold">→ lateral</span> &nbsp;|&nbsp;
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
  const dateStr = new Date().toLocaleDateString('pt-PT',
    {timeZone:'Europe/Lisbon',day:'2-digit',month:'2-digit',year:'numeric'});

  console.log(`\n🔍 ${CFG.label} — ${dateStr}`);
  console.log(`   RSI [${CFG.rsiMin}-${CFG.rsiMax}] · MACD.hist>0 · Preço>EMA50 · Var [${CFG.changeMin}%-${CFG.changeMax}%] · Vol≥${CFG.volumeMin.toLocaleString()}`);

  // 1. TV Screener
  console.log('\n📡 TradingView Screener…');
  let candidates = [];
  try {
    candidates = await scanTV();
    console.log(`   ✓ ${candidates.length} candidatas após filtros`);
  } catch(e) {
    console.error(`   ✗ TV Screener falhou: ${e.message}`); process.exit(1);
  }

  if(!candidates.length) {
    console.log('   ⚠ Nenhuma acção encontrou os critérios hoje.');
    writeFileSync(REPORT_PATH, generateHTML([],dateStr,0,0),'utf8'); return;
  }

  // 2. Pré-score, top 20
  candidates.forEach(c=>{c._pre=tvPreScore(c);});
  candidates.sort((a,b)=>b._pre-a._pre);
  const top20 = candidates.slice(0,20);
  console.log(`   → Top ${top20.length} para análise multi-TF`);

  // 3. Yahoo horário (só 4H/1H) — falha graciosamente
  console.log('\n📊 Yahoo Finance horário (4H/1H)…');
  const results = [];
  for(const cand of top20) {
    process.stdout.write(`   ${cand.yahoo.padEnd(12)}`);
    const hourly = await fetchHourly(cand.yahoo).catch(e=>{
      process.stdout.write(`[sem 4H/1H: ${e.message}] `); return [];
    });
    try {
      const a = buildAnalysis(cand, hourly);
      results.push(a);
      console.log(
        `RSI D:${a.rsi_d.value}${a.rsi_d.trend} `+
        `4H:${a.rsi_4h?.value??'--'}${a.rsi_4h?.trend??''} `+
        `1H:${a.rsi_1h?.value??'--'}${a.rsi_1h?.trend??''} `+
        `combined=${a.combined.toFixed(1)}`
      );
    } catch(e) { console.warn(`✗ ${e.message}`); }
  }

  if(!results.length){console.error('Sem resultados.');process.exit(1);}

  results.sort((a,b)=>b.combined-a.combined);
  const top15 = results.slice(0,15);

  writeFileSync(REPORT_PATH, generateHTML(top15,dateStr,candidates.length,results.length),'utf8');
  console.log(`\n✅ ${REPORT_PATH}`);
  top15.forEach((r,i)=>
    console.log(`   ${String(i+1).padStart(2)}. ${r.symbol.padEnd(8)} ${(r.name||'').substring(0,24).padEnd(24)} combined=${r.combined.toFixed(1)}`)
  );
}

main().catch(e=>{console.error('ERRO:',e);process.exit(1);});

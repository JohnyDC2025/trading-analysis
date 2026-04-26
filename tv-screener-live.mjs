// tv-screener-live.mjs — analisa os símbolos do screener TV directamente
import { writeFileSync } from 'fs';

const GDRIVE_PATH = 'G:/O meu disco/Claude ações/report.html';

const SYMBOLS = ['LSE:FCH','LSE:MONY','LSE:TRST','LSE:PFD','LSE:GNC','LSE:IMI'];
const SCAN_URL = 'https://scanner.tradingview.com/global/scan';

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

function ema(src,p){const k=2/(p+1);let v=src[0];const o=[v];for(let i=1;i<src.length;i++){v=src[i]*k+v*(1-k);o.push(v);}return o;}
function rsi(src,p){let g=0,l=0;for(let i=1;i<=p;i++){const d=src[i]-src[i-1];if(d>0)g+=d;else l-=d;}let ag=g/p,al=l/p;const o=new Array(p).fill(null);o.push(al===0?100:100-100/(1+ag/al));for(let i=p+1;i<src.length;i++){const d=src[i]-src[i-1],gi=d>0?d:0,li=d<0?-d:0;ag=(ag*(p-1)+gi)/p;al=(al*(p-1)+li)/p;o.push(al===0?100:100-100/(1+ag/al));}return o;}
function macd(src){const fast=ema(src,12),slow=ema(src,26);const line=fast.map((v,i)=>v-slow[i]);const signal=ema(line,9);return{line,signal,hist:line.map((v,i)=>v-signal[i])};}
function aggregate4H(bars){const r=[];for(let i=0;i<bars.length;i+=4){const c=bars.slice(i,i+4);if(c.length<4)break;r.push({time:c[0].time,open:c[0].open,high:Math.max(...c.map(b=>b.high)),low:Math.min(...c.map(b=>b.low)),close:c[c.length-1].close,volume:c.reduce((s,b)=>s+b.volume,0)});}return r;}
function calcVWAP(bars){if(!bars||!bars.length)return null;const ld=new Date(bars.at(-1).time*1000);const key=`${ld.getUTCFullYear()}-${ld.getUTCMonth()}-${ld.getUTCDate()}`;const s=bars.filter(b=>{const d=new Date(b.time*1000);return`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`===key;});if(!s.length)return null;const tpv=s.reduce((a,b)=>a+(b.high+b.low+b.close)/3*b.volume,0);const vol=s.reduce((a,b)=>a+b.volume,0);return vol>0?tpv/vol:null;}
function computeTF(bars){if(!bars||bars.length<35)return null;const C=bars.map(b=>b.close),n=C.length,i=n-1;const r=rsi(C,14),m=macd(C);const rv=r[i],rp=r[i-1];if(rv==null||rp==null)return null;return{rsi:{value:+rv.toFixed(1),trend:rv>rp+0.2?'↑':rv<rp-0.2?'↓':'→'},macd:{trend:m.hist[i]>m.hist[i-1]?'↑':'↓',cross:m.line[i]>m.signal[i]?'bull':'bear'}};}
function tvToYahoo(tvSym){const[exch,ticker]=tvSym.split(':');if(['NASDAQ','NYSE','AMEX','BATS','CBOE'].includes(exch))return ticker;const map={LSE:'.L',XETRA:'.DE',AMS:'.AS',EPA:'.PA',BIT:'.MI',BME:'.MC',OSL:'.OL',STO:'.ST',HEL:'.HE',CPH:'.CO',VIE:'.VI',SWX:'.SW',FWB:'.F',IST:'.IS',WSE:'.WA',ATH:'.AT',EURONEXT:'.PA'};return ticker+(map[exch]||'');}

async function fetchTVData(symbols) {
  const body = { symbols: { tickers: symbols }, columns: TV_COLS };
  const resp = await fetch(SCAN_URL, {
    method: 'POST',
    headers: {'Content-Type':'application/json','User-Agent':'Mozilla/5.0','Origin':'https://www.tradingview.com','Referer':'https://www.tradingview.com/'},
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`TV HTTP ${resp.status}`);
  const json = await resp.json();
  return (json.data||[]).map(item => {
    const d = {}; TV_COLS.forEach((c,i)=>{ d[c]=item.d[i]; });
    return { tvSymbol: item.s, yahoo: tvToYahoo(item.s), ...d };
  });
}

async function fetchHourly(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1h&range=60d`;
  const resp = await fetch(url, {headers:{'User-Agent':'Mozilla/5.0'}});
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  const res = json.chart?.result?.[0];
  if (!res || !res.timestamp) throw new Error('Sem dados');
  const ts=res.timestamp, q=res.indicators.quote[0];
  const raw = ts.map((t,i) => ({time:t,open:q.open[i],high:q.high[i],low:q.low[i],close:q.close[i],volume:q.volume[i]??0}));
  const clean = raw.filter(b => b.close!=null&&b.close>0&&b.high!=null&&b.low!=null&&b.high>=b.low&&b.high>=b.close&&b.low<=b.close);
  clean.sort((a,b) => a.time-b.time);
  return clean.slice(-600);
}

function buildAnalysis(cand, hourlyBars) {
  const close=cand['close'], rsiVal=cand['RSI']??50, rsiPrev=cand['RSI[1]']??rsiVal;
  const macdHist=cand['MACD.hist']??0, macdHistP=cand['MACD.hist[1]']??macdHist;
  const macdLine=cand['MACD.macd']??0, macdSig=cand['MACD.signal']??0;
  const ema9=cand['EMA9'],ema20=cand['EMA20'],ema50=cand['EMA50'],ema100=cand['EMA100'],ema200=cand['EMA200'];
  const bbUp=cand['BB.upper'],bbLo=cand['BB.lower'],stochK=cand['Stoch.K']??50;
  const adxPdi=cand['ADX+DI'],adxNdi=cand['ADX-DI'],relVol=cand['relative_volume_10d_calc']??1,weekChg=cand['change|1W']??0;
  const rsiSig=rsiVal>70?'overbought':rsiVal<30?'oversold':rsiVal>=50?'bullish_zone':'bearish_zone';
  const macdTrend=macdHist>macdHistP?'improving':'deteriorating', macdCross=macdLine>macdSig?'bullish':'bearish';
  const bbRange=bbUp!=null&&bbLo!=null&&(bbUp-bbLo)>0, bbPos=bbRange?(close-bbLo)/(bbUp-bbLo)*100:50;
  const bbSig=bbPos>80?'overbought':bbPos<20?'oversold':'normal';
  const allEmas=[ema9,ema20,ema50,ema100,ema200].every(e=>e!=null);
  const priceAbove=allEmas?close>ema9&&close>ema20&&close>ema50&&close>ema100&&close>ema200:close>ema50;
  const bullAlign=allEmas?ema9>ema20&&ema20>ema50&&ema50>ema100&&ema100>ema200:false;
  const dominant=adxPdi!=null&&adxNdi!=null?(adxPdi>adxNdi?'buyers':'sellers'):'unknown';
  const bars4h=aggregate4H(hourlyBars||[]), tf4h=computeTF(bars4h), tf1h=computeTF(hourlyBars||[]);
  const vwap=calcVWAP(hourlyBars||[]), vwapPct=vwap?+((close-vwap)/vwap*100).toFixed(2):null;
  let score=0, signals=[];
  if(rsiSig==='bullish_zone'){score+=2;signals.push('RSI D zona bullish');}
  if(rsiSig==='oversold'){score+=2;signals.push('RSI D sobrevendido');}
  if(macdTrend==='improving'){score+=2;signals.push('MACD D a melhorar');}
  if(macdCross==='bullish'){score+=1;signals.push('MACD D bullish');}
  if(priceAbove){score+=2;signals.push('Acima todas as EMAs');}
  if(bullAlign){score+=1;signals.push('EMAs alinhadas');}
  if(dominant==='buyers'){score+=1;signals.push('Compradores dominantes');}
  if(bbSig==='oversold'){score+=2;signals.push('BB sobrevendido');}
  if(rsiSig==='overbought'){score-=2;signals.push('RSI D sobrecomprado');}
  if(bbSig==='overbought'){score-=1;signals.push('BB sobrecomprado');}
  if(stochK>80){score-=1;signals.push('Stoch sobrecomprado');}
  if(weekChg<-3){score-=1;signals.push('Tendência baixa semanal');}
  if(tf4h){
    if(tf4h.rsi.value>=50&&tf4h.rsi.value<70){score+=1;signals.push('RSI 4H zona bullish');}
    if(tf4h.rsi.value<30){score+=1;signals.push('RSI 4H sobrevendido');}
    if(tf4h.rsi.value>70){score-=1;signals.push('RSI 4H sobrecomprado');}
    if(tf4h.macd.trend==='↑'){score+=1;signals.push('MACD 4H a melhorar');}
  }
  if(tf1h){
    if(tf1h.rsi.value<30){score+=1;signals.push('RSI 1H sobrevendido');}
    if(tf1h.rsi.value>70){score-=1;signals.push('RSI 1H sobrecomprado');}
    if(tf1h.macd.trend==='↑'){score+=1;signals.push('MACD 1H a melhorar');}
  }
  if(vwapPct!=null&&vwapPct>0){score+=1;signals.push(`Acima VWAP +${vwapPct}%`);}
  const tvRec=cand['Recommend.All'], combined=score+(tvRec!=null?tvRec*5:0);
  return{symbol:cand.tvSymbol.split(':')[1],tvSymbol:cand.tvSymbol,name:cand.description||cand.tvSymbol,sector:cand.sector||'—',price:{current:close,change_pct:+(cand.change||0).toFixed(2)},rsi_d:{value:+rsiVal.toFixed(1),trend:rsiVal>rsiPrev+0.2?'↑':rsiVal<rsiPrev-0.2?'↓':'→'},rsi_4h:tf4h?tf4h.rsi:null,rsi_1h:tf1h?tf1h.rsi:null,macd_d:{trend:macdTrend==='improving'?'↑':'↓'},macd_4h:tf4h?tf4h.macd:null,macd_1h:tf1h?tf1h.macd:null,vwap_pct:vwapPct,volume_ratio:+relVol.toFixed(2),tvRecommend:tvRec,composite:{score,signals},combined};
}

function tvLabel(val){if(val==null)return{text:'N/D',color:'#9e9e9e'};if(val>=0.5)return{text:'🟢 Forte Compra',color:'#00897b'};if(val>=0.1)return{text:'🟩 Compra',color:'#43a047'};if(val>-0.1)return{text:'⚪ Neutro',color:'#fb8c00'};if(val>-0.5)return{text:'🟥 Venda',color:'#e53935'};return{text:'🔴 Forte Venda',color:'#b71c1c'};}
function combinedLabel(s){if(s>=12)return{text:'🟢 Forte Compra',color:'#00897b',bg:'#e0f2f1'};if(s>=7)return{text:'🟡 Compra',color:'#558b2f',bg:'#f1f8e9'};if(s>=3)return{text:'⚪ Neutro',color:'#e65100',bg:'#fff3e0'};return{text:'🔴 Evitar',color:'#c62828',bg:'#ffebee'};}
function rsiColor(v){return v>70?'#c62828':v<30?'#2e7d32':'#37474f';}
function trendColor(t){return t==='↑'?'#2e7d32':t==='↓'?'#c62828':'#9e9e9e';}

function generateHTML(results, dateStr, screenerName) {
  function rsiCell(tf){if(!tf)return '<span style="color:#bbb;font-size:10px">N/D</span>';return `<span style="color:${rsiColor(tf.value)};font-weight:bold">${tf.value}</span><span style="color:${trendColor(tf.trend)};font-size:14px;font-weight:bold"> ${tf.trend}</span>`;}
  function macdCell(tf){if(!tf)return '<span style="color:#bbb;font-size:10px">N/D</span>';const c=tf.trend==='↑'?'#2e7d32':'#c62828';return `<span style="color:${c};font-size:14px;font-weight:bold">${tf.trend}</span>`;}

  const sourceNote = `
  <div style="padding:12px 28px;background:#fff8e1;border-bottom:1px solid #ffe082;font-size:11px;color:#e65100">
    <strong>📋 Fonte:</strong> Screener TradingView "<strong>${screenerName}</strong>" — ${results.length} acções dos teus filtros personalizados &nbsp;·&nbsp; <strong>Zero critérios adicionais aplicados</strong>
  </div>`;

  const rows = results.map((r,idx) => {
    const tv=tvLabel(r.tvRecommend), verd=combinedLabel(r.combined);
    const chgC=r.price.change_pct>=0?'#2e7d32':'#c62828', chgS=r.price.change_pct>=0?'+':'';
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
    <h1 style="margin:0;font-size:21px">📈 Screener TV — "${screenerName}"</h1>
    <p style="margin:6px 0 0;font-size:13px;opacity:.85">${dateStr} &nbsp;·&nbsp; TradingView Screener (D) + Yahoo Finance (4H/1H)</p>
  </div>
  ${sourceNote}
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
      <strong>D</strong> = TradingView Screener (diário) &nbsp;·&nbsp;
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

async function main() {
  const dateStr = new Date().toLocaleDateString('pt-PT', {timeZone:'Europe/Lisbon',day:'2-digit',month:'2-digit',year:'numeric'});
  const screenerName = 'Chat GTP screener';

  console.log(`\n📋 ${screenerName} — ${SYMBOLS.length} símbolos`);
  console.log('   ' + SYMBOLS.join(' · '));

  console.log('\n📡 A buscar dados TV Screener…');
  const candidates = await fetchTVData(SYMBOLS);
  console.log(`   ✓ ${candidates.length} acções com dados`);

  console.log('\n📊 Yahoo Finance horário (4H/1H)…');
  const results = [];
  for (const cand of candidates) {
    process.stdout.write(`   ${cand.yahoo.padEnd(12)}`);
    const hourly = await fetchHourly(cand.yahoo).catch(e => {
      process.stdout.write(`[sem 4H/1H: ${e.message}] `);
      return [];
    });
    const a = buildAnalysis(cand, hourly);
    results.push(a);
    console.log(
      `RSI D:${a.rsi_d.value}${a.rsi_d.trend} ` +
      `4H:${a.rsi_4h?.value??'--'}${a.rsi_4h?.trend??''} ` +
      `1H:${a.rsi_1h?.value??'--'}${a.rsi_1h?.trend??''} ` +
      `combined=${a.combined.toFixed(1)}`
    );
  }

  results.sort((a,b) => b.combined - a.combined);
  const html = generateHTML(results, dateStr, screenerName);
  writeFileSync('./report.html', html, 'utf8');
  try {
    writeFileSync(GDRIVE_PATH, html, 'utf8');
    console.log(`\n✅ report.html gerado — ${dateStr}`);
    console.log(`   📁 Local:        ./report.html`);
    console.log(`   ☁️  Google Drive: ${GDRIVE_PATH}`);
  } catch(e) {
    console.log(`\n✅ report.html gerado — ${dateStr}`);
    console.warn(`   ⚠️  Google Drive não acessível: ${e.message}`);
  }
  console.log('─'.repeat(62));
  results.forEach((r,i) => {
    const lbl = r.combined>=12?'🟢':r.combined>=7?'🟡':r.combined>=3?'⚪':'🔴';
    console.log(`   ${String(i+1).padStart(2)}. ${lbl} ${r.symbol.padEnd(6)}  ${(r.name||'').substring(0,26).padEnd(26)}  RSI D:${r.rsi_d.value}${r.rsi_d.trend}  score=${r.combined.toFixed(1)}`);
  });
}

main().catch(e => { console.error('ERRO:', e); process.exit(1); });

import { writeFileSync } from 'fs';

const OUT = 'G:\\O meu disco\\Claude ações\\sha0_bbox_htws_analysis.json';

// ── helpers ──────────────────────────────────────────────────────────────────
function ema(src,p){const k=2/(p+1);let v=src[0];const o=[v];for(let i=1;i<src.length;i++){v=src[i]*k+v*(1-k);o.push(v);}return o;}
function rsi(src,p){let g=0,l=0;for(let i=1;i<=p;i++){const d=src[i]-src[i-1];if(d>0)g+=d;else l-=d;}let ag=g/p,al=l/p;const o=new Array(p).fill(null);o.push(al===0?100:100-100/(1+ag/al));for(let i=p+1;i<src.length;i++){const d=src[i]-src[i-1];const gi=d>0?d:0,li=d<0?-d:0;ag=(ag*(p-1)+gi)/p;al=(al*(p-1)+li)/p;o.push(al===0?100:100-100/(1+ag/al));}return o;}
function macd(src){const fast=ema(src,12),slow=ema(src,26);const line=fast.map((v,i)=>v-slow[i]);const signal=ema(line,9);return{line,signal,hist:line.map((v,i)=>v-signal[i])};}
function bb(src,p,m){return src.map((_,i)=>{if(i<p-1)return null;const sl=src.slice(i-p+1,i+1);const mn=sl.reduce((a,b)=>a+b,0)/p;const sd=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/p);return{upper:mn+m*sd,mid:mn,lower:mn-m*sd};});}
function atrFn(h,l,c,p){const tr=[h[0]-l[0]];for(let i=1;i<h.length;i++)tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));let v=tr.slice(0,p).reduce((a,b)=>a+b,0)/p;const o=new Array(p-1).fill(null);o.push(v);for(let i=p;i<tr.length;i++){v=(v*(p-1)+tr[i])/p;o.push(v);}return o;}
function stoch(h,l,c,kp,dp){const k=c.map((_,i)=>{if(i<kp-1)return null;const hh=Math.max(...h.slice(i-kp+1,i+1)),ll=Math.min(...l.slice(i-kp+1,i+1));return hh===ll?50:(c[i]-ll)/(hh-ll)*100;});const d=k.map((_,i)=>{if(i<kp+dp-2)return null;const sl=k.slice(i-dp+1,i+1).filter(x=>x!==null);return sl.length===dp?sl.reduce((a,b)=>a+b,0)/dp:null;});return{k,d};}
function adxFn(h,l,c,p){const tr=[],pdm=[],ndm=[];for(let i=1;i<h.length;i++){tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));pdm.push(Math.max(h[i]-h[i-1],0)>Math.max(l[i-1]-l[i],0)?Math.max(h[i]-h[i-1],0):0);ndm.push(Math.max(l[i-1]-l[i],0)>Math.max(h[i]-h[i-1],0)?Math.max(l[i-1]-l[i],0):0);}function sm(a,p){let s=a.slice(0,p).reduce((x,y)=>x+y,0);const o=[s];for(let i=p;i<a.length;i++){s=s-s/p+a[i];o.push(s);}return o;}const a14=sm(tr,p),sp=sm(pdm,p),sn=sm(ndm,p);const pdi=sp.map((v,i)=>v/a14[i]*100),ndi=sn.map((v,i)=>v/a14[i]*100);const dx=pdi.map((v,i)=>Math.abs(v-ndi[i])/(v+ndi[i])*100);return{pdi,ndi,adx:ema(dx,p)};}

function buildAnalysis(sym,name,sector,screenerData,bars,C4H,C1H,session1H){
  const lastClose=bars[bars.length-1].close;
  const expected=screenerData.price;
  const pctDiff=Math.abs(lastClose-expected)/expected;
  if(pctDiff>0.08)throw new Error(`[${sym}] IDENTITY MISMATCH: last=${lastClose} vs expected=${expected} (${(pctDiff*100).toFixed(1)}%)`);
  const C=bars.map(b=>b.close),H=bars.map(b=>b.high),L=bars.map(b=>b.low),V=bars.map(b=>b.volume);
  const n=C.length,i=n-1;
  const e9=ema(C,9),e21=ema(C,21),e50=ema(C,50),e100=ema(C,100),e200=ema(C,200);
  const r=rsi(C,14),m=macd(C),b=bb(C,20,2),a=atrFn(H,L,C,14),st=stoch(H,L,C,14,3),adx=adxFn(H,L,C,14);
  const ai=adx.adx.length-1,bl=b[i],avgVol=V.slice(-20).reduce((a,b)=>a+b,0)/20;
  const pct=(v,base)=>+((v-base)/base*100).toFixed(2);
  const indicators={
    ema:{
      ema9:{value:+e9[i].toFixed(4),pct_from_price:pct(C[i],e9[i])},
      ema21:{value:+e21[i].toFixed(4),pct_from_price:pct(C[i],e21[i])},
      ema50:{value:+e50[i].toFixed(4),pct_from_price:pct(C[i],e50[i])},
      ema100:{value:+e100[i].toFixed(4),pct_from_price:pct(C[i],e100[i])},
      ema200:{value:+e200[i].toFixed(4),pct_from_price:pct(C[i],e200[i])},
      price_above_all:C[i]>e9[i]&&C[i]>e21[i]&&C[i]>e50[i]&&C[i]>e100[i]&&C[i]>e200[i],
      bullish_alignment:e9[i]>e21[i]&&e21[i]>e50[i]&&e50[i]>e100[i]&&e100[i]>e200[i]
    },
    rsi:{value:+r[i].toFixed(2),prev:+r[i-1].toFixed(2),direction:r[i]>r[i-1]?'rising':'falling',
      signal:r[i]>70?'overbought':r[i]<30?'oversold':r[i]>=50?'bullish_zone':'bearish_zone'},
    stochastic:{k:+(st.k[i]||0).toFixed(2),d:+(st.d[i]||0).toFixed(2),
      signal:(st.k[i]||0)>80?'overbought':(st.k[i]||0)<20?'oversold':'neutral'},
    macd:{line:+m.line[i].toFixed(4),signal:+m.signal[i].toFixed(4),hist:+m.hist[i].toFixed(4),
      hist_prev:+m.hist[i-1].toFixed(4),trend:m.hist[i]>m.hist[i-1]?'improving':'deteriorating',
      signal_cross:m.line[i]>m.signal[i]?'bullish':'bearish'},
    bollinger:{upper:+bl.upper.toFixed(4),mid:+bl.mid.toFixed(4),lower:+bl.lower.toFixed(4),
      position_pct:+((C[i]-bl.lower)/(bl.upper-bl.lower)*100).toFixed(1),
      signal:((C[i]-bl.lower)/(bl.upper-bl.lower)*100)>80?'overbought':((C[i]-bl.lower)/(bl.upper-bl.lower)*100)<20?'oversold':'normal'},
    adx:{value:adx.adx[ai]!=null&&!isNaN(adx.adx[ai])?+adx.adx[ai].toFixed(2):null,
      plus_di:adx.pdi[ai]!=null&&!isNaN(adx.pdi[ai])?+adx.pdi[ai].toFixed(2):null,
      minus_di:adx.ndi[ai]!=null&&!isNaN(adx.ndi[ai])?+adx.ndi[ai].toFixed(2):null,
      strength:!adx.adx[ai]||isNaN(adx.adx[ai])?'unknown':adx.adx[ai]>40?'very_strong':adx.adx[ai]>25?'strong':adx.adx[ai]>15?'weak':'no_trend',
      dominant:adx.pdi[ai]>adx.ndi[ai]?'buyers':'sellers'},
    atr:{value:a[i]!=null?+a[i].toFixed(4):null,suggested_stop:a[i]!=null?+(C[i]-2*a[i]).toFixed(4):null,
      risk_pct:a[i]!=null?+(2*a[i]/C[i]*100).toFixed(2):null},
    price_trend:{week1_pct:+((C[i]-C[i-5])/C[i-5]*100).toFixed(2),week2_pct:+((C[i]-C[i-10])/C[i-10]*100).toFixed(2),month1_pct:+((C[i]-C[i-20])/C[i-20]*100).toFixed(2)},
    volume:{last:V[i],avg20:Math.round(avgVol),ratio:+(V[i]/avgVol).toFixed(2)},
    rsi_4h:null,rsi_1h:null,macd_4h:null,macd_1h:null,vwap:null
  };
  let score=0,signals=[];
  if(indicators.rsi.signal==='bullish_zone'){score+=2;signals.push('RSI bullish zone');}
  if(indicators.macd.trend==='improving'){score+=2;signals.push('MACD improving');}
  if(indicators.macd.signal_cross==='bullish'){score+=1;signals.push('MACD line > signal');}
  if(indicators.ema.price_above_all){score+=2;signals.push('Above all EMAs');}
  if(indicators.ema.bullish_alignment){score+=1;signals.push('EMA bullish alignment');}
  if(indicators.adx.dominant==='buyers'){score+=1;signals.push('Buyers dominant');}
  if(indicators.bollinger.signal==='oversold'){score+=2;signals.push('BB oversold');}
  if(indicators.rsi.signal==='overbought'){score-=2;signals.push('RSI overbought');}
  if(indicators.bollinger.signal==='overbought'){score-=1;signals.push('BB overbought');}
  if(indicators.stochastic.signal==='overbought'){score-=1;signals.push('Stoch overbought');}
  if(indicators.price_trend.week2_pct<-3){score-=1;signals.push('Downtrend 2w');}
  return{symbol:sym,name,sector,analysis_date:new Date().toISOString(),screener:screenerData,
    tv_symbol:`${screenerData.exchange}:${sym}`,
    price:{current:C[i],prev_close:C[i-1]},indicators,
    composite:{score,signals,verdict:score>=5?'strong_buy':score>=3?'buy':score>=0?'neutral':'avoid'},
    ohlcv:{bars:bars.length,data:bars.map(b=>({t:b.time,o:b.open,h:b.high,l:b.low,c:b.close,v:b.volume}))}};
}

// ── fetch Yahoo Finance OHLCV ─────────────────────────────────────────────────
async function fetchBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2y`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${symbol}`);
  const json = await resp.json();
  const res = json.chart.result[0];
  const ts = res.timestamp;
  const q = res.indicators.quote[0];
  const raw = ts.map((t, i) => ({
    time: t,
    open:  q.open[i],
    high:  q.high[i],
    low:   q.low[i],
    close: q.close[i],
    volume: q.volume[i] ?? 0
  }));
  // filter: valid candles only (no nulls, no zeros, high >= low, high >= close, low <= close)
  const clean = raw.filter(b =>
    b.close != null && b.close > 0 &&
    b.high  != null && b.low != null &&
    b.high >= b.low &&
    b.high >= b.close &&
    b.low  <= b.close
  );
  // sort by time just in case, then keep last 300
  clean.sort((a, b) => a.time - b.time);
  return clean.slice(-300);
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('Fetching SHA0.DE …');
  const sha0Bars = await fetchBars('SHA0.DE');
  console.log(`  SHA0.DE: ${sha0Bars.length} bars, last close = ${sha0Bars.at(-1).close}`);

  console.log('Fetching BBOX.L …');
  const bboxBars = await fetchBars('BBOX.L');
  console.log(`  BBOX.L:  ${bboxBars.length} bars, last close = ${bboxBars.at(-1).close}`);

  console.log('Fetching HTWS.L …');
  const htwsBars = await fetchBars('HTWS.L');
  console.log(`  HTWS.L:  ${htwsBars.length} bars, last close = ${htwsBars.at(-1).close}`);

  const SHA0_SCREENER = { exchange:'XETRA', price:sha0Bars.at(-1).close, chg:null, rsi:null, macd:null, ema50:null, ema100:null, relVol:null, mktCap:null, rating:null, div:null, earnings:null };
  const BBOX_SCREENER  = { exchange:'LSE',   price:bboxBars.at(-1).close,  chg:null, rsi:null, macd:null, ema50:null, ema100:null, relVol:null, mktCap:null, rating:null, div:null, earnings:null };
  const HTWS_SCREENER  = { exchange:'LSE',   price:htwsBars.at(-1).close,  chg:null, rsi:null, macd:null, ema50:null, ema100:null, relVol:null, mktCap:null, rating:null, div:null, earnings:null };

  const sha0 = buildAnalysis('SHA0', 'Schaeffler AG',         'Industrial/AutoComponents', SHA0_SCREENER, sha0Bars, null, null, null);
  const bbox = buildAnalysis('BBOX', 'Tritax Big Box REIT',   'Real Estate/REIT',          BBOX_SCREENER,  bboxBars,  null, null, null);
  const htws = buildAnalysis('HTWS', 'Helios Towers PLC',     'Telecom/TowerInfrastructure', HTWS_SCREENER, htwsBars, null, null, null);

  const result = {
    generated_at: new Date().toISOString(),
    note: 'Daily OHLCV via Yahoo Finance (SHA0.DE / BBOX.L / HTWS.L). No 4H/1H data available.',
    symbols: ['SHA0','BBOX','HTWS'],
    analyses: [sha0, bbox, htws]
  };

  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('\n✓ Written:', OUT);
  for (const a of result.analyses) {
    console.log(`  ${a.symbol}: score=${a.composite.score} → ${a.composite.verdict}  [${a.composite.signals.join(', ')}]`);
  }
})();

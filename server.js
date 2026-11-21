const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const BASE = 'https://api.coindcx.com';
const INTERVAL = '5m';

let cache = { updatedAt: null, signals: [], errors: [] };

async function getInstruments() {
  const r = await axios.get(`${BASE}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT`, { timeout: 15000 });
  return r.data;
}

async function getCandles(pair) {
  const r = await axios.get(`${BASE}/exchange/v1/derivatives/futures/data/candles`, {
    params: { pair, interval: INTERVAL, limit: 100 }, timeout: 15000
  });
  return Array.isArray(r.data) ? r.data : [];
}

async function getOrderBook(pair) {
  try {
    const r = await axios.get(`${BASE}/exchange/v1/derivatives/futures/data/orderbook`, { params: { pair }, timeout: 8000 });
    return r.data;
  } catch { return null; }
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function ema(values, period) {
  if (values.length < period) return 0;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (const v of values.slice(period)) e = v*k + e*(1-k);
  return e;
}
function rsi(values, period=14) {
  if (values.length <= period) return 50;
  let gains=0, losses=0;
  for(let i=values.length-period;i<values.length;i++) {
    const d=values[i]-values[i-1];
    if(d>0) gains+=d; else losses-=d;
  }
  if(losses===0) return 100;
  return 100 - 100/(1+gains/losses);
}
function analyze(candles, book) {
  if(candles.length < 55) return null;
  const c = candles.map(x=>({ close:num(x.close), open:num(x.open), high:num(x.high), low:num(x.low), volume:num(x.volume) })).filter(x=>x.close>0);
  if(c.length<55) return null;
  const closes=c.map(x=>x.close), last=c[c.length-1], prev=c[c.length-2];
  const volumes=c.slice(-20).map(x=>x.volume);
  const avgVol=volumes.slice(0,-1).reduce((a,b)=>a+b,0)/Math.max(1,volumes.length-1);
  const volRising=last.volume>avgVol*1.15 && avgVol>0;
  const e9=ema(closes,9), e20=ema(closes,20), e50=ema(closes,50);
  const momentum=rsi(closes);
  let buy=0, sell=0, reasons=[];
  if(e9>e20 && e20>e50) { buy+=2; reasons.push('EMA bullish alignment'); }
  if(e9<e20 && e20<e50) { sell+=2; reasons.push('EMA bearish alignment'); }
  if(momentum>52) { buy++; reasons.push('RSI bullish'); }
  if(momentum<48) { sell++; reasons.push('RSI bearish'); }
  if(last.close>prev.close && last.close>last.open) { buy++; reasons.push('Positive candle'); }
  if(last.close<prev.close && last.close<last.open) { sell++; reasons.push('Negative candle'); }
  if(volRising) {
    if(last.close>last.open) buy+=2;
    if(last.close<last.open) sell+=2;
    reasons.push('Volume expansion');
  }
  let bid=0, ask=0;
  if(book) {
    const bids=book.bids || book.buy || [];
    const asks=book.asks || book.sell || [];
    bid=Array.isArray(bids)?bids.reduce((s,x)=>s+num(Array.isArray(x)?x[1]:x.quantity),0):0;
    ask=Array.isArray(asks)?asks.reduce((s,x)=>s+num(Array.isArray(x)?x[1]:x.quantity),0):0;
    if(bid+ask>0) {
      if(bid>ask*1.15) { buy++; reasons.push('Order book bid pressure'); }
      if(ask>bid*1.15) { sell++; reasons.push('Order book ask pressure'); }
    }
  }
  const direction=buy>=sell?'BUY':'SELL';
  const score=Math.max(buy,sell), total=buy+sell;
  const confidence=Math.min(95,Math.round(50+Math.abs(buy-sell)*8));
  const recentHigh=Math.max(...c.slice(-20).map(x=>x.high));
  const recentLow=Math.min(...c.slice(-20).map(x=>x.low));
  const entry=last.close;
  const risk=Math.max(entry*0.003, (recentHigh-recentLow)*0.25);
  const target=direction==='BUY'?entry+risk*1.5:entry-risk*1.5;
  const stop=direction==='BUY'?entry-risk:entry+risk;
  return { direction, price:entry, target, stopLoss:stop, confidence, buyScore:buy, sellScore:sell, rsi:momentum, ema9:e9, ema20:e20, ema50:e50, volumeRising:volRising, orderBook:{bid,ask}, reasons };
}

async function scan() {
  const instruments=await getInstruments();
  const pairs=(Array.isArray(instruments)?instruments:[]).map(x=>typeof x==='string'?x:(x.pair||x.symbol)).filter(Boolean);
  const results=[], errors=[];
  let index=0;
  async function worker() {
    while(index<pairs.length) {
      const pair=pairs[index++];
      try {
        const [candles,book]=await Promise.all([getCandles(pair),getOrderBook(pair)]);
        const result=analyze(candles,book);
        if(result) results.push({pair,...result});
      } catch(e) { errors.push({pair,error:e.message}); }
    }
  }
  await Promise.all(Array.from({length:8},()=>worker()));
  results.sort((a,b)=>b.confidence-a.confidence);
  cache={updatedAt:new Date().toISOString(),signals:results,errors:errors.slice(0,20)};
  return cache;
}

app.get('/api/health',(req,res)=>res.json({status:'ok',exchange:'CoinDCX Futures',timeframe:INTERVAL}));
app.get('/api/signals',(req,res)=>res.json(cache));
app.post('/api/scan',async(req,res)=>{
  try { res.json(await scan()); }
  catch(e) { res.status(500).json({error:e.message}); }
});
app.get('*',(req,res)=>res.send('UD CoinDCX Price Direction Scanner API is running.'));

app.listen(PORT,()=>console.log(`Scanner running on port ${PORT}`));

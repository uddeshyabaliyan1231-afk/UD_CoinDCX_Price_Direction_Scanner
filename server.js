
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const API = 'https://api.coindcx.com';
const PUBLIC = 'https://public.coindcx.com';

let cache = {
  updatedAt: null,
  signals: [],
  errors: [],
  scanned: 0
};

const http = axios.create({ timeout: 15000 });

async function getInstruments() {
  const url = `${API}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT`;
  const r = await http.get(url);
  if (!Array.isArray(r.data)) throw new Error('Invalid instruments response');
  return r.data.map(x => typeof x === 'string' ? x : x.pair).filter(Boolean);
}

async function getCandles(pair) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - (100 * 300);

  const r = await http.get(`${PUBLIC}/market_data/candlesticks`, {
    params: {
      pair,
      from,
      to: now,
      resolution: '5',
      pcode: 'f'
    }
  });

  const raw = Array.isArray(r.data) ? r.data : r.data?.data;

  if (!Array.isArray(raw)) {
    throw new Error('Invalid candle response');
  }

  return raw.map(x => ({
    time: Number(x.time || x.open_time || 0),
    open: Number(x.open),
    high: Number(x.high),
    low: Number(x.low),
    close: Number(x.close),
    volume: Number(x.volume)
  })).filter(x =>
    x.close > 0 &&
    x.open > 0 &&
    x.high > 0 &&
    x.low > 0
  ).sort((a, b) => a.time - b.time);
}

async function getOrderBook(pair) {
  try {
    const url = `${PUBLIC}/market_data/v3/orderbook/${pair}-futures/50`;
    const r = await http.get(url);
    return r.data;
  } catch {
    return null;
  }
}

function sumLevels(levels) {
  if (!Array.isArray(levels)) return 0;

  return levels.reduce((sum, item) => {
    if (Array.isArray(item)) {
      return sum + Number(item[1] || 0);
    }

    if (typeof item === 'object' && item !== null) {
      return sum + Number(item.quantity || item.qty || item.q || 0);
    }

    return sum;
  }, 0);
}

function ema(values, period) {
  if (values.length < period) return 0;

  const k = 2 / (period + 1);
  let result = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (const value of values.slice(period)) {
    result = value * k + result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  if (losses === 0) return 100;

  return 100 - (100 / (1 + gains / losses));
}

function analyze(candles, book) {
  if (candles.length < 55) return null;

  const closes = candles.map(x => x.close);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const e9 = ema(closes, 9);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const momentum = rsi(closes);

  const recentVolumes = candles.slice(-21, -1)
    .map(x => x.volume);

  const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) /
    Math.max(recentVolumes.length, 1);

  const volumeRising =
    last.volume > avgVolume * 1.15 && avgVolume > 0;

  let buy = 0;
  let sell = 0;
  const reasons = [];

  if (e9 > e20 && e20 > e50) {
    buy += 2;
    reasons.push('Bullish EMA alignment');
  }

  if (e9 < e20 && e20 < e50) {
    sell += 2;
    reasons.push('Bearish EMA alignment');
  }

  if (momentum > 52) {
    buy++;
    reasons.push('Bullish RSI');
  }

  if (momentum < 48) {
    sell++;
    reasons.push('Bearish RSI');
  }

  if (last.close > last.open && last.close > prev.close) {
    buy++;
    reasons.push('Buying candle');
  }

  if (last.close < last.open && last.close < prev.close) {
    sell++;
    reasons.push('Selling candle');
  }

  if (volumeRising) {
    if (last.close > last.open) buy += 2;
    if (last.close < last.open) sell += 2;
    reasons.push('Rising volume');
  }

  let bid = 0;
  let ask = 0;

  if (book) {
    const bids = book.bids || [];
    const asks = book.asks || [];

    bid = sumLevels(bids);
    ask = sumLevels(asks);

    if (bid > ask * 1.15 && bid > 0) {
      buy++;
      reasons.push('Order book buying pressure');
    }

    if (ask > bid * 1.15 && ask > 0) {
      sell++;
      reasons.push('Order book selling pressure');
    }
  }

  const direction = buy >= sell ? 'BUY' : 'SELL';
  const difference = Math.abs(buy - sell);

  const confidence = Math.min(
    95,
    50 + difference * 8
  );

  const recent = candles.slice(-20);

  const high = Math.max(...recent.map(x => x.high));
  const low = Math.min(...recent.map(x => x.low));

  const entry = last.close;
  const risk = Math.max(
    entry * 0.003,
    (high - low) * 0.25
  );

  const target = direction === 'BUY'
    ? entry + risk * 1.5
    : entry - risk * 1.5;

  const stopLoss = direction === 'BUY'
    ? entry - risk
    : entry + risk;

  return {
    direction,
    price: entry,
    target,
    stopLoss,
    confidence,
    buyScore: buy,
    sellScore: sell,
    rsi: momentum,
    ema9: e9,
    ema20: e20,
    ema50: e50,
    volumeRising,
    orderBook: { bid, ask },
    reasons
  };
}

async function scan() {
  const pairs = await getInstruments();

  const signals = [];
  const errors = [];

  let index = 0;
  let scanned = 0;

  async function worker() {
    while (index < pairs.length) {
      const pair = pairs[index++];

      try {
        const [candles, book] = await Promise.all([
          getCandles(pair),
          getOrderBook(pair)
        ]);

        scanned++;

        const result = analyze(candles, book);

        if (result) {
          signals.push({ pair, ...result });
        }
      } catch (error) {
        errors.push({
          pair,
          error: error.message
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: 8 }, () => worker())
  );

  signals.sort((a, b) => b.confidence - a.confidence);

  cache = {
    updatedAt: new Date().toISOString(),
    scanned,
    signals,
    errors: errors.slice(0, 30)
  };

  return cache;
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    exchange: 'CoinDCX Futures',
    timeframe: '5m'
  });
});

app.get('/api/signals', (req, res) => {
  res.json(cache);
});

app.post('/api/scan', async (req, res) => {
  try {
    const result = await scan();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get('/api/debug', (req, res) => {
  res.json({
    scanned: cache.scanned,
    signals: cache.signals.length,
    errors: cache.errors,
    updatedAt: cache.updatedAt
  });
});

app.get('*', (req, res) => {
  res.send('UD CoinDCX Futures Scanner API Running');
});

app.listen(PORT, () => {
  console.log(`Scanner running on port ${PORT}`);
});

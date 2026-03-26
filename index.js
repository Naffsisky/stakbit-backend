import 'dotenv/config'
import https from 'node:https'
import Fastify from 'fastify'
import { WebSocketServer } from 'ws'

const app = Fastify()
const wss = new WebSocketServer({ port: 8081 })
const clients = new Set()

// ─── Index config ─────────────────────────────────────────────────────────────
const INDEX_SYMBOLS = ['IHSG', 'LQ45', 'IDX30']

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    https
      .get(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          headers: {
            authorization: `Bearer ${process.env.STOCKBIT_BEARER}`,
            accept: 'application/json',
            origin: 'https://stockbit.com',
            referer: 'https://stockbit.com/',
            'user-agent': 'Mozilla/5.0',
          },
        },
        (res) => {
          let body = ''
          res.on('data', (c) => (body += c))
          res.on('end', () => {
            try {
              resolve(JSON.parse(body))
            } catch (e) {
              reject(new Error('JSON parse error: ' + body.substring(0, 100)))
            }
          })
        },
      )
      .on('error', reject)
  })
}

// ─── State ────────────────────────────────────────────────────────────────────
let lastData = {}
let lastTrades = []
let lastTradeId = null
let lastIndexData = {}

// ─── Broadcast ────────────────────────────────────────────────────────────────
function broadcast(data) {
  const payload = JSON.stringify(data)
  for (const client of clients) {
    if (client.readyState === 1) client.send(payload)
  }
}

function diff(newItems) {
  const changes = []
  for (const item of newItems) {
    const prev = lastData[item.symbol]
    if (!prev || JSON.stringify(prev) !== JSON.stringify(item)) {
      changes.push(item)
      lastData[item.symbol] = item
    }
  }
  return changes
}

// ─── Index normalizer ─────────────────────────────────────────────────────────
function normalizeIndex(data) {
  return {
    symbol: data.symbol,
    name: data.name,
    lastprice: data.lastprice,
    open: data.open,
    high: data.high,
    low: data.low,
    close: data.close,
    change: data.change,
    percentage_change: data.percentage_change,
    volume: data.volume,
    value: data.value,
    frequency: data.frequency,
    fbuy: data.fbuy,
    fsell: data.fsell,
    fnet: data.fnet,
    foreign: data.foreign,
    domestic: data.domestic,
    up: data.up,
    down: data.down,
    unchanged: data.unchanged,
    status: data.status,
    market_data: data.market_data ?? [],
  }
}

// ─── Generic index poller ─────────────────────────────────────────────────────
async function pollIndex(symbol) {
  try {
    const url = `https://exodus.stockbit.com/company-price-feed/v2/orderbook/companies/${symbol}`
    const json = await fetchJson(url)

    if (!json.data) {
      console.error(`[index:${symbol}] unexpected response:`, JSON.stringify(json).substring(0, 200))
      return
    }

    const normalized = normalizeIndex(json.data)
    const prev = lastIndexData[symbol]

    if (!prev || JSON.stringify(prev) !== JSON.stringify(normalized)) {
      lastIndexData[symbol] = normalized
      broadcast({ type: 'index_update', symbol, data: normalized })
      console.log(`[index:${symbol}] broadcasted | price=${normalized.lastprice} chg=${normalized.percentage_change}%`)
    }
  } catch (err) {
    console.error(`[index:${symbol}] error:`, err.message)
  }
}

// ─── Orderbook poller ─────────────────────────────────────────────────────────
async function poll() {
  try {
    const json = await fetchJson(`https://exodus.stockbit.com/orderbook/${process.env.ORDERBOOK_ID}`)
    if (!json.data?.item) {
      console.error('[poll] unexpected response:', JSON.stringify(json).substring(0, 200))
      return
    }
    const changes = diff(json.data.item)
    if (changes.length) broadcast({ type: 'update', data: changes })
  } catch (err) {
    console.error('[poll] error:', err.message)
  }
}

// ─── Running trade poller ─────────────────────────────────────────────────────
async function pollRunningTrade() {
  try {
    const json = await fetchJson(`https://exodus.stockbit.com/order-trade/running-trade?sort=DESC&limit=50&order_by=RUNNING_TRADE_ORDER_BY_TIME&watchlist_id=${process.env.WATCHLIST_ID}`)

    const trades = json.data?.running_trade
    if (!trades?.length) {
      console.log('[running-trade] no trades')
      return
    }

    if (!lastTradeId || lastTradeId !== trades[0].id) {
      lastTradeId = trades[0].id
      lastTrades = trades
      broadcast({ type: 'trade_update', data: trades })
      console.log('[running-trade] broadcasted', trades.length, 'trades')
    }
  } catch (err) {
    console.error('[running-trade] error:', err.message)
  }
}

// ─── WS: send snapshot on connect ─────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws)

  if (Object.keys(lastData).length) ws.send(JSON.stringify({ type: 'snapshot', data: Object.values(lastData) }))

  if (lastTrades.length) ws.send(JSON.stringify({ type: 'trade_snapshot', data: lastTrades }))

  const indexSnapshot = Object.values(lastIndexData)
  if (indexSnapshot.length) ws.send(JSON.stringify({ type: 'index_snapshot', data: indexSnapshot }))

  ws.on('close', () => clients.delete(ws))
})

// ─── Boot ─────────────────────────────────────────────────────────────────────
poll()
pollRunningTrade()

INDEX_SYMBOLS.forEach((symbol, i) => {
  setTimeout(() => {
    pollIndex(symbol)
    setInterval(() => pollIndex(symbol), 1000)
  }, i * 200)
})

setInterval(poll, 1000)
setInterval(pollRunningTrade, 1000)

app.get('/health', async () => ({
  status: 'ok',
  symbols: Object.keys(lastData),
  indices: Object.keys(lastIndexData),
}))

app.listen({ port: 8080 }, () => console.log('[server] http:8080 ws:8081'))

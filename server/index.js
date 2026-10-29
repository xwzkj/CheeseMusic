import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { WebSocketServer } from 'ws'
import {
  CONFIG_FILE,
  DATA_DIR,
  WEB_DIR,
  STATE_FILE,
  loadConfig,
  saveConfig
} from './config.js'
import * as netease from './netease.js'
import { AudioOutput } from './player/audio.js'
import { PlayerEngine } from './player/engine.js'
import { PlayerState } from './player/state.js'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
const config = loadConfig()
const startedAt = Date.now()
const audio = new AudioOutput(config)
const engine = new PlayerEngine(audio, { latency: config.audio.latency })
const player = new PlayerState({ engine, stateFile: STATE_FILE, config })

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '4mb' }))

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)

function localAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal) out.push({ name, address: info.address })
    }
  }
  return out
}

function playerState(includeQueue = true) {
  return {
    ...player.getState({ includeQueue }),
    audio: audio.current
  }
}

/* ------------------------------------------------------------------ */
/* health & system                                                     */
/* ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: pkg.version,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    audio: audio.current,
    loggedIn: netease.hasCookie()
  })
})

app.get('/api/system/info', (req, res) => {
  res.json({
    version: pkg.version,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    node: process.version,
    hostname: os.hostname(),
    platform: process.platform,
    addresses: localAddresses(),
    webBuilt: fs.existsSync(path.join(WEB_DIR, 'index.html')),
    tools: audio.tools
  })
})

app.get('/api/system/audio', (req, res) => {
  res.json({
    ...audio.snapshot(),
    config: { backend: config.audio.backend, device: config.audio.device }
  })
})

app.put('/api/system/audio', wrap(async (req, res) => {
  const backend = req.body?.backend || config.audio.backend
  const device = req.body?.device || config.audio.device
  const wantTest = Boolean(req.body?.test)

  config.audio.backend = backend
  config.audio.device = device
  saveConfig(config)

  const result = await player.reconfigureOutput(async () => {
    const current = await audio.detect()
    if (wantTest && current.available) {
      await audio.test({ backend: current.backend, device: current.device, tone: true })
    }
    return current
  })

  res.json({
    ok: result?.available !== false,
    output: audio.current,
    message: result?.available === false ? result.error || '没有可用的音频输出设备' : '已切换音频输出',
    state: playerState()
  })
}))

app.post('/api/system/audio/test', wrap(async (req, res) => {
  let test
  const result = await player.reconfigureOutput(async () => {
    test = await audio.test({
      backend: req.body?.backend || audio.current.backend,
      device: req.body?.device || audio.current.device,
      tone: true
    })
    return { available: audio.current.available, test }
  })
  res.json({ ok: Boolean(test?.ok), test, output: audio.current, state: result?.state || playerState() })
}))

/* ------------------------------------------------------------------ */
/* Netease API proxy & account                                         */
/* ------------------------------------------------------------------ */

app.post('/api/netease', wrap(async (req, res) => {
  const { path: apiPath, query } = req.body || {}
  if (!apiPath) {
    res.status(400).json({ code: 400, message: '缺少 path 参数' })
    return
  }
  try {
    const body = await netease.callApi(apiPath, query)
    res.json(body)
  } catch (err) {
    res.status(err.statusCode || 502).json({
      code: err.statusCode || 502,
      message: err.message || '网易云 API 请求失败'
    })
  }
}))

app.get('/api/auth/status', wrap(async (req, res) => {
  if (!netease.hasCookie()) {
    res.json({ loggedIn: false, profile: null, code: 200 })
    return
  }
  const status = await netease.loginStatus()
  const loggedIn = Boolean(status?.profile)
  if (!loggedIn && netease.hasCookie()) netease.clearCookie()
  res.json({
    loggedIn,
    code: status?.code ?? 200,
    profile: status?.profile || null,
    account: status?.account || null
  })
}))

app.post('/api/auth/cookie', wrap(async (req, res) => {
  let cookie = String(req.body?.cookie || '').trim()
  if (cookie && !cookie.includes('=')) cookie = `MUSIC_U=${cookie}`
  if (!/MUSIC_U=[^;\s]+/.test(cookie)) {
    res.status(400).json({ ok: false, message: '没有找到有效的 MUSIC_U' })
    return
  }
  netease.setCookie(cookie)
  const status = await netease.loginStatus()
  const ok = Boolean(status?.profile)
  if (!ok) netease.clearCookie()
  res.json({ ok, profile: status?.profile || null })
}))

app.delete('/api/auth/cookie', (req, res) => {
  netease.clearCookie()
  res.json({ ok: true })
})

app.get('/api/auth/cookie', (req, res) => {
  res.json({ hasCookie: netease.hasCookie() })
})

/* ------------------------------------------------------------------ */
/* playback queue                                                      */
/* ------------------------------------------------------------------ */

app.get('/api/player/state', (req, res) => {
  res.json(playerState(true))
})

app.post('/api/player/queue', wrap(async (req, res) => {
  const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks : []
  if (!tracks.length) {
    res.status(400).json({ message: '播放列表不能为空' })
    return
  }
  await player.setQueue(tracks, {
    startIndex: req.body?.startIndex ?? 0,
    play: Boolean(req.body?.play)
  })
  res.json(playerState(true))
}))

app.post('/api/player/add', wrap(async (req, res) => {
  if (!Array.isArray(req.body?.tracks) || !req.body.tracks.length) {
    res.status(400).json({ message: '缺少要添加的歌曲' })
    return
  }
  await player.addTracks(req.body.tracks, {
    position: req.body?.position ?? 'now',
    playNow: Boolean(req.body?.playNow)
  })
  res.json(playerState(true))
}))

app.post('/api/player/add-next', wrap(async (req, res) => {
  if (!Array.isArray(req.body?.tracks) || !req.body.tracks.length) {
    res.status(400).json({ message: '缺少要添加的歌曲' })
    return
  }
  const result = await player.addNext(req.body.tracks)
  res.json({ ...playerState(true), addNext: result })
}))

app.post('/api/player/remove', (req, res) => {
  player.removeTracks(req.body?.ids ?? req.body?.id ?? [])
  res.json(playerState(true))
})

app.post('/api/player/clear', (req, res) => {
  player.clear()
  res.json(playerState(true))
})

/* ------------------------------------------------------------------ */
/* playback control                                                    */
/* ------------------------------------------------------------------ */

const simpleAction = (fn) => wrap(async (req, res) => {
  await fn(req)
  res.json(playerState(true))
})

app.post('/api/player/play', simpleAction(() => player.play()))
app.post('/api/player/pause', simpleAction(() => player.pause()))
app.post('/api/player/toggle', simpleAction(() => player.toggle()))
app.post('/api/player/next', simpleAction(() => player.next()))
app.post('/api/player/prev', simpleAction(() => player.prev()))
app.post('/api/player/seek', simpleAction((req) => player.seek(req.body?.position ?? req.body?.time ?? 0)))
app.post('/api/player/index', simpleAction((req) => player.playIndex(req.body?.index, req.body?.play !== false)))
app.post('/api/player/mode', simpleAction((req) => player.setMode(req.body?.mode)))
app.post('/api/player/volume', simpleAction((req) => {
  if (typeof req.body?.volume === 'number') player.setVolume(req.body.volume)
  if (typeof req.body?.muted === 'boolean') player.setMuted(req.body.muted)
}))
app.post('/api/player/mute', simpleAction((req) => player.setMuted(Boolean(req.body?.muted))))
app.post('/api/player/lyric-delay', simpleAction((req) => {
  player.setLyricDelay(req.body?.delay ?? req.body?.lyricDelay)
}))
app.post('/api/player/quality', simpleAction((req) => {
  player.setQuality(req.body?.quality)
  config.quality = player.quality
  saveConfig(config)
}))
app.post('/api/player/reload', simpleAction((req) => player.reloadCurrent(req.body?.position ?? null)))

/* ------------------------------------------------------------------ */
/* websocket                                                           */
/* ------------------------------------------------------------------ */

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })
let lastBroadcastQueueRevision = -1

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
}

function broadcastState() {
  const includeQueue = player.queueRevision !== lastBroadcastQueueRevision
  lastBroadcastQueueRevision = player.queueRevision
  const message = { type: 'state', state: playerState(includeQueue) }
  for (const ws of wss.clients) send(ws, message)
}

wss.on('connection', (ws) => {
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })
  ws.on('error', () => {})
  send(ws, { type: 'state', state: playerState(true) })
  send(ws, { type: 'hello', version: pkg.version })
})

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, 30_000)
heartbeat.unref?.()

player.subscribe(() => {
  try {
    broadcastState()
  } catch (err) {
    console.warn('[ws] 广播播放状态失败：', err.message)
  }
})

/* ------------------------------------------------------------------ */
/* static frontend                                                     */
/* ------------------------------------------------------------------ */

const indexFile = path.join(WEB_DIR, 'index.html')

app.use(express.static(WEB_DIR, {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache')
    else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    } else res.setHeader('Cache-Control', 'public, max-age=3600')
  }
}))

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/ws') return next()
  if (!fs.existsSync(indexFile)) {
    res.status(503).type('html').send(
      '<!doctype html><meta charset="utf-8"><title>奶酪音乐</title>' +
      '<body style="font-family:system-ui;padding:3rem;line-height:1.8">' +
      '<h1>前端还没有构建</h1><p>在项目目录运行：</p>' +
      '<pre style="background:#eee;padding:1rem;border-radius:.5rem">pnpm build</pre>' +
      '<p>然后刷新本页。</p></body>'
    )
    return
  }
  res.sendFile(indexFile)
})

app.use('/api', (req, res) => {
  res.status(404).json({ code: 404, message: '接口不存在' })
})

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[http]', err)
  if (res.headersSent) return
  res.status(err.statusCode || 500).json({
    code: err.statusCode || 500,
    message: err.message || '服务器内部错误'
  })
})

/* ------------------------------------------------------------------ */
/* startup                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  if (!fs.existsSync(CONFIG_FILE)) saveConfig(config)
  await audio.detect()
  const port = Number(config.port)
  const host = config.host

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n端口 ${port} 已被占用。可以用 CHEESE_PORT=8091 pnpm start 换一个端口。\n`)
      }
      reject(err)
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })

  console.log('')
  console.log(`  🧀 奶酪音乐 · 本地服务器版 v${pkg.version}`)
  console.log(`  本机访问   http://127.0.0.1:${port}`)
  for (const { name, address } of localAddresses()) {
    console.log(`  局域网访问 http://${address}:${port}  (${name})`)
  }
  console.log(`  数据目录   ${DATA_DIR}`)
  console.log(`  音频输出   ${audio.current.backend} / ${audio.current.device}${audio.current.available ? '' : '  [不可用]'}`)
  console.log('')
}

const shutdown = (signal) => {
  console.log(`\n[server] 收到 ${signal}，正在退出…`)
  clearInterval(heartbeat)
  try {
    player.shutdown()
  } catch {
    // ignore
  }
  for (const ws of wss.clients) ws.close()
  wss.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err)
})

main().catch((err) => {
  console.error('[server] 启动失败：', err)
  process.exit(1)
})

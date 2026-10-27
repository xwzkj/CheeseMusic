import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const SAMPLE_RATE = 44_100
export const CHANNELS = 2
export const BYTES_PER_SAMPLE = 2
export const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE

const toolCache = new Map()

function commandExists(cmd) {
  if (!toolCache.has(cmd)) {
    toolCache.set(cmd, spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0)
  }
  return toolCache.get(cmd)
}

function runCapture(cmd, args, timeout = 5000) {
  try {
    const result = spawnSync(cmd, args, {
      encoding: 'utf-8',
      timeout,
      env: process.env,
      maxBuffer: 32 * 1024 * 1024
    })
    return result.status === 0 ? result.stdout || '' : ''
  } catch {
    return ''
  }
}

/**
 * When the server is started from a plain shell/systemd unit it may not have
 * the desktop session's XDG_RUNTIME_DIR. Bluetooth/PipeWire sinks live in
 * /run/user/<uid>, so infer it when possible. This is what makes Bluetooth
 * headset/speaker output visible to the service.
 */
export function ensureAudioSessionEnv() {
  const hasPipeWire = (dir) => {
    try {
      return fs.statSync(path.join(dir, 'pipewire-0')).isSocket()
    } catch {
      return false
    }
  }

  if (process.env.XDG_RUNTIME_DIR && hasPipeWire(process.env.XDG_RUNTIME_DIR)) {
    return process.env.XDG_RUNTIME_DIR
  }
  if (typeof process.getuid !== 'function') return ''
  const dir = `/run/user/${process.getuid()}`
  if (!hasPipeWire(dir)) return ''

  process.env.XDG_RUNTIME_DIR = dir
  const bus = path.join(dir, 'bus')
  if (!process.env.DBUS_SESSION_BUS_ADDRESS && fs.existsSync(bus)) {
    process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`
  }
  const pulse = path.join(dir, 'pulse', 'native')
  if (!process.env.PULSE_SERVER && fs.existsSync(pulse)) {
    process.env.PULSE_SERVER = `unix:${pulse}`
  }
  return dir
}

// Do this before any child process or PipeWire query is spawned.
const inferredRuntimeDir = ensureAudioSessionEnv()

function run(cmd, args, timeout = 4000) {
  return execFileAsync(cmd, args, {
    timeout,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024
  }).then(({ stdout }) => stdout || '').catch(() => '')
}

/** True when we can steer a pw-play stream through PipeWire itself. */
export function hasPipeWireControl() {
  return commandExists('pw-dump') && commandExists('wpctl')
}

/**
 * Locate the PipeWire node id of a stream created with `-P node.name=...`.
 * Returns null when the node never shows up (or pw-dump is unavailable).
 */
export async function findPipeWireStreamNode(nodeName, { tries = 6, intervalMs = 60 } = {}) {
  if (!nodeName || !commandExists('pw-dump')) return null
  for (let attempt = 0; attempt < tries; attempt++) {
    const raw = await run('pw-dump', [], 2500)
    if (raw) {
      try {
        const objects = JSON.parse(raw)
        const hit = (Array.isArray(objects) ? objects : []).find((object) =>
          object?.info?.props?.['media.class'] === 'Stream/Output/Audio' &&
          object.info.props['node.name'] === nodeName
        )
        if (hit && Number.isInteger(hit.id)) return hit.id
      } catch {
        // Malformed dump: try again.
      }
    }
    if (attempt + 1 < tries) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  return null
}

/**
 * Set the playback stream's own volume in the PipeWire graph. Because the
 * gain is applied while the graph mixes, a change is audible almost at once,
 * unlike scaling PCM inside Node (which sits behind the pipe/device buffer).
 */
export async function setPipeWireNodeVolume(id, volume) {
  if (!id || !commandExists('wpctl')) return false
  const value = Math.max(0, Math.min(1, Number(volume) || 0))
  try {
    await execFileAsync('wpctl', ['set-volume', String(id), value.toFixed(3)], {
      timeout: 1500,
      env: process.env
    })
    return true
  } catch {
    return false
  }
}

export function listAlsaDevices() {
  const result = spawnSync('aplay', ['-l'], { encoding: 'utf-8', timeout: 3000 })
  if (result.status !== 0 || !result.stdout) return []
  const devices = []
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^card (\d+): (\S+) \[([^\]]+)\], device (\d+): ([^\[]+)(?:\[([^\]]+)\])?/)
    if (!match) continue
    const [, card, cardId, cardName, device, deviceName, subName] = match
    const id = `plughw:CARD=${cardId},DEV=${device}`
    const label = `${cardName} ${deviceName} ${subName || ''}`
    devices.push({
      id,
      card: Number(card),
      cardId,
      cardName: cardName.trim(),
      device: Number(device),
      deviceName: deviceName.trim(),
      name: `${cardName.trim()} · ${deviceName.trim()}`,
      description: subName && subName.trim() !== deviceName.trim() ? subName.trim() : '',
      analog: !/digital|hdmi|spdif|iec958/i.test(label) && /analog|speaker|headphone|line out|pch/i.test(label)
    })
  }
  // Analog outputs are the most likely default for a music server.
  devices.sort((a, b) => Number(b.analog) - Number(a.analog) || a.card - b.card || a.device - b.device)
  return devices
}

let pipeWireCache = { at: 0, sinks: [] }

export function getDefaultPipeWireSink() {
  if (!commandExists('wpctl')) return ''
  const output = runCapture('wpctl', ['inspect', '@DEFAULT_AUDIO_SINK@'], 3000)
  const match = output.match(/node\.name\s*=\s*"([^"]+)"/)
  return match ? match[1] : ''
}

/** Enumerate PipeWire sinks, including Bluetooth devices managed by WirePlumber. */
export function listPipeWireSinks({ fresh = false } = {}) {
  ensureAudioSessionEnv()
  if (!fresh && Date.now() - pipeWireCache.at < 3000) return pipeWireCache.sinks
  if (!commandExists('pw-dump')) {
    pipeWireCache = { at: Date.now(), sinks: [] }
    return []
  }
  const raw = runCapture('pw-dump', [], 5000)
  if (!raw) {
    pipeWireCache = { at: Date.now(), sinks: [] }
    return []
  }

  let objects
  try {
    objects = JSON.parse(raw)
  } catch {
    pipeWireCache = { at: Date.now(), sinks: [] }
    return []
  }

  const defaultName = getDefaultPipeWireSink()
  const sinks = []
  for (const object of Array.isArray(objects) ? objects : []) {
    const props = object?.info?.props
    if (!props || props['media.class'] !== 'Audio/Sink') continue
    const nodeName = props['node.name']
    if (!nodeName) continue
    const api = props['device.api'] || ''
    const bluetooth = api === 'bluez5' || /bluez|bluetooth/i.test(nodeName)
    sinks.push({
      backend: 'pw-play',
      device: nodeName,
      name: String(props['node.description'] || props['node.nick'] || nodeName),
      description: bluetooth ? '蓝牙' : api === 'alsa' ? 'PipeWire / ALSA' : 'PipeWire',
      kind: bluetooth ? 'bluetooth' : 'pipewire',
      bluetooth,
      default: nodeName === defaultName
    })
  }
  sinks.sort((a, b) =>
    Number(b.default) - Number(a.default) ||
    Number(b.bluetooth) - Number(a.bluetooth) ||
    a.name.localeCompare(b.name)
  )
  pipeWireCache = { at: Date.now(), sinks }
  return sinks
}

/**
 * Flat list used by the settings dropdown. The `|` separator keeps the
 * backend and the device in one select value.
 */
export function listOutputs() {
  const outputs = []
  if (commandExists('pw-play')) {
    const sinks = listPipeWireSinks()
    if (sinks.length) {
      const defaultSink = sinks.find((sink) => sink.default)
      outputs.push({
        id: 'pw-play|default',
        backend: 'pw-play',
        device: 'default',
        name: defaultSink ? `桌面默认输出（${defaultSink.name}）` : '桌面默认输出（PipeWire）',
        description: '跟随系统默认',
        kind: 'pipewire-default'
      })
      const ordered = [...sinks].sort((a, b) => Number(b.bluetooth) - Number(a.bluetooth))
      for (const sink of ordered) {
        outputs.push({
          ...sink,
          id: `pw-play|${sink.device}`,
          description: sink.bluetooth ? '蓝牙' : sink.description
        })
      }
    }
  }

  if (commandExists('aplay')) {
    outputs.push({
      id: 'aplay|default',
      backend: 'aplay',
      device: 'default',
      name: 'ALSA 系统默认',
      description: 'ALSA',
      kind: 'alsa'
    })
    for (const device of listAlsaDevices()) {
      outputs.push({
        id: `aplay|${device.id}`,
        backend: 'aplay',
        device: device.id,
        name: device.name,
        description: device.description || 'ALSA 直连',
        kind: 'alsa',
        analog: device.analog
      })
    }
  }
  return outputs
}

export function playbackArgs(backend, device, { nodeName = '' } = {}) {
  if (backend === 'pw-play') {
    const args = [
      '--raw',
      '--format=s16',
      `--rate=${SAMPLE_RATE}`,
      `--channels=${CHANNELS}`,
      '--latency=150ms'
    ]
    if (nodeName) {
      args.push('-P', `node.name=${nodeName}`)
      // Do not let WirePlumber restore (or save) a per-role volume for this
      // stream: MPRIS/BT volume is controlled explicitly below, and a restored
      // value would leak the first samples at the wrong level.
      args.push('-P', 'state.restore-props=false')
    }
    if (device && device !== 'auto' && device !== 'default') args.push('--target', device)
    args.push('-')
    return args
  }
  return [
    '-q',
    '-D',
    device || 'default',
    '--buffer-time=250000',
    '--period-time=50000',
    '-t',
    'raw',
    '-f',
    'S16_LE',
    '-c',
    String(CHANNELS),
    '-r',
    String(SAMPLE_RATE),
    '-'
  ]
}

function pcmSilence(seconds = 0.15) {
  return Buffer.alloc(Math.round(BYTES_PER_SECOND * seconds))
}

function pcmTone(seconds = 0.7, frequency = 440, gain = 0.12) {
  const frames = Math.round(SAMPLE_RATE * seconds)
  const buf = Buffer.alloc(frames * CHANNELS * BYTES_PER_SAMPLE)
  const fadeFrames = Math.round(SAMPLE_RATE * 0.02)
  for (let i = 0; i < frames; i++) {
    const fade = Math.min(1, i / fadeFrames) * Math.min(1, (frames - i) / fadeFrames)
    const value = Math.round(Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE) * 32767 * gain * fade)
    buf.writeInt16LE(value, i * 4)
    buf.writeInt16LE(value, i * 4 + 2)
  }
  return buf
}

function runSink({ backend, device, tone, timeoutMs = 6000 }) {
  return new Promise((resolve) => {
    const cmd = backend === 'pw-play' ? 'pw-play' : 'aplay'
    if (!commandExists(cmd)) {
      resolve({ ok: false, error: `未安装 ${cmd}` })
      return
    }
    const args = playbackArgs(backend, device)
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'], env: process.env })
    let stderr = ''
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, error: stderr.trim() || '测试超时' })
    }, timeoutMs)

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-1200)
    })
    child.on('error', (err) => finish({ ok: false, error: err.message }))
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true })
      else finish({ ok: false, error: stderr.trim() || `退出码 ${code}` })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(tone ? pcmTone() : pcmSilence())
  })
}

export class AudioOutput {
  constructor(config, { logger = console } = {}) {
    ensureAudioSessionEnv()
    this.config = config
    this.logger = logger
    this.current = {
      backend: 'aplay',
      device: 'default',
      available: false,
      error: '尚未检测音频输出'
    }
    this.tools = {
      ffmpeg: commandExists('ffmpeg'),
      ffprobe: commandExists('ffprobe'),
      aplay: commandExists('aplay'),
      pwPlay: commandExists('pw-play'),
      pwDump: commandExists('pw-dump'),
      wpctl: commandExists('wpctl')
    }
  }

  async detect() {
    const preferred = {
      backend: this.config.audio?.backend || 'auto',
      device: this.config.audio?.device || 'auto'
    }
    const candidates = []
    const add = (backend, device) => {
      if (!candidates.some((c) => c.backend === backend && c.device === device)) {
        candidates.push({ backend, device })
      }
    }

    const addAlsa = () => {
      if (preferred.backend === 'aplay' && preferred.device !== 'auto') add('aplay', preferred.device)
      add('aplay', 'default')
      for (const device of listAlsaDevices()) add('aplay', device.id)
    }
    const pipeWireSinks = this.tools.pwPlay && this.tools.pwDump ? listPipeWireSinks() : []
    const addPipeWire = () => {
      if (preferred.backend === 'pw-play' && preferred.device !== 'auto') add('pw-play', preferred.device)
      if (pipeWireSinks.length) {
        add('pw-play', 'default')
        for (const sink of pipeWireSinks) add('pw-play', sink.device)
      }
    }

    // An explicitly selected output is always tried first.
    if (preferred.backend !== 'auto' && preferred.device !== 'auto') {
      add(preferred.backend, preferred.device)
    }
    // Keep ALSA-first auto behaviour, but always leave a fallback path so a
    // disconnected Bluetooth speaker does not make the whole server silent.
    if (preferred.backend === 'pw-play') {
      addPipeWire()
      addAlsa()
    } else {
      addAlsa()
      addPipeWire()
    }

    const failures = []
    for (const candidate of candidates) {
      const result = await runSink({ ...candidate, tone: false })
      if (result.ok) {
        this.current = {
          ...candidate,
          available: true,
          source: candidate.device === preferred.device && candidate.backend === preferred.backend ? 'config' : 'auto',
          error: ''
        }
        this.logger.log(`[audio] 输出设备：${candidate.backend} / ${candidate.device}`)
        return this.current
      }
      failures.push(`${candidate.backend}:${candidate.device} → ${result.error}`)
    }

    this.current = {
      backend: preferred.backend === 'auto' ? 'aplay' : preferred.backend,
      device: preferred.device === 'auto' ? 'default' : preferred.device,
      available: false,
      source: 'none',
      error: failures[0] || '没有可用的音频输出设备'
    }
    this.logger.warn('[audio] 未找到可用输出：', this.current.error)
    return this.current
  }

  get args() {
    return playbackArgs(this.current.backend, this.current.device)
  }

  get backend() {
    return this.current.backend
  }

  spawnSink({ nodeName = '' } = {}) {
    ensureAudioSessionEnv()
    const cmd = this.current.backend === 'pw-play' ? 'pw-play' : 'aplay'
    return spawn(cmd, playbackArgs(this.current.backend, this.current.device, { nodeName }), {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: process.env
    })
  }

  async test({ backend, device, tone = true } = {}) {
    ensureAudioSessionEnv()
    const target = {
      backend: backend || this.current.backend,
      device: device || this.current.device
    }
    const result = await runSink({ ...target, tone })
    return { ...result, ...target }
  }

  async applyAndDetect({ backend, device }) {
    if (backend) this.config.audio.backend = backend
    if (device) this.config.audio.device = device
    return this.detect()
  }

  snapshot() {
    const sinks = listPipeWireSinks({ fresh: true })
    const defaultSink = sinks.find((sink) => sink.default)
    return {
      current: this.current,
      tools: this.tools,
      session: {
        pipeWire: sinks.length > 0,
        runtimeDir: process.env.XDG_RUNTIME_DIR || inferredRuntimeDir || '',
        defaultSink: defaultSink ? defaultSink.name : ''
      },
      outputs: listOutputs(),
      devices: listAlsaDevices(),
      pipewire: sinks
    }
  }
}

export function pcmGain(chunk, gain) {
  if (gain >= 0.999) return chunk
  const out = Buffer.allocUnsafe(chunk.length)
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(chunk.readInt16LE(i) * gain))), i)
  }
  // A chunk with an odd trailing byte (rare) is padded with silence.
  if (chunk.length % 2) out[chunk.length - 1] = 0
  return out
}

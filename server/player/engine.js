import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'

/** Best-effort duration probe for streams without metadata. */
export function probeDuration(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let child
    let out = ''
    try {
      child = spawn('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', url
      ], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(0)
      return
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      resolve(0)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { out += chunk.toString() })
    child.on('error', () => { clearTimeout(timer); resolve(0) })
    child.on('close', () => {
      clearTimeout(timer)
      const value = Number.parseFloat(out.trim())
      resolve(Number.isFinite(value) && value > 0 ? value : 0)
    })
  })
}
import {
  SAMPLE_RATE,
  CHANNELS,
  BYTES_PER_SECOND,
  pcmGain,
  hasPipeWireControl,
  findPipeWireStreamNode,
  setPipeWireNodeVolume
} from './audio.js'

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function ffmpegArgs(url, startAt) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  if (startAt > 0.05) args.push('-ss', startAt.toFixed(3))
  if (/^https?:/i.test(url)) {
    args.push(
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
      '-user_agent',
      USER_AGENT,
      '-headers',
      'Referer: https://music.163.com/\r\n'
    )
  }
  args.push(
    '-i',
    url,
    '-vn',
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    '-ac',
    String(CHANNELS),
    '-ar',
    String(SAMPLE_RATE),
    '-'
  )
  return args
}

/**
 * Server-side PCM player.
 *
 * ffmpeg decodes the remote stream to raw s16le and aplay/pw-play writes it to
 * the machine's audio device. Pausing closes the device and keeps the logical
 * offset; resuming restarts ffmpeg at that offset. This is much more reliable
 * than trying to suspend ALSA/PipeWire streams, and it works for every
 * supported output backend.
 */
export class PlayerEngine extends EventEmitter {
  constructor(audioOutput, { latency = 0.22, logger = console, pauseHoldMs = 300_000, volumeSettleMs = 1500 } = {}) {
    super()
    this.audio = audioOutput
    this.latency = latency
    this.logger = logger
    // Keep the decoder and output stream alive for this long after a pause so
    // "resume" needs no reconnect/seek. After that the pipeline is released.
    this.pauseHoldMs = Math.max(0, Number(pauseHoldMs) || 0)
    this.volumeSettleMs = Math.max(100, Number(volumeSettleMs) || 1500)
    this.token = 0
    this.url = null
    this.duration = 0
    this.startOffset = 0
    this.volume = 1
    this.muted = false
    this.loaded = false
    this.loading = false
    this.playing = false
    this._firstChunkAt = 0
    this._ffmpegEnded = false
    this._manual = false
    this._endedEmitted = false
    this._carry = Buffer.alloc(0)
    this._ffmpeg = null
    this._sink = null
    this._stderr = ''
    this._sinkStderr = ''
    this._endTimer = null
    this._pauseTimer = null
    this._volumeTimer = null
    this._paused = false
    this._sinkNodeId = null
    this._graphVolume = false
    this._volumeTarget = 1
    this._sinkSerial = 0
    this._primeTimer = null
    this._instantStart = false
  }

  get gain() {
    return this.muted ? 0 : this.volume
  }

  get currentUrl() {
    return this.url
  }

  position() {
    let pos = this.startOffset
    if (this.loaded && this._firstChunkAt) {
      const elapsed = (Date.now() - this._firstChunkAt) / 1000
      // A fresh pipeline needs `latency` seconds before the first sample is
      // audible; a resumed pipeline is already primed and starts immediately.
      pos += Math.max(0, this._instantStart ? elapsed : elapsed - this.latency)
    }
    if (this.duration > 0) pos = Math.min(pos, this.duration)
    return Math.max(0, pos)
  }

  /**
   * How long the UI should hold its clock after a start before advancing.
   * 0 for an instant resume, and 0 once a start is older than a second (a
   * late-joining/resyncing client already has the right absolute position).
   */
  get startHold() {
    if (this._instantStart) return 0
    if (!this._firstChunkAt) return this.latency
    return Date.now() - this._firstChunkAt < 1000 ? this.latency : 0
  }

  _start({ url, startAt = 0, duration = 0 }) {
    this._teardown()
    const token = ++this.token
    this.url = url
    this.duration = Number(duration) || 0
    this.startOffset = clamp(Number(startAt) || 0, 0, this.duration || Number.MAX_SAFE_INTEGER)
    this.loaded = true
    this.loading = true
    this.playing = false
    this._firstChunkAt = 0
    this._instantStart = false
    this._ffmpegEnded = false
    this._manual = false
    this._endedEmitted = false
    this._carry = Buffer.alloc(0)
    this._stderr = ''
    this._sinkStderr = ''

    const ffmpeg = spawn('ffmpeg', ffmpegArgs(url, this.startOffset), {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this._ffmpeg = ffmpeg
    // Hold decoded audio back until the output gain is in place. The kernel
    // pipe absorbs the first second, so no audio is lost, and WirePlumber's
    // restored stream volume can never leak the first samples.
    ffmpeg.stdout.pause()

    const graphVolume = this.audio.backend === 'pw-play' && hasPipeWireControl()
    const nodeName = graphVolume ? `cheese-music-${process.pid}-${++this._sinkSerial}` : ''

    let sink
    try {
      sink = this.audio.spawnSink({ nodeName })
    } catch (err) {
      this._fail(err, token)
      return
    }
    this._sink = sink
    sink.stdin.on('error', (err) => {
      if (this.token === token && !this._manual) this._fail(new Error(`音频输出写入失败：${err.message}`), token)
    })
    sink.stderr.on('data', (chunk) => {
      this._sinkStderr = (this._sinkStderr + chunk.toString()).slice(-1500)
    })
    sink.on('error', (err) => this._fail(new Error(`音频输出启动失败：${err.message}`), token))
    sink.on('close', (code) => {
      if (this.token !== token) return
      if (this._ffmpegEnded) {
        this._finish(token)
      } else if (!this._manual && code !== 0) {
        this._fail(new Error(this._sinkStderr.trim() || `音频输出进程退出（${code}）`), token)
      }
    })

    ffmpeg.stderr.on('data', (chunk) => {
      this._stderr = (this._stderr + chunk.toString()).slice(-1500)
    })
    ffmpeg.on('error', (err) => this._fail(new Error(`ffmpeg 启动失败：${err.message}`), token))
    ffmpeg.on('close', (code) => {
      if (this.token !== token) return
      this._ffmpegEnded = true
      if (this._paused) return
      try {
        sink.stdin.end()
      } catch {
        // sink already gone
      }
      if (code !== 0 && !this._manual) {
        this._fail(new Error(this._stderr.trim() || `ffmpeg 解码失败（${code}）`), token)
        return
      }
      // Normally aplay exits as soon as stdin is drained. As a safety net,
      // finish the track after the output buffer has had time to play out.
      clearTimeout(this._endTimer)
      this._endTimer = setTimeout(() => this._finish(token), 3500)
    })

    ffmpeg.stdout.on('data', (chunk) => {
      if (this.token !== token || this._manual) return
      const pcm = this._consume(chunk)
      if (!pcm.length) return

      if (!this._firstChunkAt && !this._paused) {
        this._firstChunkAt = Date.now()
        this.loading = false
        this.playing = true
        this.emit('playing')
      }
      // With graph volume the PipeWire stream does the attenuation, so the
      // PCM stays untouched (no per-sample work and no volume lag).
      const out = pcmGain(pcm, this._graphVolume ? 1 : this.gain)
      const ok = sink.stdin.write(out)
      if (!ok) {
        if (!this._paused) ffmpeg.stdout.pause()
        sink.stdin.once('drain', () => {
          if (this.token === token && !this._paused) ffmpeg.stdout.resume()
        })
      }
    })

    if (graphVolume) this._startPrime(sink)

    this.emit('started', { url, startAt: this.startOffset })
    if (graphVolume) this._connectGraphVolume(token, nodeName)
    else ffmpeg.stdout.resume()
  }

  /**
   * Map the freshly spawned pw-play stream to its PipeWire node and push the
   * current gain into the graph. Audio stays gated until that is done (or the
   * settle timeout expires and we fall back to software gain).
   */
  _connectGraphVolume(token, nodeName) {
    const found = findPipeWireStreamNode(nodeName).catch(() => null)
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), this.volumeSettleMs)
      timer.unref?.()
    })
    Promise.race([found, timeout])
      .then(async (id) => {
        if (this.token !== token) return
        if (id) {
          const ok = await setPipeWireNodeVolume(id, this.gain)
          if (this.token !== token) return
          if (ok) {
            this._sinkNodeId = id
            this._graphVolume = true
            this._volumeTarget = this.gain
            this._unlockAudio(token)
            return
          }
        }
        this.logger.warn('[player] 未能定位 PipeWire 播放流，回退到软件音量')
        this._graphVolume = false
        this._sinkNodeId = null
        this._unlockAudio(token)
      })
      .catch(() => {
        if (this.token === token) this._unlockAudio(token)
      })
  }

  /**
   * Feed the fresh stream with short silent blocks until its volume has been
   * set. A client-node that never received data does not service the graph,
   * which makes wpctl's volume roundtrip stall (observed on Bluetooth sinks).
   */
  _startPrime(sink) {
    this._stopPrime()
    const block = Buffer.alloc(Math.round(BYTES_PER_SECOND * 0.04))
    const startedAt = Date.now()
    const pump = () => {
      if (Date.now() - startedAt > 1500) {
        this._stopPrime()
        return
      }
      try {
        sink.stdin.write(block)
      } catch {
        // sink already gone
      }
    }
    pump()
    this._primeTimer = setInterval(pump, 20)
    this._primeTimer.unref?.()
  }

  _stopPrime() {
    if (!this._primeTimer) return
    clearInterval(this._primeTimer)
    this._primeTimer = null
  }

  _unlockAudio(token) {
    if (this.token !== token || this._paused) return
    this._stopPrime()
    const ffmpeg = this._ffmpeg
    if (!ffmpeg) return
    try {
      ffmpeg.stdout.resume()
    } catch {
      // stream already gone
    }
  }

  /** Coalesce rapid slider updates into one wpctl call. */
  _applyGraphVolume(delayMs = 40) {
    if (!this._graphVolume || !this._sinkNodeId) return
    this._volumeTarget = this.gain
    // A SIGSTOPped pw-play does not service the graph, and wpctl's roundtrip
    // can stall on it; keep the value and push it once playback resumes.
    if (this._paused) return
    if (this._volumeTimer) return
    this._volumeTimer = setTimeout(() => {
      this._volumeTimer = null
      const id = this._sinkNodeId
      if (!this._graphVolume || !id) return
      setPipeWireNodeVolume(id, this._volumeTarget).then((ok) => {
        if (!ok) this.logger.warn('[player] 设置 PipeWire 流音量失败')
      })
    }, delayMs)
    this._volumeTimer.unref?.()
  }

  /** Keep PCM sample boundaries aligned across arbitrary stream chunks. */
  _consume(chunk) {
    let buf = this._carry.length ? Buffer.concat([this._carry, chunk]) : chunk
    if (buf.length % 2) {
      this._carry = buf.subarray(buf.length - 1)
      buf = buf.subarray(0, buf.length - 1)
    } else {
      this._carry = Buffer.alloc(0)
    }
    return buf
  }

  play({ url, startAt = 0, duration = 0 }) {
    this._start({ url, startAt, duration })
  }

  resume() {
    if (!this.loaded || !this.url) throw new Error('没有可以继续播放的歌曲')
    // A short pause keeps the decoder and output stream alive (the sink is
    // merely SIGSTOPped), so resuming is immediate and continues exactly where
    // the buffered audio left off.
    if (this._paused && !this._ffmpegEnded && this._ffmpeg && this._sink && this._sink.exitCode === null) {
      if (this._pauseTimer) {
        clearTimeout(this._pauseTimer)
        this._pauseTimer = null
      }
      this._paused = false
      this._manual = false
      // The buffered tail kept playing while the sink was frozen, so the
      // audible position has already moved on by roughly the pipeline latency.
      this.startOffset = clamp(
        this.startOffset + this.latency,
        0,
        this.duration || Number.MAX_SAFE_INTEGER
      )
      this._instantStart = true
      try {
        this._sink.kill('SIGCONT')
      } catch {
        // sink already gone
      }
      try {
        this._ffmpeg.stdout.resume()
      } catch {
        // decoder already gone
      }
      this._firstChunkAt = Date.now()
      this.loading = false
      this.playing = true
      this.emit('playing')
      // Apply any volume changed while the stream was frozen.
      this._applyGraphVolume(120)
      return
    }
    this._start({ url: this.url, startAt: this.startOffset, duration: this.duration })
  }

  pause() {
    const pos = this.position()
    if (this._canHoldPause()) {
      this._paused = true
      this._manual = true
      this.startOffset = pos
      this.loaded = true
      this.loading = false
      this.playing = false
      this._firstChunkAt = 0
      // Freeze the sink process: already queued samples play out, but no new
      // ones are consumed, so the pipe (and thus the exact position) survives.
      try {
        this._sink.kill('SIGSTOP')
      } catch {
        // sink already gone
      }
      try {
        this._ffmpeg.stdout.pause()
      } catch {
        // decoder already gone
      }
      this._pauseTimer = setTimeout(() => this._releasePaused(), this.pauseHoldMs)
      this._pauseTimer.unref?.()
      return pos
    }
    this._manual = true
    this.token++
    this._teardown()
    this.loaded = true
    this.loading = false
    this.playing = false
    this.startOffset = pos
    this._firstChunkAt = 0
    return pos
  }

  /** Only hold a pause once audio is actually flowing. */
  _canHoldPause() {
    return Boolean(
      this.pauseHoldMs > 0 &&
      this.playing &&
      !this._paused &&
      this._ffmpeg &&
      this._sink &&
      this._sink.exitCode === null &&
      !this._ffmpegEnded
    )
  }

  /** Give the sound card back after a long pause; resuming will reconnect. */
  _releasePaused() {
    this._pauseTimer = null
    if (!this._paused) return
    this._paused = false
    this._manual = true
    this.token++
    this._teardown()
    this.loaded = Boolean(this.url)
    this.loading = false
    this.playing = false
    this._firstChunkAt = 0
  }

  seek(seconds) {
    const target = clamp(Number(seconds) || 0, 0, this.duration || Number.MAX_SAFE_INTEGER)
    const wasPlaying = this.playing || this.loading
    this.startOffset = target
    if (this.url && wasPlaying) {
      this._start({ url: this.url, startAt: target, duration: this.duration })
    } else {
      this._manual = true
      this.token++
      this._teardown()
      this.loaded = Boolean(this.url)
      this.playing = false
      this.loading = false
      this._firstChunkAt = 0
    }
    return target
  }

  setVolume(volume) {
    this.volume = clamp(Number(volume), 0, 1)
    this._applyGraphVolume()
    return this.volume
  }

  setMuted(muted) {
    this.muted = Boolean(muted)
    this._applyGraphVolume()
    return this.muted
  }

  stop({ keepLoaded = false } = {}) {
    const pos = this.position()
    this._manual = true
    this.token++
    this._teardown()
    this.playing = false
    this.loading = false
    this._firstChunkAt = 0
    if (keepLoaded && this.url) {
      this.loaded = true
      this.startOffset = pos
    } else {
      this.loaded = false
      this.url = null
      this.startOffset = 0
    }
  }

  _teardown() {
    clearTimeout(this._endTimer)
    this._endTimer = null
    clearTimeout(this._pauseTimer)
    this._pauseTimer = null
    clearTimeout(this._volumeTimer)
    this._volumeTimer = null
    this._stopPrime()
    this._instantStart = false
    this._paused = false
    this._graphVolume = false
    this._sinkNodeId = null
    const ffmpeg = this._ffmpeg
    const sink = this._sink
    this._ffmpeg = null
    this._sink = null
    if (ffmpeg) {
      ffmpeg.stdout?.removeAllListeners()
      ffmpeg.stdout?.destroy()
      try {
        ffmpeg.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    if (sink) {
      try {
        sink.kill('SIGCONT')
      } catch {
        // not stopped
      }
      try {
        sink.stdin?.end()
      } catch {
        // already closed
      }
      try {
        sink.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
  }

  _finish(token) {
    if (this.token !== token || this._endedEmitted) return
    this._endedEmitted = true
    this._teardown()
    this.playing = false
    this.loading = false
    this.loaded = false
    if (this.duration > 0) this.startOffset = this.duration
    this.emit('ended')
  }

  _fail(error, token) {
    if (token !== undefined && this.token !== token) return
    this._manual = true
    const pos = this.position()
    this.token++
    this._teardown()
    this.playing = false
    this.loading = false
    this.loaded = false
    this.startOffset = pos
    error.position = pos
    this.logger.warn('[player]', error.message)
    this.emit('error', error)
  }
}


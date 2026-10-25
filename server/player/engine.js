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
import { SAMPLE_RATE, CHANNELS, pcmGain } from './audio.js'

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
  constructor(audioOutput, { latency = 0.22, logger = console } = {}) {
    super()
    this.audio = audioOutput
    this.latency = latency
    this.logger = logger
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
      pos += Math.max(0, (Date.now() - this._firstChunkAt) / 1000 - this.latency)
    }
    if (this.duration > 0) pos = Math.min(pos, this.duration)
    return Math.max(0, pos)
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

    let sink
    try {
      sink = this.audio.spawnSink()
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

      if (!this._firstChunkAt) {
        this._firstChunkAt = Date.now()
        this.loading = false
        this.playing = true
        this.emit('playing')
      }
      const out = pcmGain(pcm, this.gain)
      const ok = sink.stdin.write(out)
      if (!ok) {
        ffmpeg.stdout.pause()
        sink.stdin.once('drain', () => {
          if (this.token === token) ffmpeg.stdout.resume()
        })
      }
    })

    this.emit('started', { url, startAt: this.startOffset })
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
    this._start({ url: this.url, startAt: this.startOffset, duration: this.duration })
  }

  pause() {
    const pos = this.position()
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
    return this.volume
  }

  setMuted(muted) {
    this.muted = Boolean(muted)
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


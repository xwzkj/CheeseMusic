import fs from 'node:fs'
import { resolveSongUrl } from '../netease.js'
import { probeDuration } from './engine.js'

const MAX_QUEUE = 5000
const MAX_LYRIC_DELAY_MS = 2000

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function asNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function sanitizeTrack(input) {
  if (!input || input.id === undefined || input.id === null) return null
  const rawDuration = input.duration ?? (input.dt ? Number(input.dt) / 1000 : 0)
  const duration = Math.max(0, asNumber(rawDuration, 0))
  return {
    id: String(input.id),
    name: String(input.name || '未知歌曲').slice(0, 300),
    artist: String(input.artist || '').slice(0, 300),
    picurl: String(input.picurl || '').slice(0, 1000),
    tns: String(input.tns || '').slice(0, 300),
    fee: asNumber(input.fee, 0),
    duration: Math.round(duration * 1000) / 1000
  }
}

function sanitizeQueue(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const item of input.slice(0, MAX_QUEUE)) {
    const track = sanitizeTrack(item)
    if (track) out.push(track)
  }
  return out
}

function shuffledOrder(length, currentIndex = -1) {
  const order = Array.from({ length }, (_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  if (currentIndex >= 0 && order[0] !== currentIndex) {
    const pos = order.indexOf(currentIndex)
    if (pos > 0) {
      order[pos] = order[0]
      order[0] = currentIndex
    }
  }
  return order
}

export class PlayerState {
  constructor({ engine, stateFile, config, logger = console }) {
    this.engine = engine
    this.stateFile = stateFile
    this.config = config
    this.logger = logger
    this.queue = []
    this.index = -1
    this.mode = 0
    this.order = []
    this.quality = config.quality || 'jymaster'
    this.volume = clamp(asNumber(config.volume, 0.8), 0, 1)
    this.muted = false
    // Positive values show each lyric line later (compensating for audio
    // output latency); negative values show it earlier.
    this.lyricDelay = clamp(Math.round(asNumber(config.lyricDelay, 0)), -MAX_LYRIC_DELAY_MS, MAX_LYRIC_DELAY_MS)
    this.savedPosition = 0
    this.intentPlaying = false
    this.loading = false
    this.error = ''
    this.urlInfo = null
    this.loadedTrackId = null
    // Start from a time-based value so clients that were connected to a
    // previous server process (with a lower revision) accept the new state
    // after a restart instead of treating it as stale.
    this.revision = Date.now()
    this.queueRevision = Date.now()
    this._opSeq = 0
    this._retried = false
    this._saveTimer = null
    this._listeners = new Set()
    this._load()
    this.engine.setVolume(this.volume)
    this.engine.setMuted(this.muted)
    this._bindEngine()
    this._saveTicker = setInterval(() => {
      if (this.intentPlaying) this.save()
    }, 15_000)
    this._saveTicker.unref?.()
  }

  _load() {
    let saved = null
    try {
      saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'))
    } catch {
      return
    }
    this.queue = sanitizeQueue(saved.queue)
    this.index = clamp(asNumber(saved.index, -1), -1, this.queue.length - 1)
    if (this.queue.length && this.index < 0) this.index = 0
    this.mode = [0, 1, 2].includes(Number(saved.mode)) ? Number(saved.mode) : 0
    this.order = Array.isArray(saved.order)
      ? saved.order.filter((n) => Number.isInteger(n) && n >= 0 && n < this.queue.length)
      : []
    if (this.order.length !== this.queue.length) this._rebuildOrder()
    this.quality = typeof saved.quality === 'string' ? saved.quality : this.quality
    this.volume = clamp(asNumber(saved.volume, this.volume), 0, 1)
    this.muted = Boolean(saved.muted)
    this.lyricDelay = clamp(
      Math.round(asNumber(saved.lyricDelay, this.lyricDelay)),
      -MAX_LYRIC_DELAY_MS,
      MAX_LYRIC_DELAY_MS
    )
    this.savedPosition = Math.max(0, asNumber(saved.position, 0))
    if (this.currentTrack) {
      this.savedPosition = clamp(this.savedPosition, 0, this.currentTrack.duration || Number.MAX_SAFE_INTEGER)
    }
    if (this.queue.length) {
      this.logger.log(`[player] 恢复了播放列表：${this.queue.length} 首，第 ${this.index + 1} 首，已暂停`)
    }
  }

  save() {
    clearTimeout(this._saveTimer)
    this._saveTimer = null
    const position = this.intentPlaying ? this.engine.position() : this.savedPosition
    const data = {
      version: 2,
      queue: this.queue,
      index: this.index,
      mode: this.mode,
      order: this.order,
      quality: this.quality,
      volume: this.volume,
      muted: this.muted,
      lyricDelay: this.lyricDelay,
      position: Math.round(position * 1000) / 1000
    }
    try {
      const tmp = `${this.stateFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data))
      fs.renameSync(tmp, this.stateFile)
    } catch (err) {
      this.logger.warn('[player] 保存播放状态失败：', err.message)
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => this.save(), 500)
    this._saveTimer.unref?.()
  }

  _touch({ queueChanged = false } = {}) {
    this.revision++
    if (queueChanged) this.queueRevision++
    this._scheduleSave()
    for (const listener of this._listeners) {
      try {
        listener(this)
      } catch (err) {
        this.logger.warn('[player] state listener error:', err.message)
      }
    }
  }

  subscribe(listener) {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  get currentTrack() {
    return this.queue[this.index] || null
  }

  get duration() {
    const track = this.currentTrack
    const full = track?.duration || this.engine.duration || 0
    // A preview URL is only 30–45 seconds long even though song detail has the
    // full duration. Show and seek within the real playable range.
    const trialEnd = this.urlInfo && track && this.urlInfo.id === track.id
      ? Number(this.urlInfo.trial?.end) || 0
      : 0
    return trialEnd > 0 ? Math.min(full || trialEnd, trialEnd) : full
  }

  get position() {
    if (this.engine.loaded) return this.engine.position()
    return clamp(this.savedPosition, 0, this.duration || Number.MAX_SAFE_INTEGER)
  }

  getState({ includeQueue = true } = {}) {
    const track = this.currentTrack
    return {
      revision: this.revision,
      queueRevision: this.queueRevision,
      queue: includeQueue ? this.queue : null,
      index: this.index,
      track,
      mode: this.mode,
      order: includeQueue ? this.order : null,
      quality: this.quality,
      actualQuality: this.urlInfo?.level || '',
      trial: Boolean(this.urlInfo?.trial),
      bitrate: this.urlInfo?.br || 0,
      playing: this.intentPlaying && !this.error,
      paused: !this.intentPlaying,
      loading: this.loading,
      error: this.error,
      position: Math.round(this.position * 1000) / 1000,
      duration: this.duration,
      // The client uses these to keep its interpolation clock in sync with
      // the audible position instead of jumping on every state resync.
      latency: this.engine.latency,
      startHold: this.engine.startHold,
      volume: this.volume,
      muted: this.muted,
      lyricDelay: this.lyricDelay,
      serverTime: Date.now()
    }
  }

  _bindEngine() {
    this.engine.on('playing', () => {
      this.loading = false
      this.error = ''
      this.intentPlaying = true
      this._touch()
    })
    this.engine.on('ended', () => {
      this.loading = false
      this.savedPosition = 0
      if (this.intentPlaying && this.queue.length) {
        this._step(this.mode === 2 ? 0 : 1)
      } else {
        this.intentPlaying = false
        this._touch()
      }
    })
    this.engine.on('error', (err) => {
      this.loading = false
      const position = Number.isFinite(err.position) ? err.position : this.position
      this.savedPosition = position
      if (this.intentPlaying && this.queue.length && !this._retried) {
        this._retried = true
        this.logger.warn('[player] 播放失败，尝试重新获取播放地址：', err.message)
        setTimeout(() => {
          if (this.intentPlaying) this._loadAndPlay(position, { forceResolve: true })
        }, 600)
        return
      }
      this.intentPlaying = false
      this.error = err.message || '播放失败'
      this._touch()
    })
  }

  _rebuildOrder() {
    if (this.mode === 1) {
      this.order = shuffledOrder(this.queue.length, this.index)
    } else {
      this.order = Array.from({ length: this.queue.length }, (_, i) => i)
    }
  }

  _nextIndex(delta) {
    const length = this.queue.length
    if (!length) return -1
    if (this.mode === 1 && this.order.length === length) {
      let pos = this.order.indexOf(this.index)
      if (pos < 0) pos = 0
      return this.order[(pos + delta + length) % length]
    }
    return (this.index + delta + length) % length
  }

  async setQueue(tracks, { startIndex = 0, play = false } = {}) {
    const queue = sanitizeQueue(tracks)
    this._opSeq++
    this.engine.stop()
    this.queue = queue
    this.index = queue.length ? clamp(Math.trunc(asNumber(startIndex, 0)), 0, queue.length - 1) : -1
    this.savedPosition = 0
    this.urlInfo = null
    this.loadedTrackId = null
    this.error = ''
    this.loading = false
    this.intentPlaying = false
    this._retried = false
    this._rebuildOrder()
    this._touch({ queueChanged: true })
    if (play && this.currentTrack) await this._loadAndPlay(0)
    return this.getState()
  }

  async addTracks(tracks, { position = 'now', playNow = false } = {}) {
    const additions = sanitizeQueue(tracks)
    if (!additions.length) return this.getState()
    let insertAt
    if (position === 'now') insertAt = this.index >= 0 ? this.index + 1 : this.queue.length
    else insertAt = clamp(Math.trunc(asNumber(position, this.queue.length)), 0, this.queue.length)

    this.queue.splice(insertAt, 0, ...additions)
    if (this.queue.length > MAX_QUEUE) this.queue.length = MAX_QUEUE

    if (playNow) {
      this.index = insertAt
      this.savedPosition = 0
      this.urlInfo = null
      this.loadedTrackId = null
      this.engine.stop()
      this.error = ''
      this._retried = false
    } else if (this.index >= insertAt) {
      this.index += additions.length
    }
    this.index = clamp(this.index, this.queue.length ? 0 : -1, this.queue.length - 1)
    this._rebuildOrder()
    this._touch({ queueChanged: true })
    if (playNow) await this._loadAndPlay(0)
    return this.getState()
  }

  async addNext(tracks) {
    // Clicking "play next" repeatedly must not duplicate tracks: skip songs
    // already in the queue and repeats inside the same request.
    const queuedIds = new Set(this.queue.map((track) => track.id))
    const additions = sanitizeQueue(tracks).filter((track) => {
      if (queuedIds.has(track.id)) return false
      queuedIds.add(track.id)
      return true
    })
    if (!additions.length) return this.getState()
    const insertAt = this.index >= 0 ? this.index + 1 : 0
    const oldOrder = this.order.slice()
    this.queue.splice(insertAt, 0, ...additions)
    if (this.queue.length > MAX_QUEUE) this.queue.length = MAX_QUEUE
    const insertedCount = Math.min(additions.length, this.queue.length - insertAt)
    if (this.index >= insertAt) this.index += insertedCount
    if (this.mode === 1 && oldOrder.length) {
      const adjustedOrder = oldOrder.map((index) => index >= insertAt ? index + insertedCount : index)
      const currentPosition = adjustedOrder.indexOf(this.index)
      adjustedOrder.splice(currentPosition < 0 ? 0 : currentPosition + 1, 0,
        ...Array.from({ length: insertedCount }, (_, offset) => insertAt + offset))
      this.order = adjustedOrder
    } else {
      this._rebuildOrder()
    }
    this._touch({ queueChanged: true })
    return this.getState()
  }

  removeTracks(ids) {
    const set = new Set((Array.isArray(ids) ? ids : [ids]).map(String))
    if (!set.size) return this.getState()
    const current = this.currentTrack
    const currentRemoved = Boolean(current && set.has(current.id))
    const oldIndex = this.index
    this.queue = this.queue.filter((track) => !set.has(track.id))
    if (!this.queue.length) {
      this.clear()
      return this.getState()
    }
    if (currentRemoved) {
      this.index = clamp(oldIndex, 0, this.queue.length - 1)
      this.engine.stop()
      this.loadedTrackId = null
      this.urlInfo = null
      this.savedPosition = 0
      this.intentPlaying = false
      this.loading = false
    } else if (current) {
      const found = this.queue.indexOf(current)
      if (found >= 0) this.index = found
    }
    this._rebuildOrder()
    this._touch({ queueChanged: true })
    return this.getState()
  }

  clear() {
    this._opSeq++
    this.engine.stop()
    this.queue = []
    this.index = -1
    this.order = []
    this.savedPosition = 0
    this.urlInfo = null
    this.loadedTrackId = null
    this.intentPlaying = false
    this.loading = false
    this.error = ''
    this._touch({ queueChanged: true })
  }

  async play() {
    if (!this.currentTrack) {
      this.error = '播放列表是空的，先选一首歌吧'
      this._touch()
      return
    }
    if (this.intentPlaying && (this.engine.playing || this.engine.loading)) return
    this.error = ''
    if (this.engine.loaded && this.loadedTrackId === this.currentTrack.id) {
      this.intentPlaying = true
      this.loading = true
      this._touch()
      try {
        this.engine.resume()
      } catch (err) {
        this.intentPlaying = false
        this.loading = false
        this.error = err.message
        this._touch()
      }
      return
    }
    await this._loadAndPlay(this.savedPosition)
  }

  pause() {
    this._opSeq++
    if (this.engine.loaded) {
      this.savedPosition = this.engine.pause()
    }
    this.intentPlaying = false
    this.loading = false
    this._touch()
  }

  toggle() {
    if (this.intentPlaying) this.pause()
    else return this.play()
  }

  async seek(position) {
    if (!this.currentTrack) return
    const target = clamp(asNumber(position, 0), 0, this.duration || Number.MAX_SAFE_INTEGER)
    if (this.loading && !this.engine.loaded) {
      this.savedPosition = target
      if (this.intentPlaying) await this._loadAndPlay(target)
      else this._touch()
      return
    }
    if (this.engine.loaded) {
      this.savedPosition = this.engine.seek(target)
      this._touch()
    } else {
      this.savedPosition = target
      this._touch()
    }
  }

  async playIndex(index, play = true) {
    if (!this.queue.length) return
    const target = clamp(Math.trunc(asNumber(index, 0)), 0, this.queue.length - 1)
    if (target === this.index && this.engine.loaded) {
      if (play && !this.intentPlaying) await this.play()
      return
    }
    this.index = target
    this.savedPosition = 0
    this.urlInfo = null
    this.loadedTrackId = null
    this._retried = false
    this.engine.stop()
    this._touch()
    if (play) await this._loadAndPlay(0)
  }

  async next() {
    await this._step(1)
  }

  async prev() {
    await this._step(-1)
  }

  async _step(delta) {
    if (!this.queue.length) return
    this._opSeq++
    this.engine.stop()
    this.index = this._nextIndex(delta)
    this.savedPosition = 0
    this.urlInfo = null
    this.loadedTrackId = null
    this.error = ''
    this._retried = false
    this.intentPlaying = true
    this._touch()
    await this._loadAndPlay(0)
  }

  setMode(mode) {
    const nextMode = Number(mode)
    this.mode = [0, 1, 2].includes(nextMode) ? nextMode : 0
    this._rebuildOrder()
    this._touch()
  }

  setQuality(quality) {
    if (typeof quality !== 'string' || !quality) return
    this.quality = quality
    this.urlInfo = null
    this._touch()
  }

  setVolume(volume) {
    this.volume = clamp(asNumber(volume, this.volume), 0, 1)
    this.engine.setVolume(this.volume)
    this._touch()
    return this.volume
  }

  setMuted(muted) {
    this.muted = Boolean(muted)
    this.engine.setMuted(this.muted)
    this._touch()
    return this.muted
  }

  setLyricDelay(delay) {
    this.lyricDelay = clamp(
      Math.round(asNumber(delay, this.lyricDelay)),
      -MAX_LYRIC_DELAY_MS,
      MAX_LYRIC_DELAY_MS
    )
    this._touch()
    return this.lyricDelay
  }

  async reloadCurrent(position = null, { keepPlaying = true } = {}) {
    if (!this.currentTrack) return
    const pos = position ?? this.position
    this.engine.stop()
    this.loadedTrackId = null
    this.urlInfo = null
    this.savedPosition = pos
    if (keepPlaying) {
      this.intentPlaying = true
      this._touch()
      await this._loadAndPlay(pos)
    } else {
      this.intentPlaying = false
      this._touch()
    }
  }

  async _loadAndPlay(position = 0, { forceResolve = false } = {}) {
    const track = this.currentTrack
    if (!track) return
    const trialEnd = Number(this.urlInfo?.trial?.end) || 0
    const playableDuration = trialEnd > 0 ? Math.min(track.duration || trialEnd, trialEnd) : track.duration
    const pos = clamp(asNumber(position, 0), 0, playableDuration || Number.MAX_SAFE_INTEGER)
    const seq = ++this._opSeq
    this.error = ''
    this.loading = true
    this.intentPlaying = true
    this.savedPosition = pos
    this._touch()

    let info = this.urlInfo
    const fresh = info && Date.now() - info.resolvedAt < 4 * 60 * 1000
    if (forceResolve || !fresh || info.id !== track.id) {
      this.engine.stop()
      this.loadedTrackId = null
      try {
        const resolved = await resolveSongUrl(track.id, this.quality)
        if (seq !== this._opSeq) return
        info = { ...resolved, id: track.id, resolvedAt: Date.now() }
        this.urlInfo = info
      } catch (err) {
        if (seq !== this._opSeq) return
        this.loading = false
        this.intentPlaying = false
        this.error = err.message || '获取播放地址失败'
        this._touch()
        return
      }
    }
    if (seq !== this._opSeq) return
    const finalTrialEnd = Number(info.trial?.end) || 0
    const finalDuration = finalTrialEnd > 0
      ? Math.min(track.duration || finalTrialEnd, finalTrialEnd)
      : track.duration
    const startAt = clamp(pos, 0, finalDuration || Number.MAX_SAFE_INTEGER)
    this.engine.stop()
    this.loadedTrackId = track.id
    this.savedPosition = startAt
    try {
      this.engine.play({ url: info.url, startAt, duration: finalDuration })
    } catch (err) {
      this.loading = false
      this.intentPlaying = false
      this.error = err.message
      this._touch()
    }
    if (!track.duration) {
      probeDuration(info.url).then((duration) => {
        if (!duration || this.currentTrack !== track) return
        track.duration = duration
        if (this.loadedTrackId === track.id) this.engine.duration = duration
        this._touch({ queueChanged: true })
      }).catch(() => {})
    }
  }

  /**
   * Run a device probe/reconfiguration with the audio pipeline stopped, then
   * put playback back the way it was. Used by the settings page.
   */
  async reconfigureOutput(action) {
    const wasPlaying = this.intentPlaying
    const pos = this.engine.loaded ? this.engine.position() : this.savedPosition
    this._opSeq++
    this.engine.stop()
    this.loadedTrackId = null
    this.savedPosition = pos
    this.intentPlaying = false
    this.loading = false
    this._touch()

    let result
    try {
      result = await action()
    } catch (err) {
      this.error = err.message || '切换音频输出失败'
      this._touch()
      return { available: false, error: this.error }
    }
    if (!result || result.available === false) {
      this.error = result?.error || '音频输出设备不可用'
      this._touch()
      return result
    }
    this.error = ''
    if (wasPlaying && this.currentTrack) {
      this.intentPlaying = true
      this._touch()
      await this._loadAndPlay(pos)
    } else {
      this._touch()
    }
    return result
  }

  /** The output device changed: keep the song and position, restart the pipeline. */
  async onAudioOutputChanged({ available = true } = {}) {
    const wasPlaying = this.intentPlaying
    const pos = this.engine.loaded ? this.engine.position() : this.savedPosition
    this.engine.stop()
    this.loadedTrackId = null
    this.savedPosition = pos
    this.loading = false
    if (!available) {
      this.intentPlaying = false
      this.error = '音频输出设备不可用'
      this._touch()
      return
    }
    if (wasPlaying && this.currentTrack) {
      this.intentPlaying = true
      this._touch()
      await this._loadAndPlay(pos)
    } else {
      this.intentPlaying = false
      this.error = ''
      this._touch()
    }
  }

  shutdown() {
    this.save()
    clearInterval(this._saveTicker)
    this.engine.stop()
  }
}

import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import * as api from '@/modules/api.js'
import * as lyricTools from '@/modules/lyric.js'
import { useUserStore } from './user.js'
import { useSettingStore } from './setting.js'
import { playerClient } from '@/modules/playerClient.js'

const EMPTY_TRACK = {
  id: '0',
  picurl: '/icon.png',
  name: '暂无歌曲',
  artist: '',
  tns: '',
  duration: 0
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

/**
 * Playback is owned by the Node server now: the browser is a remote control
 * plus a live view of the server's queue and playback position.
 */
export const usePlayStore = defineStore('play', () => {
  const userStore = useUserStore()
  const settingStore = useSettingStore()

  const playlist = ref<any[]>([])
  const playlistIndex = ref(-1)
  const playOrder = ref<number[]>([])
  const playMode = ref(0)
  const volume = ref(0.8)
  const muted = ref(false)
  const loading = ref(false)
  const errorText = ref('')
  const connected = ref(false)
  const connectionError = ref('')
  const actualQuality = ref('')
  const isTrial = ref(false)
  const musicStatus = ref({ duration: 0, currentTime: 0, paused: true })
  const lyricIndexNow = ref({ lineIndex: -1, wordIndex: -1, wordDuration: 0 })
  const lyricsCache = reactive(new Map<string, any[]>())

  let base = { position: 0, at: 0, playing: false }
  let lastRevision = -1
  let lastQueueRevision = -1
  let lastTrackId = '0'
  let lastErrorShown = ''
  let lastMediaSync = 0
  let initialized = false
  let migrating = false
  let seekTimer: ReturnType<typeof setTimeout> | null = null
  let volumeSendTimer: ReturnType<typeof setTimeout> | null = null
  let volumeLastSentAt = 0
  let volumeHoldUntil = 0
  const VOLUME_THROTTLE_MS = 33
  let silentAudio: HTMLAudioElement | null = null
  let mediaSessionUnlockBound = false

  const currentMusic = computed(() => {
    const item = playlist.value[playlistIndex.value] || EMPTY_TRACK
    const id = String(item.id)
    return {
      ...EMPTY_TRACK,
      ...item,
      isLiked: id !== '0' && userStore.likedSongs.includes(Number(id)),
      lyric: id !== '0' ? lyricsCache.get(id) : undefined,
      currentLyricIndex: lyricIndexNow.value
    }
  })

  const nameWithTns = computed(() => {
    const tns = currentMusic.value.tns
    const name = currentMusic.value.name
    if (tns) {
      return `<span class="text1">${api.escapeHtml(name)}</span><span class="text2">&nbsp;&nbsp;&nbsp;(${api.escapeHtml(tns)})</span>`
    }
    return api.escapeHtml(name)
  })

  const volumePercent = computed(() => Math.round(volume.value * 100))

  function init() {
    if (initialized) return
    initialized = true
    setupMediaSession()
    setupMediaSessionUnlock()

    playerClient.onConnection((ok, detail) => {
      connected.value = ok
      connectionError.value = ok ? '' : detail || '与服务器连接断开'
    })
    playerClient.onState(applyServerState)
    playerClient.connect()

    playerClient
      .getState(true)
      .then(() => maybeMigrateLegacyPlaylist())
      .catch((err) => {
        connectionError.value = err?.message || '无法连接播放服务器'
      })

    setInterval(tick, 250)
    // Periodic REST resync covers phone sleep, dropped WebSocket frames and
    // clock drift without a chatty server-side progress broadcast.
    setInterval(() => {
      if (document.visibilityState === 'visible') playerClient.getState(true).catch(() => {})
    }, 30_000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') playerClient.getState(true).catch(() => {})
    })
  }

  function applyServerState(state) {
    if (!state || typeof state.revision !== 'number') return
    if (state.revision < lastRevision) return
    lastRevision = state.revision

    if (Array.isArray(state.queue) && state.queueRevision !== lastQueueRevision) {
      playlist.value = state.queue
      lastQueueRevision = state.queueRevision
    }
    playlistIndex.value = state.index ?? -1
    playMode.value = state.mode === 1 ? 1 : 0
    if (Array.isArray(state.order)) playOrder.value = state.order
    // Do not let an older broadcast snap the slider backwards while local
    // volume interactions are being sent at a high rate.
    if (Date.now() >= volumeHoldUntil) {
      volume.value = clamp(Number(state.volume ?? volume.value), 0, 1)
      muted.value = Boolean(state.muted)
    }
    loading.value = Boolean(state.loading)
    errorText.value = state.error || ''
    actualQuality.value = state.actualQuality || ''
    isTrial.value = Boolean(state.trial)
    if (state.quality && settingStore.musicLevel !== state.quality) {
      settingStore.musicLevel = state.quality
    }

    musicStatus.value.duration = Number(state.duration) || currentMusic.value.duration || 0
    musicStatus.value.paused = !state.playing
    base = {
      position: Number(state.position) || 0,
      at: performance.now(),
      playing: Boolean(state.playing) && !state.loading
    }
    tick()

    if (currentMusic.value.id !== lastTrackId) {
      lastTrackId = String(currentMusic.value.id)
      onTrackChanged()
    }

    if (state.error && state.error !== lastErrorShown) {
      lastErrorShown = state.error
      api.error(state.error, '服务端播放失败')
    }
    if (!state.error) lastErrorShown = ''
  }

  function tick() {
    const duration = musicStatus.value.duration || 0
    let current = base.position
    if (base.playing) current += (performance.now() - base.at) / 1000
    if (duration > 0) current = Math.min(current, duration)
    musicStatus.value.currentTime = Math.max(0, current)

    if (!musicStatus.value.paused) {
      updateLyric()
      updateKtvLyric()
    }

    const now = performance.now()
    if (now - lastMediaSync > 1000) {
      lastMediaSync = now
      syncMediaSession()
    }
  }

  function onTrackChanged() {
    lyricIndexNow.value = { lineIndex: -1, wordIndex: -1, wordDuration: 0 }
    const track = currentMusic.value
    if (track.id !== '0') {
      document.title = `${track.name} - ${track.artist} - 奶酪音乐`
      loadLyric(track.id)
      updateMediaMetadata(track)
    } else {
      document.title = '奶酪音乐'
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = null
    }
  }

  async function loadLyric(id) {
    const key = String(id)
    if (!key || key === '0' || lyricsCache.has(key)) return
    // Reserve the key so concurrent state updates do not request twice.
    lyricsCache.set(key, [])
    try {
      const res = await api.lyricNew(key)
      const data = res?.data || {}
      let lyric: any[] = []
      if (data.code === 200) {
        if (data?.yrc?.lyric) {
          lyric = lyricTools.parseYrc(data.yrc.lyric)
          if (data?.yromalrc?.lyric) lyric = lyricTools.parseSecondaryLrc(data.yromalrc.lyric, lyric, 'roma')
          if (data?.ytlrc?.lyric) lyric = lyricTools.parseSecondaryLrc(data.ytlrc.lyric, lyric, 'tran')
        } else if (data?.lrc?.lyric) {
          lyric = lyricTools.parseLrc(data.lrc.lyric)
          if (data?.romalrc?.lyric) lyric = lyricTools.parseSecondaryLrc(data.romalrc.lyric, lyric, 'roma')
          if (data?.tlyric?.lyric) lyric = lyricTools.parseSecondaryLrc(data.tlyric.lyric, lyric, 'tran')
        }
      }
      lyricsCache.set(key, lyric)
    } catch (err) {
      console.warn('[playStore] 获取歌词失败', err)
    }
  }

  function updateLyric() {
    try {
      const lyric = currentMusic.value.lyric
      if (!Array.isArray(lyric) || !lyric.length) return
      const currentTime = musicStatus.value.currentTime * 1000 + 80
      const lineIndex = lyric.findIndex((_, index) => {
        if (index + 1 < lyric.length) {
          return lyric[index + 1].time > currentTime && lyric[index].time <= currentTime
        }
        return lyric[index].time <= currentTime
      })
      lyricIndexNow.value.lineIndex = lineIndex
    } catch (err) {
      console.warn('[playStore] updateLyric', err)
    }
  }

  function updateKtvLyric() {
    try {
      const line = currentMusic.value.lyric?.[lyricIndexNow.value.lineIndex]?.lrc
      if (!Array.isArray(line) || !line.length) return
      const currentTime = musicStatus.value.currentTime * 1000 + 80
      const wordIndex = line.findIndex((_, index) => {
        if (index + 1 < line.length) {
          return line[index + 1].time > currentTime && line[index].time <= currentTime
        }
        return line[index].time <= currentTime
      })
      if (wordIndex !== -1 && wordIndex !== lyricIndexNow.value.wordIndex) {
        lyricIndexNow.value.wordIndex = wordIndex
        lyricIndexNow.value.wordDuration = line[wordIndex].duration
      }
    } catch (err) {
      console.warn('[playStore] updateKtvLyric', err)
    }
  }

  /**
   * Browsers only keep an OS/browser media session alive while a media element
   * is playing. Server-side playback has no browser audio, so keep a silent
   * looping element as the session carrier; all controls still go to the server.
   */
  function silentWavUrl() {
    const sampleRate = 8000
    const samples = sampleRate
    const buffer = new ArrayBuffer(44 + samples * 2)
    const view = new DataView(buffer)
    const write = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
    }
    write(0, 'RIFF')
    view.setUint32(4, 36 + samples * 2, true)
    write(8, 'WAVE')
    write(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    write(36, 'data')
    view.setUint32(40, samples * 2, true)
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
  }

  function ensureSilentAudio() {
    if (silentAudio) return silentAudio
    const audio = new Audio(silentWavUrl())
    audio.loop = true
    audio.preload = 'auto'
    audio.setAttribute('playsinline', '')
    audio.setAttribute('aria-hidden', 'true')
    audio.style.display = 'none'
    audio.addEventListener('pause', () => {
      // Some browsers pause silent media when the tab is hidden. Restore it as
      // soon as the page is visible so hardware media keys keep working.
      if (document.visibilityState === 'visible') {
        setTimeout(() => {
          if (silentAudio && silentAudio.paused) silentAudio.play().catch(() => {})
        }, 200)
      }
    })
    document.body.appendChild(audio)
    silentAudio = audio
    return audio
  }

  function activateMediaSession() {
    if (!('mediaSession' in navigator)) return
    const audio = ensureSilentAudio()
    if (audio.paused) audio.play().catch(() => {})
    syncMediaSession()
  }

  function setupMediaSessionUnlock() {
    if (mediaSessionUnlockBound) return
    mediaSessionUnlockBound = true
    const unlock = () => {
      activateMediaSession()
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
    }
    window.addEventListener('pointerdown', unlock, true)
    window.addEventListener('keydown', unlock, true)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') activateMediaSession()
    })
    // Silent media can sometimes start without a gesture. If not, the first
    // pointer/key event above will unlock it.
    setTimeout(() => activateMediaSession(), 0)
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['previoustrack', () => { activateMediaSession(); prev() }],
      ['nexttrack', () => { activateMediaSession(); next() }],
      ['play', () => { activateMediaSession(); play() }],
      ['pause', () => { activateMediaSession(); pause() }],
      ['stop', () => { activateMediaSession(); pause() }]
    ]
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler)
      } catch {
        // action unsupported
      }
    }
    try {
      navigator.mediaSession.setActionHandler('seekto', (conf) => {
        activateMediaSession()
        if (typeof conf.seekTime === 'number') seek(conf.seekTime)
      })
    } catch {
      // unsupported
    }
    try {
      navigator.mediaSession.setActionHandler('seekbackward', (conf) => {
        activateMediaSession()
        seek(musicStatus.value.currentTime - (conf.seekOffset || 10))
      })
    } catch {
      // unsupported
    }
    try {
      navigator.mediaSession.setActionHandler('seekforward', (conf) => {
        activateMediaSession()
        seek(musicStatus.value.currentTime + (conf.seekOffset || 10))
      })
    } catch {
      // unsupported
    }
  }

  function updateMediaMetadata(track) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return
    const pic = (track.picurl || '/icon.png').replace(/^http:\/\//, 'https://')
    const artwork = pic === '/icon.png'
      ? [{ src: pic, sizes: '777x777' }]
      : [96, 128, 192, 256, 512].map((size) => ({ src: `${pic}?param=${size}y${size}`, sizes: `${size}x${size}` }))
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist: track.artist,
      album: track.tns || '',
      artwork
    })
  }

  function syncMediaSession() {
    if (!('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.playbackState = musicStatus.value.paused ? 'paused' : 'playing'
    } catch {
      // Some browsers require metadata before playbackState can be set.
    }
    const duration = musicStatus.value.duration
    const position = musicStatus.value.currentTime
    if (
      'setPositionState' in navigator.mediaSession &&
      Number.isFinite(duration) &&
      duration > 0 &&
      Number.isFinite(position) &&
      position >= 0 &&
      position <= duration
    ) {
      try {
        navigator.mediaSession.setPositionState({ duration, position, playbackRate: 1 })
      } catch {
        // Some browsers reject state updates while metadata is absent.
      }
    }
  }

  /** Import a pre-server-edition localStorage queue once, when the server is empty. */
  async function maybeMigrateLegacyPlaylist() {
    if (migrating) return
    const state = playerClient.state
    if (state?.queue?.length) return
    let saved: any
    try {
      saved = JSON.parse(localStorage.getItem('playlist') || '{}')
    } catch {
      return
    }
    if (saved?.version !== 3 || !Array.isArray(saved.playlist) || !saved.playlist.length) return
    if (localStorage.getItem('playlist-migrated') === '1') return
    migrating = true
    try {
      let tracks = saved.playlist.map((item) => ({ ...item }))
      // Refresh metadata and fetch durations in batches; old saves have neither.
      const ids = tracks.map((t) => t.id).filter(Boolean).slice(0, 2000)
      try {
        const details = []
        for (let i = 0; i < ids.length; i += 500) {
          const res = await api.songDetail(ids.slice(i, i + 500).join(','))
          if (Array.isArray(res?.data?.songs)) details.push(...api.parseDetailToList(res.data.songs))
        }
        const byId = new Map(details.map((item) => [String(item.id), item]))
        tracks = tracks.map((item) => ({ ...item, ...(byId.get(String(item.id)) || {}) }))
      } catch (err) {
        console.warn('[playStore] 迁移旧播放列表时刷新歌曲信息失败', err)
      }
      await playerClient.setQueue(tracks, saved.current ?? 0, false)
      if (saved.playMode === 1) await playerClient.setMode(1)
      localStorage.setItem('playlist-migrated', '1')
      console.log(`[playStore] 已把本地播放列表迁移到服务器（${tracks.length} 首）`)
    } finally {
      migrating = false
    }
  }

  async function playlistInit(ids: any = null, dataFromApi: any = null) {
    init()
    if (ids) {
      await addMusic(ids, 0, true)
      return
    }
    if (dataFromApi) {
      const tracks = api.parseDetailToList(dataFromApi)
      await playerClient.setQueue(tracks, 0, false)
      return
    }
    await maybeMigrateLegacyPlaylist()
  }

  async function addMusic(ids: any = [], position: string | number = 'now', letIndexIsNew = false) {
    init()
    const idList = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
    if (!idList.length) return playlist.value
    let details: any[] = []
    try {
      const res = await api.songDetail(idList.join(','))
      details = api.parseDetailToList(res?.data?.songs || [])
    } catch (err) {
      console.warn('[playStore] 获取歌曲信息失败', err)
      return playlist.value
    }
    if (!details.length) return playlist.value
    await playerClient.addTracks(details, { position, playNow: letIndexIsNew })
    return playlist.value
  }

  async function play() {
    init()
    activateMediaSession()
    musicStatus.value.paused = false
    loading.value = true
    try {
      await playerClient.play()
    } catch (err: any) {
      loading.value = false
      api.error(err.message, '播放失败')
    }
  }

  async function pause() {
    init()
    activateMediaSession()
    musicStatus.value.paused = true
    try {
      await playerClient.pause()
    } catch (err: any) {
      api.error(err.message, '暂停失败')
    }
  }

  function toggle() {
    if (musicStatus.value.paused) return play()
    return pause()
  }

  async function next() {
    init()
    activateMediaSession()
    loading.value = true
    try {
      await playerClient.next()
    } catch (err: any) {
      loading.value = false
      api.error(err.message, '切歌失败')
    }
  }

  async function prev() {
    init()
    activateMediaSession()
    loading.value = true
    try {
      await playerClient.prev()
    } catch (err: any) {
      loading.value = false
      api.error(err.message, '切歌失败')
    }
  }

  function seek(time: number) {
    init()
    activateMediaSession()
    const duration = musicStatus.value.duration || 0
    const target = clamp(Number(time) || 0, 0, duration > 0 ? duration : Number.MAX_SAFE_INTEGER)
    musicStatus.value.currentTime = target
    base = { position: target, at: performance.now(), playing: !musicStatus.value.paused && !loading.value }
    // Dragging the slider fires many updates; only seek the server once the
    // user settles on a position (each seek restarts the server decoder).
    if (seekTimer) clearTimeout(seekTimer)
    const trackId = currentMusic.value.id
    seekTimer = setTimeout(() => {
      seekTimer = null
      if (currentMusic.value.id !== trackId) return
      playerClient.seek(target).catch((err: any) => api.error(err.message, '跳转失败'))
    }, 180)
  }

  async function playWithPlaylistIndex(index: number) {
    init()
    activateMediaSession()
    playlistIndex.value = index
    loading.value = true
    try {
      await playerClient.playIndex(index)
    } catch (err: any) {
      loading.value = false
      api.error(err.message, '播放失败')
    }
  }

  async function setPlayMode(mode: number) {
    init()
    playMode.value = mode === 1 ? 1 : 0
    try {
      await playerClient.setMode(playMode.value)
    } catch (err: any) {
      api.error(err.message, '切换播放模式失败')
    }
  }

  function sendVolumeNow() {
    if (volumeSendTimer) {
      clearTimeout(volumeSendTimer)
      volumeSendTimer = null
    }
    volumeLastSentAt = performance.now()
    volumeHoldUntil = Date.now() + 400
    playerClient.setVolume(volume.value).catch((err: any) => api.error(err.message, '调节音量失败'))
  }

  /**
   * Throttle (not debounce) volume traffic: the first change is sent
   * immediately, later changes are coalesced to at most one request every
   * 50 ms. This keeps the speaker close to the slider while avoiding floods.
   */
  function scheduleVolumeSend() {
    volumeHoldUntil = Date.now() + 400
    const elapsed = performance.now() - volumeLastSentAt
    if (!volumeSendTimer && elapsed >= VOLUME_THROTTLE_MS) {
      sendVolumeNow()
      return
    }
    if (!volumeSendTimer) {
      volumeSendTimer = setTimeout(() => {
        volumeSendTimer = null
        volumeLastSentAt = performance.now()
        volumeHoldUntil = Date.now() + 400
        playerClient.setVolume(volume.value).catch((err: any) => api.error(err.message, '调节音量失败'))
      }, Math.max(0, VOLUME_THROTTLE_MS - elapsed))
    }
  }

  function setVolume(value: number) {
    init()
    volume.value = clamp(Number(value) || 0, 0, 1)
    muted.value = false
    scheduleVolumeSend()
  }

  async function setMuted(value: boolean) {
    init()
    muted.value = Boolean(value)
    volumeHoldUntil = Date.now() + 400
    if (volumeSendTimer) {
      clearTimeout(volumeSendTimer)
      volumeSendTimer = null
    }
    try {
      await playerClient.setMuted(muted.value)
    } catch (err: any) {
      api.error(err.message, '调节音量失败')
    }
  }

  function toggleMute() {
    return setMuted(!muted.value)
  }

  /** Step the server volume in whole percentage points (e.g. ±2%). */
  function adjustVolume(deltaPercent: number) {
    init()
    activateMediaSession()
    const current = Math.round(volume.value * 100)
    const next = clamp(current + Math.round(Number(deltaPercent) || 0), 0, 100) / 100
    setVolume(next)
  }

  async function setQuality(level: string) {
    init()
    settingStore.setMusicLevel(level)
    try {
      await playerClient.setQuality(level)
      api.success('音质设置已保存，将在下一首生效')
    } catch (err: any) {
      api.error(err.message, '设置音质失败')
    }
  }

  async function stop() {
    init()
    if (seekTimer) {
      clearTimeout(seekTimer)
      seekTimer = null
    }
    musicStatus.value.paused = true
    musicStatus.value.currentTime = 0
    base = { position: 0, at: performance.now(), playing: false }
    try {
      await playerClient.pause()
      await playerClient.seek(0)
    } catch {
      // server may be offline
    }
  }

  function musicChanged() {
    // Kept for compatibility: the server is authoritative now.
  }

  async function refresh() {
    try {
      const state = await playerClient.getState(true)
      applyServerState(state)
    } catch {
      // connection banner already reflects this
    }
  }

  return {
    playlist,
    playlistIndex,
    playOrder,
    playMode,
    volume,
    muted,
    volumePercent,
    loading,
    errorText,
    connected,
    connectionError,
    actualQuality,
    isTrial,
    currentMusic,
    nameWithTns,
    musicStatus,
    init,
    playlistInit,
    addMusic,
    stop,
    play,
    pause,
    toggle,
    next,
    prev,
    seek,
    musicChanged,
    setPlayMode,
    playWithPlaylistIndex,
    setVolume,
    setMuted,
    toggleMute,
    adjustVolume,
    setQuality,
    refresh
  }
})

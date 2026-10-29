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

// A small constant lead makes the lyric line feel in-sync at the default
// setting. Users can then add a positive delay for slow audio outputs
// (notably Bluetooth) or a negative one when lyrics run late.
const LYRIC_BASE_OFFSET_MS = 80
const LYRIC_DELAY_LIMIT_MS = 2000
const LYRIC_DELAY_THROTTLE_MS = 60

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
  const lyricDelay = ref(0)
  const musicStatus = ref({ duration: 0, currentTime: 0, paused: true })
  const lyricIndexNow = ref({ lineIndex: -1, wordIndex: -1, wordDuration: 0 })
  const lyricsCache = reactive(new Map<string, any[]>())

  let base = { position: 0, at: 0, playing: false, holdMs: 0 }
  let lastRevision = -1
  let lastQueueRevision = -1
  let lastTrackId = '0'
  let mediaMetadataNeedsRefresh = false
  let lastErrorShown = ''
  let lastMediaSync = 0
  let initialized = false
  let migrating = false
  let seekTimer: ReturnType<typeof setTimeout> | null = null
  let reanchorTimers: ReturnType<typeof setTimeout>[] = []
  let volumeSendTimer: ReturnType<typeof setTimeout> | null = null
  let volumeLastSentAt = 0
  let volumeHoldUntil = 0
  const VOLUME_THROTTLE_MS = 33
  let lyricDelaySendTimer: ReturnType<typeof setTimeout> | null = null
  let lyricDelayLastSentAt = 0
  let lyricDelayHoldUntil = 0
  let silentAudio: HTMLAudioElement | null = null
  let mediaSessionUnlockBound = false
  let mediaSessionWanted = false
  let mediaSessionWatchdog: ReturnType<typeof setInterval> | null = null
  let lastMediaCommandAt = 0
  let mediaKeysBound = false

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
    setupMediaKeys()

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

    // 60 ms keeps the lyric line/word highlight close to the audio; 250 ms
    // made it visibly late on fast lines.
    setInterval(tick, 60)
    // Periodic REST resync covers phone sleep, dropped WebSocket frames and
    // clock drift without a chatty server-side progress broadcast.
    setInterval(() => {
      if (document.visibilityState === 'visible') playerClient.getState(true).catch(() => {})
    }, 30_000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        playerClient.getState(true).catch(() => {})
        reanchorClock()
      }
    })
    // The very first state after a page load / tab switch is often processed
    // while the UI is still rendering, leaving the interpolation clock ~100 ms
    // behind the server. Re-sync once the page has settled.
    reanchorClock()
  }

  /** Re-fetch the authoritative position after the page has finished rendering. */
  function reanchorClock() {
    for (const timer of reanchorTimers) clearTimeout(timer)
    reanchorTimers = []
    for (const delay of [400, 1200]) {
      const timer = setTimeout(() => {
        reanchorTimers = reanchorTimers.filter((item) => item !== timer)
        playerClient.getState(true).catch(() => {})
      }, delay)
      reanchorTimers.push(timer)
    }
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
    playMode.value = [0, 1, 2].includes(Number(state.mode)) ? Number(state.mode) : 0
    if (Array.isArray(state.order)) playOrder.value = state.order
    // Do not let an older broadcast snap the slider backwards while local
    // volume interactions are being sent at a high rate.
    if (Date.now() >= volumeHoldUntil) {
      volume.value = clamp(Number(state.volume ?? volume.value), 0, 1)
      muted.value = Boolean(state.muted)
    }
    if (Date.now() >= lyricDelayHoldUntil) {
      lyricDelay.value = clamp(
        Math.round(Number(state.lyricDelay) || 0),
        -LYRIC_DELAY_LIMIT_MS,
        LYRIC_DELAY_LIMIT_MS
      )
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
    lastMediaSync = 0
    const nowPlaying = Boolean(state.playing) && !state.loading
    // A brand-new pipeline is silent for about `latency` seconds before the
    // first sample is audible, so hold the UI clock for that long. A resync
    // mid-song carries an absolute position and must not jump the clock.
    const holdMs = nowPlaying && !base.playing
      ? Math.max(0, Number(state.startHold) || 0) * 1000
      : 0
    base = {
      position: Number(state.position) || 0,
      at: performance.now(),
      playing: nowPlaying,
      holdMs
    }
    tick()

    if (currentMusic.value.id !== lastTrackId) {
      lastTrackId = String(currentMusic.value.id)
      mediaMetadataNeedsRefresh = currentMusic.value.id !== '0'
      onTrackChanged()
    }
    if (mediaMetadataNeedsRefresh && state.playing && !loading.value && !state.error) {
      updateMediaMetadata(currentMusic.value)
      mediaMetadataNeedsRefresh = false
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
    if (base.playing) {
      const elapsed = (performance.now() - base.at - base.holdMs) / 1000
      current += Math.max(0, elapsed)
    }
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

  /** Lyric time in ms; positive `lyricDelay` shows lines later. */
  function lyricClockMs() {
    return musicStatus.value.currentTime * 1000 + LYRIC_BASE_OFFSET_MS - lyricDelay.value
  }

  function updateLyric() {
    try {
      const lyric = currentMusic.value.lyric
      if (!Array.isArray(lyric) || !lyric.length) return
      const currentTime = lyricClockMs()
      const lineIndex = lyric.findIndex((_, index) => {
        if (index + 1 < lyric.length) {
          return lyric[index + 1].time > currentTime && lyric[index].time <= currentTime
        }
        return lyric[index].time <= currentTime
      })
      // A new line starts from its own first word; keeping the previous
      // line's word index would leave the karaoke fill/duration stale.
      if (lineIndex !== lyricIndexNow.value.lineIndex) {
        lyricIndexNow.value.wordIndex = -1
        lyricIndexNow.value.wordDuration = 0
      }
      lyricIndexNow.value.lineIndex = lineIndex
    } catch (err) {
      console.warn('[playStore] updateLyric', err)
    }
  }

  function updateKtvLyric() {
    try {
      const line = currentMusic.value.lyric?.[lyricIndexNow.value.lineIndex]?.lrc
      if (!Array.isArray(line) || !line.length) return
      const currentTime = lyricClockMs()
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
   * is playing. Server-side playback has no browser audio, so keep a real
   * (silent) MP3 carrier playing. A 600s file is used instead of a tiny silent
   * clip because some browsers hide media controls for very short media.
   */
  function ensureSilentAudio() {
    if (silentAudio) return silentAudio
    const audio = new Audio('/silence.mp3')
    audio.loop = true
    audio.preload = 'auto'
    audio.volume = 1
    audio.setAttribute('playsinline', '')
    audio.setAttribute('aria-hidden', 'true')
    audio.style.cssText =
      'position:fixed;left:-9999px;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;'
    const resumeIfUnexpected = () => {
      // If the server says playback is running but the carrier was paused by
      // the browser (background/audio focus), restore it. When the server is
      // paused, leave the element paused so the OS media button becomes "play".
      if (!mediaSessionWanted || musicStatus.value.paused) return
      setTimeout(() => {
        if (mediaSessionWanted && !musicStatus.value.paused && silentAudio?.paused) {
          silentAudio.play().catch(() => {})
        }
      }, 150)
    }
    audio.addEventListener('pause', resumeIfUnexpected)
    audio.addEventListener('ended', resumeIfUnexpected)
    document.body.appendChild(audio)
    silentAudio = audio
    return audio
  }

  function activateMediaSession() {
    if (!('mediaSession' in navigator)) return
    mediaSessionWanted = true
    ensureSilentAudio()
    if (!mediaSessionWatchdog) {
      mediaSessionWatchdog = setInterval(() => {
        // Recover only while the server is playing; a paused server must keep
        // the carrier paused so the OS shows a play button.
        if (mediaSessionWanted && !musicStatus.value.paused && silentAudio?.paused) {
          silentAudio.play().catch(() => {})
        }
      }, 3000)
    }
    syncSilentAudio()
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
    window.addEventListener('pageshow', () => activateMediaSession())
    // Silent media can sometimes start without a gesture. If not, the first
    // pointer/key event above will unlock it.
    setTimeout(() => activateMediaSession(), 0)
  }

  function runMediaCommand(command: string) {
    // Media Session handlers and the keyboard fallback can both fire for one
    // physical media key press; ignore the duplicate.
    const now = Date.now()
    if (now - lastMediaCommandAt < 200) return
    lastMediaCommandAt = now
    activateMediaSession()
    if (command === 'toggle') return toggle()
    if (command === 'play') return play()
    if (command === 'pause' || command === 'stop') return pause()
    if (command === 'next') return next()
    if (command === 'prev') return prev()
    if (command === 'forward') return seek(musicStatus.value.currentTime + 10)
    if (command === 'rewind') return seek(musicStatus.value.currentTime - 10)
  }

  function setupMediaKeys() {
    if (mediaKeysBound) return
    mediaKeysBound = true
    const keyMap: Record<string, string> = {
      MediaPlayPause: 'toggle',
      MediaTrackNext: 'next',
      MediaTrackPrevious: 'prev',
      MediaStop: 'stop',
      MediaFastForward: 'forward',
      MediaRewind: 'rewind'
    }
    window.addEventListener('keydown', (event) => {
      const command = keyMap[event.key]
      if (!command) return
      event.preventDefault()
      runMediaCommand(command)
    })
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['previoustrack', () => { runMediaCommand('prev') }],
      ['nexttrack', () => { runMediaCommand('next') }],
      ['play', () => { runMediaCommand('play') }],
      ['pause', () => { runMediaCommand('pause') }],
      ['stop', () => { runMediaCommand('stop') }]
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

  function syncSilentAudio() {
    const audio = silentAudio
    if (!audio || !mediaSessionWanted) return
    if (musicStatus.value.paused) {
      if (!audio.paused) audio.pause()
    } else if (audio.paused) {
      audio.play().catch(() => {})
    }
  }

  function syncMediaSession() {
    if (!('mediaSession' in navigator)) return
    syncSilentAudio()
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
      if ([1, 2].includes(Number(saved.playMode))) await playerClient.setMode(Number(saved.playMode))
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
    if (letIndexIsNew && idList.length === 1) {
      try {
        await playerClient.getState(true)
      } catch {
        // Use the last synchronized queue if the server is temporarily unreachable.
      }
      const existingIndex = playlist.value.findIndex((track) => String(track.id) === String(idList[0]))
      if (existingIndex >= 0) {
        await playWithPlaylistIndex(existingIndex)
        return playlist.value
      }
    }
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
    syncMediaSession()
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
    syncMediaSession()
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
    base = { position: target, at: performance.now(), playing: !musicStatus.value.paused && !loading.value, holdMs: 0 }
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
    playMode.value = [0, 1, 2].includes(Number(mode)) ? Number(mode) : 0
    try {
      await playerClient.setMode(playMode.value)
    } catch (err: any) {
      api.error(err.message, '切换播放模式失败')
    }
  }

  function cyclePlayMode() {
    return setPlayMode((playMode.value + 1) % 3)
  }

  async function addToNext(id: string | number) {
    init()
    try {
      const res = await api.songDetail(String(id))
      const tracks = api.parseDetailToList(res?.data?.songs || [])
      if (tracks.length) await playerClient.addNext(tracks)
    } catch (err: any) {
      api.error(err.message, '添加到下一曲失败')
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

  function sendLyricDelayNow() {
    if (lyricDelaySendTimer) {
      clearTimeout(lyricDelaySendTimer)
      lyricDelaySendTimer = null
    }
    lyricDelayLastSentAt = performance.now()
    lyricDelayHoldUntil = Date.now() + 500
    playerClient.setLyricDelay(lyricDelay.value)
      .catch((err: any) => api.error(err.message, '调节歌词延迟失败'))
  }

  /** Same throttle pattern as volume: one request every 60 ms while dragging. */
  function scheduleLyricDelaySend() {
    lyricDelayHoldUntil = Date.now() + 500
    const elapsed = performance.now() - lyricDelayLastSentAt
    if (!lyricDelaySendTimer && elapsed >= LYRIC_DELAY_THROTTLE_MS) {
      sendLyricDelayNow()
      return
    }
    if (!lyricDelaySendTimer) {
      lyricDelaySendTimer = setTimeout(() => {
        lyricDelaySendTimer = null
        sendLyricDelayNow()
      }, Math.max(0, LYRIC_DELAY_THROTTLE_MS - elapsed))
    }
  }

  /**
   * Set the shared lyric delay in milliseconds. Positive values show lyrics
   * later, negative values earlier; the server persists it for every device.
   */
  function setLyricDelay(value: number) {
    init()
    const next = clamp(Math.round(Number(value) || 0), -LYRIC_DELAY_LIMIT_MS, LYRIC_DELAY_LIMIT_MS)
    const changed = next !== lyricDelay.value
    lyricDelay.value = next
    if (changed) {
      // Update immediately even while paused, otherwise the display would
      // keep the previous line until playback resumes.
      updateLyric()
      updateKtvLyric()
    }
    scheduleLyricDelaySend()
  }

  function adjustLyricDelay(deltaMs: number) {
    setLyricDelay(lyricDelay.value + Math.round(Number(deltaMs) || 0))
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
    base = { position: 0, at: performance.now(), playing: false, holdMs: 0 }
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
    cyclePlayMode,
    addToNext,
    playWithPlaylistIndex,
    setVolume,
    setMuted,
    toggleMute,
    adjustVolume,
    lyricDelay,
    setLyricDelay,
    adjustLyricDelay,
    setQuality,
    refresh
  }
})

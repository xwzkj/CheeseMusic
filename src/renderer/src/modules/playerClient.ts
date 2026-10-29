import { serverRequest } from './serverApi'

type StateListener = (state: any) => void
type ConnectionListener = (connected: boolean, detail?: string) => void

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15_000]

class PlayerClient {
  private ws: WebSocket | null = null
  private stateListeners = new Set<StateListener>()
  private connectionListeners = new Set<ConnectionListener>()
  private reconnectTimer: number | null = null
  private reconnectAttempt = 0
  private manuallyClosed = false
  private lastState: any = null
  private started = false
  private fetchInFlight: Promise<any> | null = null

  get state() {
    return this.lastState
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  onState(listener: StateListener) {
    this.stateListeners.add(listener)
    if (this.lastState) listener(this.lastState)
    return () => this.stateListeners.delete(listener)
  }

  onConnection(listener: ConnectionListener) {
    this.connectionListeners.add(listener)
    listener(this.connected)
    return () => this.connectionListeners.delete(listener)
  }

  connect() {
    if (this.started) return
    this.started = true
    this.manuallyClosed = false
    this._open()
    window.addEventListener('online', this._onOnline)
    document.addEventListener('visibilitychange', this._onVisibility)
  }

  disconnect() {
    this.manuallyClosed = true
    this.started = false
    window.removeEventListener('online', this._onOnline)
    document.removeEventListener('visibilitychange', this._onVisibility)
    clearTimeout(this.reconnectTimer ?? undefined)
    this.reconnectTimer = null
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
    this.ws = null
  }

  private _onOnline = () => {
    if (!this.connected) {
      clearTimeout(this.reconnectTimer ?? undefined)
      this.reconnectTimer = null
      this._open()
    }
  }

  private _onVisibility = () => {
    if (document.visibilityState === 'visible' && !this.connected && !this.manuallyClosed) {
      clearTimeout(this.reconnectTimer ?? undefined)
      this.reconnectTimer = null
      this._open()
    }
  }

  private _open() {
    if (this.manuallyClosed) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let ws: WebSocket
    try {
      ws = new WebSocket(`${protocol}//${location.host}/ws`)
    } catch (err) {
      this._notifyConnection(false, '无法连接服务器')
      this._scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.reconnectAttempt = 0
      this._notifyConnection(true)
      // The server sends a snapshot immediately, but a REST fetch also covers
      // the case where that first frame was dropped.
      this.getState(true).catch(() => {})
    }
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message?.type === 'state' && message.state) this._ingest(message.state)
      } catch {
        // ignore malformed frames
      }
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      this._notifyConnection(false, '与服务器的连接已断开')
      this._scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose handles reconnection
    }
  }

  private _scheduleReconnect() {
    if (this.manuallyClosed || this.reconnectTimer !== null) return
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    this.reconnectAttempt++
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this._open()
    }, delay)
  }

  private _notifyConnection(connected: boolean, detail?: string) {
    for (const listener of this.connectionListeners) {
      try {
        listener(connected, detail)
      } catch {
        // ignore listener errors
      }
    }
  }

  private _ingest(state: any) {
    if (!state || typeof state.revision !== 'number') return
    if (this.lastState && state.revision < this.lastState.revision) return
    // Broadcasts omit the queue when it did not change; keep the local copy.
    if (state.queue == null && this.lastState?.queue) {
      state = {
        ...state,
        queue: this.lastState.queue,
        order: state.order ?? this.lastState.order
      }
    }
    this.lastState = state
    for (const listener of this.stateListeners) {
      try {
        listener(state)
      } catch (err) {
        console.error('[playerClient] state listener failed', err)
      }
    }
  }

  async getState(force = false) {
    if (this.fetchInFlight && !force) return this.fetchInFlight
    this.fetchInFlight = serverRequest('/api/player/state')
      .then((state) => {
        this._ingest(state)
        return state
      })
      .finally(() => {
        this.fetchInFlight = null
      })
    return this.fetchInFlight
  }

  private async _action(path: string, body?: any) {
    const state = await serverRequest(`/api/player/${path}`, { method: 'POST', body })
    this._ingest(state)
    return state
  }

  setQueue(tracks: any[], startIndex = 0, play = false) {
    return this._action('queue', { tracks, startIndex, play })
  }

  addTracks(tracks: any[], options: { position?: number | string; playNow?: boolean } = {}) {
    return this._action('add', {
      tracks,
      position: options.position ?? 'now',
      playNow: Boolean(options.playNow)
    })
  }

  addNext(tracks: any[]) {
    return this._action('add-next', { tracks })
  }

  removeTracks(ids: (string | number)[]) {
    return this._action('remove', { ids })
  }

  clearQueue() {
    return this._action('clear')
  }

  play() {
    return this._action('play')
  }

  pause() {
    return this._action('pause')
  }

  toggle() {
    return this._action('toggle')
  }

  next() {
    return this._action('next')
  }

  prev() {
    return this._action('prev')
  }

  seek(position: number) {
    return this._action('seek', { position })
  }

  playIndex(index: number, play = true) {
    return this._action('index', { index, play })
  }

  setMode(mode: number) {
    return this._action('mode', { mode })
  }

  setVolume(volume: number) {
    // Moving the slider is an explicit "make it audible" action.
    return this._action('volume', { volume, muted: false })
  }

  setMuted(muted: boolean) {
    return this._action('volume', { muted })
  }

  setLyricDelay(delay: number) {
    return this._action('lyric-delay', { delay })
  }

  setQuality(quality: string) {
    return this._action('quality', { quality })
  }

  reload(position?: number | null) {
    return this._action('reload', { position: position ?? null })
  }
}

export const playerClient = new PlayerClient()

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = process.env.CHEESE_DATA_DIR
  ? path.resolve(process.env.CHEESE_DATA_DIR)
  : path.join(ROOT_DIR, 'data')
export const WEB_DIR = path.join(ROOT_DIR, 'dist', 'web')
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
export const STATE_FILE = path.join(DATA_DIR, 'player-state.json')
export const COOKIE_FILE = path.join(DATA_DIR, 'cookie.txt')

export const DEFAULT_CONFIG = {
  version: 1,
  port: Number(process.env.CHEESE_PORT || process.env.PORT || 8090),
  host: process.env.CHEESE_HOST || process.env.HOST || '0.0.0.0',
  audio: {
    backend: process.env.CHEESE_AUDIO_BACKEND || 'auto',
    device: process.env.CHEESE_AUDIO_DEVICE || 'auto',
    latency: 0.22
  },
  quality: process.env.CHEESE_QUALITY || 'jymaster',
  volume: 0.8
}

function deepMerge(base, extra) {
  const out = { ...base }
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(base[key] || {}, value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

export function loadConfig() {
  ensureDataDir()
  let extra = {}
  try {
    extra = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
  } catch {
    // First run or a corrupt file: fall back to defaults.
  }
  const config = deepMerge(DEFAULT_CONFIG, extra)
  // Environment always wins, useful for service units.
  config.port = Number(process.env.CHEESE_PORT || process.env.PORT || config.port)
  config.host = process.env.CHEESE_HOST || process.env.HOST || config.host
  if (process.env.CHEESE_AUDIO_BACKEND) config.audio.backend = process.env.CHEESE_AUDIO_BACKEND
  if (process.env.CHEESE_AUDIO_DEVICE) config.audio.device = process.env.CHEESE_AUDIO_DEVICE
  if (process.env.CHEESE_VOLUME) config.volume = Number(process.env.CHEESE_VOLUME)
  return config
}

export function saveConfig(config) {
  ensureDataDir()
  const tmp = `${CONFIG_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
  fs.renameSync(tmp, CONFIG_FILE)
}

export function readCookie() {
  try {
    return normalizeCookieString(fs.readFileSync(COOKIE_FILE, 'utf-8'))
  } catch {
    return ''
  }
}

export function writeCookie(cookie) {
  ensureDataDir()
  if (!cookie) {
    try {
      fs.rmSync(COOKIE_FILE)
    } catch {
      // already gone
    }
    return
  }
  fs.writeFileSync(COOKIE_FILE, cookie, { mode: 0o600 })
}

/**
 * Accepts "MUSIC_U=xxx" or "MUSIC_U=xxx; foo=bar" and returns a clean
 * "name=value; name=value" cookie header. Attribute pairs that Netease's
 * API returns (Path, Max-Age, ...) are ignored.
 */
export function normalizeCookieString(input) {
  if (!input) return ''
  const attrs = new Set(['path', 'max-age', 'expires', 'domain', 'httponly', 'secure', 'samesite', 'version', 'comment'])
  const jar = new Map()
  const parts = String(input).split(/;|\r?\n/).map((s) => s.trim()).filter(Boolean)
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!name || attrs.has(name.toLowerCase())) continue
    jar.set(name, value)
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

export function mergeCookieStrings(existing, additions) {
  const jar = new Map()
  for (const source of [existing, ...(Array.isArray(additions) ? additions : [additions])]) {
    for (const part of normalizeCookieString(source || '').split(';').map((s) => s.trim()).filter(Boolean)) {
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      const name = part.slice(0, eq)
      const value = part.slice(eq + 1)
      if (value) jar.set(name, value)
      else jar.delete(name)
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

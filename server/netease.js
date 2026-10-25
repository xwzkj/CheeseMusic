import Netease from 'NeteaseCloudMusicApi'
import { mergeCookieStrings, normalizeCookieString, readCookie, writeCookie } from './config.js'

let cookie = readCookie()

export function getCookie() {
  return cookie
}

export function setCookie(raw) {
  const next = normalizeCookieString(raw)
  cookie = next
  writeCookie(cookie)
  return cookie
}

export function clearCookie() {
  cookie = ''
  writeCookie('')
}

export function hasCookie() {
  return /(?:^|;\s*)MUSIC_U=[^;]+/.test(cookie)
}

export function normalizeApiPath(rawPath) {
  return String(rawPath || '')
    .trim()
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/+/, '')
    .replace(/\//g, '_')
}

function absorbCookies(result) {
  const incoming = []
  if (Array.isArray(result?.cookie)) incoming.push(...result.cookie)
  else if (typeof result?.cookie === 'string') incoming.push(result.cookie)
  if (typeof result?.body?.cookie === 'string') incoming.push(result.body.cookie)
  if (!incoming.length) return
  const next = mergeCookieStrings(cookie, incoming)
  if (next !== cookie) {
    cookie = next
    writeCookie(cookie)
  }
}

const TIMEOUT_MS = 30_000

export async function callApi(rawPath, query = {}) {
  const key = normalizeApiPath(rawPath)
  const fn = Netease[key]
  if (typeof fn !== 'function') {
    const err = new Error(`未知的网易云 API：${rawPath}`)
    err.statusCode = 404
    throw err
  }

  const args = { ...(query || {}) }
  // Never let a browser override the server-side account cookie.
  delete args.cookie
  // Netease documents noCookie for QR-code login polling; the module layer
  // does not implement it, so honour it here and still capture the new cookies.
  if (cookie && args.noCookie !== true) args.cookie = cookie

  let timer
  try {
    const result = await Promise.race([
      fn(args),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`网易云 API 请求超时：${key}`)), TIMEOUT_MS)
      })
    ])
    absorbCookies(result)
    return result?.body ?? {}
  } catch (err) {
    if (err?.response?.body) {
      absorbCookies(err.response)
      return err.response.body
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function loginStatus() {
  const body = await callApi('login_status', {})
  return body?.data ?? body
}

const URL_LEVEL_FALLBACK = ['exhigh', 'standard']

/**
 * Resolve a playable Netease stream URL. Netease normally downgrades the
 * quality automatically, but some tracks only return a URL when an explicit
 * lower level is requested.
 */
export async function resolveSongUrl(id, preferredLevel = 'jymaster') {
  const levels = []
  for (const level of [preferredLevel, ...URL_LEVEL_FALLBACK]) {
    if (level && !levels.includes(level)) levels.push(level)
  }
  let lastError = ''
  for (const level of levels) {
    const body = await callApi('song_url_v1', { id, level })
    const item = body?.data?.[0]
    if (item?.url) {
      return {
        url: item.url.startsWith('//') ? `https:${item.url}` : item.url,
        level: item.level || level,
        br: item.br || 0,
        size: item.size || 0,
        trial: item.freeTrialInfo || null,
        fee: item.fee
      }
    }
    if (item?.code && item.code !== 200) lastError = `网易云返回错误码 ${item.code}`
    else lastError = body?.message || body?.msg || '没有可用的播放地址（可能需要登录或会员）'
  }
  throw new Error(lastError || '没有可用的播放地址')
}

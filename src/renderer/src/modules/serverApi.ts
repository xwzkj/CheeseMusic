const DEFAULT_TIMEOUT = 45_000

/**
 * Small fetch wrapper for this app's own server API (not the Netease proxy).
 */
export async function serverRequest(
  path: string,
  { method = 'GET', body, timeout = DEFAULT_TIMEOUT }: { method?: string; body?: any; timeout?: number } = {}
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store'
    })
    const text = await res.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    if (!res.ok) {
      const message = data?.message || data?.error || `服务器返回 ${res.status}`
      const err = new Error(message)
      ;(err as any).status = res.status
      ;(err as any).data = data
      throw err
    }
    return data
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error('请求服务器超时')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export const getHealth = () => serverRequest('/api/health')
export const getSystemInfo = () => serverRequest('/api/system/info')
export const getAudioInfo = () => serverRequest('/api/system/audio')
export const applyAudio = (backend: string, device: string, test = false) =>
  serverRequest('/api/system/audio', { method: 'PUT', body: { backend, device, test } })
export const testAudio = (backend?: string, device?: string) =>
  serverRequest('/api/system/audio/test', { method: 'POST', body: { backend, device }, timeout: 20_000 })

export const getAuthStatus = () => serverRequest('/api/auth/status')
export const setServerCookie = (cookie: string) =>
  serverRequest('/api/auth/cookie', { method: 'POST', body: { cookie } })
export const clearServerCookie = () => serverRequest('/api/auth/cookie', { method: 'DELETE' })

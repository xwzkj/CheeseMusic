import { defineStore } from 'pinia'
import * as api from '@/modules/api.js'
import { toRaw, unref } from 'vue'
import { clearServerCookie, getAuthStatus, setServerCookie } from '@/modules/serverApi.js'

export const useUserStore = defineStore('user', {
    state: () => ({
        isLogin: false,
        name: '',
        avatar: '',
        vipIcon: '',
        vipexpire: '',
        province: '',
        city: '',
        // Cookies live on the server now. Kept empty for compatibility.
        cookie: '',
        uid: '',
        ip: '',
        playlists: [],
        likedSongs: [],
        updateTime: 0,
    }),
    actions: {
        async updateLikelist() {
            if (!this.uid) return []
            let res = await api.likelist(this.uid)
            if (res.data.code == 200) {
                this.likedSongs = res.data.ids
                this.storeToStorage()
                return res.data.ids
            }
            throw new Error('获取喜欢列表失败')
        },

        /**
         * 用服务器上的 cookie 刷新用户资料。
         * @param cookie 可选：把新的 MUSIC_U 交给服务器保存
         * @param options.silent 静默模式，不弹错误提示（启动时自动恢复用）
         */
        async updateByCookie(cookie?: string, options: { silent?: boolean } = {}) {
            if (cookie) {
                try {
                    const saved = await setServerCookie(cookie)
                    if (!saved?.ok) {
                        if (!options.silent) api.error('Cookie 无效或已过期', '登录失败')
                        return false
                    }
                } catch (err: any) {
                    if (!options.silent) api.error(err.message, '登录失败')
                    return false
                }
            }

            let res
            try {
                res = await api.loginStatus()
            } catch (err: any) {
                if (!options.silent) api.error(err.message, '获取登录状态失败')
                return false
            }
            const status = res?.data?.data ?? res?.data ?? {}
            if (status.code != 200 || !status.profile) {
                this.$reset()
                this.clearStorage()
                clearServerCookie().catch(() => {})
                if (!options.silent && cookie) {
                    api.error('登录状态已过期，请重新登录', '登录失败')
                }
                return false
            }

            this.isLogin = true
            this.name = status.profile.nickname
            this.avatar = status.profile.avatarUrl
            this.uid = status.profile.userId
            this.province = status.profile.province
            this.city = status.profile.city
            this.cookie = ''
            if (!this.ip) this.ip = `111.37.150.${api.random(0, 255)}`

            try {
                res = await api.userPlaylist(this.uid)
                if (res.data.code == 200) this.playlists = res.data.playlist
                await this.updateLikelist()
            } catch (err) {
                console.warn('[user] 获取歌单/喜欢列表失败', err)
            }

            try {
                res = await api.vipInfo()
                if (res.data.code == 200) {
                    this.vipIcon = res.data.data.associator.iconUrl
                    this.vipexpire = res.data.data.associator.expireTime
                    let svipIcon = res.data.data.redplus.iconUrl
                    let svipexpire = res.data.data.redplus.expireTime
                    if (svipexpire > Date.now()) this.vipIcon = svipIcon
                }
            } catch (err) {
                console.warn('[user] 获取会员信息失败', err)
            }

            this.updateTime = Date.now()
            this.storeToStorage()
            return true
        },

        /** Called once at startup: the server owns the session, not localStorage. */
        async restoreSession() {
            this.updateByStorage()
            try {
                const status = await getAuthStatus()
                if (!status?.loggedIn) {
                    this.$reset()
                    this.clearStorage()
                    return false
                }
            } catch (err) {
                // 服务器暂时不可用时保留本地展示，播放器连接横幅会提示
                return false
            }
            return this.updateByCookie(undefined, { silent: true })
        },

        async updateByStorage() {
            let user = JSON.parse(localStorage.getItem('user') ?? '{}')
            this.updateByObj(user)
            this.cookie = ''
        },

        updateByObj(obj: any) {
            for (let key in obj) {
                let t: any = this
                t[key] = obj[key]
            }
        },

        storeToStorage() {
            let rawObj: any = toRaw(this)
            let pureObj: any = {}
            for (let key in rawObj) {
                if (key.slice(0, 1) != '_' && key.slice(0, 1) != '$' && typeof rawObj[key] != 'function') {
                    pureObj[key] = unref(rawObj[key])
                }
            }
            pureObj.cookie = ''
            localStorage.setItem('user', JSON.stringify(pureObj))
        },

        clearStorage() {
            localStorage.removeItem('user')
            localStorage.removeItem('cookie')
        },

        logout(silent = false) {
            this.$reset()
            this.clearStorage()
            clearServerCookie().catch(() => {})
            if (!silent) api.success('已退出登录~')
        }
    }
})

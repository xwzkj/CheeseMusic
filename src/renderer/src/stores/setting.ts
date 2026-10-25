import { defineStore } from 'pinia'

export const useSettingStore = defineStore('setting', {
    state: () => ({
        lyricFontSize: '1.8rem',
        musicLevel: 'jymaster'
    }),
    actions: {
        init() {
            let obj = null
            try {
                obj = JSON.parse(localStorage.getItem('setting')!)
            } catch {
                obj = null
            }
            if (obj && obj.version == 1) {
                this.lyricFontSize = obj.lyricFontSize ?? '1.8rem'
                this.musicLevel = obj.musicLevel ?? 'jymaster'
            }
        },
        setLyricFontSize(size: string) {
            this.lyricFontSize = size
            this.save()
        },
        setMusicLevel(level: string) {
            this.musicLevel = level
            this.save()
        },
        save() {
            localStorage.setItem('setting', JSON.stringify({
                version: 1,
                lyricFontSize: this.lyricFontSize,
                musicLevel: this.musicLevel
            }))
        }
    }
})

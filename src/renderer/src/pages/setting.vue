<template>
    <div>
        <div class="setting">
            <n-card class="server-card" title="服务端播放" :bordered="false">
                <div class="server-status">
                    <div>
                        <div class="server-title">
                            声音由服务器连接的音频设备播放
                            <n-tag size="small" :type="audio.current?.available ? 'success' : 'error'" :bordered="false">
                                {{ audio.current?.available ? '输出正常' : '输出不可用' }}
                            </n-tag>
                        </div>
                        <div class="server-sub">
                            访问地址 {{ pageHost }} · 所有局域网设备共享同一个播放队列和进度
                        </div>
                    </div>
                    <n-button v-if="!playStore.connected" size="small" secondary @click="playStore.refresh()">
                        重新连接
                    </n-button>
                </div>

                <div class="server-current">
                    <div class="server-current-label">当前输出</div>
                    <div class="server-current-value">
                        {{ currentOutputLabel }}
                        <span class="server-current-small">{{ audio.current?.backend || '-' }} / {{ audio.current?.device || '-' }}</span>
                        <span v-if="audio.current?.error" class="server-error">（{{ audio.current.error }}）</span>
                    </div>
                </div>

                <div v-if="audio.session?.pipeWire" class="server-session">
                    PipeWire 已连接，系统默认输出：{{ audio.session.defaultSink || '未知' }}
                </div>
                <div v-else-if="audio.session" class="server-session server-error">
                    未检测到 PipeWire 桌面音频会话，蓝牙设备可能不会出现在列表中。请让服务和桌面会话使用同一个用户运行。
                </div>

                <div v-if="audio.tools && !audio.tools.ffmpeg" class="server-error">
                    未检测到 ffmpeg，服务端无法解码音频，请先安装 ffmpeg。
                </div>
                <div v-if="audio.tools && !audio.tools.aplay && !audio.tools.pwPlay" class="server-error">
                    未检测到 aplay / pw-play，请安装 alsa-utils 或 PipeWire。
                </div>

                <div class="server-form">
                    <n-select v-model:value="selectedOutput" :options="deviceOptions" :disabled="applying"
                        placeholder="选择音频输出设备" />
                    <n-button type="primary" :loading="applying" @click="applyDevice">应用</n-button>
                    <n-button secondary :loading="testing" @click="testDevice">测试声音</n-button>
                </div>
                <div class="server-hint">
                    使用蓝牙音箱/耳机时，请先在系统里连接好蓝牙设备，然后选择带「蓝牙」标记的 PipeWire 输出。
                    “桌面默认输出”会跟随系统默认声卡；ALSA 是绕过桌面音频服务的直连方式。测试会短暂播放提示音并自动
                    暂停/恢复当前播放。
                </div>

                <div class="volume-row">
                    <span class="volume-label text2">服务端音量</span>
                    <n-icon size="1.4rem" class="icon" style="cursor:pointer" @click="playStore.toggleMute()">
                        <i-hugeicons-volume-off v-if="playStore.muted || playStore.volume === 0" />
                        <i-hugeicons-volume-low v-else-if="playStore.volume < 0.5" />
                        <i-hugeicons-volume-high v-else />
                    </n-icon>
                    <n-slider class="volume-slider" :value="playStore.volumePercent" :min="0" :max="100"
                        :step="1" :format-tooltip="(value) => `${value}%`"
                        @update:value="(value) => playStore.setVolume(value / 100)" />
                    <span class="volume-value text2">{{ playStore.volumePercent }}%</span>
                </div>
            </n-card>

            <settingItem :needInput="true" :actionOnClick="loginByCookie" v-show="!userStore.isLogin">
                <template #t1>输入 cookie 来登录</template>
                <template #t2>从浏览器登录网易云后复制 MUSIC_U，登录状态会保存在服务器</template>
            </settingItem>
            <settingItem :actionOnClick="update" v-show="userStore.isLogin">
                <template #t1>马上更新用户信息</template>
                <template #t2>登录状态由服务器保存，每三分钟自动更新</template>
            </settingItem>
            <settingItem>
                <template #t1>主题色</template>
                <template #t2>默认值为 #DEB237</template>
                <template #action>
                    <n-color-picker class="color-picker" v-model:value="primaryColor" :show-alpha="false"
                        :modes="['hex']" style="width: 8rem; height: 2rem;" />
                </template>
            </settingItem>
            <settingItem>
                <template #t1>设置默认音质</template>
                <template #t2>期望的最高音质，下一首生效（服务端播放）</template>
                <template #action>
                    <n-dropdown :options="levelData" @select="setQuality" trigger="click">
                        <n-button type="primary" secondary icon-placement="right">
                            {{ levelData.find((obj) => obj.key == settingStore.musicLevel)?.label || settingStore.musicLevel }}
                            <template #icon>
                                <n-icon>
                                    <i-hugeicons-arrow-down-01 />
                                </n-icon>
                            </template>
                        </n-button>
                    </n-dropdown>
                </template>
            </settingItem>
            <settingItem>
                <template #t1>设置歌词字体大小</template>
                <template #t2>默认是 1.8rem</template>
                <template #action>
                    <div class="w-128px">
                        <n-slider :value="lyricFontSize" :min="1" :max="4" :step="0.1"
                            :format-tooltip="(value) => `${value}rem`"
                            @update:value="(value) => settingStore.setLyricFontSize(value + 'rem')" />
                    </div>
                </template>
            </settingItem>
            <settingItem v-show="userStore.isLogin">
                <template #t1>退出登录</template>
                <template #t2>会同时清除服务器上保存的 cookie</template>
                <template #action>
                    <n-button class="button" type="error" secondary @click="logout">退出登录</n-button>
                </template>
            </settingItem>
            <settingItem>
                <template #t1>版本信息</template>
                <template #t2>前端 v{{ buildInfo.version }} · 构建 {{ buildInfo.buildNumber }} · {{ buildInfo.buildTime }}</template>
                <template #action>
                    <div></div>
                </template>
            </settingItem>
        </div>
    </div>
</template>

<script setup name="setting" lang="js">
import { useUserStore } from '@/stores/user'
import { useThemeStore } from '@/stores/theme'
import { useSettingStore } from '@/stores/setting'
import { usePlayStore } from '@/stores/play'
import * as api from '@/modules/api'
import { applyAudio, getAudioInfo, testAudio } from '@/modules/serverApi'
import settingItem from '@/components/settingItem.vue'
import buildInfo from '@/modules/build-info'

let settingStore = useSettingStore()
let userStore = useUserStore()
let themeStore = useThemeStore()
let playStore = usePlayStore()

let lyricFontSize = computed(() => parseFloat(settingStore.lyricFontSize))
let primaryColor = ref(themeStore.mainColor || '#DEB237')
let colorReady = false
let pageHost = location.host
let audio = ref({ current: null, outputs: [], devices: [], tools: {}, session: null })
let selectedOutput = ref('')
let applying = ref(false)
let testing = ref(false)
let levelData = [
    { key: 'standard', label: '标准' },
    { key: 'higher', label: '较高' },
    { key: 'exhigh', label: '极高' },
    { key: 'lossless', label: '无损' },
    { key: 'hires', label: 'Hi-Res' },
    { key: 'jyeffect', label: '高清环绕声' },
    { key: 'sky', label: '沉浸环绕声' },
    { key: 'jymaster', label: '超清母带' }
]

let deviceOptions = computed(() => {
    return (audio.value.outputs || []).map((output) => {
        let prefix = output.kind === 'bluetooth' ? '蓝牙' : output.kind === 'pipewire' || output.kind === 'pipewire-default' ? 'PipeWire' : 'ALSA'
        let suffix = ''
        if (output.description && output.description !== prefix && !String(output.name).includes(output.description)) {
            suffix = ` · ${output.description}`
        }
        return {
            label: `${prefix} · ${output.name}${suffix}`,
            value: output.id
        }
    })
})

let currentOutput = computed(() => {
    if (!audio.value.current) return null
    let id = `${audio.value.current.backend}|${audio.value.current.device}`
    return (audio.value.outputs || []).find((output) => output.id === id) || null
})

let currentOutputLabel = computed(() => {
    if (!audio.value.current?.available) return '没有可用的输出'
    return currentOutput.value?.name || audio.value.current.device
})

function splitOutput(id) {
    let text = String(id || '')
    let index = text.indexOf('|')
    if (index < 0) return { backend: 'aplay', device: text || 'default' }
    return { backend: text.slice(0, index), device: text.slice(index + 1) }
}

function outputId(output) {
    return output ? `${output.backend}|${output.device}` : ''
}

onMounted(async () => {
    watch(primaryColor, (value) => {
        if (!colorReady) return
        if (/^#[0-9a-fA-F]{6}$/.test(String(value))) themeStore.setMainColor(value)
    })
    await nextTick()
    colorReady = true
    await loadAudioInfo()
})

async function loadAudioInfo() {
    try {
        audio.value = await getAudioInfo()
        let currentId = outputId(audio.value.current)
        if (currentId && (audio.value.outputs || []).some((output) => output.id === currentId)) {
            selectedOutput.value = currentId
        } else {
            let configured = audio.value.config
            let configuredId = configured ? `${configured.backend}|${configured.device}` : ''
            if ((audio.value.outputs || []).some((output) => output.id === configuredId)) {
                selectedOutput.value = configuredId
            } else {
                selectedOutput.value = audio.value.outputs?.[0]?.id || ''
            }
        }
    } catch (err) {
        api.error(err.message, '获取服务器音频信息失败')
    }
}

async function applyDevice() {
    applying.value = true
    try {
        let requestedId = selectedOutput.value
        let target = splitOutput(requestedId)
        let res = await applyAudio(target.backend, target.device, false)
        if (res?.output) audio.value.current = res.output
        await loadAudioInfo()
        if (res?.ok) {
            let actualId = outputId(res.output)
            if (actualId && actualId !== requestedId) {
                api.error(`所选设备不可用，已回退到 ${res.output.backend} / ${res.output.device}`, '注意')
            } else {
                api.success('已切换到新的音频输出')
            }
        } else {
            api.error(res?.message || '音频输出不可用', '切换失败')
        }
    } catch (err) {
        api.error(err.message, '切换音频输出失败')
    } finally {
        applying.value = false
    }
}

async function testDevice() {
    testing.value = true
    try {
        let target = splitOutput(selectedOutput.value)
        let res = await testAudio(target.backend, target.device)
        if (res?.ok) api.success('如果听到了提示音，说明输出设备正常')
        else api.error(res?.test?.error || '没有听到声音，请检查设备', '测试失败')
    } catch (err) {
        api.error(err.message, '测试音频输出失败')
    } finally {
        testing.value = false
    }
}

function setQuality(key) {
    playStore.setQuality(key)
}

function logout() {
    userStore.logout()
}

function loginByCookie(value) {
    userStore.updateByCookie(value).then((ok) => {
        if (ok) api.success('登录成功~')
    })
}

async function update() {
    let ok = await userStore.updateByCookie(undefined, { silent: true })
    if (ok) api.success('用户信息已更新')
    else api.error('更新失败，登录可能已过期')
}
</script>

<style scoped>
* {
    box-sizing: border-box;
}

.setting {
    padding: 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
}

.server-card {
    width: 100%;
    margin: 0.5rem;
    background-color: #ffffff80;
}

.server-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
}

.server-title {
    font-size: 1rem;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.server-sub,
.server-hint {
    color: #777;
    font-size: 0.8rem;
    margin-top: 0.25rem;
    line-height: 1.6;
}

.server-current {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-top: 1rem;
    padding: 0.6rem 0.8rem;
    border-radius: 0.5rem;
    background: rgba(0, 0, 0, 0.035);
}

.server-current-label {
    font-size: 0.8rem;
    color: #777;
}

.server-current-value {
    font-size: 0.9rem;
    word-break: break-all;
}

.server-error {
    color: #c0392b;
}

.server-current-small {
    color: #999;
    font-size: 0.78rem;
    margin-left: 0.4rem;
}

.server-session {
    color: #777;
    font-size: 0.8rem;
    margin-top: 0.5rem;
}

.server-form {
    display: flex;
    gap: 0.6rem;
    margin-top: 0.8rem;
    flex-wrap: wrap;
}

.server-form .n-select {
    min-width: 16rem;
    flex: 1;
}

.server-hint {
    margin-top: 0.6rem;
}

.volume-row {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin-top: 1rem;
}

.volume-label {
    font-size: 0.82rem;
    white-space: nowrap;
}

.volume-slider {
    max-width: 16rem;
}

.volume-value {
    min-width: 3rem;
    text-align: right;
}

.color-picker {
    width: 8rem;
    height: 2rem;
}

@media screen and (max-width: 600px) {
    .setting {
        padding: 0.5rem;
    }

    .server-status {
        align-items: flex-start;
        flex-direction: column;
    }
}
</style>

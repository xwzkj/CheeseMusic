<template>
    <div class="login-container">
        <div class="login">
            <div class="login-row-qr">
                <div class="login-qr">
                    <n-qr-code :value="qrcode" :size="200" background-color="rgba(255,255,255,0)" :color="themeStore.mainColors[9]" v-if="qrcode != ''" />
                    <span v-if="qrcode == ''" style="text-align: center;" class="text3">等待生成二维码<br />若长时间未生成
                        大概是炸了</span>
                    <span v-if="qrcode != ''" class="text2">{{ qrStatus }}</span>
                </div>
            </div>
            <div class="login-row-passwd">
                <div class="login-passwd">
                    <div style="width: 100%;">
                        <div style="font-size:1.5rem" class="text1">登录</div>
                        <div style="font-size:1rem;" class="text2">使用云音乐账号</div>
                    </div>
                    <div class="login-input-container">
                        <!-- 手机号 -->
                        <n-input v-model:value="name" class="login-input" :clearable="true" placeholder="请输入手机号">
                            <template #prefix>
                                <n-icon size="1.2rem">
                                    <i-hugeicons-smart-phone-01 />
                                </n-icon>
                            </template>
                        </n-input>
                    </div>
                    <div class="login-input-container">
                        <!-- 密码或者验证码 -->
                        <n-input v-model:value="key" class="login-input"
                            :type="currentMethod == 'passwd' ? 'password' : 'text'"
                            :placeholder="currentMethod == 'passwd' ? '请输入密码' : '请输入验证码'"
                            >
                            <template #prefix>
                                <n-icon size="1.2rem">
                                    <i-hugeicons-square-lock-password v-show="currentMethod == 'passwd'" />
                                    <i-hugeicons-message-lock-01 v-show="currentMethod == 'sms'" />
                                </n-icon>
                            </template>
                        </n-input>
                        <n-button v-show="currentMethod == 'sms'" @click="sendCaptcha">获取验证码</n-button>
                    </div>
                    <n-button style="width:100%" @click="login">登录</n-button>
                    <n-divider class="login-divider">或者</n-divider>
                    <div>
                        <n-icon size="1.5rem" class="login-icon login-method-icon" v-show="currentMethod != 'passwd'"
                            @click="currentMethod = 'passwd'; key = ''">
                            <i-hugeicons-square-lock-password />
                        </n-icon>
                        <n-icon size="1.5rem" class="login-icon login-method-icon" v-show="currentMethod != 'sms'"
                            @click="currentMethod = 'sms'; key = ''">
                            <i-hugeicons-message-lock-01 />
                        </n-icon>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup name="login">
import * as api from '@/modules/api';
import { useRouter } from 'vue-router';
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { useUserStore } from "@/stores/user";
import { NQrCode } from 'naive-ui';
import { useThemeStore } from '@/stores/theme';
let themeStore = useThemeStore();
let userStore = useUserStore();
let router = useRouter()
let qrcode = ref('');
let qrStatus = ref('等待扫码');
let check;//二维码状态检查定时器的id
let name = ref('');
let key = ref('');
let currentMethod = ref('sms');
onMounted(() => {
    // console.log('登录组件加载');
    createQRcode();
    // user.updateByCookie();//测试使用
})
onBeforeUnmount(() => {
    clearInterval(check);
})
async function createQRcode() {
    let key = await api.loginQrKey();
    // console.log('生成qrkey /login/qr/key', key.data);
    key = key.data.data.unikey;
    let qr = await api.loginQrCreate(key);
    qrStatus.value = '等待扫码'
    // console.log('生成二维码 /login/qr/create', qr.data);
    qrcode.value = qr.data.data.qrurl;
    check = setInterval(() => {
        api.loginQrCheck(key)
            .then(res => {
                if (res.data.code == 800) {
                    clearInterval(check);
                    qrStatus.value = '二维码已失效'
                    createQRcode();
                }
                if (res.data.code == 801) {
                    qrStatus.value = '等待扫码'
                }
                if (res.data.code == 802) {
                    qrStatus.value = '正在授权'
                }
                if (res.data.code == 803) {
                    qrStatus.value = '授权成功'
                    clearInterval(check);
                    afterLogin(res.data.cookie);
                }
            })
    }, 3000)
}
async function login() {
    if (name.value.length != 11) {
        api.error('请输入十一位国内号码')
        return;
    }
    if (key.value == '') {
        return;
    }
    let res;
    if (currentMethod.value == 'sms') {
        res = await api.verifyCaptcha(name.value, key.value);
        if (res.data?.code != 200) {
            api.error(JSON.stringify(res.data))
            return;
        }
        res = await api.loginWithPhone(name.value, null, key.value);
    }
    if (currentMethod.value == 'passwd') {
        res = await api.loginWithPhone(name.value, key.value);
    }
    if (res.data?.code == 200) {
        afterLogin(res.data.cookie);
    } else {
        api.error(JSON.stringify(res.data))
    }

}
async function sendCaptcha() {
    if (name.value.length != 11) {
        api.error('请输入十一位国内号码')
        return;
    }
    let res;
    res = await api.sendCaptcha(name.value);
    if (res.data.code == 200) {
        api.success(res.data.message);
    } else {
        api.error(JSON.stringify(res.data))
    }
}

async function afterLogin(cookie){
    api.success('登陆成功~')
    userStore.updateByCookie(cookie);
    router.push({ 'name': 'account' });
}
</script>

<style scoped>
.login-container {
    display: flex;
    justify-content: center;
    align-items: center;
    flex-direction: column;
    width: 100%;
}

.login {
    display: flex;
    flex: 100%;
    max-width: 45rem;
    min-width: 20rem;
    flex-direction: row;
    flex-wrap: nowrap;
    justify-content: center;
    align-items: center;
    padding: 2rem;
    margin: 2rem 5%;
    height: 25rem;
    border-radius: 2rem;
    box-shadow: 0 0 0.5rem gray;
}

.login-passwd,
.login-qr,
.login-row-qr,
.login-row-passwd {
    display: flex;
    flex-direction: column;
    align-items: center;
}

.login-row-qr,
.login-row-passwd {
    margin: 2rem 0.5rem;
}

.login-icon {
    margin: 0.5rem;
}

.login-method-icon {
    cursor: pointer;
}

.login-divider{
    margin: 0.5rem 0;
}
.login-row-qr {
    flex: 45%;
}

.login-row-passwd {
    flex: 55%;
}

.login-passwd {
    width: 17rem;
}

.login-input-container {
    margin: 0.5rem;
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    align-items: center;
    width: 100%;
    height:2.3rem;
}

@media (max-width:640px) {
    .login-row-qr {
        display: none;
    }
}
</style>
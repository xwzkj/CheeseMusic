<script setup>
import { onMounted } from "vue";
import { useUserStore } from "@/stores/user";
import { usePlayStore } from '@/stores/play'
import { useThemeStore } from "@/stores/theme";
import { useSettingStore } from "@/stores/setting";
import messageApi from "@/modules/messageApi.vue";
import notificationApi from "@/modules/notificationApi.vue";
import modalApi from "@/modules/modalApi.vue";
import Container from "./pages/container.vue";
import emitter from "@/utils/mitt";
import * as api from "@/modules/api";

let settingStore = useSettingStore();
let userStore = useUserStore();
let playStore = usePlayStore();
let themeStore = useThemeStore();
settingStore.init();
userStore.updateByStorage();

let themeOverrides = ref({
  common: {
    borderRadius: "10px",
    borderRadiusSmall: "7px"
  }
});

emitter.on('changeTheme', (theme) => {
  api.objDeepMerge(themeOverrides.value, theme)
})

// 同步初始化主题，保证设置页首次挂载时颜色选择器已有有效值
themeStore.initByLocalStorage();

onMounted(async () => {
  // 播放状态由服务器维护，连上后所有设备共享同一个队列
  playStore.init();

  // 服务端保存登录 cookie，换设备打开也会自动恢复
  await userStore.restoreSession();

  setInterval(() => {
    if (userStore.isLogin) userStore.updateByCookie(undefined, { silent: true });
  }, 1000 * 60 * 3);
})

// 解决移动端 vh 包含导航栏问题
let setRealVhVw = () => {
  let realVh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${realVh}px`);
  let realVw = window.innerWidth * 0.01;
  document.documentElement.style.setProperty('--vw', `${realVw}px`);
}
setRealVhVw = api.debounce(setRealVhVw, 10, 0)

window.addEventListener('resize', setRealVhVw);
window.addEventListener('orientationchange', setRealVhVw);
document.addEventListener('DOMContentLoaded', setRealVhVw);
</script>

<template>
  <div class="app">
    <n-config-provider :theme-overrides="themeOverrides">
      <Container />
      <n-message-provider>
        <messageApi />
      </n-message-provider>
      <n-notification-provider>
        <notificationApi />
      </n-notification-provider>
      <n-modal-provider>
        <modalApi />
      </n-modal-provider>
    </n-config-provider>
  </div>
</template>

<style>
.app,
.bg {
  background-color: v-bind('themeStore.mainColors[0]');
}

* {
  --color-0: v-bind('themeStore.mainColors[0]');
  --color-1: v-bind('themeStore.mainColors[1]');
  --color-2: v-bind('themeStore.mainColors[2]');
  --color-3: v-bind('themeStore.mainColors[3]');
  --color-4: v-bind('themeStore.mainColors[4]');
  --color-5: v-bind('themeStore.mainColors[5]');
  --color-6: v-bind('themeStore.mainColors[6]');
  --color-7: v-bind('themeStore.mainColors[7]');
  --color-8: v-bind('themeStore.mainColors[8]');
  --color-9: v-bind('themeStore.mainColors[9]');
}

.icon,
.n-icon {
  color: var(--color-8);
}

.text1 {
  color: var(--color-9);
}

.text2 {
  color: var(--color-7);
}

.text3 {
  color: var(--color-6);
}


/* 主题色 */
.color0 {
  color: var(--color-0);
}

.color1 {
  color: var(--color-1);
}

.color2 {
  color: var(--color-2);
}

.color3 {
  color: var(--color-3);
}

.color4 {
  color: var(--color-4);
}

.color5 {
  color: var(--color-5);
}

.color6 {
  color: var(--color-6);
}

.color7 {
  color: var(--color-7);
}

.color8 {
  color: var(--color-8);
}

.color9 {
  color: var(--color-9);
}

.loading-center {
  width: 100%;
  height: calc(70 * var(--vh, 1vh));
  display: flex;
  justify-content: center;
  align-items: center;
}

</style>

<template>
  <div class="volume-popover">
    <div class="volume-popover-header">
      <span>音量</span>
      <span class="volume-popover-percent">{{ playStore.volumePercent }}%</span>
    </div>
    <div class="volume-popover-row">
      <span class="volume-popover-mute" :title="playStore.muted ? '取消静音' : '静音'"
        @click="playStore.toggleMute()">
        <n-icon size="1.25rem" class="icon">
          <i-hugeicons-volume-off v-if="playStore.muted || playStore.volume === 0" />
          <i-hugeicons-volume-low v-else-if="playStore.volume < 0.5" />
          <i-hugeicons-volume-high v-else />
        </n-icon>
      </span>
      <n-slider class="volume-popover-slider" :value="playStore.volumePercent" :min="0" :max="100" :step="1"
        :tooltip="true" :format-tooltip="(value) => `${value}%`"
        @update:value="(value) => playStore.setVolume(value / 100)" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { usePlayStore } from '@/stores/play'

const playStore = usePlayStore()
</script>

<style scoped>
.volume-popover {
  user-select: none;
}

.volume-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.65rem;
  color: var(--color-7);
  font-size: 0.8rem;
}

.volume-popover-percent {
  color: var(--color-9);
  font-size: 0.85rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.volume-popover-row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}

.volume-popover-slider {
  flex: 1;
}

.volume-popover-mute {
  display: inline-flex;
  align-items: center;
  color: var(--color-8);
  cursor: pointer;
  opacity: 0.85;
  transition: opacity 0.15s ease;
}

.volume-popover-mute:hover {
  opacity: 1;
}
</style>

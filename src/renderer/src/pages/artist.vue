<template>
  <div class="artist-page">
    <n-spin v-if="loading" class="loading-center" size="large" />
    <template v-else-if="artist">
      <section class="artist-header">
        <img class="artist-avatar" :src="artist.cover || artist.avatar || '/icon.png'" :alt="artist.name" />
        <div class="artist-info">
          <h1 class="artist-name">{{ artist.name }}</h1>
          <div class="artist-stats text2">
            <span v-if="artist.musicSize">歌曲 {{ artist.musicSize }}</span>
            <span v-if="artist.albumSize">专辑 {{ artist.albumSize }}</span>
            <span v-if="artist.mvSize">MV {{ artist.mvSize }}</span>
          </div>
          <p v-if="artist.briefDesc" class="artist-description text2">{{ artist.briefDesc }}</p>
          <n-button type="primary" @click="playAll">播放热门歌曲</n-button>
        </div>
      </section>
      <musicList :value="songs" :nameOnClick="playSong" />
    </template>
    <n-empty v-else description="未找到歌手信息" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import * as api from '@/modules/api'
import { usePlayStore } from '@/stores/play'
import musicList from '@/components/musicList.vue'

const props = defineProps<{ id?: string | number }>()
const playStore = usePlayStore()
const artist = ref<any>(null)
const songs = ref<any[]>([])
const loading = ref(false)

watch(() => props.id, loadArtist, { immediate: true })

async function loadArtist() {
  if (!props.id) {
    artist.value = null
    songs.value = []
    return
  }
  loading.value = true
  try {
    const [detailRes, songsRes] = await Promise.all([
      api.artistDetail(props.id),
      api.artistTopSongs(props.id)
    ])
    const detail = detailRes?.data?.data || detailRes?.data?.artist || detailRes?.data || {}
    artist.value = detail.artist || detail
    songs.value = songsRes?.data?.songs || []
  } catch {
    artist.value = null
    songs.value = []
  } finally {
    loading.value = false
  }
}

async function playSong(id: string | number) {
  await playStore.addMusic([id], 'now', true)
}

async function playAll() {
  if (!songs.value.length) return
  await playStore.playlistInit(null, songs.value)
  await playStore.play()
}
</script>

<style scoped>
.artist-page {
  min-height: 100%;
}

.artist-header {
  display: flex;
  align-items: flex-start;
  gap: 1.25rem;
  margin: 0.5rem 0 1.25rem;
}

.artist-avatar {
  width: 9rem;
  height: 9rem;
  flex: 0 0 auto;
  object-fit: cover;
  border-radius: 0.5rem;
}

.artist-info {
  min-width: 0;
}

.artist-name {
  margin: 0 0 0.5rem;
  font-size: 1.5rem;
  font-weight: 600;
}

.artist-stats {
  display: flex;
  gap: 1rem;
  margin-bottom: 0.5rem;
}

.artist-description {
  max-width: 50rem;
  margin: 0 0 0.75rem;
  white-space: pre-wrap;
}

@media (max-width: 600px) {
  .artist-avatar {
    width: 6rem;
    height: 6rem;
  }
}
</style>

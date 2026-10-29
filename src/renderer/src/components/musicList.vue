<template>
    <div class="music-list">
        <div class="list-head-div">
            <n-card class="list-head-card" content-style="padding-top:0;padding-bottom:0;">
                <div class="list-head-card-content">
                    <div class="head-num text2">#</div>
                    <div class="head-music text2">歌曲</div>
                    <div class="head-action text2">&nbsp;</div>
                    <div class="head-album text2">专辑</div>
                </div>
            </n-card>
        </div>
        <div class="list-items">
            <!-- 每一项 -->
            <div v-for="(item, index) in props.value" :key="index" class="list-item-div">
                <n-card class="list-item-card">
                    <div class="list-item-card-content">
                        <!-- 序号 -->
                        <div class="item-num text2">{{ index + 1 }}</div>
                        <!-- 音乐图片 名称 翻译名 艺术家 -->
                        <div class="item-music" @click="props.nameOnClick(item.id)">
                            <img class="item-music-img" :src="item.al.picUrl + '?param=80y80'" :alt="item.al.name"
                                loading="lazy" />
                            <div class="item-music-detail">
                                <div class="item-music-name">
                                    <span class="item-music-text text1">{{ item.name }}</span>
                                    <span class="item-music-text text2"
                                        v-if="api.parseArray(item.tns) != ''">&nbsp;({{ api.parseArray(item.tns) }})</span>
                                </div>

                                <div class="item-music-ar">
                                    <n-tag v-if="item.fee == 1" type="warning" size="small"
                                        :bordered="false">VIP</n-tag>
                                    <n-tag v-if="item.fee == 4" type="info" size="small" :bordered="false">数字专辑</n-tag>
                                    <span v-for="(artist, artistIndex) in item.ar" :key="artist.id || artist.name" class="artist-link text2" @click.stop="openArtist(artist.id)">
                                        {{ artist.name }}<span v-if="artistIndex < item.ar.length - 1">、</span>
                                    </span>
                                </div>
                            </div>
                        </div>
                        <!-- 动作 比如收藏 -->
                        <div class="item-action" @click.stop>
                            <n-icon size="1.3rem" class="like-button" :title="isLiked(item.id) ? '取消收藏' : '收藏'">
                                <i-ant-design-heart-filled v-if="isLiked(item.id)" @click="api.likeAndUpdateLikelist(item.id, false)" />
                                <i-ant-design-heart-outlined v-else @click="api.likeAndUpdateLikelist(item.id, true)" />
                            </n-icon>
                            <n-button quaternary circle size="small" title="添加到下一曲" @click="playStore.addToNext(item.id)">
                                <template #icon><n-icon><i-hugeicons-plus-sign /></n-icon></template>
                            </n-button>
                        </div>
                        <!-- 专辑 -->
                        <div class="item-album">
                            <span class="item-album-al text2">
                                <span>{{ item.al.name }}</span>
                            </span>
                        </div>
                    </div>
                </n-card>
            </div>
        </div>

    </div>
</template>

<script setup name="musicList">
import { usePlayStore } from '@/stores/play';
import { useUserStore } from '@/stores/user';
import { useRouter } from 'vue-router';
import * as api from '@/modules/api';
let props = defineProps(['value', 'nameOnClick']);
let playStore = usePlayStore();
let userStore = useUserStore();
let router = useRouter();
function isLiked(id) {
    return userStore.likedSongs.includes(Number(id));
}
function openArtist(id) {
    if (id) router.push({ name: 'artist', query: { id } });
}
function onAction(key, item) {
    if (key === 'next') playStore.addToNext(item.id);
    if (key === 'play') props.nameOnClick(item.id);
    if (key === 'artist') openArtist(item.ar?.[0]?.id);
}

</script>

<style scoped>
.music-list {
    width: 100%;
    max-width: 100%;
}

.head-num,
.item-num {
    width: 2rem;
}

.head-music,
.item-music {
    flex: 2;
    width: 60%;
}

.item-music-name,
.item-music-ar,
.item-music-text {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}

.head-action,
.item-action {
    width: 1.5rem;
}

.head-album,
.item-album {
    flex: 1;
    padding-left: 1rem;
}

.list-head-card,
.list-item-card {
    background-color: #ffffff80;
}

.list-head-card {
    border: none;
    padding: 0;
}

.list-head-div,
.list-item-div {
    margin: 0.5rem;
    margin-bottom: 0;
}

.list-item-card-content,
.list-head-card-content {
    display: flex;
    flex-direction: row;
    align-items: center;
}

.item-music-detail {
    display: flex;
    justify-content: center;
    flex-direction: column;
    width: calc(100% - 6rem);
}

.item-music {
    display: flex;
    cursor: pointer;
}

.item-music-img {
    width: 2.8rem;
    height: 2.8rem;
    border-radius: 0.5rem;
    border: 1px solid rgba(0, 0, 0, 0.2);
    margin-right: 1rem;
}

.like-button {
    cursor: pointer;
}

.artist-link {
    cursor: pointer;
}

.artist-link:hover {
    text-decoration: underline;
}

@media (max-width: 700px) {

    .item-album,
    .head-album {
        display: none;
    }
}
</style>
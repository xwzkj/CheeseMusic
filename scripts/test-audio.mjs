import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../server/config.js'
import { AudioOutput } from '../server/player/audio.js'
import { PlayerEngine } from '../server/player/engine.js'

const args = process.argv.slice(2)
let file = args.find((arg) => !arg.startsWith('-'))
const keep = args.includes('--keep')
const generated = !file

if (!file) {
  file = path.join(os.tmpdir(), 'cheese-music-audio-test.wav')
  console.log('生成测试音频：', file)
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-af', 'volume=0.12,afade=t=in:d=0.3,afade=t=out:st=19.4:d=0.6',
    '-ar', '44100', '-ac', '2', file
  ])
}

const config = loadConfig()
const audio = new AudioOutput(config)
await audio.detect()
if (!audio.current.available) {
  console.error('音频输出不可用：', audio.current.error)
  if (!keep) fs.rmSync(file, { force: true })
  process.exit(1)
}

const engine = new PlayerEngine(audio, { latency: config.audio.latency })
engine.setVolume(0.35)
let last = -1
let ended = false

engine.on('playing', () => console.log('▶ 开始播放'))
engine.on('ended', () => {
  ended = true
  console.log('■ 播放结束')
  finish(0)
})
engine.on('error', (err) => {
  console.error('✖ 播放错误：', err.message)
  finish(1)
})

const ticker = setInterval(() => {
  const pos = engine.position().toFixed(1)
  if (pos !== last) {
    last = pos
    process.stdout.write(`\r  位置 ${pos}s / ${engine.duration ? engine.duration.toFixed(1) : '?'}s   `)
  }
}, 200)

let duration = 20
try {
  duration = Number(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file
  ]).toString().trim()) || 20
} catch {
  // keep the 20s default for the generated file
}

engine.play({ url: file, startAt: 0, duration })

const timers = []
function at(seconds, fn) {
  timers.push(setTimeout(fn, seconds * 1000))
}

// A tiny scripted session so pause / resume / seek are exercised end-to-end.
at(3, () => {
  const pos = engine.pause()
  console.log(`\n⏸ 暂停于 ${pos.toFixed(2)}s`)
})
at(5, () => {
  console.log('▶ 继续播放')
  engine.resume()
})
at(8, () => {
  engine.seek(12)
  console.log('\n⏩ 跳转到 12s')
})
at(22, () => {
  if (!ended) {
    console.error('\n✖ 超时：播放没有在预期时间内结束')
    finish(1)
  }
})

function finish(code) {
  clearInterval(ticker)
  for (const timer of timers) clearTimeout(timer)
  engine.stop()
  if (!keep && generated) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // ignore
    }
  }
  setTimeout(() => process.exit(code), 300)
}

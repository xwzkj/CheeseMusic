# 奶酪音乐 · 本地服务器版

> 基于 [xwzkj/cheesemusic](https://github.com/xwzkj/cheesemusic) 改造。
> 浏览器只负责「点歌 / 遥控」，声音从运行服务端的那台机器所连接的音频设备发出。

手机、平板、电脑连上同一个局域网后，打开 `http://<服务器IP>:8090` 就能一起使用同一套播放队列。播放、暂停、切歌、拖动进度、音量都由服务器执行，多台设备之间的状态通过 WebSocket 实时同步。

```
手机 / 平板 / 电脑                        局域网服务器
┌────────────────────┐    HTTP + WS    ┌──────────────────────────────┐
│  Vue 3 前端         │ ◄────────────► │  Node.js (Express + ws)       │
│  遥控 + 显示状态     │                 │   ├─ 网易云 API 代理 / 登录    │
└────────────────────┘                 │   ├─ 播放队列与状态（持久化）   │
                                       │   └─ ffmpeg ──► aplay/pw-play │
                                       │                    │         │
                                       │                 声卡 / HDMI   │
                                       └──────────────────────────────┘
```

## 功能

- 局域网设备通过浏览器访问，无需安装客户端。
- **服务端播放**：ffmpeg 解码网易云音频流，写入服务器上的 ALSA / PipeWire 音频设备。
- **多端同步**：播放队列、当前歌曲、进度、音量、歌词延迟、播放模式由服务器统一维护。
- 支持播放/暂停、上一首/下一首、拖动进度、随机/顺序播放；设置页有音量滑杆/静音，底栏提供音量弹层，播放器页的 ±2% 加减按钮点击会弹出音量条并支持长按连续调节，音量通过 PipeWire 流音量实时生效。
- **歌词延迟**：设置页可在 ±2 秒内以 50 ms 步进微调歌词时间，补偿蓝牙等音频输出的延迟；设置保存在服务端，所有设备同步。
- 服务端保存登录 cookie；在一台设备扫码登录后，其他设备打开即可共享账号。
- 服务端保存播放队列和进度，重启后从上次位置暂停恢复。
- 音频输出可在设置页选择并试听：PipeWire 桌面输出（含蓝牙音箱/耳机）或 ALSA 直连设备。
- **系统媒体控制**：浏览器/耳机/锁屏的播放、暂停、切歌、快进快退会转发到服务端。受浏览器自动播放策略限制，首次打开页面后点一下页面或播放按钮即可启用。
- 保留原版界面、歌单、搜索、歌曲评论、逐字歌词、下载等功能。
- 原版 Electron 客户端中的桌面歌词、窗口控制、自动更新等能力已移除，改为纯 Web。

## 环境要求

- Linux。播放链路依赖 ALSA 或 PipeWire（蓝牙音频需要 PipeWire/WirePlumber 桌面会话）。
- Node.js >= 20
- pnpm（仓库使用 pnpm 的 lockfile；也可以用 npm/yarn，但推荐 pnpm）
- `ffmpeg`、`ffprobe`
- `alsa-utils`（提供 `aplay`）或 PipeWire（提供 `pw-play`）
- 服务器上有一块可用的声卡 / HDMI 音频 / USB 声卡 / 蓝牙音频设备
- 能访问网易云音乐 API 的网络（使用 NeteaseCloudMusicApi 4.32.0）

Debian / Ubuntu 安装依赖：

```bash
sudo apt update
sudo apt install -y ffmpeg alsa-utils
```

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 构建前端（输出到 dist/web）
pnpm build

# 3. 启动服务
pnpm start
```

启动后终端会打印所有可访问地址，例如：

```
  🧀 奶酪音乐 · 本地服务器版
  本机访问   http://127.0.0.1:8090
  局域网访问 http://<server-ip>:8090
```

让局域网设备打开「局域网访问」地址即可。端口默认是 `8090`。

### 开发模式

```bash
pnpm dev
```

- 前端 Vite：<http://127.0.0.1:5173>（已配置 `/api`、`/ws` 代理）
- 服务端：<http://127.0.0.1:8090>
- 也可以分别运行：`pnpm dev:web`、`pnpm dev:server`

### 只测试音频输出

不依赖网易云，生成一段 20 秒测试音，自动验证播放、暂停、继续和跳转：

```bash
pnpm test:audio
```

> 该命令会从服务器音箱发出声音，请先确认音量合适。它会占用声卡；如果服务端正在播放，请先暂停或停止服务，或改用设置页的「测试声音」（会自动暂停再恢复）。

## 音频输出

播放流程是：`ffmpeg` 把远程音频解码成 44.1kHz / 16bit / 双声道 PCM，再通过 PipeWire 的 `pw-play`（推荐，支持蓝牙）或 ALSA 的 `aplay` 写入声卡。音量优先交给 PipeWire 调节该播放流本身的音量，因此在蓝牙音箱上调节也几乎立刻生效（ALSA 直连时仍有约半秒的硬件缓冲）。暂停会冻结解码管线和输出流，继续时从原位置立即接着播放；暂停超过 5 分钟才释放声卡与网络连接，之后继续需要重新建立管线。

### 在设置页选择设备

打开「设置」→「服务端播放」，下拉框会按来源列出：

- **PipeWire · 桌面默认输出**：跟随系统当前默认声卡。
- **蓝牙 · 设备名**：WirePlumber 管理的蓝牙音箱/耳机。
- **PipeWire · 其他 Sink**：HDMI、USB、内置声卡等由桌面音频服务管理的输出。
- **ALSA · 设备名**：绕过桌面音频服务，直接打开 ALSA 设备（`plughw:CARD=<card>,DEV=<device>`）。

点击「应用」保存，点击「测试声音」播放约 0.7 秒提示音。测试会短暂暂停当前播放，结束后自动恢复。

服务启动时会自动尝试接入当前用户的 PipeWire 会话（`/run/user/<uid>`），因此即使服务由 systemd 启动，也能看到蓝牙设备。前提是服务和桌面会话属于同一个用户。

蓝牙设备需要先在系统里完成配对并连接；连接后刷新设置页即可看到。若列表里没有蓝牙设备：

```bash
# 查看桌面会话中的音频 Sink
wpctl status
# 查看默认 Sink
wpctl inspect @DEFAULT_AUDIO_SINK@
```

### ALSA 设备

`aplay -l` 可以查看 ALSA 播放设备。例如：

```
card 1: <card-id> [<card-name>], device 0: <device-name> [...]
```

对应的设备值形如：

```
plughw:CARD=<card-id>,DEV=<device-index>
```

### 命令行 / 环境变量

配置保存在 `data/config.json`，首次启动自动生成；也可以用环境变量覆盖：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CHEESE_PORT` | `8090` | HTTP / WebSocket 端口 |
| `CHEESE_HOST` | `0.0.0.0` | 监听地址 |
| `CHEESE_DATA_DIR` | `./data` | 数据目录（cookie、配置、队列） |
| `CHEESE_AUDIO_BACKEND` | `auto` | `auto` / `aplay` / `pw-play`（PipeWire） |
| `CHEESE_AUDIO_DEVICE` | `auto` | `default`、ALSA `plughw:CARD=...,DEV=...` 或 PipeWire `node.name` |
| `CHEESE_VOLUME` | `0.8` | 初始音量 0–1 |
| `CHEESE_QUALITY` | `jymaster` | 初始音质（实际以设置页为准） |

启动时服务会按配置依次尝试 PipeWire / ALSA 输出；蓝牙输出不可用或桌面音频服务未启动时，会自动回退到 ALSA 直连设备（如果存在），并在日志和设置页显示实际使用的设备。

常见问题：`aplay: audio open error: Host is down` 表示 `default` 指向的音频服务不可用。此时在设置里选择一个具体的 `plughw:CARD=...,DEV=...`，或保证服务进程拥有正确的 `XDG_RUNTIME_DIR` / DBus 会话环境。

## 登录

- 推荐在登录页直接扫码或使用手机号登录。
- 登录成功后 cookie 由**服务端**保存（`data/cookie.txt`，权限 `600`），所有局域网设备共享，不需要每台设备单独登录。
- 也可以从浏览器登录网易云后，复制 `MUSIC_U=...` 到「设置 → 输入 cookie 来登录」。
- 未登录或没有会员时，部分歌曲只能播放 30–45 秒试听片段，界面会显示「试听」标签，进度条也会按试听长度显示。

## 使用说明

- 「播放全部」会用当前歌单替换服务器队列。
- 点击单曲会插入到当前歌曲之后并立即播放。
- 底部控制条和全屏播放页都可以操作；手机端也可以正常使用。
- 播放队列、顺序/随机模式、音量、歌词延迟、当前歌曲和进度会保存到 `data/player-state.json`。
- 歌词比声音早时在设置页把「歌词延迟」调大，比声音晚时调小；调好后所有设备共用这个偏移。
- 服务重启后默认**暂停**在上次保存的位置，不会一开机就自动外放。
- 第一次升级到服务器版时，如果服务器队列为空，浏览器会自动把它在旧版 Electron/网页版 `localStorage` 里的播放列表迁移一次到服务器。

## 用 systemd 常驻

### 桌面用户（推荐，能访问 PipeWire）

```ini
# ~/.config/systemd/user/cheese-music.service
[Unit]
Description=Cheese Music local server
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/path/to/cheesemusic
ExecStart=/usr/bin/env node server/index.js
Restart=on-failure
RestartSec=3
Environment=CHEESE_PORT=8090

[Install]
WantedBy=default.target
```


> systemd 的默认 `PATH` 通常不包含 nvm 等版本管理器安装的 Node。用 `readlink -f "$(which node)"` 查到绝对路径后替换 `ExecStart`，或在单元里补充 `Environment=PATH=...`。

```bash
systemctl --user daemon-reload
systemctl --user enable --now cheese-music
# 让服务在未登录桌面时也保持运行
loginctl enable-linger "$USER"
```

仓库里也带了示例文件：[deploy/cheese-music.user.service](deploy/cheese-music.user.service)。

### 系统服务（适合无桌面的机器，直接使用 ALSA）

```ini
# /etc/systemd/system/cheese-music.service
[Unit]
Description=Cheese Music local server
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=your-user
Group=audio
SupplementaryGroups=audio
WorkingDirectory=/path/to/cheesemusic
ExecStart=/usr/bin/env node server/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

> 系统服务无法自动接入某个桌面用户的 PipeWire/PulseAudio 会话。如果机器上声音由桌面 PipeWire 管理，优先使用用户级服务；否则请在设置页选择具体的 ALSA 设备。

示例文件：[deploy/cheese-music.system.service](deploy/cheese-music.system.service)。

## 目录结构

```
server/
  index.js              Express + WebSocket + 静态前端
  config.js             配置 / cookie / 数据目录
  netease.js            网易云 API 代理、cookie 吸收、歌曲 URL
  player/
    audio.js            ALSA/PipeWire 设备探测与测试
    engine.js           ffmpeg → aplay/pw-play PCM 播放引擎
    state.js            队列、播放状态、持久化、自动下一首
src/renderer/           Vue 3 前端（保留原版页面与组件）
scripts/
  dev.mjs               同时启动 Vite 与服务端
  test-audio.mjs        本地音频链路测试
deploy/
  *.service             systemd 示例
data/                   运行时生成，已被 .gitignore 忽略
  config.json
  cookie.txt
  player-state.json
```

## 常见问题

**能打开网页，但没有声音**

1. 看终端 / 设置页的「当前输出」是否显示「输出不可用」。蓝牙输出请确认桌面里已经连接好蓝牙设备。
2. 在服务器上执行：

   ```bash
   aplay -l
   speaker-test -D plughw:CARD=<card-id>,DEV=<device-index> -c 2 -t sine -l 1
   ```

3. 确认 `ffmpeg` 可用：`ffmpeg -version`。
4. 在设置页选择具体设备后点「测试声音」；蓝牙设备选择带「蓝牙」标记的 PipeWire 输出。
5. 如果服务是以其他用户或系统服务方式运行，可能无法访问桌面 PipeWire 会话；改用用户级 systemd 服务，或选择 ALSA 直连设备。

**暂停后马上继续，声音会立刻回来吗？**

会。暂停时服务端最多保留 5 分钟的解码管线和已经写出的音频，继续时从原位置接着播，几乎不需要等待。暂停超过 5 分钟后会释放声卡；之后再继续需要重新连接音源，无损 FLAC 跳到歌曲中间时可能要 1–5 秒，进度和队列不受影响。


**歌曲显示 VIP / 试听**

未登录或账号没有对应会员。扫码登录后重新播放；音质设置只影响能获取到的最高档位。

**端口被占用**

```bash
CHEESE_PORT=8091 pnpm start
```

**局域网打不开**

确认服务监听在 `0.0.0.0`、服务器防火墙放行端口，并检查手机与服务器是否在同一网段。

**反向代理后 WebSocket 不工作**

反代需要支持 `Upgrade` / `Connection` 头，并把 `/ws` 转发到同一后端；HTTPS 页面会自动使用 `wss://`。

## 安全说明

本项目没有内置用户认证，设计前提是**仅在家中可信局域网使用**。任何能访问端口的人都可以控制播放、修改服务器上的网易云登录 cookie。不要直接暴露到公网；如需外网访问，请放在带认证和 TLS 的反向代理之后，并限制来源 IP。

## 与上游项目的区别

- 移除 Electron 主进程、preload、桌面歌词窗口、自动更新和窗口控制。
- 浏览器端的网易云 API 调用改为经本地服务器代理，登录 cookie 由服务器保管。
- 播放从浏览器 `<audio>` 改为服务端 ffmpeg + ALSA/PipeWire。
- 新增服务端队列、进度、音量、音频设备选择与多端 WebSocket 同步。
- 移除外部统计脚本和远程字体依赖，局域网打开更干净。
- 保留原版 UI、歌单、搜索、评论、歌词与下载逻辑。

## 致谢与许可证

- 上游：[xwzkj/cheesemusic](https://github.com/xwzkj/cheesemusic)
- 网易云 API：[NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)
- 本项目沿用上游的 **AGPL-3.0** 许可证，详见 [LICENSE](LICENSE)。

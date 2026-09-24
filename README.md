# 同屏 · 常驻主机与远程现场

当前 Windows 电脑是固定的现场主机。两位远端打开 [会议网站](https://home.sunny-string.cn/meeting/)，用账号和口令验证后连接该主机。主机自动开启两路摄像头和麦克风，并在控制窗口显示、播放远端的摄像头和声音。

```text
远端 A ── 账号验证 / SDP / ICE ── 阿里云 HTTPS / WSS ── 主机常驻程序
远端 B ──────────────────────────────┘                  │
                                                        ↓ 唤起采集
                                         双摄各自最高分辨率 + 麦克风
                                                        │
                     主机为 A 生成两个裁剪流 ←────────────┤
                     主机为 B 生成两个裁剪流 ←────────────┘
                     ↓ 最高 1080p WebRTC             ↓ 最高 1080p WebRTC
                   远端 A                           远端 B
```

音视频通过 WebRTC 在主机和远端之间传输，远端之间也直接交换摄像头和麦克风。阿里云只提供网页、账号验证和连接信令，不收集或转发音视频。裁剪控制走加密的 WebRTC DataChannel。

## 使用

1. 当前电脑启动常驻主机程序后显示“现场控制台”。无人接入时保持信令在线，摄像头和麦克风关闭。
2. 远端打开网站，输入账号和口令，点击“登录并连接主机”，允许自己的摄像头和麦克风；也可选仅音频或旁听。
3. 首位远端进入后，主机自动按设备最高可用分辨率采集两路摄像头，并开启麦克风。最多两位远端同时接入，第三位会收到容量提示。
4. 每路现场画面都可通过滑块 / 滚轮放大、拖动画面平移、点击定位框选择区域，或点击“全景复位”。两位远端、两路摄像头的视野互相独立。
5. 最后一位远端断开约 3 秒后，主机释放所有设备并回到待机；下一次连接自动重新开启。
6. 主机控制窗口可“暂停远端接入”并立即关闭本机采集；“恢复远端接入”可恢复等待中的远端连接。关闭控制窗口后程序会自动恢复窗口，暂停请用按钮。

无须由现场主持人手动创建房间或分享邀请链接；远端每次都通过自己的登录会话接入。旧版邀请链接不再授予访问权限。

## 采集与裁剪

- 主机枚举非红外摄像头，读取设备能力，用 `resizeMode: none` 优先尝试最大宽高组合，不支持该组合时协商设备可用的最大设置。主机窗口和远端显示实际采集尺寸。
- 原始高分辨率视频轨道只用于本机视频源。每位远端各有两张独立的 canvas（最高 1920×1080，720p 源使用 1280×720），从原始视频的对应区域执行 `drawImage` 后，通过 `captureStream(24)` 加入该远端的 PeerConnection。原始摄像头轨道不加入远端 PeerConnection。
- 1× 发送全景，放大后只发送所选区域；每路输出保持源分辨率上限内的 1080p 或 720p。源比例不是 16:9 时保留黑边，不拉伸原始画面。允许 1–8× 数字放大，达到源像素上限后继续放大不会增加真实细节。
- 本机实测：PC Camera (eba4:6579) 的驱动报告并成功开启 **8160×6120**；Surface Camera Front (045e:0990) 最高为 **1280×720**。这是驱动提供的尺寸，不代表传感器原生像素或真实有效帧率。PC Camera 输出 1080p，Surface 前置摄像头保持 720p 输出。
- 1080p 每条视频发送上限 3 Mbps，720p 每条 1.6 Mbps，帧率上限 24 fps；当前主机向两位远端各发送一条 1080p 和一条 720p，上行预算约 9.2 Mbps 加音频和协议开销。WebRTC 会根据网络和设备负载调整实际帧率、码率和编码尺寸；源采集分辨率不随远端放大变化。

实现参考：[W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)、[W3C Canvas Media Capture](https://www.w3.org/TR/mediacapture-fromelement/)。

## 远端账号

管理员 `admin` 登录后点击“账号管理”，可以新增远端用户、重置口令、停用 / 启用或删除账号。账号为 2–32 位字母、数字、点、下划线或短横线，不区分大小写；每人有独立的 6–128 位口令。

- 管理员可管理账号和连接主机；普通远端用户可连接主机。内部角色值 `host` 为旧版本兼容保留，网页中显示“远端用户”。
- 重置口令、停用、删除账号或退出登录，只断开该账号 / 登录会话对应的远端连接，不影响其他用户或主机进程。
- 浏览器登录有效 8 小时，使用 HttpOnly、SameSite=Strict、Secure Cookie；WebSocket 和接入票据均绑定登录会话。
- 服务端保存带随机盐的 scrypt 哈希，不提供查看原口令功能。账号文件 `/var/lib/remote-meeting/users.json` 独立于发布目录；升级保留账号。
- `BOOTSTRAP_ADMIN_PASSWORD` 仅在账号文件不存在时初始化管理员，修改它不会重置现有账号。首次初始化后可移除环境文件中的该口令。

## 本机常驻程序

需要 Windows 已登录的桌面会话、Node.js 22+ 和 Edge / Chrome。主机保持开机、联网且不休眠；这里的“唤起”是启动设备采集，并非远程开机。设备通过专用浏览器进程采集，只给本机控制站点授权，不依赖用户平时打开的网页。

```powershell
npm ci
Copy-Item host/config.example.json .local/host.json
# 设置 serverUrl、与云端相同的 agentKey，以及实际 nodePath / browserPath。
# cameras 可填两个完整设备名称；空数组自动选两个非红外摄像头。
node host/index.js
```

`agentKey` 是主机程序的机器凭据，与远端用户的简短口令分开。它只放在云端 `/etc/remote-meeting.env` 的 `HOST_AGENT_KEY` 和本机忽略的 `.local/host.json`，不发给远端或浏览器、不提交 Git。

安装当前 Windows 用户登录后自动启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File host/install.ps1
```

安装器创建当前用户 Startup 目录下的 `Remote Meeting Host.lnk`，隐藏的监督进程运行 Node 常驻服务，Edge 控制窗口保持可见；监听端口为 `127.0.0.1:3034`，不对外开放。监督进程恢复意外退出的 Node，Node 恢复被关闭 / 崩溃的控制窗口，云端信令自动重连。

检查本机：`http://127.0.0.1:3034/api/status`；日志：`.local/host.log`。临时停止接入用窗口中的暂停按钮。取消自动启动时删除上述专用启动快捷方式；不要删除用户其他启动项。

配置字段：`serverUrl` 必须以 `/meeting/` 结尾；`cameras` 为两个完整设备名称，`microphone` 可指定完整设备名称；`idleMs` 为最后一位离开后等待关闭设备的毫秒数；`headless: false` 保持可见窗口。

## 云端部署

复用阿里云现有 Nginx、HTTPS 域名和证书，URL 为 `https://home.sunny-string.cn/meeting/`。Node 信令只绑定 `127.0.0.1:3033`，机器端主动向云端建立 WSS 长连接，无须云端反向访问 Windows 入站端口。

```sh
git archive --format=tar.gz --output=release.tar.gz HEAD
scp release.tar.gz aliyun-remote-meeting:/tmp/remote-meeting-release.tar.gz
ssh -T aliyun-remote-meeting 'mkdir -p /opt/remote-meeting/releases/<sha>; tar -xzf /tmp/remote-meeting-release.tar.gz -C /opt/remote-meeting/releases/<sha>; bash /opt/remote-meeting/releases/<sha>/deploy/install.sh'
```

- 部署独立的 `remote-meeting` 系统用户和 systemd 服务，只在已有 HTTPS 站点添加 `/meeting/` 的 Nginx include。
- 配置 `/etc/remote-meeting.env` 仅 root 可读；账号目录 `/var/lib/remote-meeting` 为 0700，哈希文件为 0600。部署脚本自动生成机器凭据 `HOST_AGENT_KEY`，配置本机时将此值写入 `.local/host.json`。
- `/opt/remote-meeting/current` 指向已提交的发布目录，旧版本保留。更新会重启信令、清空内存登录和远端连接；用户重新登录，主机自动重连。
- `systemctl status remote-meeting` / `journalctl -u remote-meeting --since today` / `curl http://127.0.0.1:3033/api/health`。不要停止整台机器的 Nginx 或修改其他应用。

本地开发云端服务：复制 `.env.example` 到 `.env`，设置初始化管理员口令和随机 `HOST_AGENT_KEY`，运行 `npm start`。本地开发默认 `http://127.0.0.1:3000/`，主机配置也使用该地址。

## 网络边界

默认使用 STUN 直连，不启用 TURN，阿里云不承担媒体中继。对称 NAT、企业防火墙或 UDP 封锁可能导致直连失败，此时可换手机热点或配置另一台有足够带宽的 TURN 服务；不同真实外网仍需各自验证。

可选独立 coturn：配置 `use-auth-secret`，云端设置 `TURN_URLS` 与同一 `TURN_SECRET`。登录和主机认证后下发有时限凭据，页面显示 P2P 直连 / 独立 TURN。WebRTC 媒体使用 DTLS-SRTP，控制使用加密 DataChannel；云端仅允许有长度限制的 SDP / ICE 信令。此实现面向一台固定主机、两个远端，不是多实例会议平台。

## 验证

```sh
npm run check
npm test
npx playwright install chromium
npm run test:e2e
npm run test:accounts
# 主动开启本机真实摄像头和麦克风，仅在本机测试：
node test/hardware.mjs
```

用 `BROWSER_PATH` 可指定已安装的 Edge。默认端到端测试在本机启动云端和常驻主机，使用两路合成 4K 源及测试麦克风，验证两位远端看到不同区域的实际视频像素、1080p 接收、原始轨道未发送、双向音视频、重连、暂停 / 恢复、人数限制、静音、设备释放和手机布局。截图只保存在忽略的 `test-results/`。

设置 `E2E_BASE_URL`、`E2E_USERNAME`（默认 admin）、`E2E_ADMIN_KEY`（该账号口令）可对已部署网站和已启动的真实主机运行同套接入测试，会主动开启真实设备。`E2E_HOST_STATUS_URL` 默认为 `http://127.0.0.1:3034/api/status`；线上模式不保存真实摄像头截图。测试结束后释放设备。账号测试创建并删除自己的临时账号。

## SSH / Codex

本机 SSH 别名 `aliyun-remote-meeting`，私钥在 `~/.ssh/remote_meeting_aliyun`，不在仓库中。自动化使用 `ssh -T aliyun-remote-meeting '<command>'` 避开服务器默认交互式 Shell。Codex 连接复用该 SSH 配置；不将 SSH 私钥、root 密码或任何登录凭据加入 Git。

所有开发变更直接提交并推送 `main`，云端部署使用已提交版本。

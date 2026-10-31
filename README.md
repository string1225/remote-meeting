# 同屏 · 服务器转发网页会议

Windows 后端直接采集 USB 主摄像头、笔记本前置摄像头和话筒，合成 **1920×1080 / 30 fps**，通过 WebRTC 发送给远端。两路可独立设置左右镜像，画中画固定右下角，支持共享缩放与位置控制。现场网页接收远端的画面和声音。

## 使用

1. 保持本机开机、联网并登录 Windows，启动本地常驻服务。
2. 远端登录 [会议网页](https://home.sunny-string.cn/meeting/)。登录、刷新和重连都不启动任何设备。
3. 分别点击“启动摄像头”和“开启现场话筒”。两个开关独立，本地控制台也可操作，状态实时同步。
4. 远端需要露脸或说话时，分别开启“我的摄像头”和“麦克风”，允许浏览器权限。只接收现场时不需要给远端网页设备权限。
5. 可拖动现场画面、使用方向键或调整定位框控制 1–8× 数字缩放。笔记本画中画保持右下角。
6. 本机网页默认显示摄像头视图，左侧 2/3 为现场画面，右侧 1/3 为远端画面；窄屏上下排列。本地、远端点击“网页内全屏”后，画面铺满网页并同时请求浏览器全屏，再次点击或按 Esc 退出。声音被浏览器拦截时点击“播放远端声音”。
7. 关闭现场摄像头会释放两只原设备；最后一位远端下线时也会自动关闭并释放摄像头，会议期间本机断开云端连接时同样释放。仍有远端在线时继续采集，远端重新接入后需手动启动摄像头。话筒开关独立；现场网页关闭或刷新不影响后端采集，退出本地常驻服务会释放全部设备。

## 本机设备设置

在现场控制台选择“摄像头视图”，展开“本机设备设置”，可选择主摄像头、画中画摄像头和麦克风，分别设置左右镜像。当前方向相对之前两路各翻转一次：主画面关闭镜像，画中画开启镜像。主次摄像头不能是同一设备。

点击“保存并应用”后写入本机 .local/devices.json，重启服务后继续使用；此文件独立于含机器密钥的 host.json。读取列表、登录或保存均不自动打开已关闭的设备。修改已开启的设备时，仅重新连接发生变化的设备；转发连接保持。

桌面端的镜像选项、等宽的“保存并应用”与“刷新设备列表”按钮、状态提醒依次排列在同一行；窄屏自动换行。

GET /api/devices 返回本地后端枚举和选择，PUT /api/devices/config 保存设置，二者要求同源请求和 X-Host-Console:1。设备未连接或设置无效时拒绝保存。

## 数据与性能

```text
USB + 笔记本 → Python 原生采集 / 合成 → 一份 H264 编码 → 139 TURN 转发 → 远端网页
现场话筒     → WASAPI / Opus 后端采集             → 139 TURN 转发 → 远端网页
现场网页     ←                 139 TURN 转发      ← 远端摄像头 / 麦克风
双方控制     ↔ 139 HTTPS/WSS：账号、开关、缩放、SDP / ICE
```

- 139 处理账号、控制、连接协商，并通过专用 coturn 转发双向音视频。WebRTC 媒体保持端到端加密，无 WSS 媒体分片或 MediaSource 缓冲。
- 现场网页的 Permissions-Policy 禁止摄像头和麦克风，代码不调用 getUserMedia 或 enumerateDevices。现场预览通过后端本地 JPEG 接口低频刷新，预览图像不会发送给云端。
- 原生后端使用 OpenCV / DirectShow 采集两只摄像头，目标分别为 ≤1920×1080/30 和 ≤640×480/30，每只只保留最新帧。
- 首选 Intel Quick Sync H264 硬件编码，失败时回退 libx264。两位远端共用一份 H264 编码和一份 Opus 编码；每位远端有自己的 WebRTC 加密连接。没有虚拟摄像头读取及现场浏览器重复编码。
- 默认视频码率约 3 Mbps，现场音频单声道 48 kHz / Opus 48 kbps。远端自身视频上限 640×480 / 15 fps，约 600 kbps。实际帧率受硬件及网络影响，状态包含 measuredFps、encoder 和 encodeMs。
- 话筒优先使用 Windows 默认 WASAPI 输入，也可在本机设备设置中选择。按设备原生采样率和声道回调采集，再明确重采样、混音为 48 kHz 单声道 Opus；每包 960 采样 / 20 ms，RTP 时钟固定 48 kHz。采集队列有上限，过载时丢弃陈旧数据并保留真实采集时间戳，不积压或放慢声音。现场页面显示采集格式、编码频率和包频率。后端不包含浏览器的回声消除；同处一室或扬声器回传时可使用耳机。
- 浏览器强制 iceTransportPolicy=relay，原生后端在 ICE 收集前设置 aioice 的 RELAY 策略；信令还会过滤 host / srflx / prflx 候选。TURN 不可用时连接失败，不回退 P2P。getStats 的 localCandidate 和 remoteCandidate 应均为 relay。
- 云端用 TURN_SECRET 签发 9 小时有效的 coturn REST 凭据，覆盖最长 8 小时登录会话；共享密钥只保存在服务器。每次远端入会前刷新主机配置，已运行的 Python 后端也会接收更新，避免闲置后使用过期凭据。
- 不录制或保存媒体。后端与本地页面之间的预览和媒体发送队列都有上限。

## 本地安装

需要 Windows、Node.js 22+、Python 3.12+ 和 Edge / Chrome。当前转发模式不需要安装虚拟摄像头驱动，也不会使用 OBS 的设备。

```powershell
npm ci
New-Item -ItemType Directory .local -Force
Copy-Item host/config.example.json .local/host.json
python -m venv .local/virtual-camera
.local/virtual-camera/Scripts/python.exe -m pip install -r host/rtc-requirements.txt
node host/index.js
# 设置当前用户登录后自动启动
powershell -NoProfile -ExecutionPolicy Bypass -File host/install.ps1
```

在 .local/host.json 设置 serverUrl、agentKey、nodePath、browserPath。serverUrl 使用云端 /meeting/ 地址，agentKey 与 HOST_AGENT_KEY 相同。cameras 顺序为 USB、笔记本前置；空数组自动识别。output 默认 {"width":1920,"fps":30}。rtc.pythonPath 可指定 Python；rtc.encoder 可设 auto、h264_qsv 或 libx264，默认 auto。headless:false 显示现场窗口。

更新后可在已登录 Windows 桌面中双击 `host/restart.cmd`，自动核对并关闭旧主机进程树，重新启动常驻程序和现场窗口；服务账号无权关闭其他用户的进程时，不要反复重试同一命令。

本地服务仅监听 127.0.0.1:3034。/api/status 返回状态，/api/preview 返回最新现场预览。POST /api/devices/camera 或 /api/devices/microphone，JSON 为 {"enabled":true/false}，需要同源 Origin、Content-Type:application/json 和 X-Host-Console:1。远端通过已认证的云端控制连接调用同一后端控制逻辑。机器凭据不进入浏览器。

Startup 中的 Remote Meeting Host.lnk 启动隐藏监督进程，意外退出会恢复服务。现场窗口关闭后自动重开。日志在 .local/host.log，取消自启动时只删除本服务的专用快捷方式。

旧的 MFCreateVirtualCamera 原生组件和 OBS 仍独立保留，当前网页会议不经过这些虚拟设备。需要旧系统摄像头输出时可使用仓库中单独的 virtual-camera.py / 安装脚本，先关闭本模式的现场采集，避免抢占原设备。

## 账号与安全

本地人员配置可保存姓名、账号和独立口令；最多两位远端同时接入。修改账号、重置密钥、停用或删除会撤销对应人员的登录和媒体协商连接，不影响其他人员。

网页登录有效 8 小时，使用 HttpOnly / SameSite=Strict / HTTPS Secure Cookie，票据绑定登录会话。账号文件只保存加盐 scrypt 哈希。主机管理 API 仅允许回环同源请求并验证专用头；机器凭据不进入网页。

信令只允许现场与远端交换，并验证频道、SDP 大小、ICE 字段、消息频率。远端之间不能互发信令。媒体由独立 coturn 服务转发；Node 信令服务不接收媒体内容。

## 云端部署

复用阿里云 139.224.12.141 的 Nginx、HTTPS 域名和证书，地址为 https://home.sunny-string.cn/meeting/。Node 监听 127.0.0.1:3033。音视频强制经该机器的 coturn 服务转发，不再使用 STUN_URLS 或 P2P。

deploy/install.sh 会调用恢复自本项目已有部署归档的 deploy/install-turn.sh：复用 /opt/remote-meeting/turn/4.18.0，缺失时按固定源码校验和编译；启动 remote-meeting-turn.service，并在 /etc/remote-meeting.env 生成或保留 TURN_SECRET，配置 TURN_URLS 和 ICE_TRANSPORT_POLICY=relay。密钥与 coturn static-auth-secret 保持一致，不写入发布包。TURN_URLS / TURN_SECRET 缺失或策略非 relay 时应用拒绝启动。

公网入口只使用已有的 TCP 443：浏览器和原生后端连接 `turns:home.sunny-string.cn:443?transport=tcp`。`deploy/install-tls.sh` 使用 HAProxy 终止 TLS，根据解密后的 STUN magic cookie 区分 TURN 与 HTTPS；普通 HTTPS（包括没有 ALPN 的客户端）继续交给 Nginx。Nginx 的 HTTPS 上游只监听 `127.0.0.1:8443`，通过 PROXY v2 保留原客户端地址，原有站点、路由与证书继续使用。coturn 的 3478 和 UDP relay 端口只供服务器内部转发，不要求向公网放行额外端口。证书续期 hook 会同步并重载共享 TLS 入口。

`deploy/install-public-redirects.sh` 为 Nginx 的 HTTP 配置安装 `port_in_redirect off`，让所有虚拟主机自动生成的重定向省略内部的 8443 端口。安装前备份已有配置，校验失败时恢复，再平滑重载 Nginx。

TURN_PUBLIC_IP 默认使用已确认的 139.224.12.141；私网地址从 eth0 获取，可用 TURN_PRIVATE_IP 指定实际值。TURN_TLS_HOST 默认使用 home.sunny-string.cn。发布前核对现有服务、证书、地址和端口；发布后仍需验证公网 443 上的双向媒体解码，不能只看健康接口。

```sh
git archive --format=tar.gz --output=release.tar.gz HEAD
scp release.tar.gz aliyun-remote-meeting:/tmp/remote-meeting-release.tar.gz
ssh -T aliyun-remote-meeting 'mkdir -p /opt/remote-meeting/releases/<sha>; tar -xzf /tmp/remote-meeting-release.tar.gz -C /opt/remote-meeting/releases/<sha>; bash /opt/remote-meeting/releases/<sha>/deploy/install.sh'
```

更新 remote-meeting、专用 remote-meeting-turn、remote-meeting-tls 服务与已有站点的 /meeting/ include，通过 reload 应用 Nginx 配置。账号文件 /var/lib/remote-meeting/users.json 与 /etc/remote-meeting.env 独立于发布目录，升级保留；配置仅 root 可读。健康接口返回 {"status":"ok","mode":"web-meeting","transport":"relay"}。该接口仅证明应用配置，仍须验证真实媒体的 relay 候选和双向解码。发布后重启 Windows 本地 host/index.js 和现场页面，远端刷新并重新登录；已建立的旧 P2P 连接必须断开重建。

## 验证

```powershell
npm run check
npm test
npm run test:e2e
npm run test:meeting-ui
npm run test:accounts
npm run test:host-accounts
.local/virtual-camera/Scripts/python.exe test/native-camera.test.py
.local/virtual-camera/Scripts/python.exe test/audio-capture.test.py
.local/virtual-camera/Scripts/python.exe test/native-relay.test.py
node test/relay-browser.mjs
node test/device-settings-browser.mjs
# 以下验收打开真实设备，需先关闭另一份本地采集
node test/hardware.mjs
```

BROWSER_PATH 可指定 Edge。浏览器回归启动仅监听回环的认证测试 TURN 服务（node-turn 仅为开发依赖，生产使用 coturn），使用原生合成测试画面和测试声音，验证登录不开设备、独立手动开关、双向 relay 候选、解码与音量、现场网页零采集、关闭页面仍发送、重连、两人同步控制和账号撤销。relay-browser.mjs 和 native-relay.test.py 验证 TURN 不可达时不产生直连候选。UI 覆盖桌面、320/390 px、网页全屏 / Esc、缩放与草稿保留。只保存合成截图到忽略的 test-results/；真实设备验收不保存图像。

## 开发

SSH 别名 aliyun-remote-meeting，自动化使用 ssh -T。机器凭据、SSH 密钥及 .local 文件不进入 Git。所有变更直接提交并推送 main；云端只部署已提交版本。

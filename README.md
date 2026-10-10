# 同屏 · 常驻主机与远程现场

当前 Windows 电脑提供一路共享合成画面：USB 摄像头铺满画面，笔记本前置摄像头固定在右下角。两位远端打开 [会议网站](https://home.sunny-string.cn/meeting/)登录，通过网页启动、停止现场摄像头并调整 USB 画面的缩放和位置。本地同时输出系统摄像头 **OBS Virtual Camera**，可在微信、腾讯会议等支持该设备的软件中选择。

```text
USB 摄像头 ≤1080p/30fps ── 缩放、移动 ──┐
笔记本摄像头 ≤640×480/30fps ── 右下角 ──┴─ 本地单张 canvas，1080p/30fps
                                              ├─ WebRTC → 远端 A
                                              ├─ WebRTC → 远端 B
                                              └─ OBS Virtual Camera → 微信 / 腾讯会议
远端网页 ── 加密 DataChannel ── 启动 / 停止 / USB 视野控制
```

阿里云只提供网页、账号验证和连接信令，音视频通过 WebRTC 直接传输。两位远端共享画面、缩放和位置；任意一位调整后，其他远端及系统虚拟摄像头同步更新。

## 使用

1. 启动常驻主机程序后默认显示“人员配置”，设备保持关闭。切换“摄像头视图”，可在本地点击“启动摄像头”，无需远端接入；本地单独使用系统摄像头时不开启麦克风。
2. 远端登录后点击“登录并连接主机”。可选择摄像头和麦克风、仅麦克风或旁听；连接仅自动开启主机会议麦克风，现场摄像头等待明确启动。
3. 点击网页右侧“启动现场摄像头”，开启两路物理摄像头。左侧接收一路合成画面，USB 为主画面，笔记本为右下角画中画；最多两位远端接入。
4. 用左下角的方向、＋ / −、复位按钮，或滑块、滚轮、拖动和定位框控制 USB 视野。支持 1–8× 数字缩放；画中画不随 USB 缩放或平移变化。
5. 点击“停止现场摄像头”或本地“关闭摄像头”释放两路物理摄像头及系统虚拟摄像头输出，会议语音继续。启动中可用本地“取消启动”取消；设备异常可停止后重试。
6. 最后一位远端离开约 3 秒后释放会议麦克风。已启动的画面持续输出，供微信等软件使用，直到明确停止；摄像头停止且无人接入时释放合成流。主机“暂停远端接入”会关闭所有设备；恢复接入后按需重新启动摄像头。
7. 在微信或腾讯会议的摄像头列表中选择 **OBS Virtual Camera**，麦克风仍在对应软件中单独选择。本服务直接向已安装的 OBS 驱动送帧，无需运行 OBS 主程序；OBS 的虚拟摄像头输出须处于停止状态，以免占用同一个输出设备。

无须创建房间或分享邀请链接。远端主画面支持浏览器全屏，保留 USB 方向、缩放与复位控制；声音按钮可开启或静音接收音频。主机人员配置、连接前麦克风检测、扬声器试听及会议中的音量电平继续可用。

## 采集、合成与系统虚拟摄像头

- 默认输出为 **1920×1080、30 fps**，本机实测 USB PC Camera 采集 **1920×1080、30 fps**，Surface Camera Front 采集 **640×480、30 fps**。不再打开旧的 8160×6120 模式。
- 枚举时排除红外及虚拟摄像头，自动优先 USB / PC Camera，再选择笔记本前置设备；`cameras` 可明确指定主画面、画中画顺序。采集约束使用尺寸、帧率硬上限和 `resizeMode: none`，避免驱动先采集 8K 再缩小。
- 只维护一张合成 canvas、一次绘制循环和一条合成视频轨道；两位远端使用同一轨道，原始物理摄像头轨道不进入 PeerConnection。每个 PeerConnection 仍需各自进行 WebRTC 编码。
- USB 及画中画按比例裁剪铺满各自区域，不拉伸；画中画宽为输出宽的约 26%，与右边和下边保留 2% 的边距。USB 变焦不会增加传感器细节。
- 默认每位远端视频码率上限 3 Mbps，两位合计约 6 Mbps，加音频和协议开销。合成、USB 采集及 WebRTC 发送帧率上限均为 30 fps，可配置 5–30 fps。其他软件直接使用原摄像头时，先在本地点击“关闭摄像头”，释放两路物理视频设备及系统虚拟摄像头输出；网页语音可继续使用。
- 系统输出从同一合成 canvas 读取 RGBA 帧，通过仅监听回环地址、校验 Host / Origin 的独立 WebSocket 交给 Python / pyvirtualcam，再送到已安装的 OBS 驱动。最多一帧在途，慢时丢帧，不积累队列。系统输出故障在本地与远端显示，WebRTC 画面仍可继续。

实现参考：[W3C Canvas Media Capture](https://www.w3.org/TR/mediacapture-fromelement/)、[pyvirtualcam](https://github.com/letmaik/pyvirtualcam)。

## 远端账号

在当前主机打开 [现场控制台](http://127.0.0.1:3034/)，默认显示“外部接入人员配置”；通话期间可通过顶部“人员配置”切回，无需再登录云端管理员账号：

1. 填写姓名、登录账号和登录密钥，点击“保存并启用”。可手动设置 6–128 位密钥，也可生成随机密钥；保存前可显示并记录密钥。
2. 将账号和密钥告知对应人员，对方在页面提供的远端登录地址输入即可登录。人员姓名由主机配置。
3. 点击人员旁的“编辑”修改姓名、账号或密钥；密钥留空保留原值。支持停用、启用、删除及刷新列表；可配置多位人员，同时接入容量仍为两位。
4. 保存成功表示云端已持久化，远端立即使用新配置登录。主机暂停接入时仍可管理人员；网络中断时会提示失败或要求刷新核对，不会把未确认的配置显示为已保存。

本机仅管理普通远端人员，保留原有管理员入口。修改账号、密钥、停用或删除会撤销该人员的登录和连接；仅修改姓名则在下次连接时使用新姓名。配置接口通过本机服务代发并使用机器凭据认证，机器凭据不进入网页；接口仅监听回环地址，并校验 Host、Origin 和专用请求头。账号和密钥哈希存储在云端持久账号文件，主机页面不保存明文密钥。

管理员 `admin` 登录后点击“账号管理”，可以新增远端用户、重置口令、停用 / 启用或删除账号。账号为 2–32 位字母、数字、点、下划线或短横线，不区分大小写；每人有独立的 6–128 位口令。

- 管理员可管理账号和连接主机；普通远端用户可连接主机。内部角色值 `host` 为旧版本兼容保留，网页中显示“远端用户”。
- 重置口令、停用、删除账号或退出登录，只断开该账号 / 登录会话对应的远端连接，不影响其他用户或主机进程。
- 浏览器登录有效 8 小时，使用 HttpOnly、SameSite=Strict、Secure Cookie；WebSocket 和接入票据均绑定登录会话。
- 服务端保存带随机盐的 scrypt 哈希，不提供查看原口令功能。账号文件 `/var/lib/remote-meeting/users.json` 独立于发布目录；升级保留账号。
- `BOOTSTRAP_ADMIN_PASSWORD` 仅在账号文件不存在时初始化管理员，修改它不会重置现有账号。首次初始化后可移除环境文件中的该口令。

## 本机常驻程序

需要 Windows 已登录的桌面会话、Node.js 22+、Edge / Chrome、Python 3.10+ 和已安装 OBS Studio 的虚拟摄像头驱动。主机保持开机、联网且不休眠；这里的“唤起”是启动设备采集，并非远程开机。设备通过专用浏览器进程采集，只给本机控制站点授权，不依赖用户平时打开的网页。

```powershell
npm ci
Copy-Item host/config.example.json .local/host.json
# 设置 serverUrl、与云端相同的 agentKey，以及实际 nodePath / browserPath。
# cameras 顺序为 USB 主画面、笔记本画中画；空数组自动识别。
powershell -NoProfile -ExecutionPolicy Bypass -File host/install-virtual-camera.ps1
# 可用 -PythonPath 指定真实 Python 可执行文件。
node host/index.js
```

`agentKey` 是主机程序的机器凭据，与远端用户的简短口令分开。它只放在云端 `/etc/remote-meeting.env` 的 `HOST_AGENT_KEY` 和本机忽略的 `.local/host.json`，不发给远端或浏览器、不提交 Git。

安装当前 Windows 用户登录后自动启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File host/install.ps1
```

安装器创建当前用户 Startup 目录下的 `Remote Meeting Host.lnk`，隐藏的监督进程运行 Node 常驻服务，Edge 控制窗口保持可见；监听端口为 `127.0.0.1:3034`，不对外开放。监督进程恢复意外退出的 Node，Node 恢复被关闭 / 崩溃的控制窗口，云端信令自动重连。

检查本机：`http://127.0.0.1:3034/api/status`；日志：`.local/host.log`。临时停止接入用窗口中的暂停按钮。取消自动启动时删除上述专用启动快捷方式；不要删除用户其他启动项。

配置字段：`serverUrl` 必须以 `/meeting/` 结尾；`cameras` 按 USB、笔记本画中画填写两个完整设备名称；`microphone` 可指定设备名称；`output` 默认 `{ "width": 1920, "fps": 30 }`；`virtualCamera.enabled` 默认 true，`pythonPath` 可指定独立安装了依赖的解释器，默认 `.local/virtual-camera/Scripts/python.exe`；`idleMs` 控制无人接入时释放会议麦克风及已停止的合成流的等待时间；`headless: false` 保持可见窗口。

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
npm run test:meeting-ui
npm run test:accounts
npm run test:host-accounts
# 主动开启本机真实摄像头和麦克风，仅在本机测试：
node test/hardware.mjs
```

用 `BROWSER_PATH` 可指定已安装的 Edge。默认媒体回归使用受采集尺寸限制的两路颜色测试源，验证手动启动、部分设备失败释放、一路共享轨道、USB 控制同步、固定画中画实际像素、语音保持、容量、重连、取消启动和设备释放。默认不使用系统虚拟摄像头驱动。

`test:meeting-ui` 覆盖声音、电平、全屏、USB 方向与缩放、人员配置草稿保留、桌面和手机布局；截图仅保存在忽略的 `test-results/`，不拍摄真实摄像头。

`node test/virtual-camera-browser.mjs` 为 Windows / OBS 驱动测试：只使用颜色测试源，另一浏览器真实读取系统摄像头，验证输出像素与远端控制、远端离开后持续输出、本地启动不开麦克风和停止释放。`node test/hardware.mjs` 主动开启真实 USB 和 Surface 摄像头，只在本地测试，不保存摄像头截图。二者需要先安装 Python 依赖及 OBS 驱动，避免与其他正在输出 OBS Virtual Camera 的程序同时运行。

设置 `E2E_BASE_URL`、`E2E_USERNAME`（默认 admin）、`E2E_ADMIN_KEY` 可对已部署网页及真实主机运行媒体回归，会启动真实设备并改变共享视野。普通账号管理测试创建并删除自己的临时账号。

## SSH / Codex

本机 SSH 别名 `aliyun-remote-meeting`，私钥在 `~/.ssh/remote_meeting_aliyun`，不在仓库中。自动化使用 `ssh -T aliyun-remote-meeting '<command>'` 避开服务器默认交互式 Shell。Codex 连接复用该 SSH 配置；不将 SSH 私钥、root 密码或任何登录凭据加入 Git。

所有开发变更直接提交并推送 `main`，云端部署使用已提交版本。

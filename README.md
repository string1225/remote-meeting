# 同屏 · 双向网页会议

Windows 本地采集 USB 和笔记本摄像头，合成 **1920×1080、30 fps** 画面。USB 主画面左右镜像，笔记本画中画固定右下角。远端登录 [会议网页](https://home.sunny-string.cn/meeting/) 后，可启动、关闭和控制摄像头，同时与现场双向通话；现场窗口同步显示每位远端的画面和声音。

```text
USB + 笔记本 → 原生合成 → 本地网页：一路视频 + 麦克风
                                  ⇅ HTTPS/WSS 443
                     139.224.12.141：认证、控制、音视频转发
                                  ⇅ HTTPS/WSS 443
                         远端网页：视频 + 麦克风
```

两端媒体统一经 139 中转，无点对点连接，不需要开放额外 TURN 端口。本地浏览器读取已有的合成虚拟设备，只编码一路，再由服务器转发给最多两位远端。音视频合并编码保持同步，浏览器通过 MediaSource 播放。服务器不录制或保存媒体，只保留有界的实时发送缓冲。

## 使用

1. 本机保持开机、联网、已登录 Windows 且不休眠。常驻程序打开现场窗口，可切换摄像头视图和人员配置。
2. 远端用账号和密钥登录，自动接入现场并启动合成摄像头。首次使用允许摄像头、麦克风权限；拒绝权限仍可接收现场画面和声音。
3. 远端画面出现在现场窗口，现场合成画面出现在远端网页。两边可关闭自己的麦克风、静音接收声音；若浏览器拦截自动播放，点击“播放远端声音”。远端可单独关闭自己的摄像头。
4. 用方向按钮、＋ / −、全景复位、缩放滑块或定位框控制 USB 的 1–8× 数字缩放及裁剪位置。两位远端控制状态同步，画中画固定右下角。
5. 点击视频上的“网页内全屏”，画面铺满当前网页；再次点击或按 Esc 退出。现场的远端视频同样支持此操作。
6. 本地或远端点击“关闭摄像头”会释放两只原摄像头，声音通话继续。明确关闭后，同一控制会话刷新或重连不会自行重启；新建立的控制会话会自动启动。所有远端离开后，现场麦克风停止，已开启的本地合成继续保持。
7. “暂停远端接入”断开云端媒体和控制，恢复后自动重连。支持新版 Edge / Chrome；手机浏览器需支持 MediaRecorder 与相应 MediaSource 格式。

**Remote Meeting Camera** 使用 Windows 11 的 [MFCreateVirtualCamera](https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/nf-mfvirtualcamera-mfcreatevirtualcamera) 注册原生软件摄像头。Windows 自动按系统语言为名称添加虚拟摄像头后缀，中文系统显示 **(Windows 虚拟摄像头)**，英文系统显示 **(Windows Virtual Camera)**。自己的媒体源由 Windows Frame Server 加载，提供 NV12 / YUY2，支持 Media Foundation、WinRT 和 DirectShow 的系统枚举路径。设备对当前桌面用户发布，并持久保留；停止本地采集时输出黑帧并释放原摄像头。OBS 的设备仍独立。

## 本地采集与性能

- 默认合成输出 1920×1080 / 30 fps；USB 采集上限为 1920×1080 / 30，笔记本上限为 640×480 / 30，拒绝驱动返回更大的采集尺寸。
- OpenCV / DirectShow 采集，每只摄像头只保留最新一帧；原生 NumPy / OpenCV 合成后转换为 NV12，写入受 ACL 保护的本机最新帧文件映射，由 Windows Frame Server 只读采样。浏览器读取合成设备后用 MediaRecorder 编码，默认现场 VP8 + Opus 约 2.5 Mbps 视频 / 48 kbps 音频，远端画面上限 640×480 / 15 fps、约 600 kbps。增加远端不会增加现场编码器数量。
- 输出采用绝对时间节拍，目标及生产上限为 30 fps；状态中的 `virtualCamera.measuredFps` 是实际送帧速率，受硬件负载影响。
- USB 主画面左右镜像，缩放与定位使用镜像后的画面坐标；画中画保持自身方向，叠加在最终输出的右下角。两路按比例裁剪，不拉伸。画中画宽约 26%，右、下边距分别约为输出宽、高的 2%。数字变焦不增加传感器细节。
- 自动选取 USB / PC Camera 和笔记本前置设备，排除红外及虚拟摄像头。`cameras` 可明确指定主画面、画中画顺序，兼容浏览器设备名末尾的 VID:PID。
- 物理摄像头被占用、断开、原生进程异常或启动超时会在控制台与远端显示错误；停止会等待进程退出后才报告原设备已释放。

## 远端账号

在 [本地控制台](http://127.0.0.1:3034/) 默认的“人员配置”中填写姓名、登录账号和密钥，保存后云端立即可登录。支持随机密钥、编辑、启用、停用、删除和刷新；切换摄像头视图保留未保存的草稿。本机只能管理普通远端人员。

管理员 `admin` 登录网页后可通过“账号管理”管理所有账号。账号为 2–32 位字母、数字、点、下划线或短横线，每人有独立的 6–128 位口令。内部角色 `host` 兼容旧版本，界面显示为远端用户。

修改账号、重置密钥、停用或删除会撤销对应人员的登录与控制连接，不影响其他人员。网页登录有效 8 小时，使用 HttpOnly / SameSite=Strict / HTTPS Secure Cookie；控制票据绑定登录会话。云端账号文件保存加盐 scrypt 哈希，发布与升级保留账号。

主机配置 API 仅监听回环地址，验证 Host、Origin 和专用请求头，机器凭据不进入浏览器。保存成功代表云端持久化成功；网络失败时不会把未确认的操作显示为保存成功。

## 安装本机服务

需要 Windows 11（Build 22000+）已登录桌面、Node.js 22+、Edge / Chrome 和 Python 3.10+；构建原生组件需要 x64 MSVC 与 Windows SDK 22000+。

```powershell
npm ci
New-Item -ItemType Directory .local -Force
Copy-Item host/config.example.json .local/host.json
# 设置 serverUrl、agentKey 和实际 nodePath / browserPath。
# cameras 顺序是 USB、笔记本前置；空数组自动识别。
# 在 VS x64 开发者终端中构建，或用 -ToolchainRoot 指定含 MSVC 和 SDK 的便携工具链。
powershell -NoProfile -ExecutionPolicy Bypass -File host/build-mf-camera.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File host/install-virtual-camera.ps1
# 可用 -PythonPath 指定真实 Python 可执行文件。
node host/index.js
```

安装器建立 `.local/virtual-camera` Python 环境，先自检原生媒体源，再请求一次 Windows 管理员确认。媒体源位于 `C:\Program Files\Remote Meeting Camera\native\<版本>`，其专用 COM CLSID 在 HKLM 注册，以便系统 Frame Server 加载；随后由原桌面用户调用 MFCreateVirtualCamera 发布自己的设备。安装只清理本服务旧的 UnityCapture 用户注册，保留 OBS。

仅更新原生组件：先构建，再运行 `host/install-mf-camera.ps1 -Elevate`。`-WhatIf` 会自检并预览安装步骤。`RemoteMeetingCamera.exe list` 可检查 Media Foundation 枚举，`remove` 可取消当前用户的设备发布。旧 `install-camera-driver.ps1` 仅用于旧版 UnityCapture 的诊断或卸载，不再是默认安装路径。

共享帧文件位于 ProgramData 的专用目录，只允许本用户写入、Windows 服务读取，始终覆盖最新一帧，不累积录制。正常停止会清零像素；异常退出超过两秒后媒体源自动输出黑帧。若提示 PC Camera 无法打开，先停止 OBS、钉钉等应用对该原摄像头的使用，钉钉应选择合成虚拟设备。

配置：`serverUrl` 为云端 `/meeting/` 地址；`agentKey` 与云端 `HOST_AGENT_KEY` 相同；`output` 默认 `{ "width": 1920, "fps": 30 }`；`virtualCamera.enabled` 默认 true，`pythonPath` 默认 `.local/virtual-camera/Scripts/python.exe`；`headless: false` 显示控制窗口。`microphone` 可按设备名称指定现场麦克风，未配置时使用系统默认输入；旧的 idleMs 字段不再使用。

当前用户登录后自动启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File host/install.ps1
```

安装器创建当前用户 Startup 目录的 `Remote Meeting Host.lnk`。隐藏监督进程运行本地服务，意外退出后恢复；本地可见窗口负责音视频播放、编码、控制和人员配置。关闭窗口时原生合成继续保持，网页通话在窗口自动恢复后重建。

本地监听 `127.0.0.1:3034`；检查 `http://127.0.0.1:3034/api/status`，日志 `.local/host.log`。暂停按钮仅暂停远端控制。取消自动启动时仅删除本服务的专用快捷方式。

## 云端部署

复用阿里云 Nginx、HTTPS 域名和证书，地址为 `https://home.sunny-string.cn/meeting/`。云端 Node 仅监听 `127.0.0.1:3033`，本机主动建立独立的 WSS 控制和媒体连接，无需对 Windows 开放入站端口。媒体也由此服务器通过现有 443 端口转发。

```sh
git archive --format=tar.gz --output=release.tar.gz HEAD
scp release.tar.gz aliyun-remote-meeting:/tmp/remote-meeting-release.tar.gz
ssh -T aliyun-remote-meeting 'mkdir -p /opt/remote-meeting/releases/<sha>; tar -xzf /tmp/remote-meeting-release.tar.gz -C /opt/remote-meeting/releases/<sha>; bash /opt/remote-meeting/releases/<sha>/deploy/install.sh'
```

部署只更新 `remote-meeting` 服务和已有 HTTPS 站点的 `/meeting/` include。配置 `/etc/remote-meeting.env` 仅 root 可读；账号文件 `/var/lib/remote-meeting/users.json` 位于发布目录外。`/opt/remote-meeting/current` 指向已提交版本，旧发布保留，健康检查失败会回滚。

发布重启云端会使内存登录与控制连接失效，远端重新登录即可。本机主动重连，原生虚拟输出不依赖云端连接。健康接口返回 `{"status":"ok","mode":"web-meeting","transport":"wss-relay"}`。

本地开发云端：复制 `.env.example` 到 `.env`，设置管理员初始密钥和随机机器凭据，运行 `npm start`；本机配置使用同一个开发 URL。`BOOTSTRAP_ADMIN_PASSWORD` 只在账号文件不存在时初始化，后续通过界面改口令。

## 验证

```sh
npm run check
npm test
npm run test:e2e
npm run test:meeting-ui
npm run test:accounts
npm run test:host-accounts
# Windows：先安装 Python 依赖及独立摄像头驱动；避免同时运行另一份本地输出。
.local/virtual-camera/Scripts/python.exe test/native-camera.test.py
.local/virtual-camera/Scripts/python.exe test/mf-camera.test.py
node test/virtual-camera-browser.mjs
node test/hardware.mjs
```

可用 `BROWSER_PATH` 指定已安装 Edge。默认浏览器回归使用合成摄像头和测试音频，验证双向解码画面、播放音量、两位远端控制、重连、失败重试、关闭和账号权限；服务器回归验证媒体身份绑定、角色隔离、退出撤销和帧大小限制。UI 回归覆盖网页内全屏 / Esc、桌面、320 / 390 px 手机布局、方向 / 缩放 / 复位及草稿保留；仅测试图像保存到忽略的 `test-results/`。

原生单元测试验证设备选择、实际合成像素、固定画中画、裁剪边界和失败释放。Media Foundation 验收跨进程检查六种格式、送帧与过期黑帧，驱动验收使用颜色测试源，由独立本地接收程序读取 Remote Meeting Camera，验证 1080p/30 模式及实际控制效果。硬件验收会开启真实 USB 和 Surface，检查实际采集尺寸及帧率、本地关闭后另一程序重新打开两只原设备；不保存真实摄像头画面；公网验收会通过授权的 139 会议中转发送现场媒体。

## SSH / Codex

SSH 别名 `aliyun-remote-meeting`，自动化使用 `ssh -T` 避开交互式 Shell。SSH 私钥、机器凭据、登录密钥和 `.local/host.json` 不进入 Git。

所有开发变更直接提交并推送 `main`，云端部署使用已提交版本。

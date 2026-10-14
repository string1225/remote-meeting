# 同屏 · 钉钉摄像头控制

Windows 本地服务原生采集 USB 主摄像头和笔记本前置摄像头，合成为 **1920×1080、30 fps** 的独立系统摄像头 **Remote Meeting Camera Windows Virtual Camera**。USB 铺满画面，笔记本摄像头固定在右下角。远端登录 [控制网页](https://home.sunny-string.cn/meeting/) 后自动启动本地虚拟输出，只控制摄像头开关、USB 数字缩放和位置。画面与声音由钉钉会议传输。

```text
USB 摄像头 ≤1920×1080/30 ── 缩放、移动 ──┐
笔记本摄像头 ≤640×480/30 ── 固定右下角 ──┴─ 本地原生合成 → Remote Meeting Camera → 钉钉
远端网页 ── HTTPS/WSS：登录、开关、缩放、位置 ── 本地服务
OBS ── 自己的场景 ── OBS Virtual Camera（独立设备）
```

本地和远端网页都不申请摄像头或麦克风，不显示摄像头画面，不创建 WebRTC 连接，不传输音视频帧。云端仅处理账号、控制连接和少量状态 JSON。页面同时通过 Permissions-Policy 禁用摄像头和麦克风权限。

## 使用

1. 本机保持开机、联网、已登录 Windows 且不休眠。启动常驻程序后默认显示人员配置；本地也可切换摄像头视图，手动开启输出。
2. 远端使用账号和密钥登录，控制面板自动连接主机并启动虚拟摄像头，最多两位远端同时控制。
3. 在本地钉钉会议的摄像头设置中选择 **Remote Meeting Camera Windows Virtual Camera**，麦克风在钉钉中另行选择。新增设备后，已经打开的会议软件可能需要重新启动以刷新列表。
4. 用方向按钮、＋ / −、全景复位、缩放滑块或定位框控制 USB 的 1–8× 数字缩放及裁剪位置。两位远端同步显示控制状态，笔记本画中画保持固定。
5. 在本地或远端点击“关闭摄像头”，停止原生进程并释放两路原摄像头，其他软件可直接使用原设备。启动中可在本地取消。
6. 远端离开、控制连接短暂中断、暂停远端控制或重新打开本地控制窗口，已有虚拟输出继续保持。明确关闭后，同一个控制会话刷新或断线重连不会自行重启；新登录并建立的新控制会话会自动启动。

**Remote Meeting Camera** 使用 Windows 11 的 [MFCreateVirtualCamera](https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/nf-mfvirtualcamera-mfcreatevirtualcamera) 注册原生软件摄像头。Windows 自动为名称添加 **Windows Virtual Camera** 后缀。自己的媒体源由 Windows Frame Server 加载，提供 NV12 / YUY2，支持 Media Foundation、WinRT 和 DirectShow 的系统枚举路径。设备对当前桌面用户发布，并持久保留；停止本地采集时输出黑帧并释放原摄像头。OBS 的设备仍独立。

## 本地采集与性能

- 默认合成输出 1920×1080 / 30 fps；USB 采集上限为 1920×1080 / 30，笔记本上限为 640×480 / 30，拒绝驱动返回更大的采集尺寸。
- OpenCV / DirectShow 采集，每只摄像头只保留最新一帧；原生 NumPy / OpenCV 合成后转换为 NV12，写入受 ACL 保护的本机最新帧文件映射，由 Windows Frame Server 只读采样。没有浏览器画布、浏览器编码或 WebSocket 图像搬运。
- 输出采用绝对时间节拍，目标及生产上限为 30 fps；状态中的 `virtualCamera.measuredFps` 是实际送帧速率，受硬件负载影响。
- USB 和画中画按比例裁剪，不拉伸。画中画宽约 26%，右、下边距约 2%。数字变焦不增加传感器细节。
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

配置：`serverUrl` 为云端 `/meeting/` 地址；`agentKey` 与云端 `HOST_AGENT_KEY` 相同；`output` 默认 `{ "width": 1920, "fps": 30 }`；`virtualCamera.enabled` 默认 true，`pythonPath` 默认 `.local/virtual-camera/Scripts/python.exe`；`headless: false` 显示控制窗口。旧的 microphone / idleMs 字段不再使用。

当前用户登录后自动启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File host/install.ps1
```

安装器创建当前用户 Startup 目录的 `Remote Meeting Host.lnk`。隐藏监督进程运行本地服务，意外退出后恢复；本地可见窗口只负责控制和人员配置，关闭窗口不会中断原生输出，窗口会自动恢复。

本地监听 `127.0.0.1:3034`；检查 `http://127.0.0.1:3034/api/status`，日志 `.local/host.log`。暂停按钮仅暂停远端控制。取消自动启动时仅删除本服务的专用快捷方式。

## 云端部署

复用阿里云 Nginx、HTTPS 域名和证书，地址为 `https://home.sunny-string.cn/meeting/`。云端 Node 仅监听 `127.0.0.1:3033`，本机主动建立 WSS 控制连接，无需对 Windows 开放入站端口。无需 STUN、TURN 或媒体中继。

```sh
git archive --format=tar.gz --output=release.tar.gz HEAD
scp release.tar.gz aliyun-remote-meeting:/tmp/remote-meeting-release.tar.gz
ssh -T aliyun-remote-meeting 'mkdir -p /opt/remote-meeting/releases/<sha>; tar -xzf /tmp/remote-meeting-release.tar.gz -C /opt/remote-meeting/releases/<sha>; bash /opt/remote-meeting/releases/<sha>/deploy/install.sh'
```

部署只更新 `remote-meeting` 服务和已有 HTTPS 站点的 `/meeting/` include。配置 `/etc/remote-meeting.env` 仅 root 可读；账号文件 `/var/lib/remote-meeting/users.json` 位于发布目录外。`/opt/remote-meeting/current` 指向已提交版本，旧发布保留，健康检查失败会回滚。

发布重启云端会使内存登录与控制连接失效，远端重新登录即可。本机主动重连，原生虚拟输出不依赖云端连接。健康接口返回 `{"status":"ok","mode":"control-only"}`。

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

可用 `BROWSER_PATH` 指定已安装 Edge。默认浏览器回归禁止并记录摄像头 / 麦克风枚举、采集与 PeerConnection，验证纯 JSON 控制、自动启动、两位远端同步、重连、失败重试、关闭及账号权限。UI 回归覆盖桌面、320 / 390 px 手机布局、方向 / 缩放 / 复位及草稿保留，截图仅保存到忽略的 `test-results/`。

原生单元测试验证设备选择、实际合成像素、固定画中画、裁剪边界和失败释放。Media Foundation 验收跨进程检查六种格式、送帧与过期黑帧，驱动验收使用颜色测试源，由独立本地接收程序读取 Remote Meeting Camera，验证 1080p/30 模式及实际控制效果。硬件验收会开启真实 USB 和 Surface，检查实际采集尺寸及帧率、本地关闭后另一程序重新打开两只原设备；不保存或上传真实摄像头画面。

## SSH / Codex

SSH 别名 `aliyun-remote-meeting`，自动化使用 `ssh -T` 避开交互式 Shell。SSH 私钥、机器凭据、登录密钥和 `.local/host.json` 不进入 Git。

所有开发变更直接提交并推送 `main`，云端部署使用已提交版本。

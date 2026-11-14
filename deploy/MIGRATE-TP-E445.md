# tp-e445 运行与维护交接

目标工作目录：`C:\Users\syw91\Code\remote-meeting`。源工作目录：
`C:\Users\junte\Code\remote-meeting`。迁移时保留目标已有文件和源端未提交修改。

## 系统组成

- tp-e445 接替 Surface 的 Windows 现场端：`host/index.js`、原生 Python
  WebRTC 采集、摄像头/麦克风、本地控制窗口和登录启动监督程序。
- 现有公网入口为 `https://home.sunny-string.cn/meeting/`，139 云端继续承担
  HTTPS/WSS、账号、信令和 TURN。云端部署资料随包交接，由新机器维护。
- Windows 控制台只监听 `127.0.0.1:3034`；云端 Node 只监听
  `127.0.0.1:3033`。两者不是同一个进程，不应把 Linux systemd 安装脚本
  直接运行在 Windows 上。
- 云端账号保存在 `/var/lib/remote-meeting/users.json`，运行配置在
  `/etc/remote-meeting.env`，不随 Git 发布覆盖。

## 接包与 Git

1. 下载后先核对父会话给出的 SHA-256。139 临时链接在下次北京时间凌晨
   04:00 过期。敏感配置与整个迁移归档经过加密；密钥由父会话另行传递，
   不写入 Git、日志或文档。
2. 使用包内指定的解密格式，将归档解到项目外的暂存目录，再检查清单和
   文件哈希。拒绝包含绝对路径或 `..` 越界路径的归档。
3. `repository.bundle` 包含已提交的 main 及历史。先运行
   `git bundle verify <bundle>`，再从 bundle 克隆到暂存目录，核对 main
   提交和工作树，再放入目标项目。不得覆盖目标 `.local` 或其他已有文件。
4. 将 origin 设置为 `https://github.com/string1225/remote-meeting.git`，
   获取远端 main，并核对与包内版本的祖先关系。写入认证使用目标机器的
   现有凭据或本仓库专用 deploy key，避免复制个人通用 Git 凭据。
5. 包中的 `local-changes-reference` 是源机器在迁移前已经存在的未提交
   修改，仅作交接参考；不得自动应用、提交或部署。

## Windows 环境和配置

1. 安装 Node.js 22+、Python 3.12 x64、Git，以及 Edge/Chrome。用户级便携
   安装可以使用，记录真实路径。运行 `npm ci --no-audit --no-fund`。
2. 用实际 Python 创建 `.local/virtual-camera`，运行
   `.local/virtual-camera/Scripts/python.exe -m pip install -r host/rtc-requirements.txt`。
   原生采集模式不需要安装旧的虚拟摄像头驱动，也不需要 OBS。
3. 从加密状态包恢复 `.local/host.json`，保留 `serverUrl`、`agentKey`；更新
   `nodePath`、`browserPath`，必要时设置 `rtc.pythonPath`。不要照搬 Surface
   摄像头名称。重新枚举并设置目标摄像头和麦克风；迁移的 `devices.json`
   也必须核对。`video.json` 可恢复原画质选择。
4. 先运行 `npm run check` 和 `npm test`。检查 Python 依赖可导入并确认
   Node/浏览器路径，安装启动项时使用 `host/install.ps1 -NoStart`。
5. 现场服务和有声浏览器应在已登录的 Windows 桌面用户会话中启动。
   服务账号或 Session 0 不能证明设备和有声播放可用。
   `remote-agent` 后台可能使用 `LOCAL SERVICE`；目录写权限不等于桌面、
   用户进程或 GitHub 写权限。无法停止源进程或启动目标桌面时，应交由
   已登录用户运行已准备的脚本，不重复执行被 Windows 拒绝的操作。

## 媒体网络与切换

云端历史 FRP 配置为 `frp-sea.com:33574/UDP` 转到源机器
`192.168.31.150:20000/UDP`，应以实时配置为准。tp-e445 预检地址为
以太网 `192.168.31.106` 和 WLAN `192.168.31.171`。旧映射不能直接沿用。

优先核对并调整本项目的 UDP 映射、目标地址和 Windows 20000/UDP 入站权限。
如果无法接管 FRP，可在备份云端 env 后移除 `HOST_MEDIA_UDP_ADDRESS`
使现场媒体恢复项目已有的认证 TURN 模式；保留 `TURN_SECRET`、`TURN_URLS`
和 `ICE_TRANSPORT_POLICY=relay`，重启项目专用服务并验证双向媒体。
不要把一个指向旧机器的 UDP 地址当成迁移成功。

云端只允许一个现场端注册。按以下顺序切换：

1. 新机器完成安装、配置、静态检查和设备枚举，不提前启动现场端。
2. 源机器记录启动项、现场端/监督程序的 PID 与所属用户，停用
   `Remote Meeting Host.lnk` 并关闭本项目监督程序、现场端和其子进程。
   必须核实进程归属；保留可恢复副本，不结束不相关的 Node/Python/浏览器。
3. 确认旧现场端不再注册、不会被监督程序或登录启动项重新拉起。
4. 在新机器的桌面用户会话启动 `host/run.ps1`，检查本地 `/api/status`
   的 `online`、`renderer`、`cloudConnection.state=registered`，确认没有
   409 冲突，并核对云端看到的新现场身份。
5. 验证设备枚举、画质切换、手动摄像头/麦克风开关、真实媒体解码与声音、
   远端返回声音、双观看者、断线重连和再次登录启动。真实采集验证后关闭设备。
6. 分别记录已完成验证与未完成的真实设备/公网测试。健康接口可用不能
   代替媒体验证。验证通过后安装/启用新机器登录启动项。

## 云端发布和回退

云端实际发布与服务快照另见加密部署包。代码发布使用已提交 main 的
`git archive`，通过现有部署通道传到
`/opt/remote-meeting/releases/<commit>`，保留 `current` 的旧指向。
现有 139 的实际 TLS/Nginx 配置包含仓库安装脚本尚未收录的修复；本次
迁移不能直接重跑 `deploy/install.sh` 或 `deploy/install-tls.sh` 覆盖它。
新建环境须先依照部署快照中的重建手册对齐配置，再评估安装脚本。

只更新代码时复用已验证的生产依赖，先以 `remote-meeting` 服务用户确认
release 目录可遍历、入口和依赖可读，再切换 `current`。仅文档变更且
运行源码字节一致时可不重启；重启前必须核实新 release 的读取权限。
切换媒体配置时只备份并修改必要的 env 项，只重启项目主服务，保留
`remote-meeting-turn`、`remote-meeting-tls` 和共享 Nginx。验证服务、
公网 HTTPS 和实际媒体；涉及 Nginx 时另运行 `nginx -t`。不要覆盖其他
站点、全机凭据或其他项目服务。

若目标失败，先停止目标现场端以释放云端单现场注册，再恢复源启动项和
已核实的源端启动方式；如果改过 FRP/TURN 环境，则还原对应备份。保留账号、
密钥与此前 release。迁移包、解密密钥、运行状态文件均不进入 Git。

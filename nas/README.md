# QNAP NAS 远程开机

139 的 meeting 网页 → NAS 主动发起的 HTTPS 长轮询 → 家中 UDP 9 广播。
NAS 不监听端口，不需要公网 IP、路由器端口转发或 NAS 管理界面的外网访问。
所有已登录的 meeting 账号都可操作，电脑关机、会议主机离线时仍可使用。

已确认 NAS：QNAP TS-551（linux/amd64），192.168.31.200。

| 电脑 | IP | 容器变量 | 当前配置 |
| --- | --- | --- | --- |
| 地下室大电脑 | 192.168.31.100 | WOL_BASEMENT_MAC | 22-18-4D-11-5D-C0，已确认有线网卡 |
| 小房间电脑（tp-e445） | 192.168.31.250 | WOL_SMALL_ROOM_MAC | B8-88-E3-F9-AD-19，用户已确认有线网卡 |

## 导入与运行

推荐使用 `meeting-wol-qnap-1.1.1.tar`：由 Docker 20.10 原生导出的未压缩**镜像**归档，保留 NAS 导入检查使用的 `repositories`、每层 `json` 与 `VERSION`，同时含现代 `manifest.json`。
在 Container Station 的“镜像 / Images → 导入”选择这个文件，然后从 `remote-meeting-wol:1.1.1` 创建容器；它不包含容器运行配置，不能用来恢复容器。
旧版 `remote-meeting-wol-amd64.tar.gz` 虽可由 Docker 加载，但缺少部分旧格式元数据，可能被 Container Station 的预检查拒绝，请改用兼容版 `.tar`。

创建容器设置：

- 名称：`meeting-wol`，重启策略：`unless-stopped`（或“始终重启”）。
- 网络：**Host / 主机网络**，不映射任何端口；Bridge/NAT 网络通常不能广播到物理局域网。
- 环境变量：填写随包的 `container-settings.txt`，其中 `WOL_AGENT_KEY` 是本次配套凭据，请妥善保存。
- 不需要挂载目录，也不需要特权模式。可启用只读根文件系统、删除全部 capabilities。

通过 SSH 管理 NAS 的等效操作（先上传镜像和配置，不在终端中粘贴密钥）：

```sh
docker load -i meeting-wol-qnap-1.1.1.tar
chmod 600 .env
docker compose -f compose.yaml up -d
docker logs --tail 30 meeting-wol
```

若 Container Station 版本没有 Compose 命令，可在“应用程序 / Applications”创建应用，使用 `compose.yaml` 并把环境变量填入应用；也可直接用创建容器向导。
容器启动后，登录 https://home.sunny-string.cn/meeting/ ，在“家里电脑开机”看到 NAS 在线，点击地下室大电脑的“开机”。
回执表示 NAS 已发送 3 个标准 Magic Packet，不表示已经检测到电脑开机。每台电脑 30 秒内只接受一次请求。

## 查看电脑在线状态

1.1.1 容器支持独立的状态检查。网页登录、打开已登录的页面或整页刷新时，自动让 NAS 检查两台固定 IP；“刷新状态”按钮重新检查，并显示检查时间。
状态检查不依赖 WOL 的 MAC 配置。小房间检查 tp-e445 的 192.168.31.250，地下室仍检查 192.168.31.100。
1.1.1 容器会同时报告实际检查的地址；云端只接受与网页目标一致的结果，避免把旧 Surface 的 192.168.31.150 在线状态误当成新电脑在线。

- **在线**：收到 ICMP 回复，或 Windows 常用端口（445、135、3389）接受/拒绝了 TCP 连接，说明该 IP 有响应。
- **未响应**：在限定时间内没有响应，可能是关机、断网或防火墙拦截；不把它当作确定关机。
- **状态未知/状态已过期**：尚未检查、NAS 离线、检查失败或结果已超过 90 秒。旧结果的检查时间会保留。

NAS 并行检查两台电脑，先使用 Linux 无特权 ICMP，再使用有限时的 TCP 探测；不需要 root 或 NET_RAW 权限。
发送开机信号后，网页等待 20 秒再自动检查一次。定时读取页面状态只读取缓存，不会持续扫描局域网。
1.0.0、1.1.0 容器仍可发送开机信号，但新网页不会接受其旧地址检查结果，会提示升级到 1.1.1。导入 1.1.1 镜像后，保留原有环境变量和 Host 网络，将 `WOL_SMALL_ROOM_MAC` 设为 `B8-88-E3-F9-AD-19`，重建 `meeting-wol` 容器；只运行一个版本，避免两个代理争用连接。

## Windows 与硬件设置

1. 地下室电脑保持插电、插网线；BIOS/UEFI 开启 Wake on LAN / Power on by PCI-E，关闭会切断网卡待机供电的 ErP / Deep Sleep。
2. Windows 有线网卡的“高级”开启 Wake on Magic Packet、Shutdown Wake-on-LAN（若有）；“电源管理”允许此设备唤醒计算机，仅允许魔术封包唤醒。
3. 若关机不能唤醒而睡眠可以，检查快速启动、网卡驱动与固件的 S5 支持。需要改变电源选项时在电脑上按实际情况设置。
4. 第一次从睡眠开始测试，再测试关机；关机后网口指示灯/待机供电应保留。代理和网页不能补足硬件本身缺少的唤醒能力。

小房间现为 tp-e445，用户确认已插电并接有线网线，MAC 为 `B8-88-E3-F9-AD-19`。该机正常关机后的实际唤醒仍待验证；NAS 发包回执和状态检查地址修正均不能证明关机/S5 唤醒已成功。需要按上面的 BIOS、网卡和待机供电步骤核对。

## 构建与凭据

标准 Docker 构建与导出：

```sh
docker build --platform linux/amd64 -t remote-meeting-wol:1.1.1 nas
docker save --output meeting-wol-qnap-1.1.1.tar remote-meeting-wol:1.1.1
```

没有 Docker 的工作站也可运行 `python nas/build-image.py --output /绝对路径/meeting-wol-compatible.tar`；脚本生成含完整旧格式元数据的 USTAR 镜像归档，输出 `.tar.gz` 或 `.tgz` 时才启用 gzip 压缩。
构建脚本从 Docker 官方 Python 镜像下载 amd64 层，逐层校验压缩及解压 SHA-256，再生成 Docker load 归档和校验清单。Docker Hub 连接受限时，加上 `--registry ecr` 使用 Docker 官方镜像的 Amazon ECR 公共镜像源。
清单记录不可变的基础 manifest digest；重建时可用 `--base sha256:...` 固定它。
镜像中没有 NAS 凭据；`.env`、`container-settings.txt` 不能提交到 Git 或公开下载。

服务器 `/etc/remote-meeting.env` 的 `WOL_AGENT_KEY` 必须与 NAS 相同，且与 `HOST_AGENT_KEY` 独立；配置后重启 `remote-meeting`。
NAS 凭据只能轮询/确认两个固定目标的唤醒和状态检查指令，不能登录网页、操作账号或摄像头。网页使用既有会话、同源检查和限流；并发状态检查共享一次 NAS 探测。
离线或超时的请求不会持久化，NAS 恢复后不会补执行旧的开机指令。NAS 与服务器的系统时间应正确同步。

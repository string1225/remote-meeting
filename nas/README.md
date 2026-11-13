# QNAP NAS 远程开机

139 的 meeting 网页 → NAS 主动发起的 HTTPS 长轮询 → 家中 UDP 9 广播。
NAS 不监听端口，不需要公网 IP、路由器端口转发或 NAS 管理界面的外网访问。
所有已登录的 meeting 账号都可操作，电脑关机、会议主机离线时仍可使用。

已确认 NAS：QNAP TS-551（linux/amd64），192.168.31.200。

| 电脑 | IP | 容器变量 | 当前配置 |
| --- | --- | --- | --- |
| 地下室大电脑 | 192.168.31.100 | WOL_BASEMENT_MAC | 22-18-4D-11-5D-C0，已确认有线网卡 |
| 小房间电脑 | 192.168.31.150 | WOL_SMALL_ROOM_MAC | 留空，等安装支持唤醒的有线网卡 |

## 导入与运行

提供的 `remote-meeting-wol-amd64.tar.gz` 是 Docker **镜像**归档，等同于 `docker save` 后压缩，不能当作容器文件系统导入。
在 Container Station 的“镜像 / Images → 导入”选择这个文件，然后从 `remote-meeting-wol:1.0.0` 创建容器。
如果当前界面的“导入容器”只接受 `docker export` 格式，请切换到“镜像”导入；格式扩展名相同但内容不同。

创建容器设置：

- 名称：`meeting-wol`，重启策略：`unless-stopped`（或“始终重启”）。
- 网络：**Host / 主机网络**，不映射任何端口；Bridge/NAT 网络通常不能广播到物理局域网。
- 环境变量：填写随包的 `container-settings.txt`，其中 `WOL_AGENT_KEY` 是本次配套凭据，请妥善保存。
- 不需要挂载目录，也不需要特权模式。可启用只读根文件系统、删除全部 capabilities。

通过 SSH 管理 NAS 的等效操作（先上传镜像和配置，不在终端中粘贴密钥）：

```sh
docker load -i remote-meeting-wol-amd64.tar.gz
chmod 600 .env
docker compose -f compose.yaml up -d
docker logs --tail 30 meeting-wol
```

若 Container Station 版本没有 Compose 命令，可在“应用程序 / Applications”创建应用，使用 `compose.yaml` 并把环境变量填入应用；也可直接用创建容器向导。
容器启动后，登录 https://home.sunny-string.cn/meeting/ ，在“家里电脑开机”看到 NAS 在线，点击地下室大电脑的“开机”。
回执表示 NAS 已发送 3 个标准 Magic Packet，不表示已经检测到电脑开机。每台电脑 30 秒内只接受一次请求。

## Windows 与硬件设置

1. 地下室电脑保持插电、插网线；BIOS/UEFI 开启 Wake on LAN / Power on by PCI-E，关闭会切断网卡待机供电的 ErP / Deep Sleep。
2. Windows 有线网卡的“高级”开启 Wake on Magic Packet、Shutdown Wake-on-LAN（若有）；“电源管理”允许此设备唤醒计算机，仅允许魔术封包唤醒。
3. 若关机不能唤醒而睡眠可以，检查快速启动、网卡驱动与固件的 S5 支持。需要改变电源选项时在电脑上按实际情况设置。
4. 第一次从睡眠开始测试，再测试关机；关机后网口指示灯/待机供电应保留。代理和网页不能补足硬件本身缺少的唤醒能力。

小房间当前是 Surface 的 Intel Wi-Fi 网卡，未检测到可编程的唤醒设备，不能直接假设支持关机 WOL。
USB 网卡需要该网卡、USB 待机供电及电脑固件共同支持；很多型号只支持睡眠唤醒。选购时核实**这台电脑的关机/S5 唤醒**兼容性，而不只看“支持 WOL”。
接好后，把其有线网卡 MAC 填入 `WOL_SMALL_ROOM_MAC` 并重建容器，网页入口自动可用。Wi-Fi 的 MAC 不可代替有线网卡 MAC。

## 构建与凭据

标准 Docker 构建与导出：

```sh
docker build --platform linux/amd64 -t remote-meeting-wol:1.0.0 nas
docker save remote-meeting-wol:1.0.0 | gzip > remote-meeting-wol-amd64.tar.gz
```

没有 Docker 的工作站也可运行 `python nas/build-image.py --output /绝对路径/remote-meeting-wol-amd64.tar.gz`。
构建脚本从 Docker 官方 Python 镜像下载 amd64 层，逐层校验压缩及解压 SHA-256，再生成 Docker load 归档和校验清单。Docker Hub 连接受限时，加上 `--registry ecr` 使用 Docker 官方镜像的 Amazon ECR 公共镜像源。
清单记录不可变的基础 manifest digest；重建时可用 `--base sha256:...` 固定它。
镜像中没有 NAS 凭据；`.env`、`container-settings.txt` 不能提交到 Git 或公开下载。

服务器 `/etc/remote-meeting.env` 的 `WOL_AGENT_KEY` 必须与 NAS 相同，且与 `HOST_AGENT_KEY` 独立；配置后重启 `remote-meeting`。
NAS 凭据只能轮询/确认两个固定目标的唤醒指令，不能登录网页、操作账号或摄像头。网页使用既有会话、同源检查和限流。
离线或超时的请求不会持久化，NAS 恢复后不会补执行旧的开机指令。NAS 与服务器的系统时间应正确同步。

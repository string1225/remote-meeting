# 同屏 · 三方远程会议

一台现场电脑使用两个摄像头和一个麦克风，两位远端通过浏览器参会。远端也可以发送摄像头 / 麦克风，或选择旁听。阿里云仅提供 HTTPS 网页和 WSS 信令，音视频由三台浏览器之间的 WebRTC mesh 传输。

```text
现场 Windows 电脑（双摄 + 麦克风）
       ⇅ WebRTC             ⇅ WebRTC
远端浏览器 A  ⇄ WebRTC ⇄  远端浏览器 B
       ╲         │         ╱
        阿里云 HTTPS / WSS 信令
        （不承载音视频、不录制）
```

## 使用

1. 主持人打开会议网址，输入主持密钥，选择“现场主持 · 双摄像头 + 麦克风”。
2. 点击“授权并检测设备”，选择两个**不同的物理摄像头**和一个麦克风，然后创建会议。
3. 点击“复制邀请链接”，把该链接发给两位伙伴。不要分享浏览器地址栏里的主持人链接。
4. 伙伴打开邀请链接，选择设备或旁听后加入。推荐双方使用耳机避免回声。
5. 右侧状态会显示 P2P 直连 / 独立 TURN、延迟和发送码率。关闭摄像头按钮暂停传输视频内容，离开会议会释放所有设备。
6. 主持人“结束所有人的会议”会使链接立即失效；普通离开可再次使用原链接加入。会议默认有效 8 小时。

现场电脑只需打开同一 HTTPS 网站并授权设备，无须开放入站端口，也无须从云端反向访问 Windows。浏览器必须保持开启、电脑不能休眠。服务器本身无法绕过浏览器权限静默开启摄像头。

## 网络与带宽

- 使用 STUN 发现直连地址。阿里云上的 Node 服务只转发受限的 SDP / ICE JSON，不实现 SFU、MCU、媒体上传或 TURN。
- **只使用 STUN 无法保证在所有 NAT / 防火墙下连通。** 对称 NAT、企业网络或 UDP 封锁可能使 P2P 失败。可换手机热点，或配置独立带宽充足的 TURN 服务。默认不启用 TURN，也不隐式使用阿里云中继。
- 720p 默认每路视频每位接收者上限约 1 Mbps；现场两路视频发给两位远端时，上行预算约 4 Mbps 加音频和协议开销。实际码率随画面和网络变化；可选 360p 或 1080p。
- WebRTC 媒体使用 DTLS-SRTP。信令服务器和邀请链接仍是信任边界；应用未实现独立的对端身份核验或额外的应用层 E2EE。
- 外网采集设备需要 HTTPS，localhost 可在 HTTP 下开发。IP 地址上的普通 HTTP 不能替代 HTTPS 摄像头权限。

## 本地运行

需要 Node.js 22+。

```sh
npm ci
cp .env.example .env
# 用随机值替换 ADMIN_KEY；其余本地默认配置可保留
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npm start
```

打开 `http://localhost:3000/`。Windows 使用 `Copy-Item .env.example .env`。密钥和 `.env` 不提交到 Git。

## 部署到已有 Nginx 主机

部署脚本针对该项目指定的阿里云 Linux 主机，复用现有证书与网站。默认 URL：`https://home.sunny-string.cn/meeting/`。服务仅监听 `127.0.0.1:3033`，外部只需要现有的 TCP 443。

```sh
git archive --format=tar.gz --output=release.tar.gz HEAD
scp release.tar.gz aliyun-remote-meeting:/tmp/remote-meeting-release.tar.gz
# 使用当前提交 SHA 作为 <sha>
ssh aliyun-remote-meeting 'mkdir -p /opt/remote-meeting/releases/<sha>; tar -xzf /tmp/remote-meeting-release.tar.gz -C /opt/remote-meeting/releases/<sha>; bash /opt/remote-meeting/releases/<sha>/deploy/install.sh'
```

- 可用 `SITE_CONFIG`、`PUBLIC_ORIGIN` 环境变量指定已有 HTTPS 站点配置和来源。路径固定为 `/meeting/`。
- 部署创建独立 `remote-meeting` 系统用户、systemd 服务、`/etc/remote-meeting.env` 和 Nginx location include。修改前备份原站点配置，`nginx -t` 通过后才 reload。
- `/opt/remote-meeting/current` 指向当前版本，旧版本保留用于回滚。更新会重启信令服务，内存会议及旧邀请链接会失效，应避开正在进行的会议。
- 查看状态：`systemctl status remote-meeting`；日志：`journalctl -u remote-meeting --since today`；健康检查：`curl http://127.0.0.1:3033/api/health`。
- 只对应用重启：`systemctl restart remote-meeting`。不要停止整台机器的 Nginx 或重置现有 SSH 配置。
- 主持密钥存在服务器 `/etc/remote-meeting.env`，仅 root 可读；丢失时通过 SSH 读取，禁止提交到 Git。

## 可选独立 TURN

在**另一个有足够带宽的服务**配置 coturn `use-auth-secret`，并在应用环境变量中设置相同 `TURN_SECRET` 与 `TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349`。应用为已认证参会者签发有时限的 HMAC 凭据。重启应用后生效。页面会明确显示使用 TURN 的链路；TURN 带宽由独立服务承担。

## 安全边界

会议令牌为 192 位随机值，区分主持人和访客，通过 URL fragment 分享（不会随 HTTP 请求发送给服务器）。WebSocket 加入消息验证令牌，服务端限制同一会议最多 1 主持 + 2 访客，禁止跨房间转发。创建会议需要管理员密钥，并检查 Origin；信令有长度、速率、超时与连接数限制。此版本采用内存会议存储，适合小规模内部会议，不是多实例大规模会议平台。

## 测试

```sh
npm run check
npm test
npx playwright install chromium
npm run test:e2e
```

也可通过 `BROWSER_PATH` 使用已有 Chrome / Edge。端到端测试使用合成的两路摄像头和测试麦克风，在三个隔离浏览器上下文中验证真正的 WebRTC 视频帧 / 音频字节、人数限制、静音、重连、旁听、结束会议与手机布局。截图位于忽略的 `test-results/`。合成设备测试不替代实际两台摄像头和不同外网的验收。

设置 `E2E_BASE_URL` 和 `E2E_ADMIN_KEY` 可运行部署后的同一套端到端测试（会创建并结束一个独立测试会议）。`node test/hardware.mjs` 是主动启用真实设备的本机检查：同时开启两个非红外摄像头和麦克风，确认预览后释放设备，媒体不发送到其他电脑。

本机已验证 PC Camera 与 Surface Camera Front 同时输出 1280×720，默认 PC Camera 麦克风可用。不要选择 Windows Hello 的 Surface IR 红外摄像头。真实外网参会者的 NAT 连通性仍需在各自网络验收。

## SSH / Codex

本机 SSH 别名：`aliyun-remote-meeting`，身份文件位于用户的 `~/.ssh/remote_meeting_aliyun`，不在本仓库。`ssh aliyun-remote-meeting` 可连接；自动化命令用 `ssh -T aliyun-remote-meeting '<command>'` 避开服务器默认交互式 Copilot Shell。

Codex 可从 `~/.ssh/config` 发现具体主机别名。连接设置中启用该 SSH 主机，使用已有身份文件；远端还需要可用的 Codex CLI 及账号认证。不要把 SSH 私钥、root 密码或 Codex 账号凭据加入本仓库。

开发变更直接提交并推送 `main`；部署使用已提交的版本。

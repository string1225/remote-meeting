#!/usr/bin/env bash
# Dedicated authenticated media relay; does not change Nginx or other services.
set -euo pipefail
version=4.18.0
archive_sha=28d55294ac596fbd129b293a85e7bb1c5dc4bd15b7fb55c500f355149e5f4e28
public_ip="${TURN_PUBLIC_IP:-139.224.12.141}"
private_ip="${TURN_PRIVATE_IP:-$(ip -4 -o addr show dev eth0 scope global | awk '{print $4}' | cut -d/ -f1 | head -1)}"
prefix="/opt/remote-meeting/turn/$version"
[[ "$public_ip" =~ ^[0-9.]+$ && "$private_ip" =~ ^[0-9.]+$ ]] || { echo 'Explicit IPv4 relay addresses are required.'; exit 1; }
if [[ ! -x "$prefix/bin/turnserver" ]]; then
  dnf install -y gcc make libevent-devel openssl-devel sqlite-devel
  mkdir -p /opt/remote-meeting/turn/build
  cd /opt/remote-meeting/turn/build
  curl --fail --location --silent --show-error "https://codeload.github.com/coturn/coturn/tar.gz/refs/tags/$version" -o "coturn-$version.tar.gz"
  printf '%s  %s\n' "$archive_sha" "coturn-$version.tar.gz" | sha256sum -c -
  tar -xzf "coturn-$version.tar.gz"
  cd "coturn-$version"
  ./configure --prefix="$prefix"
  make -j2
  make install
fi
id remote-meeting-turn >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /sbin/nologin remote-meeting-turn
install -d -m 750 -o root -g remote-meeting-turn /etc/remote-meeting
TURN_SETUP_PUBLIC="$public_ip" TURN_SETUP_PRIVATE="$private_ip" python3 - <<'PY'
import os, pathlib, secrets, grp
env_path=pathlib.Path('/etc/remote-meeting.env')
lines=env_path.read_text().splitlines()
values=dict(line.split('=',1) for line in lines if '=' in line and not line.startswith('#'))
secret=values.get('TURN_SECRET') or secrets.token_hex(32)
public=os.environ['TURN_SETUP_PUBLIC']; private=os.environ['TURN_SETUP_PRIVATE']
updates={'TURN_URLS':f'turn:{public}:3478?transport=udp,turn:{public}:3478?transport=tcp','TURN_SECRET':secret,'ICE_TRANSPORT_POLICY':'relay','STUN_URLS':''}
lines=[line for line in lines if line.split('=',1)[0] not in updates]
env_path.write_text('\n'.join(lines+[key+'='+value for key,value in updates.items()])+'\n');env_path.chmod(0o600)
config=pathlib.Path('/etc/remote-meeting/turnserver.conf')
config.write_text(f'''listening-port=3478
listening-ip={private}
relay-ip={private}
external-ip={public}/{private}
min-port=50000
max-port=50127
realm=home.sunny-string.cn
fingerprint
use-auth-secret
static-auth-secret={secret}
no-tls
no-tcp-relay
no-multicast-peers
denied-peer-ip=0.0.0.0-255.255.255.255
allowed-peer-ip={public}
allowed-peer-ip={private}
user-quota=12
total-quota=64
max-allocate-lifetime=3600
pidfile=/run/remote-meeting-turn/turn.pid
log-file=stdout
simple-log
''')
os.chown(config,0,grp.getgrnam('remote-meeting-turn').gr_gid);config.chmod(0o640)
PY
cat >/etc/systemd/system/remote-meeting-turn.service <<EOF
[Unit]
Description=Remote Meeting authenticated TURN media relay
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=remote-meeting-turn
Group=remote-meeting-turn
RuntimeDirectory=remote-meeting-turn
ExecStart=$prefix/bin/turnserver -c /etc/remote-meeting/turnserver.conf
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/run/remote-meeting-turn
LimitNOFILE=8192
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable remote-meeting-turn >/dev/null
systemctl restart remote-meeting-turn
systemctl is-active remote-meeting-turn
printf 'TURN configured at %s:3478 TCP/UDP, relay UDP 50000-50127.\n' "$public_ip"

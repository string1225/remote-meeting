#!/usr/bin/env bash
# Keep HTTPS and TURN/TLS on the existing public 443 listener.
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
site_config="${SITE_CONFIG:-/etc/nginx/conf.d/sunny-string.conf}"
tls_host="${TURN_TLS_HOST:-home.sunny-string.cn}"
private_ip="${TURN_PRIVATE_IP:-$(ip -4 -o addr show dev eth0 scope global | awk '{print $4}' | cut -d/ -f1 | head -1)}"
[[ "$tls_host" =~ ^[a-zA-Z0-9.-]+$ && "$private_ip" =~ ^[0-9.]+$ ]] || exit 1
command -v haproxy >/dev/null || dnf install -y haproxy
install -d -m 750 /etc/remote-meeting
bash "$root/deploy/renew-tls.sh"
stamp="$(date +%Y%m%d%H%M%S)"
backup="/opt/remote-meeting/backups/tls443-$stamp"
install -d -m 700 "$backup"
cp -a "$site_config" "$backup/nginx.conf"
was_active=false
if systemctl is-active --quiet remote-meeting-tls; then was_active=true; fi
for file in tls.cfg tls.pem; do
    [[ ! -f /etc/remote-meeting/$file ]] || cp -a "/etc/remote-meeting/$file" "$backup/$file"
done
rollback() {
    result=$?; trap - ERR; set +e
    if [[ "$was_active" != true ]]; then systemctl stop remote-meeting-tls; fi
    cp -a "$backup/nginx.conf" "$site_config"
    for file in tls.cfg tls.pem; do [[ ! -f "$backup/$file" ]] || cp -a "$backup/$file" "/etc/remote-meeting/$file"; done
    if [[ "$was_active" == true ]]; then systemctl reload remote-meeting-tls; fi
    nginx -t && systemctl reload nginx
    echo 'Shared TLS setup failed; prior HTTPS listener/configuration restored.'
    exit "$result"
}
trap rollback ERR
sed -e "s/@TLS_HOST@/$tls_host/g" -e "s/@TURN_PRIVATE_IP@/$private_ip/g" "$root/deploy/remote-meeting-tls.cfg" > /etc/remote-meeting/tls.cfg
haproxy -c -f /etc/remote-meeting/tls.cfg
python3 - "$site_config" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]);s=p.read_text()
if 'listen 127.0.0.1:8443 ssl proxy_protocol;' not in s:
    needle='    listen 443 ssl;'
    if s.count(needle)!=1:raise SystemExit('Expected the existing single HTTPS listener')
    s=s.replace(needle,needle+'\n    listen 127.0.0.1:8443 ssl proxy_protocol;\n    set_real_ip_from 127.0.0.1;\n    real_ip_header proxy_protocol;')
# Preserve the HTTPS server, certificate, routes and original client addresses.
s=re.sub(r'^\s*listen (?:443|\[::\]:443) ssl;\n','\n',s,flags=re.M)
p.write_text(s)
PY
nginx -t
systemctl reload nginx
if [[ "$was_active" != true ]]; then
    for attempt in $(seq 1 30); do
        if ! ss -lntp | grep -E ':443 .*nginx' >/dev/null; then break; fi
        sleep 0.1
    done
fi
install -m 644 "$root/deploy/remote-meeting-tls.service" /etc/systemd/system/remote-meeting-tls.service
systemctl daemon-reload
systemctl enable remote-meeting-tls >/dev/null
if [[ "$was_active" == true ]]; then systemctl reload remote-meeting-tls; else systemctl start remote-meeting-tls; fi
systemctl is-active --quiet remote-meeting-tls
python3 - "$tls_host" <<'PY'
import socket,ssl,sys
host=sys.argv[1]
for alpn in [[],['http/1.1']]:
    context=ssl.create_default_context()
    if alpn:context.set_alpn_protocols(alpn)
    with context.wrap_socket(socket.create_connection(('127.0.0.1',443),5),server_hostname=host) as stream:
        stream.settimeout(10)
        stream.sendall(('GET /meeting/api/health HTTP/1.1\r\nHost: '+host+'\r\nConnection: close\r\n\r\n').encode())
        response=b''
        while True:
            chunk=stream.recv(8192)
            if not chunk:break
            response+=chunk
        if b'"status":"ok"' not in response:raise SystemExit('HTTPS verification failed')
print('HTTPS verified on 443 with and without ALPN.')
PY
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat >/etc/letsencrypt/renewal-hooks/deploy/remote-meeting-tls.sh <<'EOF'
#!/usr/bin/env bash
exec bash /opt/remote-meeting/current/deploy/renew-tls.sh
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/remote-meeting-tls.sh
trap - ERR
printf 'HTTPS and TURN/TLS share %s:443; Nginx upstream is loopback-only.\n' "$tls_host"

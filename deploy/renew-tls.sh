#!/usr/bin/env bash
# Certbot deploy hook and installation helper; never prints key material.
set -euo pipefail
site_config="${SITE_CONFIG:-/etc/nginx/conf.d/sunny-string.conf}"
python3 - "$site_config" <<'PY'
import os,pathlib,re,sys
text=pathlib.Path(sys.argv[1]).read_text()
paths=[]
for name in ['ssl_certificate','ssl_certificate_key']:
    matches=re.findall(r'^\s*'+name+r'\s+([^;]+);',text,re.M)
    if len(matches)!=1:raise SystemExit('Expected one existing HTTPS certificate')
    paths.append(pathlib.Path(matches[0].strip().strip('"\'')))
target=pathlib.Path('/etc/remote-meeting/tls.pem')
temp=target.with_suffix('.pem.new')
fd=os.open(temp,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
with os.fdopen(fd,'wb') as stream:
    for path in paths:stream.write(path.read_bytes()+b'\n')
os.chmod(temp,0o600)
os.replace(temp,target)
PY
if systemctl is-active --quiet remote-meeting-tls; then
    /usr/sbin/haproxy -c -f /etc/remote-meeting/tls.cfg
    systemctl reload remote-meeting-tls
fi

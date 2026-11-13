export function initWakeControls(accounts, notify) {
  const panel = document.getElementById('wake-panel'), status = document.getElementById('wake-status'), list = document.getElementById('wake-targets');
  const base = new URL('./', location.href);
  let generation = 0, refreshing = false;
  const sending = new Set();
  async function api(path, method = 'GET') {
    const response = await fetch(new URL('api/wol' + path, base), { method, signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || '唤醒服务暂不可用'), { status: response.status });
    return data;
  }
  async function refresh() {
    if (!accounts.current() || refreshing) return;
    const current = generation; refreshing = true;
    try {
      const data = await api('');
      if (current !== generation) return;
      status.textContent = !data.enabled ? '等待配置 NAS 唤醒服务' : data.online ? 'NAS 唤醒服务在线' : 'NAS 唤醒服务离线 · 请启动容器';
      list.replaceChildren(...data.targets.map(target => {
        const row = document.createElement('div'); row.className = 'wake-target';
        const info = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p');
        title.textContent = target.name;
        detail.className = 'hint';
        detail.textContent = target.ip + (target.configured ? ' · 有线网卡已配置' : ' · 等待配置有线网卡');
        if (target.lastSentAt) detail.textContent += ' · 上次发包 ' + new Date(target.lastSentAt).toLocaleTimeString('zh-CN');
        info.append(title, detail);
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.dataset.target = target.id;
        button.textContent = sending.has(target.id) || target.pending ? '正在发送…' : '开机';
        button.disabled = !data.online || !target.configured || target.pending || sending.has(target.id);
        button.setAttribute('aria-label', '唤醒' + target.name);
        button.onclick = async () => {
          sending.add(target.id); button.disabled = true; button.textContent = '正在发送…';
          try {
            await api('/' + target.id + '/wake', 'POST');
            if (current === generation) notify(target.name + '：NAS 已发送唤醒信号，请等待电脑启动。');
          } catch (error) { if (current === generation) notify(error.message, true); }
          finally { sending.delete(target.id); void refresh(); }
        };
        row.append(info, button); return row;
      }));
    } catch (error) {
      if (current === generation) { status.textContent = '读取唤醒服务失败，请稍后重试'; list.querySelectorAll('button').forEach(button => { button.disabled = true; }); }
      if (error.status === 401) void accounts.refresh();
    } finally { refreshing = false; }
  }
  document.addEventListener('account-change', () => {
    generation++; panel.hidden = !accounts.current(); list.replaceChildren();
    status.textContent = '正在读取 NAS 状态…';
    if (accounts.current()) void refresh();
  });
  const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
  window.addEventListener('pagehide', () => { generation++; clearInterval(timer); });
}

export function initWakeControls(accounts, notify) {
  const panel = document.getElementById('wake-panel'), status = document.getElementById('wake-status'), list = document.getElementById('wake-targets'), refreshButton = document.getElementById('wake-refresh');
  const base = new URL('./', location.href);
  let generation = 0, refreshingFor, checkingFor, snapshot, accountId, checkWhenOnline = false, bootTimer;
  const sending = new Set();
  async function api(path, method = 'GET') {
    const response = await fetch(new URL('api/wol' + path, base), { method, signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || '唤醒服务暂不可用'), { status: response.status });
    return data;
  }
  function render(data) {
    snapshot = data;
    const checking = checkingFor === generation || data.checking;
    refreshButton.disabled = checking;
    refreshButton.textContent = checking ? '正在检查…' : '刷新状态';
    status.textContent = !data.enabled ? '等待配置 NAS 唤醒服务' : !data.online ? 'NAS 唤醒服务离线 · 请启动容器' : !data.canCheck ? 'NAS 在线 · 请升级容器至 1.1.0 以检查状态' : 'NAS 唤醒服务在线';
    list.replaceChildren(...data.targets.map(target => {
      const row = document.createElement('div'); row.className = 'wake-target'; row.dataset.computer = target.id;
      const info = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p'), power = document.createElement('span');
      title.textContent = target.name;
      const state = checking ? 'checking' : target.stale && data.online && data.canCheck ? 'stale' : target.powerState || 'unknown';
      power.className = 'wake-power'; power.dataset.powerState = state; power.setAttribute('role', 'status');
      power.textContent = ({ online: '在线', unreachable: '未响应', unknown: '状态未知', checking: '正在检查…', stale: '状态已过期' })[state];
      detail.className = 'hint';
      detail.textContent = target.ip + (target.configured ? ' · 可远程开机' : ' · 开机网卡未配置');
      if (target.checkedAt) detail.textContent += ' · 检查于 ' + new Date(target.checkedAt).toLocaleTimeString('zh-CN');
      info.append(title, power, detail);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.dataset.target = target.id;
      button.textContent = sending.has(target.id) || target.pending ? '正在发送…' : '开机';
      button.disabled = !data.online || !target.configured || target.pending || sending.has(target.id);
      button.setAttribute('aria-label', '唤醒' + target.name);
      button.onclick = async () => {
        const current = generation;
        sending.add(target.id); button.disabled = true; button.textContent = '正在发送…';
        try {
          await api('/' + target.id + '/wake', 'POST');
          if (current === generation) {
            notify(target.name + '：NAS 已发送唤醒信号，请等待电脑启动。');
            clearTimeout(bootTimer); bootTimer = setTimeout(() => void check(false), 20000);
          }
        } catch (error) { if (current === generation) notify(error.message, true); }
        finally { sending.delete(target.id); if (current === generation) void refresh(); }
      };
      row.append(info, button); return row;
    }));
  }
  async function check(manual = true, data) {
    if (!accounts.current() || checkingFor === generation) return;
    const current = generation; checkingFor = current;
    if (snapshot) render(snapshot);
    try {
      data ||= await api('');
      if (current !== generation) return;
      render(data);
      if (!data.online || !data.canCheck) {
        checkWhenOnline = true;
        if (manual) notify(!data.online ? 'NAS 离线，请启动容器后再刷新状态。' : '请升级 NAS 容器至 1.1.0，以支持电脑状态检查。', true);
        return;
      }
      checkWhenOnline = false;
      const result = await api('/check', 'POST');
      if (current !== generation) return;
      render(result);
      if (manual) notify('已更新两台电脑的状态。');
    } catch (error) {
      if (current === generation) {
        if (snapshot) render({ ...snapshot, checking: false, targets: snapshot.targets.map(target => ({ ...target, powerState: 'unknown', stale: false })) });
        notify(error.name === 'TimeoutError' ? '状态检查超时，请稍后重试。' : error.message, true);
      }
      if (error.status === 401) void accounts.refresh();
    } finally {
      if (current === generation) { checkingFor = undefined; if (snapshot) render(snapshot); }
    }
  }
  async function refresh() {
    if (!accounts.current() || refreshingFor === generation) return;
    const current = generation; refreshingFor = current;
    try {
      const data = await api('');
      if (current !== generation) return;
      render(data);
      if (checkWhenOnline && data.online && data.canCheck) void check(false, data);
    } catch (error) {
      if (current === generation) {
        if (snapshot) render({ ...snapshot, online: false, canCheck: false });
        status.textContent = '读取唤醒服务失败，请稍后重试'; list.querySelectorAll('button').forEach(button => { button.disabled = true; });
      }
      if (error.status === 401) void accounts.refresh();
    } finally { if (refreshingFor === current) refreshingFor = undefined; }
  }
  document.addEventListener('account-change', () => {
    const account = accounts.current();
    if (accountId === account?.id) return;
    accountId = account?.id; generation++; clearTimeout(bootTimer);
    panel.hidden = !account; list.replaceChildren(); snapshot = undefined; checkingFor = undefined;
    checkWhenOnline = !!account; refreshButton.disabled = false; refreshButton.textContent = '刷新状态'; status.textContent = '正在读取 NAS 状态…';
    if (account) void refresh();
  });
  refreshButton.onclick = () => void check();
  const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
  window.addEventListener('pagehide', () => { generation++; clearInterval(timer); clearTimeout(bootTimer); });
}

const $ = id => document.getElementById(id);
const base = new URL('./', location.href);

async function api(path, method = 'GET', data) {
  const response = await fetch(new URL(`api/${path}`, base), { method, headers: data ? { 'Content-Type': 'application/json' } : {}, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || '操作失败，请稍后重试'), { status: response.status });
  return result;
}

export function initAccounts(notify) {
  let account = null, resetId;
  function render() {
    $('login-fields').hidden = !!account;
    $('signed-in').hidden = !account;
    $('manage-users').hidden = account?.role !== 'admin';
    $('account-name').textContent = account ? `${account.displayName} · ${account.username} / ${account.role === 'admin' ? '管理员' : '主持人'}` : '';
  }
  async function loadSession() { account = (await api('session')).user; render(); }
  const ready = loadSession().catch(() => {});
  async function ensureLoggedIn() {
    await ready;
    await loadSession();
    if (account) return account;
    account = (await api('login', 'POST', { username: $('username').value, password: $('admin-key').value })).user;
    $('admin-key').value = '';
    if ($('name').value === '现场主持人') $('name').value = account.displayName;
    render();
    return account;
  }
  $('login').onclick = async () => {
    $('login').disabled = true;
    try { await ensureLoggedIn(); notify('登录成功，可以创建会议。'); }
    catch (error) { notify(error.message, true); }
    finally { $('login').disabled = false; }
  };
  $('logout').onclick = async () => {
    $('logout').disabled = true;
    try { await ready; await api('logout', 'POST'); account = null; render(); notify('已退出登录。'); }
    catch (error) { notify(error.message, true); }
    finally { $('logout').disabled = false; }
  };
  function message(text, error = false) {
    $('users-message').textContent = text;
    $('users-message').className = error ? 'account-error' : 'account-success';
    $('users-message').hidden = false;
  }
  function cancelReset() { resetId = null; $('reset-user-form').reset(); $('reset-user-form').hidden = true; }
  function button(label, action) {
    const element = document.createElement('button');
    element.type = 'button'; element.className = 'secondary'; element.textContent = label; element.dataset.action = action;
    return element;
  }
  async function reloadUsers() {
    const { users } = await api('users');
    $('users-list').replaceChildren(...users.map(user => {
      const row = document.createElement('div'); row.className = 'account-row'; row.dataset.username = user.username;
      const info = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = `${user.displayName} (${user.username})`;
      const detail = document.createElement('small'); detail.textContent = `${user.role === 'admin' ? '管理员' : '主持人'} · ${user.enabled ? '已启用' : '已停用'}${user.id === account.id ? ' · 当前账号' : ''}`;
      info.append(title, detail);
      const actions = document.createElement('div'); actions.className = 'account-actions';
      const reset = button('重置口令', 'reset');
      reset.onclick = () => { resetId = user.id; $('reset-user-title').textContent = `设置 ${user.username} 的新口令`; $('reset-user-form').hidden = false; $('reset-password').value = ''; $('reset-password').focus(); };
      const toggle = button(user.enabled ? '停用' : '启用', 'toggle');
      toggle.onclick = () => {
        if (user.enabled && !confirm(`停用 ${user.username}？该账号的登录和会议将立即失效。`)) return;
        void change(toggle, () => api(`users/${user.id}`, 'PATCH', { enabled: !user.enabled }), user.enabled ? '账号已停用。' : '账号已启用。');
      };
      const remove = button('删除', 'delete'); remove.className = 'text-button';
      remove.onclick = () => {
        if (confirm(`删除账号 ${user.username}？该账号的登录和会议将立即失效。`)) void change(remove, () => api(`users/${user.id}`, 'DELETE'), '账号已删除。');
      };
      actions.append(reset, toggle, remove); row.append(info, actions); return row;
    }));
  }
  async function change(element, operation, success) {
    element.disabled = true;
    try {
      await operation();
      cancelReset();
      await loadSession();
      if (account?.role !== 'admin') { $('users-dialog').close(); notify(`${success}请重新登录。`); }
      else { await reloadUsers(); message(success); }
    } catch (error) { message(error.message, true); }
    finally { element.disabled = false; }
  }
  $('manage-users').onclick = async () => {
    $('manage-users').disabled = true;
    try { await loadSession(); await reloadUsers(); $('users-message').hidden = true; $('users-dialog').showModal(); }
    catch (error) { notify(error.message, true); }
    finally { $('manage-users').disabled = false; }
  };
  $('close-users').onclick = () => $('users-dialog').close();
  $('cancel-reset').onclick = cancelReset;
  $('users-dialog').onclose = () => { cancelReset(); $('create-user-form').reset(); };
  $('create-user-form').onsubmit = event => {
    event.preventDefault();
    void change(event.submitter, async () => {
      await api('users', 'POST', { username: $('new-username').value, displayName: $('new-display-name').value, password: $('new-password').value, role: $('new-role').value });
      $('create-user-form').reset();
    }, '账号已创建，可使用独立口令登录。');
  };
  $('reset-user-form').onsubmit = event => {
    event.preventDefault();
    void change(event.submitter, () => api(`users/${resetId}`, 'PATCH', { password: $('reset-password').value }), '新口令已保存，旧登录和会议已失效。');
  };
  return { ensureLoggedIn };
}

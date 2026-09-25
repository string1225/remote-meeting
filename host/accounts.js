const $ = id => document.getElementById(id);
let editingId = null, busy = false;

async function api(path = '', method = 'GET', data) {
  const response = await fetch(`/api/users${path}`, { method, headers: { 'X-Host-Console': '1', ...(data ? { 'Content-Type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败，请刷新后重试');
  return result;
}
function message(text, error = false) {
  $('access-message').textContent = text;
  $('access-message').className = error ? 'account-error' : 'account-success';
  $('access-message').hidden = !text;
}
function setBusy(value) {
  busy = value;
  $('access-fields').disabled = value;
  $('refresh-accounts').disabled = value;
  for (const button of $('access-list').querySelectorAll('button')) button.disabled = value;
  $('access-list').setAttribute('aria-busy', String(value));
}
function showKey(visible) {
  $('remote-key').type = visible ? 'text' : 'password';
  $('show-key').textContent = visible ? '隐藏密钥' : '显示密钥';
  $('show-key').setAttribute('aria-pressed', String(visible));
}
function resetForm() {
  editingId = null; $('access-form').reset(); showKey(false);
  $('access-form-title').textContent = '新增人员'; $('remote-key-label').textContent = '登录密钥';
  $('remote-key').required = true; $('remote-key').placeholder = '6–128 个字符';
  $('save-account').textContent = '保存并启用'; $('cancel-account').hidden = true;
}
function edit(user) {
  resetForm(); editingId = user.id;
  $('access-form-title').textContent = `编辑人员 · ${user.displayName}`;
  $('remote-name').value = user.displayName; $('remote-username').value = user.username;
  $('remote-key-label').textContent = '新密钥（选填）'; $('remote-key').required = false;
  $('remote-key').placeholder = '留空保留原密钥'; $('save-account').textContent = '保存修改'; $('cancel-account').hidden = false;
  $('remote-name').focus();
}
function button(label, action, handler) {
  const el = document.createElement('button'); el.type = 'button'; el.className = 'secondary'; el.textContent = label;
  el.dataset.action = action; el.onclick = handler; return el;
}
async function reload() {
  const { users, loginUrl } = await api();
  $('access-count').textContent = `(${users.length})`;
  if (loginUrl) { $('remote-login-link').href = loginUrl; $('remote-login-link').textContent = loginUrl; $('remote-login-address').hidden = false; }
  $('access-list').replaceChildren(...users.map(user => {
    const row = document.createElement('div'); row.className = 'account-row'; row.dataset.username = user.username; row.dataset.id = user.id;
    const info = document.createElement('div'), name = document.createElement('strong'), detail = document.createElement('small');
    name.textContent = user.displayName; detail.textContent = `${user.username} · ${user.enabled ? '已启用' : '已停用'}`; info.append(name, detail);
    const actions = document.createElement('div'); actions.className = 'account-actions';
    actions.append(button('编辑', 'edit', () => edit(user)), button(user.enabled ? '停用' : '启用', 'toggle', () => {
      if (!user.enabled || confirm(`停用 ${user.displayName}（${user.username}）？该人员的登录和连接将立即失效。`)) {
        void change(() => api(`/${user.id}`, 'PATCH', { enabled: !user.enabled }), user.enabled ? '人员已停用。' : '人员已启用。', editingId === user.id);
      }
    }), button('删除', 'delete', () => {
      if (confirm(`删除 ${user.displayName}（${user.username}）？该人员的登录和连接将立即失效。`)) void change(() => api(`/${user.id}`, 'DELETE'), '人员已删除。', editingId === user.id);
    }));
    row.append(info, actions); return row;
  }));
  if (!users.length) { const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '尚未配置外部人员，请填写姓名、账号和密钥后保存。'; $('access-list').append(empty); }
}
async function change(operation, success, clearForm = true) {
  if (busy) return; setBusy(true); message('正在保存到云端…');
  try {
    await operation();
    if (clearForm) resetForm();
    try { await reload(); message(success); }
    catch { message(`${success}列表刷新失败，请点击“刷新列表”核对。`, true); }
  } catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
async function refresh() {
  if (busy) return; setBusy(true);
  try { await reload(); message('人员配置已同步，保存的账号和密钥可用于远端登录。'); }
  catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
$('access-form').onsubmit = event => {
  event.preventDefault();
  const data = { displayName: $('remote-name').value.trim(), username: $('remote-username').value.trim() };
  if (!data.displayName) { message('请填写人员姓名。', true); $('remote-name').focus(); return; }
  if (!editingId || $('remote-key').value) data.password = $('remote-key').value;
  // Omit an unchanged username so a name-only edit keeps existing sessions.
  const row = [...$('access-list').children].find(row => row.dataset.username === data.username.toLowerCase());
  const path = editingId ? `/${editingId}` : '', method = editingId ? 'PATCH' : 'POST';
  if (editingId && row?.dataset.id === editingId) delete data.username;
  void change(() => api(path, method, data), editingId ? '修改已保存；如已修改账号或密钥，请将新登录信息告知对应人员。' : '人员已保存并启用，请将账号和密钥告知对应人员。');
};
$('refresh-accounts').onclick = refresh;
$('cancel-account').onclick = resetForm;
$('show-key').onclick = () => showKey($('remote-key').type === 'password');
$('generate-key').onclick = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';
  // Rejection sampling avoids bias while excluding easily confused characters.
  let secret = '';
  while (secret.length < 20) { const bytes = crypto.getRandomValues(new Uint8Array(32)); for (const byte of bytes) if (byte < Math.floor(256 / alphabet.length) * alphabet.length && secret.length < 20) secret += alphabet[byte % alphabet.length]; }
  $('remote-key').value = secret; showKey(true);
};
void refresh();

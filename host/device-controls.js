const $ = id => document.getElementById(id);
let loaded = false, loading = false;
function setDisabled(value) { for (const id of ['device-fields', 'device-mirror-fields', 'save-devices']) $(id).disabled = value; }
function message(text, failed = false) { $('device-message').textContent = text; $('device-message').className = failed ? 'error' : 'hint'; }
function fill(select, entries, chosen) {
  select.replaceChildren(...entries.map(({ value, label }) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option; }));
  if (chosen && !entries.some(e => e.value === chosen)) { const missing = document.createElement('option'); missing.value = chosen; missing.textContent = '未连接 · ' + chosen; select.append(missing); }
  select.value = chosen || '';
}
async function request(path, method = 'GET', data) {
  const response = await fetch(path, { method, headers: { 'X-Host-Console': '1', ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
async function refresh() {
  if (loading) return; loading = true; setDisabled(true); message('正在读取本机设备…');
  try {
    const { devices, settings } = await request('/api/devices');
    const cameras = [{ value: '', label: '自动识别' }, ...devices.cameras.map(name => ({ value: name, label: name }))];
    const configured = settings.cameras.length ? settings.cameras : devices.defaultCameras;
    fill($('main-camera'), cameras, configured[0] || ''); fill($('secondary-camera'), cameras, configured[1] || '');
    fill($('microphone-device'), [{ value: '', label: '跟随系统默认输入' }, ...devices.microphones.map(m => ({ value: m.id, label: `${m.name} · ${m.sampleRate / 1000} kHz / ${m.channels} 声道` }))], settings.microphone);
    $('mirror-main').checked = settings.mirrorMain; $('mirror-secondary').checked = settings.mirrorSecondary;
    loaded = true; message('配置保存在本机文件中，重启后保留。读取列表不会开启设备。');
  } catch (error) { message(error.message, true); }
  finally { loading = false; setDisabled(!loaded); }
}
$('device-settings').addEventListener('toggle', () => { if ($('device-settings').open && !loaded) void refresh(); });
$('refresh-devices').onclick = () => void refresh();
$('device-form').onsubmit = async event => {
  event.preventDefault();
  const cameras = [$('main-camera').value, $('secondary-camera').value];
  if (cameras.some(Boolean) && (!cameras.every(Boolean) || cameras[0] === cameras[1])) { message('请选择两只不同的摄像头，或将两项都设为自动识别。', true); return; }
  setDisabled(true); loading = true; message('正在保存并应用…');
  try {
    const data = await request('/api/devices/config', 'PUT', { cameras: cameras.every(Boolean) ? cameras : [], microphone: $('microphone-device').value, mirrorMain: $('mirror-main').checked, mirrorSecondary: $('mirror-secondary').checked });
    message(data.warning || '设备配置已保存到本机文件；已开启的设备正在应用新配置。关闭的设备保持关闭。', !!data.warning);
  } catch (error) { message(error.message, true); }
  finally { loading = false; setDisabled(false); }
};

import { randomUUID } from 'node:crypto';

export const wakeTargets = Object.freeze([
  { id: 'small-room', name: '小房间电脑', ip: '192.168.31.150' },
  { id: 'basement', name: '地下室大电脑', ip: '192.168.31.100' },
]);
const failure = (status, message) => Object.assign(new Error(message), { status });

// The NAS makes outbound HTTPS requests. Commands exist only while the browser
// is waiting: an offline/reconnected NAS must never execute an old wake request.
export function createWakeBroker({ enabled = false, pollMs = 20000, commandMs = 10000, onlineMs = 45000, cooldownMs = 30000, statusMs = 90000 } = {}) {
  let lastSeen = 0, configured = new Set(), waiter, closed = false, canCheck = false;
  const pending = new Map(), lastSent = new Map(), lastAttempt = new Map(), power = new Map();
  const online = () => enabled && !closed && lastSeen > 0 && Date.now() - lastSeen < onlineMs;
  function deliver() {
    if (!waiter) return;
    const command = [...pending.values()].find(job => !job.delivered);
    if (command) {
      command.delivered = true;
      waiter.finish({ command: { id: command.id, type: command.type, ...(command.target ? { target: command.target } : {}), expiresAt: command.expiresAt } });
    }
  }
  function requireOnline() {
    if (!enabled) throw failure(503, 'NAS 唤醒服务尚未配置');
    if (!online()) throw failure(503, 'NAS 唤醒服务离线，请检查容器是否运行');
  }
  function enqueue(type, target) {
    const id = randomUUID(), expiresAt = Date.now() + commandMs;
    const job = { id, type, target, expiresAt, delivered: false };
    job.promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => job.finish(failure(504, type === 'check' ? '未收到 NAS 状态检查结果，请稍后重试' : '未收到 NAS 发包确认，请检查网络后重试')), commandMs);
      job.finish = (error, result) => {
        clearTimeout(timer); pending.delete(id);
        if (error) {
          if (type === 'check') for (const [target, checked] of power) power.set(target, { ...checked, state: 'unknown' });
          reject(error);
        } else resolve(result);
      };
    });
    pending.set(id, job); deliver(); return job.promise;
  }
  const validStates = states => states && typeof states === 'object' && !Array.isArray(states)
    && Object.keys(states).length === wakeTargets.length && wakeTargets.every(target => ['online', 'unreachable', 'unknown'].includes(states[target.id]));
  const broker = {
    status() {
      const connected = online(), checking = [...pending.values()].some(job => job.type === 'check');
      return { enabled, online: connected, canCheck: connected && canCheck, checking, lastSeen: lastSeen || null, targets: wakeTargets.map(target => {
        const checked = power.get(target.id), fresh = checked && Date.now() - checked.checkedAt < statusMs;
        return { ...target, configured: configured.has(target.id), pending: [...pending.values()].some(job => job.type === 'wake' && job.target === target.id), lastSentAt: lastSent.get(target.id) || null,
          powerState: connected && canCheck && fresh ? checked.state : 'unknown', checkedAt: checked?.checkedAt || null, stale: !!checked && !fresh };
      }) };
    },
    poll(input, res, json) {
      if (closed) throw failure(503, '唤醒服务正在重启');
      if (!Array.isArray(input.configured) || input.configured.some(id => !wakeTargets.some(target => target.id === id))) throw failure(400, '无效的唤醒设备配置');
      if (input.result !== undefined && (!input.result || typeof input.result.id !== 'string' || typeof input.result.ok !== 'boolean')) throw failure(400, '无效的唤醒回执');
      if (input.capabilities !== undefined && (!Array.isArray(input.capabilities) || input.capabilities.some(value => typeof value !== 'string'))) throw failure(400, '无效的 NAS 能力配置');
      if (input.result?.states !== undefined && !validStates(input.result.states)) throw failure(400, '无效的电脑状态');
      if (waiter) throw failure(409, '已有 NAS 正在连接，请只运行一个唤醒容器');
      lastSeen = Date.now(); configured = new Set(input.configured); canCheck = input.capabilities?.includes('status') === true;
      if (input.result) {
        const job = pending.get(input.result.id);
        if (job?.delivered && job.expiresAt > Date.now()) {
          if (!input.result.ok) job.finish(failure(502, job.type === 'check' ? 'NAS 检查电脑状态失败，请稍后重试' : 'NAS 发送唤醒信号失败，请检查容器网络和网卡配置'));
          else if (job.type === 'check') {
            if (!validStates(input.result.states)) job.finish(failure(502, 'NAS 未返回电脑状态，请更新容器'));
            else {
              const checkedAt = Date.now();
              for (const target of wakeTargets) power.set(target.id, { state: input.result.states[target.id], checkedAt });
              job.finish(null, { ok: true });
            }
          } else { lastSent.set(job.target, Date.now()); job.finish(null, { ok: true, target: job.target, sentAt: lastSent.get(job.target) }); }
        }
      }
      let timer;
      const current = { finish(data, respond = true) {
        clearTimeout(timer); res.off('close', onClose);
        if (waiter === current) waiter = undefined;
        if (respond && !res.destroyed) json(res, 200, data);
      } };
      const onClose = () => current.finish(null, false);
      waiter = current; res.once('close', onClose);
      timer = setTimeout(() => current.finish({ command: null }), pollMs);
      deliver();
    },
    wake(target) {
      if (!wakeTargets.some(item => item.id === target)) throw failure(404, '电脑不存在');
      requireOnline();
      if (!configured.has(target)) throw failure(409, '请先在 NAS 容器中配置此电脑的有线网卡 MAC 地址');
      if ([...pending.values()].some(job => job.target === target) || Date.now() - (lastAttempt.get(target) || 0) < cooldownMs) throw failure(429, '此电脑刚刚发送过唤醒请求，请等待 30 秒后再试');
      lastAttempt.set(target, Date.now());
      return enqueue('wake', target);
    },
    async check() {
      requireOnline();
      if (!canCheck) throw failure(409, '请更新 NAS 容器至 1.1.0，以支持电脑状态检查');
      const existing = [...pending.values()].find(job => job.type === 'check');
      await (existing?.promise || enqueue('check'));
      return broker.status();
    },
    shutdown() {
      closed = true; waiter?.finish({ command: null });
      for (const job of pending.values()) job.finish(failure(503, '唤醒服务正在重启，请稍后重试'));
    },
  };
  return broker;
}

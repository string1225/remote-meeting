import { randomUUID } from 'node:crypto';

export const wakeTargets = Object.freeze([
  { id: 'small-room', name: '小房间电脑', ip: '192.168.31.150' },
  { id: 'basement', name: '地下室大电脑', ip: '192.168.31.100' },
]);
const failure = (status, message) => Object.assign(new Error(message), { status });

// The NAS makes outbound HTTPS requests. Commands exist only while the browser
// is waiting: an offline/reconnected NAS must never execute an old wake request.
export function createWakeBroker({ enabled = false, pollMs = 20000, commandMs = 10000, onlineMs = 45000, cooldownMs = 30000 } = {}) {
  let lastSeen = 0, configured = new Set(), waiter, closed = false;
  const pending = new Map(), lastSent = new Map(), lastAttempt = new Map();
  const online = () => enabled && !closed && lastSeen > 0 && Date.now() - lastSeen < onlineMs;
  function deliver() {
    if (!waiter) return;
    const command = [...pending.values()].find(job => !job.delivered);
    if (command) {
      command.delivered = true;
      waiter.finish({ command: { id: command.id, target: command.target, expiresAt: command.expiresAt } });
    }
  }
  return {
    status() {
      return { enabled, online: online(), lastSeen: lastSeen || null, targets: wakeTargets.map(target => ({
        ...target, configured: configured.has(target.id), pending: [...pending.values()].some(job => job.target === target.id), lastSentAt: lastSent.get(target.id) || null,
      })) };
    },
    poll(input, res, json) {
      if (closed) throw failure(503, '唤醒服务正在重启');
      if (!Array.isArray(input.configured) || input.configured.some(id => !wakeTargets.some(target => target.id === id))) throw failure(400, '无效的唤醒设备配置');
      if (input.result !== undefined && (!input.result || typeof input.result.id !== 'string' || typeof input.result.ok !== 'boolean')) throw failure(400, '无效的唤醒回执');
      if (waiter) throw failure(409, '已有 NAS 正在连接，请只运行一个唤醒容器');
      lastSeen = Date.now(); configured = new Set(input.configured);
      if (input.result) {
        const job = pending.get(input.result.id);
        if (job?.delivered) {
          if (input.result.ok) { lastSent.set(job.target, Date.now()); job.finish(null, { ok: true, target: job.target, sentAt: lastSent.get(job.target) }); }
          else job.finish(failure(502, 'NAS 发送唤醒信号失败，请检查容器网络和网卡配置'));
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
      if (!enabled) throw failure(503, 'NAS 唤醒服务尚未配置');
      if (!online()) throw failure(503, 'NAS 唤醒服务离线，请检查容器是否运行');
      if (!configured.has(target)) throw failure(409, '请先在 NAS 容器中配置此电脑的有线网卡 MAC 地址');
      if ([...pending.values()].some(job => job.target === target) || Date.now() - (lastAttempt.get(target) || 0) < cooldownMs) throw failure(429, '此电脑刚刚发送过唤醒请求，请等待 30 秒后再试');
      lastAttempt.set(target, Date.now());
      return new Promise((resolve, reject) => {
        const id = randomUUID(), expiresAt = Date.now() + commandMs;
        const job = { id, target, expiresAt, delivered: false, finish(error, result) {
          clearTimeout(timer); pending.delete(id);
          if (error) reject(error); else resolve(result);
        } };
        const timer = setTimeout(() => job.finish(failure(504, '未收到 NAS 发包确认，请检查网络后重试')), commandMs);
        pending.set(id, job); deliver();
      });
    },
    shutdown() {
      closed = true; waiter?.finish({ command: null });
      for (const job of pending.values()) job.finish(failure(503, '唤醒服务正在重启，请稍后重试'));
    },
  };
}

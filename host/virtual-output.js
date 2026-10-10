export function createVirtualOutput(composite, enabled, onStatus) {
  if (!enabled) { onStatus({ type: 'virtual-camera-state', state: 'disabled' }); return { dispose() {} }; }
  const socket = new WebSocket(`ws://${location.host}/virtual-camera`);
  let available = false, busy = false, disposed = false;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'start', output: composite.settings }));
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'frame-ready') { busy = false; available = true; }
    else { available = message.state === 'ready'; onStatus(message); }
  };
  socket.onclose = () => { available = false; if (!disposed) onStatus({ type: 'virtual-camera-state', state: 'error', message: '系统虚拟摄像头连接中断，请停止后重新启动' }); };
  socket.onerror = () => {};
  const context = composite.canvas.getContext('2d');
  const timer = setInterval(() => {
    if (!available || busy || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 0) return;
    busy = true;
    socket.send(context.getImageData(0, 0, composite.canvas.width, composite.canvas.height).data.buffer);
  }, 1000 / composite.settings.fps);
  return { dispose() { disposed = true; clearInterval(timer); socket.close(); } };
}

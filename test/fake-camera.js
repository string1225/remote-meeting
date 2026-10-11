// Control protocol fixture. Real camera/driver acceptance uses the native worker.
export function createFakeCamera(config, publish) {
  let generation = 0, settings, view;
  const camera = {
    starts: 0, stops: 0, failNext: false,
    async start(output) {
      const token = ++generation; settings = output; camera.starts++;
      publish({ type: 'virtual-camera-state', state: 'starting' });
      await new Promise(resolve => setTimeout(resolve, 80));
      if (generation !== token) return;
      if (camera.failNext) { camera.failNext = false; publish({ type: 'virtual-camera-state', state: 'error', message: '测试摄像头被占用' }); return; }
      publish({ type: 'virtual-camera-state', state: 'ready', device: 'Remote Meeting Camera', cameras: [{ label: 'Synthetic USB', width: 1920, height: 1080, frameRate: 30 }, { label: 'Synthetic Front', width: 640, height: 480, frameRate: 30 }] });
      camera.setView({ zoom: 1, x: 0.5, y: 0.5 });
    },
    setView(next) { view = next; publish({ type: 'viewport-applied', camera: 0, shared: true, ...view, outputWidth: settings.width, outputHeight: settings.height }); return true; },
    async stop() { generation++; camera.stops++; publish({ type: 'virtual-camera-state', state: 'stopping' }); await new Promise(resolve => setTimeout(resolve, 10)); publish({ type: 'virtual-camera-state', state: 'stopped' }); }
  };
  return camera;
}

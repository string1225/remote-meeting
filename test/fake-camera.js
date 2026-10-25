import { createRtcWorker } from '../host/rtc-worker.js';
// Real native WebRTC with synthetic pixels/audio; inject a startup fault once.
export function createFakeCamera(config, publish) {
 const worker = createRtcWorker({ ...config, synthetic: true, encoder: 'libx264' }, publish);
 return { ...worker, get preview() { return worker.preview; }, starts: 0, stops: 0, failNext: false,
  start(output) { this.starts++; if (this.failNext) { this.failNext=false; publish({type:'virtual-camera-state',state:'error',message:'测试摄像头被占用'}); } else worker.start(output); },
  stop() { this.stops++; return worker.stop(); }
 };
}

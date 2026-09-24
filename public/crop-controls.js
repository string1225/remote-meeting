const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function cropControls(video, camera, initial, send) {
  let view = { zoom: 1, x: 0.5, y: 0.5, ...initial }, timer, pending = false, source = { width: 16, height: 9 };
  const panel = document.createElement('div'); panel.className = 'crop-controls'; panel.dataset.camera = camera;
  panel.innerHTML = '<div class="crop-top"><label>放大<input type="range" min="1" max="8" step="0.1"></label><output></output><button type="button" class="secondary">全景复位</button></div><div class="crop-bottom"><div class="crop-map" role="slider" tabindex="0"><div class="crop-region"></div></div><small>拖动画面或点击定位框移动视野</small></div><small class="crop-status">等待主机控制通道…</small>';
  const slider = panel.querySelector('input'), value = panel.querySelector('output'), map = panel.querySelector('.crop-map'), region = panel.querySelector('.crop-region'), status = panel.querySelector('.crop-status');
  slider.setAttribute('aria-label', `摄像头 ${camera + 1} 放大倍率`); map.setAttribute('aria-label', `摄像头 ${camera + 1} 查看区域，方向键移动`);
  function render() {
    const edge = 0.5 / view.zoom; view.x = clamp(view.x, edge, 1 - edge); view.y = clamp(view.y, edge, 1 - edge);
    slider.value = view.zoom; value.value = `${view.zoom.toFixed(1)}×`;
    region.style.width = region.style.height = `${100 / view.zoom}%`; region.style.left = `${(view.x - edge) * 100}%`; region.style.top = `${(view.y - edge) * 100}%`;
    map.setAttribute('aria-valuetext', `${view.zoom.toFixed(1)} 倍，横向 ${Math.round(view.x * 100)}%，纵向 ${Math.round(view.y * 100)}%`);
  }
  function transmit() { pending = false; status.textContent = send({ type: 'viewport', camera, ...view }) ? '正在应用主机裁剪…' : '等待主机控制通道…'; }
  function update() { render(); if (!pending) { pending = true; timer = setTimeout(transmit, 80); } }
  function zoom(next, x = 0.5, y = 0.5) { const z = clamp(next, 1, 8); view.x += (x - 0.5) * (1 / view.zoom - 1 / z); view.y += (y - 0.5) * (1 / view.zoom - 1 / z); view.zoom = z; update(); }
  slider.oninput = () => zoom(Number(slider.value)); panel.querySelector('button').onclick = () => { view = { zoom: 1, x: 0.5, y: 0.5 }; update(); };
  const locate = e => { const r = map.getBoundingClientRect(); view.x = (e.clientX - r.left) / r.width; view.y = (e.clientY - r.top) / r.height; update(); };
  map.onpointerdown = e => { map.setPointerCapture(e.pointerId); locate(e); }; map.onpointermove = e => { if (map.hasPointerCapture(e.pointerId)) locate(e); };
  map.onkeydown = e => { const d = 0.1 / view.zoom; if (e.key === 'ArrowLeft') view.x -= d; else if (e.key === 'ArrowRight') view.x += d; else if (e.key === 'ArrowUp') view.y -= d; else if (e.key === 'ArrowDown') view.y += d; else return; e.preventDefault(); update(); };
  const content = () => { const r = video.getBoundingClientRect(), width = Math.min(r.width, r.height * source.width / source.height), height = width * source.height / source.width; return { width, height, left: r.left + (r.width - width) / 2, top: r.top + (r.height - height) / 2 }; };
  let drag; video.style.touchAction = 'none';
  video.onpointerdown = e => { video.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, view: { ...view } }; };
  video.onpointermove = e => { if (!drag || !video.hasPointerCapture(e.pointerId)) return; const r = content(); view.x = drag.view.x - (e.clientX - drag.x) / r.width / view.zoom; view.y = drag.view.y - (e.clientY - drag.y) / r.height / view.zoom; update(); };
  video.onpointerup = video.onpointercancel = () => { drag = null; };
  const wheel = e => { e.preventDefault(); const r = content(); zoom(view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)); };
  video.addEventListener('wheel', wheel, { passive: false }); render();
  return { element: panel, get view() { return { ...view }; }, resend: transmit,
    applied(m) { source = { width: m.sourceWidth, height: m.sourceHeight }; status.textContent = `主机已裁剪 · 采集 ${source.width} × ${source.height} → 传输 ${m.outputWidth} × ${m.outputHeight} · ${m.zoom.toFixed(1)}×`; },
    dispose() { clearTimeout(timer); video.removeEventListener('wheel', wheel); }
  };
}

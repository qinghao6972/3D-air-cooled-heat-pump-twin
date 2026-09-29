/* =============================================================================
 * main.js — 应用装配：场景 / 模型 / 仿真 / 界面 / 交互 / 渲染循环
 * ========================================================================== */
import * as THREE from 'three';
import {
  WEBGL_OK, createRenderer, createLabelRenderer, createScene,
  buildEnvironment, createLights, createControls, createGround,
} from './scene.js';
import { TwinModel } from './model.js';
import { FlowNetwork } from './flow.js';
import { TwinSim } from './sim.js';
import { UI } from './ui.js';
import { VIEWS, EQUIPMENT, LAYERS } from './config.js';

const GLB = './IndustrialPlantRoom.glb';
const fatal = (msg) => {
  const f = document.querySelector('#fatal');
  f.hidden = false;
  document.querySelector('#fatalMsg').textContent = msg;
  document.querySelector('#loading').style.display = 'none';
  document.title = 'TWIN-ERR ' + String(msg).split('\n')[0];
};
addEventListener('error', (e) => console.error(e.message || e));
window.__ERRORS = [];
window.__FRAMES = 0;
addEventListener('error', (e) => window.__ERRORS.push(String((e.error && e.error.stack) || e.message || e)));
addEventListener('unhandledrejection', (e) => window.__ERRORS.push('unhandled: ' + String((e.reason && e.reason.stack) || e.reason)));

class App {
  constructor() {
    this.canvas = document.querySelector('#gl');
    this.renderer = createRenderer(this.canvas);
    this.labelRenderer = createLabelRenderer();
    this.scene = createScene();
    this.camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 900);
    this.camera.position.set(36, 26, 40);
    this.controls = createControls(this.camera, this.canvas);
    this.scene.environment = buildEnvironment(this.renderer);
    this.lights = createLights(this.scene);
    this.ground = createGround(this.scene);

    this._tPrev = performance.now();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-10, -10);
    this.tween = null;
    this.paused = false;
    this.sim = new TwinSim();
    this.autoRotate = false;
    this._pickAcc = 0;
    this._pendingShadow = true;
  }

  async boot() {
    const ui = new UI(this.sim, null, this);
    this.ui = ui;
    this.flow = new FlowNetwork(this.scene);
    ui.setLoadProgress(0.05);

    const model = new TwinModel(this.scene);
    model.onLabelClick = (id) => this.select(id, true);
    await model.load(GLB, (p) => ui.setLoadProgress(0.05 + p * 0.9));
    this.model = model;
    this.ui.model = model;
    ui.setLoadProgress(1);

    model.paint();
    model.refresh(this.sim);
    this.applyLayers();
    document.querySelector('#loading').style.display = 'none';

    /* 事件流回填初始日志 */
    [...this.sim.events].reverse().forEach((e) => ui.pushEvent(e));
    this.sim.on('event', (e) => ui.pushEvent(e));

    /* 初始视角 */
    const want = new URLSearchParams(location.search).get('view');
    const v = VIEWS.find((x) => x.id === want) || VIEWS[0];
    this.setView(v.id, true);

    this._bindPointer();
    this._bindKeys();
    addEventListener('resize', () => this.resize());
    this.controls.addEventListener('start', () => { this.tween = null; });

    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setAnimationLoop(() => this.frame());
    console.log('[twin] 合批:', JSON.stringify(model.stats));
    const s = model.stats;
    document.title = `TWIN-OK nodes=${s.sourceNodes} meshes=${s.sourceMeshes} batches=${s.batches} `
      + `equip=${s.equipment} calls=${this.renderer.info.render.calls}`;
    window.__TWIN_READY__ = true;
  }

  /* -------------------------------------------------------------- 交互 */
  _bindPointer() {
    const el = this.canvas;
    let down = null;
    el.addEventListener('pointermove', (ev) => {
      this.pointer.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
      if (down && (Math.abs(ev.clientX - down.x) > 4 || Math.abs(ev.clientY - down.y) > 4)) down.moved = true;
      const tip = document.querySelector('#tip');
      tip.style.left = `${ev.clientX}px`; tip.style.top = `${ev.clientY}px`;
    });
    el.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY, t: performance.now(), moved: false }; });
    el.addEventListener('pointerup', (ev) => {
      if (!down || down.moved || performance.now() - down.t > 420) { down = null; return; }
      down = null;
      if (this.hover) this.select(this.hover.equip ? this.hover.equip.id : null);
      else this.select(null);
    });
    el.addEventListener('dblclick', () => { if (this.hover?.equip) this.focus(this.hover.equip.id); });
    el.addEventListener('pointerleave', () => { this.pointer.set(-10, -10); this.model.hover = null; this.model.paint(); });
  }

  _bindKeys() {
    addEventListener('keydown', (ev) => {
      if (ev.target.tagName === 'INPUT') return;
      const n = parseInt(ev.key, 10);
      if (n >= 1 && n <= VIEWS.length) this.setView(VIEWS[n - 1].id);
      if (ev.key === 'Escape') this.select(null);
      if (ev.key === 'f' || ev.key === 'F') this.fitAll();
      if (ev.key === 'r' || ev.key === 'R') this.autoRotate = !this.autoRotate;
      if (ev.code === 'Space') { ev.preventDefault(); this.paused = !this.paused; }
      if (ev.key === 'h' || ev.key === 'H') document.querySelectorAll('.hud').forEach((h) => { h.style.display = h.style.display === 'none' ? '' : 'none'; });
    });
  }

  /* -------------------------------------------------------------- 选中 */
  select(id, fly) {
    this.selected = id;
    this.model.selected = id;
    this.model.paint();
    this.model.refresh(this.sim);
    this.ui.setSelected(id);
    if (id && fly) this.focus(id);
    if (id) {
      const d = this.sim.devices.get(id);
      d._status = d.status;
    }
  }

  command(id, c) {
    this.sim.command(id, c);
    this.ui.renderDetail();
  }

  /* -------------------------------------------------------------- 相机 */
  _flyTo(pos, target, dur = 0.9) {
    this.tween = {
      t: 0, dur,
      p0: this.camera.position.clone(), p1: new THREE.Vector3(...pos),
      t0: this.controls.target.clone(), t1: new THREE.Vector3(...target),
    };
  }

  setView(id, instant) {
    const v = VIEWS.find((x) => x.id === id); if (!v) return;
    this.viewId = id;
    if (instant) {
      this.camera.position.set(...v.pos); this.controls.target.set(...v.target); this.controls.update();
      this.tween = null;
    } else this._flyTo(v.pos, v.target);
  }

  focus(id) {
    const f = this.model.focusBox(id, 1.5); if (!f) return;
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    if (dir.lengthSq() < 0.1) dir.set(1, 0.65, 1).normalize();
    const dist = f.radius / Math.tan((this.camera.fov * Math.PI / 180) / 2) * 0.9;
    const pos = f.center.clone().addScaledVector(dir, Math.max(dist, f.radius * 1.7)).setY(f.center.y + f.radius * 0.55);
    this._flyTo(pos.toArray(), f.center.toArray(), 0.8);
  }

  fitAll() {
    const b = new THREE.Box3();
    for (const e of EQUIPMENT) {
      const x = this.model.boxes.get(e.id); if (x) b.union(x);
    }
    const c = b.getCenter(new THREE.Vector3()), r = b.getSize(new THREE.Vector3()).length() * 0.5;
    const dist = r / Math.tan((this.camera.fov * Math.PI / 180) / 2) * 0.92;
    const d = new THREE.Vector3(0.66, 0.52, 0.72).normalize();
    this._flyTo(c.clone().addScaledVector(d, dist).toArray(), c.toArray(), 0.9);
  }

  setLayer(id, on) {
    if (id === 'model') { this.model.setLayerVisible(LAYERS.equip, on); this.model.setLayerVisible(LAYERS.pipes, on); }
    if (id === 'flow') this.flow.setVisible(on);
    if (id === 'halo') this.model.setHalosVisible(on);
    if (id === 'label') this.model.setLabelsVisible(on);
    if (id === 'zones') this.model.setLayerVisible(LAYERS.zones, on);
    if (id === 'walls') this.model.setLayerVisible(LAYERS.building, on);
  }

  applyLayers() {
    for (const l of LAYERS) this.setLayer(l.id, l.on);
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.labelRenderer.setSize(innerWidth, innerHeight);
  }

  /* -------------------------------------------------------------- 主循环 */
  frame() {
    window.__FRAMES++;
    try { this._frame(); } catch (e) { window.__ERRORS.push('frame: ' + (e.stack || e)); }
  }

  _frame() {
    const now = performance.now();
    const dt = Math.min((now - this._tPrev) / 1000, 0.05);
    this._tPrev = now;
    if (!this.paused) this.sim.step(dt);

    this.flow.update(dt);
    this.flow.setActive(this.sim);

    if (this.tween) {
      this.tween.t += dt / this.tween.dur;
      const t = Math.min(1, this.tween.t);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, e);
      this.controls.target.lerpVectors(this.tween.t0, this.tween.t1, e);
      if (t >= 1) this.tween = null;
    }
    if (this.autoRotate) {
      const a = dt * 0.09, c = this.controls.target;
      const dx = this.camera.position.x - c.x, dz = this.camera.position.z - c.z;
      this.camera.position.x = c.x + dx * Math.cos(a) - dz * Math.sin(a);
      this.camera.position.z = c.z + dx * Math.sin(a) + dz * Math.cos(a);
    }
    this.controls.update();

    /* 拾取（限频 ~20 Hz） */
    this._pickAcc += dt;
    if (this._pickAcc > 0.05 && !this.paused) {
      this._pickAcc = 0;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = this.model.pick(this.raycaster);
      const id = hit?.equip?.id || null;
      const cur = this.model.hover;
      if (id !== cur) {
        this.model.hover = id;
        this.model.paint();
        const tip = document.querySelector('#tip');
        if (hit) {
          const d = this.sim.devices.get(id);
          tip.innerHTML = `${d ? d.tag : hit.name} · ${d ? d.name : ''} · <b style="color:${d ? d.color : '#888'}">${d ? d.statusText : ''}</b>`;
          tip.classList.add('on');
        } else tip.classList.remove('on');
        this.canvas.style.cursor = id ? 'pointer' : 'default';
      }
    }

    /* 界面 / 状态（每 0.5 s，按真实时钟，低帧率下也不会滞后） */
    if (!this._uiT) this._uiT = now - 1000;
    if (now - this._uiT > 500) {
      this._uiT = now;
      for (const e of EQUIPMENT) { const d = this.sim.devices.get(e.id); if (d) d._status = d.status; }
      this.model.refresh(this.sim);
      this.model.paint();
      this.ui.update(now / 1000);
      const c = this.camera.position;
      document.title = `TWIN-OK view=${this.viewId || '-'} cam=${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)}`
        + ` calls=${this.renderer.info.render.calls} tri=${this.renderer.info.render.triangles}`;
    }
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }
}

/* ------------------------------------------------------------------ 启动 */
if (location.protocol === 'file:') {
  fatal('请通过 HTTP 服务访问本页面（ES Module 与 .glb 模型都不允许 file:// 协议）。\n\n'
      + '在本目录下执行：  python -m http.server 8080\n然后打开：        http://localhost:8080/');
} else if (!WEBGL_OK) {
  fatal('当前浏览器/显卡未提供可用的 WebGL 上下文。\n请检查浏览器是否启用了硬件加速。');
} else {
  const app = new App();
  window.twin = app;
  app.boot().catch((err) => { console.error(err); fatal(String(err && err.stack || err)); });
}

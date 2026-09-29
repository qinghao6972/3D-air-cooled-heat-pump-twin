/* =============================================================================
 * model.js — 载入 GLB、几何实例化合批、设备台账绑定、拾取 / 高亮 / 标签 / 光环
 *
 * 性能策略：GLB 有 3074 个节点、951 个网格。three.js 默认每个节点一个 Mesh，
 * 即 3053 次 draw call。这里按 (几何体 | 材质 | 图层) 分组，改写成 InstancedMesh，
 * draw call 降到 ~950 次；同时保留 instanceId -> 原始节点 -> 设备 的映射，
 * 使逐设备拾取与高亮依然可用（用 instanceColor 做逐实例着色）。
 * ========================================================================== */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EQUIPMENT, EQUIP_BY_NODE, STATUS_COLORS } from './config.js';

export const LAYERS = { equip: 'equip', pipes: 'pipes', zones: 'zones', building: 'building' };

function classify(name) {
  if (name.startsWith('PP_') || name.startsWith('PS_')) return LAYERS.pipes;
  if (name.startsWith('ZN_')) return LAYERS.zones;
  if (name.startsWith('FL_') || name.startsWith('CR_') || name.startsWith('LB_')) return LAYERS.building;
  return LAYERS.equip;
}

/** 找出设备根节点：优先精确节点名，其次按前缀（管路等单节点对象） */
function ownerOf(obj) {
  let o = obj;
  while (o) {
    if (EQUIP_BY_NODE[o.name]) return EQUIP_BY_NODE[o.name];
    o = o.parent;
  }
  return null;
}

export class TwinModel {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'Twin';
    scene.add(this.root);
    this.instanced = [];                     // {mesh, layer, entries:[{equip,srcIdx}]}
    this.byLayer = { equip: [], pipes: [], zones: [], building: [] };
    this.equipMeshes = new Map();            // equipId -> [{mesh, idx}]
    this.labels = [];
    this.halos = new Map();
    this.hover = null;
    this.selected = null;
    this.statusTint = false;
    this.stats = {};
  }

  async load(url, onProgress) {
    const loader = new GLTFLoader();
    const gltf = await new Promise((res, rej) =>
      loader.load(url, res, (e) => onProgress?.(e.loaded / (e.total || 6417980)), rej));
    const src = gltf.scene;
    src.updateMatrixWorld(true);

    /* ---- 1. 收集网格 + 归类 ---- */
    const items = [];
    src.traverse((o) => {
      if (!o.isMesh) return;
      const layer = classify(o.name);
      const equip = ownerOf(o);
      items.push({ obj: o, layer, equip, mat: o.matrixWorld.clone(), geo: o.geometry, material: o.material });
    });

    /* ---- 2. 透明 / 玻璃材质降级：关闭 transmission，改用普通透明混合 ---- */
    let glassCount = 0;
    const seenMat = new Set();
    for (const it of items) {
      const m = it.material;
      if (seenMat.has(m.uuid)) continue;
      seenMat.add(m.uuid);
      if (m.transmission !== undefined && m.transmission > 0) {
        m.transmission = 0; m.transparent = true;
        m.opacity = Math.min(m.opacity ?? 1, 0.34);
        m.depthWrite = false; m.side = THREE.DoubleSide;
        glassCount++;
      }
      if (m.emissiveIntensity !== undefined && m.emissive && m.emissive.getHex() !== 0) {
        // LED 保持发光
        m.emissiveIntensity = Math.max(m.emissiveIntensity, 1.0);
      }
      m.envMapIntensity = m.metalness > 0.7 ? 1.15 : 0.85;
      m.needsUpdate = true;
    }

    /* ---- 3. 实例化合批 ---- */
    const groups = new Map();
    for (const it of items) {
      const key = `${it.geo.uuid}|${it.material.uuid}|${it.layer}`;
      let g = groups.get(key);
      if (!g) { g = { geo: it.geo, material: it.material, layer: it.layer, list: [] }; groups.set(key, g); }
      g.list.push(it);
    }

    for (const g of groups.values()) {
      const n = g.list.length;
      const im = new THREE.InstancedMesh(g.geo, g.material, n);
      im.name = `INST_${g.layer}_${this.instanced.length}`;
      im.castShadow = true; im.receiveShadow = true;
      im.frustumCulled = true;
      const colors = new Float32Array(n * 3).fill(1);
      im.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      const entries = [];
      g.list.forEach((it, i) => {
        im.setMatrixAt(i, it.mat);
        entries.push({ equip: it.equip, name: it.obj.name });
        if (it.equip) {
          if (!this.equipMeshes.has(it.equip.id)) this.equipMeshes.set(it.equip.id, []);
          this.equipMeshes.get(it.equip.id).push({ inst: im, idx: i });
        }
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.userData.entries = entries;
      im.userData.layer = g.layer;
      this.root.add(im);
      const rec = { mesh: im, layer: g.layer, entries };
      this.instanced.push(rec);
      this.byLayer[g.layer].push(im);
    }

    /* ---- 4. 设备包围盒（用于取景 / 光环 / 标签锚点） ---- */
    const boxes = new Map();
    for (const it of items) {
      if (!it.equip) continue;
      let b = boxes.get(it.equip.id);
      if (!b) { b = new THREE.Box3(); boxes.set(it.equip.id, b); }
      b.expandByObject(it.obj, true);
    }
    this.boxes = boxes;

    /* ---- 5. 光环 + 标签 ---- */
    this._buildHalos();
    this._buildLabels();

    this.stats = {
      sourceNodes: 3074, sourceMeshes: items.length, batches: this.instanced.length,
      glassMaterials: glassCount, equipment: EQUIPMENT.length,
      drawCallSaved: items.length - this.instanced.length,
    };
    return this;
  }

  /* --------------------------------------------------------------- 光环 */
  _buildHalos() {
    const grp = new THREE.Group(); grp.name = 'Halos';
    const geo = new THREE.RingGeometry(0.86, 1.0, 48);
    for (const e of EQUIPMENT) {
      const b = this.boxes.get(e.id);
      const radius = b ? Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.62 : 1.2;
      const cx = b ? (b.min.x + b.max.x) / 2 : e.pos[0];
      const cz = b ? (b.min.z + b.max.z) / 2 : e.pos[2];
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(STATUS_COLORS.standby), transparent: true, opacity: 0.55,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.scale.setScalar(radius);
      m.rotation.x = -Math.PI / 2;
      m.position.set(cx, 0.035, cz);
      m.renderOrder = 3;
      m.userData.equip = e.id;
      grp.add(m);
      this.halos.set(e.id, m);
    }
    this.scene.add(grp);
    this.haloGroup = grp;
  }

  /* --------------------------------------------------------------- 标签 */
  _buildLabels() {
    for (const e of EQUIPMENT) {
      const el = document.createElement('div');
      el.className = 'eq-label';
      el.innerHTML = `<span class="dot"></span><b>${e.tag}</b><i>${e.name}</i>`;
      el.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.onLabelClick?.(e.id); });
      const b = this.boxes.get(e.id);
      const y = b ? b.max.y + 0.35 : e.pos[1] + 1.6;
      const x = b ? (b.min.x + b.max.x) / 2 : e.pos[0];
      const z = b ? (b.min.z + b.max.z) / 2 : e.pos[2];
      const obj = new CSS2DObject(el);
      obj.position.set(x, y, z);
      obj.center.set(0.5, 1);
      this.scene.add(obj);
      this.labels.push({ equip: e, obj, el });
    }
    this.labelGroup = this.labels.map((l) => l.obj);
  }

  /* --------------------------------------------------------- 状态刷新 */
  refresh(sim) {
    for (const e of EQUIPMENT) {
      const d = sim.devices.get(e.id);
      if (!d) continue;
      const halo = this.halos.get(e.id);
      if (!halo) continue;
      const running = d.status === 'running';
      halo.material.color.set(STATUS_COLORS[d.status]);
      halo.material.opacity = d.status === 'fault'
        ? 0.35 + 0.45 * Math.abs(Math.sin(performance.now() / 380))
        : running ? 0.52 : 0.22;
    }
    for (const l of this.labels) {
      const d = sim.devices.get(l.equip.id);
      if (!d) continue;
      l.el.dataset.status = d.status;
      l.el.querySelector('.dot').style.background = STATUS_COLORS[d.status];
      l.el.classList.toggle('sel', this.selected === l.equip.id);
    }
  }

  /* --------------------------------------------------- 逐实例着色 */
  paint() {
    for (const rec of this.instanced) {
      const c = rec.mesh.instanceColor;
      if (!c) continue;
      const arr = c.array;
      let dirty = false;
      for (let i = 0; i < rec.entries.length; i++) {
        const eq = rec.entries[i].equip;
        let r = 1, g = 1, b = 1;
        if (eq) {
          if (this.statusTint) {
            const st = eq._status || 'standby';
            const col = new THREE.Color(STATUS_COLORS[st]);
            r = 0.55 + col.r * 0.75; g = 0.55 + col.g * 0.75; b = 0.55 + col.b * 0.75;
          }
          if (this.hover === eq.id) { r *= 1.5; g *= 1.5; b *= 1.5; }
          if (this.selected === eq.id) { r = 0.42; g = 1.55; b = 2.30; }
        }
        const o = i * 3;
        if (arr[o] !== r || arr[o + 1] !== g || arr[o + 2] !== b) {
          arr[o] = r; arr[o + 1] = g; arr[o + 2] = b; dirty = true;
        }
      }
      if (dirty) c.needsUpdate = true;
    }
  }

  /* --------------------------------------------------------- 拾取 */
  pick(raycaster) {
    const hits = raycaster.intersectObjects(this.root.children, false);
    for (const h of hits) {
      const e = h.object.userData.entries?.[h.instanceId];
      if (e) return { equip: e.equip, name: e.name, point: h.point, distance: h.distance };
    }
    return null;
  }

  /* --------------------------------------------------------- 图层 */
  setLayerVisible(layer, v) { this.byLayer[layer]?.forEach((m) => { m.visible = v; }); }
  setHalosVisible(v) { this.haloGroup.visible = v; }
  setLabelsVisible(v) { this.labels.forEach((l) => { l.obj.visible = v; }); }

  /* --------------------------------------------------------- 聚焦 */
  focusBox(id, pad = 1.35) {
    const b = this.boxes.get(id);
    if (!b) return null;
    const box = b.clone().expandByScalar(0.15);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    return { center, radius: Math.max(size.length() * 0.5, 0.6) * pad, box };
  }
}

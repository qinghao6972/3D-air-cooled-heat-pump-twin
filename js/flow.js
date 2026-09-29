/* =============================================================================
 * flow.js — 管道流动可视化
 * 在 DN200 管路外侧套一层略大的发光管，用沿曲线弧长参数 u 运动的光带表现
 * 供水（红）/ 回水（蓝）的流向与流速。光带间距按实际米数计算，各管路一致。
 * ========================================================================== */
import * as THREE from 'three';
import { PIPE_RUNS, PIPE_COLORS } from './config.js';

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const FRAG = /* glsl */`
  uniform float uTime, uSpeed, uDensity, uOpacity;
  uniform vec3  uColor;
  varying vec2 vUv;
  void main() {
    // 沿管长方向的相位：光带 + 亮芯
    float f    = fract(vUv.x * uDensity - uTime * uSpeed);
    float band = smoothstep(0.0, 0.30, f) * smoothstep(1.0, 0.60, f);
    float core = smoothstep(0.0, 0.07, f) * smoothstep(0.24, 0.05, f);
    // 管端淡出，避免出现整齐的切边
    float end  = smoothstep(0.0, 0.025, vUv.x) * smoothstep(1.0, 0.975, vUv.x);
    float a    = (band * 0.40 + core * 0.95) * uOpacity * end;
    gl_FragColor = vec4(uColor * (1.0 + core * 1.6), a);
  }`;

/** 二次贝塞尔圆角：把折线拐角替换成采样点，与实际管路 fillet 一致 */
function fillet(pts, r = 0.42, seg = 5) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i], a = pts[i - 1], b = pts[i + 1];
    const u = new THREE.Vector3().subVectors(a, c), v = new THREE.Vector3().subVectors(b, c);
    const lu = u.length(), lv = v.length();
    const rr = Math.min(r, 0.45 * lu, 0.45 * lv);
    if (rr < 1e-4) { out.push(c); continue; }
    const p1 = c.clone().addScaledVector(u.normalize(), rr);
    const p2 = c.clone().addScaledVector(v.normalize(), rr);
    for (let s = 0; s <= seg; s++) {
      const t = s / seg, it = 1 - t;
      out.push(new THREE.Vector3(
        it * it * p1.x + 2 * it * t * c.x + t * t * p2.x,
        it * it * p1.y + 2 * it * t * c.y + t * t * p2.y,
        it * it * p1.z + 2 * it * t * c.z + t * t * p2.z));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export class FlowNetwork {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.name = 'FlowNetwork';
    this.materials = [];
    this.runs = new Map();
    const geoCache = new Map();

    for (const run of PIPE_RUNS) {
      const pts = fillet(run.path.map((p) => new THREE.Vector3(...p)), 0.42, 5);
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.0);
      const len = curve.getLength();
      const segs = Math.max(24, Math.round(len * 7));
      const geo = new THREE.TubeGeometry(curve, segs, 0.114, 10, false);

      const speed = 2.15 / Math.max(len, 0.5);      // 光带推进 2.15 m/s
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 }, uSpeed: { value: speed },
          uDensity: { value: Math.max(1, len / 1.55) },
          uOpacity: { value: 0 },
          uColor: { value: new THREE.Color(PIPE_COLORS[run.kind]) },
        },
        vertexShader: VERT, fragmentShader: FRAG,
        transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `FLOW_${run.id}`;
      mesh.renderOrder = 4;
      mesh.userData.run = run;
      mesh.userData.length = len;
      this.group.add(mesh);
      this.materials.push(mat);
      this.runs.set(run.id, { run, mesh, mat, curve, len, geo });
      geoCache.set(run.id, geo);
    }
    parent.add(this.group);
    this.opacity = 0;
    this.target = 1;
  }

  /** 依据仿真：水泵停机 / 阀门关闭时对应支管停流 */
  setActive(sim) {
    const anyPump = sim.list.some((d) => d.kind === 'pump' && d.status === 'running');
    const hpOn = new Set(sim.list.filter((d) => d.kind === 'heatpump' && d.status === 'running').map((d) => d.id));
    const pumpOn = new Set(sim.list.filter((d) => d.kind === 'pump' && d.status === 'running').map((d) => d.id));
    for (const [, r] of this.runs) {
      const o = r.run.owner;
      let v = anyPump ? 1 : 0.12;
      if (o && o.startsWith('HP_') && !hpOn.has(o)) v = 0.10;
      if (o && o.startsWith('PUMP_') && !pumpOn.has(o)) v = 0.10;
      r.mat.uniforms.uOpacity.value += (v * this.target - r.mat.uniforms.uOpacity.value) * 0.06;
    }
  }

  update(dt) { for (const m of this.materials) m.uniforms.uTime.value += dt; }

  setVisible(v) { this.group.visible = v; }
}

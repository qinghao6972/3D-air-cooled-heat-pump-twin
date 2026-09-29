/* =============================================================================
 * scene.js — 渲染器 / 灯光 / 环境反射 / 地面 场景搭建
 * ========================================================================== */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export const WEBGL_OK = (() => {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch (e) { return false; }
})();

export function createRenderer(canvas) {
  const r = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: false,
    powerPreference: 'high-performance', preserveDrawingBuffer: true,
  });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.setSize(innerWidth, innerHeight);
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.02;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  r.shadowMap.autoUpdate = false;      // 静态场景，阴影只烘一次（“重烘阴影”按钮可刷新）
  return r;
}

export function createLabelRenderer() {
  const l = new CSS2DRenderer();
  l.setSize(innerWidth, innerHeight);
  l.domElement.className = 'label-layer';
  document.body.appendChild(l.domElement);
  return l;
}

export function createScene() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0d1420, 95, 280);

  /* 天空渐变穹顶 */
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(400, 32, 20),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x0a1020) }, bot: { value: new THREE.Color(0x2a3a52) } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bot; varying vec3 vP;
        void main(){ float h = clamp(normalize(vP).y*0.5+0.5, 0.0, 1.0);
          gl_FragColor = vec4(mix(bot, top, pow(h, 0.85)), 1.0); }`,
    }),
  );
  sky.name = 'Sky';
  scene.add(sky);
  return scene;
}

/** 程序化环境贴图：用一组自发光面片烘出 PMREM，给金属 / 不锈钢提供反射 */
export function buildEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const env = new THREE.Scene();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const panel = (c, i, pos, scl) => {
    const m = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(i) }));
    m.position.set(...pos); m.scale.set(...scl); env.add(m);
  };
  const shell = new THREE.Mesh(new THREE.BoxGeometry(30, 18, 30),
    new THREE.MeshBasicMaterial({ color: 0x2b3444, side: THREE.BackSide }));
  env.add(shell);
  panel(0xffffff, 0.10, [0, -8.6, 0], [30, 0.4, 30]);        // 地面
  panel(0xffffff, 0.35, [0, 8.6, 0], [30, 0.4, 30]);         // 顶棚
  panel(0xdfe8ff, 5.2, [-8, 5.0, -5], [12, 0.3, 6]);         // 主光带
  panel(0xffffff, 3.4, [7, 4.4, 6], [9, 0.3, 5]);
  panel(0xffffff, 1.5, [-9, 0.5, 8], [0.3, 9, 7]);
  panel(0xffe9c4, 2.0, [9.4, 1.5, -7], [0.3, 8, 8]);
  panel(0x8fb6ff, 0.8, [0, 0, -9.4], [14, 9, 0.3]);
  const tex = pmrem.fromScene(env, 0.02).texture;
  pmrem.dispose();
  env.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  return tex;
}

export function createLights(scene) {
  const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x2c3038, 0.85);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.35);
  sun.position.set(46, 38, -30);
  sun.castShadow = true;
  const S = 34;
  sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
  sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 160;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.028;
  sun.target.position.set(0, 0, 0);
  scene.add(sun); scene.add(sun.target);

  const fill = new THREE.DirectionalLight(0x9fc4ff, 0.55);
  fill.position.set(-34, 22, 28);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffd9a8, 0.35);
  rim.position.set(-20, 10, -34);
  scene.add(rim);

  return { hemi, sun, fill, rim };
}

export function createControls(camera, dom) {
  const c = new OrbitControls(camera, dom);
  c.enableDamping = true; c.dampingFactor = 0.075;
  c.maxPolarAngle = Math.PI * 0.495;
  c.minDistance = 1.5; c.maxDistance = 190;
  c.screenSpacePanning = false;
  c.target.set(-2, 1.2, 0);
  return c;
}

/** 厂房外地坪 + 参考网格 */
export function createGround(scene) {
  const g = new THREE.Group(); g.name = 'GroundDressing';
  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(260, 260),
    new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.96, metalness: 0.0 }),
  );
  base.rotation.x = -Math.PI / 2; base.position.y = -0.305;
  base.receiveShadow = true;
  g.add(base);

  const grid = new THREE.GridHelper(240, 120, 0x3d5170, 0x2f3c50);
  grid.position.y = -0.30;
  grid.material.opacity = 0.5; grid.material.transparent = true;
  g.add(grid);
  scene.add(g);
  return g;
}

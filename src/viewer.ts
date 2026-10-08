import {
  ACESFilmicToneMapping, AgXToneMapping, Box3, DirectionalLight, Group, Material,
  MathUtils, Matrix4, Mesh, MeshPhysicalMaterial, NeutralToneMapping, Object3D, PCFShadowMap, PerspectiveCamera, Scene, Sphere, SRGBColorSpace,
  Texture, Timer, ToneMapping, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { EnvironmentManager } from './environment';
import { Ground } from './ground';
import { Post, TONE_MODES, ToneMapName } from './post';
import { computeSun, SunState } from './sun';
import { toPhysical } from './materials';
import { patchTransmissionSampling, tuneGlass } from './glass';
import { patchShadowFiltering } from './shadows';

/** All models in /Models are discovered at build time. */
export const MODEL_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob('/Models/*.{glb,gltf}', { query: '?url', import: 'default', eager: true }) as Record<string, string>)
    .map(([path, url]) => [path.split('/').pop()!, url]),
);

const THREE_TONE: Record<ToneMapName, ToneMapping> = { AgX: AgXToneMapping, ACES: ACESFilmicToneMapping, Neutral: NeutralToneMapping };
/** Models are normalised so their largest dimension equals this (scene units ≈ metres). */
const MODEL_SIZE = 10;

export const device = (() => {
  // Coarse primary pointer (phones/tablets) or iPadOS masquerading as a Mac. Touch-screen laptops stay 'desktop'.
  const touch = matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  const mem = (navigator as any).deviceMemory as number | undefined;
  const lowEnd = (navigator.hardwareConcurrency ?? 8) <= 4 || (mem !== undefined && mem <= 4);
  return { touch, lowEnd, maxDpr: touch ? 1.5 : 2 };
})();

export type PresetName = 'home' | 'front' | 'corner' | 'close-up' | 'aerial';

/** Start ("home") view per model, in scene units: from the "Leo Test" preset. Others fall back to 'corner'. */
const HOME_VIEWS: Record<string, { position: [number, number, number]; target: [number, number, number] }> = {
  'project.glb': { position: [-5.796, 1.686, 6.197], target: [-0.002, 1.431, -0.002] },
};

interface Tween { p0: Vector3; p1: Vector3; t0: Vector3; t1: Vector3; time: number; dur: number }

/** Hook used by the path tracer module (lazy-loaded) to take over frame output. */
export interface FrameHandler {
  /** Return true if this handler rendered the frame. */
  frame(viewer: Viewer, dirty: boolean, interacting: boolean): boolean;
}

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(35, 1, 0.1, 1000);
  readonly controls: OrbitControls;
  readonly sun = new DirectionalLight(0xffffff, 4);
  readonly env: EnvironmentManager;
  readonly ground = new Ground();
  readonly post: Post;
  readonly modelRoot = new Group();

  model: Object3D | null = null;
  modelName = '';
  radius = 5;
  /** Normalisation scale applied to the current model (source units → scene units). */
  modelScale = 1;
  readonly bounds = new Box3();

  // Lighting state
  // Defaults from the "Leo Test" preset.
  timeOfDay = 11.5;
  northOffset = 39;
  sunPeak = 3.3;
  sunEnabled = true;
  shadowSoftness = 3;
  sunState!: SunState;
  toneMap: ToneMapName = 'AgX';

  frameHandler: FrameHandler | null = null;
  readonly listeners = {
    changed: new Set<() => void>(), model: new Set<() => void>(), frame: new Set<() => void>(),
    /** Tap/click without drag on the canvas. */
    tap: new Set<(e: PointerEvent) => void>(),
    /** Mesh geometry/UVs replaced (path tracer must rebuild its BVH). */
    geometry: new Set<() => void>(),
    /** Per-frame updates (e.g. walk mode). Return true while something is moving. */
    step: new Set<(dt: number) => boolean>(),
  };

  private dirty = 2;
  private interactingUntil = 0;
  private tween: Tween | null = null;
  private timer = new Timer();
  private gltfLoader: GLTFLoader;
  private loadToken = 0;

  constructor(readonly container: HTMLElement) {
    patchTransmissionSampling();
    patchShadowFiltering();
    const r = (this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false }));
    r.setPixelRatio(Math.min(devicePixelRatio, device.maxDpr));
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = AgXToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.shadowMap.autoUpdate = false; // static scene: re-render shadows only on change, not on orbit
    container.appendChild(r.domElement);

    this.controls = new OrbitControls(this.camera, r.domElement);
    Object.assign(this.controls, { autoRotateSpeed: 0.8, enableDamping: true, dampingFactor: 0.08, maxPolarAngle: Math.PI / 2 - 0.03, screenSpacePanning: true });
    this.controls.addEventListener('start', () => { this.tween = null; this.markInteracting(); });
    this.controls.addEventListener('change', () => this.markInteracting());

    this.env = new EnvironmentManager(r, this.scene);
    const shadowRes = device.touch ? 2048 : 4096;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowRes, shadowRes);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target, this.ground, this.modelRoot);

    this.post = new Post(r, this.scene, this.camera);
    this.post.setFocusTarget(this.controls.target); // DOF autofocus follows the orbit / walk look-at point
    if (device.touch || device.lowEnd) { this.post.setQuality('Low'); this.post.ao.configuration.halfRes = true; this.post.settings.msaa = 2; this.post.rebuild(); }

    // Decoder/transcoder binaries are resolved + bundled by three itself (import.meta.url).
    const draco = new DRACOLoader();
    const ktx2 = new KTX2Loader().detectSupport(r);
    this.gltfLoader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);

    // Tap detection (no drag) for picking / closing the panel.
    let down: { x: number; y: number; t: number } | null = null;
    r.domElement.addEventListener('pointerdown', (e) => { down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; });
    r.domElement.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && performance.now() - down.t < 400) this.listeners.tap.forEach((f) => f(e));
      down = null;
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.updateSun();
    r.setAnimationLoop(() => this.loop());
  }

  /** Request re-render (and notify listeners such as the path tracer). */
  invalidate(frames = 1) {
    this.dirty = Math.max(this.dirty, frames);
  }

  /** Called after any scene/material/light change: re-render + notify. */
  changed() {
    this.renderer.shadowMap.needsUpdate = true;
    this.invalidate();
    this.listeners.changed.forEach((f) => f());
  }

  geometryChanged() {
    this.listeners.geometry.forEach((f) => f());
    this.changed();
  }

  markInteracting(ms = 220) {
    this.interactingUntil = performance.now() + ms;
    this.invalidate();
  }

  get interacting() {
    return performance.now() < this.interactingUntil || this.tween !== null;
  }

  // ---------------------------------------------------------------- models

  async loadModel(name: string, onProgress?: (p: number) => void) {
    const url = MODEL_FILES[name];
    if (!url) throw new Error(`Unknown model ${name}`);
    const token = ++this.loadToken;
    const gltf = await this.gltfLoader.loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
    if (token !== this.loadToken) { disposeObject(gltf.scene); return; }

    if (this.model) { this.modelRoot.remove(this.model); disposeObject(this.model); }
    const pivot = new Group();
    pivot.name = name;
    pivot.add(gltf.scene);
    const upgraded = new Map<Material, Material>();
    pivot.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      // All slots become MeshPhysicalMaterial so they can be edited uniformly (shared materials stay shared).
      const up = (mt: Material) => { if (!upgraded.has(mt)) upgraded.set(mt, toPhysical(mt)); return upgraded.get(mt)!; };
      m.material = Array.isArray(m.material) ? m.material.map(up) : up(m.material);
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const glassy = mats.some((mt: any) => mt.transmission > 0 || (mt.transparent && mt.opacity < 0.9));
      m.castShadow = !glassy;
      m.receiveShadow = true;
    });

    upgraded.forEach((p, orig) => { if (p !== orig) orig.dispose(); tuneGlass(p as MeshPhysicalMaterial); });

    // Normalise: scale, centre on XZ, rest on ground.
    const box = new Box3().setFromObject(pivot);
    const size = box.getSize(new Vector3());
    this.modelScale = MODEL_SIZE / Math.max(size.x, size.y, size.z, 1e-6);
    this.post.unitsPerMetre = this.modelScale;
    this.post.applyParams();
    pivot.scale.setScalar(this.modelScale);
    box.setFromObject(pivot);
    const c = box.getCenter(new Vector3());
    pivot.position.set(-c.x, -box.min.y, -c.z);
    pivot.updateMatrixWorld(true);

    this.model = pivot;
    this.modelName = name;
    this.modelRoot.add(pivot);
    this.bounds.setFromObject(pivot);
    this.radius = this.bounds.getBoundingSphere(new Sphere()).radius;

    this.ground.fit(this.radius);
    this.controls.minDistance = this.radius * 0.15;
    this.controls.maxDistance = this.radius * 8;
    this.camera.near = this.radius * 0.01;
    this.camera.far = this.radius * 60;
    this.camera.updateProjectionMatrix();
    this.updateSun();
    this.ground.contact.bake(this.renderer, this.scene);
    this.goToPreset('home', false);
    this.listeners.model.forEach((f) => f());
    this.changed();
  }

  bakeContactShadow() {
    this.ground.contact.visible = this.ground.contact.enabled && this.ground.catcher.visible;
    this.ground.contact.bake(this.renderer, this.scene);
    this.changed();
  }

  // ---------------------------------------------------------------- lighting

  updateSun() {
    const s = (this.sunState = computeSun(this.timeOfDay, this.northOffset, this.sunPeak));
    const center = this.bounds.isEmpty() ? new Vector3() : this.bounds.getCenter(new Vector3());
    this.sun.visible = this.sunEnabled;
    this.sun.color.copy(s.color);
    this.sun.intensity = s.intensity;
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(s.direction, this.radius * 3);
    this.sun.shadow.radius = this.shadowSoftness;
    this.sun.shadow.normalBias = 0.004 * this.radius;
    this.env.factor = s.envFactor;
    this.env.sunDir.copy(s.direction);
    this.env.apply();
    this.fitShadowCamera();
    this.changed();
  }

  /** Fit the ortho shadow frustum tightly around the model and its projected shadow on the ground. */
  private fitShadowCamera() {
    if (this.bounds.isEmpty()) return;
    const cam = this.sun.shadow.camera;
    const view = new Matrix4().lookAt(this.sun.position, this.sun.target.position, new Vector3(0, 1, 0));
    view.setPosition(this.sun.position).invert();
    const d = this.sunState.direction;
    const b = this.bounds;
    const pts: Vector3[] = [];
    for (let i = 0; i < 8; i++) {
      const p = new Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      pts.push(p);
      const t = Math.min(p.y / Math.max(d.y, 1e-3), this.radius * 3); // shadow length, capped at low sun
      pts.push(p.clone().addScaledVector(d, -t).setY(0));
    }
    const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of pts) { p.applyMatrix4(view); min.min(p); max.max(p); }
    const pad = this.radius * 0.05;
    cam.left = min.x - pad; cam.right = max.x + pad; cam.bottom = min.y - pad; cam.top = max.y + pad;
    cam.near = Math.max(0.01, -max.z - pad); cam.far = -min.z + pad;
    cam.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
  }

  setExposure(v: number) { this.renderer.toneMappingExposure = v; this.changed(); }

  setToneMapping(name: ToneMapName) {
    this.toneMap = name;
    this.renderer.toneMapping = THREE_TONE[name];
    this.post.tone.mode = TONE_MODES[name];
    this.changed();
  }

  // ---------------------------------------------------------------- camera

  goToPreset(name: PresetName, animate = true) {
    const home = name === 'home' ? HOME_VIEWS[this.modelName] : undefined;
    if (name === 'home' && !home) name = 'corner';
    if (home) {
      const target = new Vector3(...home.target);
      const pos = new Vector3(...home.position);
      if (this.camera.aspect < 1) pos.sub(target).multiplyScalar(1.35).add(target); // portrait: step back
      if (!animate) {
        this.tween = null;
        this.camera.position.copy(pos);
        this.controls.target.copy(target);
        this.controls.update();
        this.changed();
      } else {
        this.flyTo(pos, target);
      }
      return;
    }
    const R = this.radius;
    const target = this.bounds.isEmpty() ? new Vector3() : this.bounds.getCenter(new Vector3());
    target.y = (this.bounds.max.y - this.bounds.min.y) * (name === 'close-up' ? 0.35 : 0.4);
    const dirs: Record<PresetName, [number, number, number, number]> = {
      home: [0.85, 0.3, 1, 1], front: [0, 0.12, 1, 1], corner: [0.85, 0.3, 1, 1], 'close-up': [0.5, 0.08, 1, 0.5], aerial: [0.6, 1.3, 0.9, 1.05],
    };
    const [x, y, z, k] = dirs[name];
    const vFov = MathUtils.degToRad(this.camera.fov);
    const fov = Math.min(vFov, 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect));
    const fit = this.camera.aspect < 1 ? 0.95 : 0.72; // portrait needs more room
    const dist = (R / Math.sin(fov / 2)) * fit * k;
    const pos = new Vector3(x, y, z).normalize().multiplyScalar(dist).add(target);
    pos.y = Math.max(pos.y, R * 0.05);
    if (!animate) {
      this.tween = null;
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.changed();
      return;
    }
    this.tween = { p0: this.camera.position.clone(), p1: pos, t0: this.controls.target.clone(), t1: target, time: 0, dur: 1.1 };
  }

  /** Smoothly move the camera to a saved view. */
  flyTo(position: Vector3, target: Vector3) {
    this.tween = { p0: this.camera.position.clone(), p1: position.clone(), t0: this.controls.target.clone(), t1: target.clone(), time: 0, dur: 1.1 };
    this.invalidate();
  }

  private stepTween(dt: number) {
    const tw = this.tween!;
    tw.time += dt;
    const k = MathUtils.clamp(tw.time / tw.dur, 0, 1);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    this.camera.position.lerpVectors(tw.p0, tw.p1, e);
    this.controls.target.lerpVectors(tw.t0, tw.t1, e);
    if (k >= 1) { this.tween = null; this.invalidate(); }
  }

  // ---------------------------------------------------------------- loop

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h);
    this.changed();
  }

  private loop() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    if (this.tween) { this.stepTween(dt); this.markInteracting(); }
    let stepping = false;
    this.listeners.step.forEach((f) => { if (f(dt)) stepping = true; });
    if (stepping) this.markInteracting();
    // Orbit controls are switched off in walk mode (update() would snap the camera back to the orbit).
    if (this.controls.enabled && this.controls.update(dt)) this.markInteracting();
    const dirty = this.dirty > 0;
    if (this.frameHandler?.frame(this, dirty, this.interacting)) { this.dirty = 0; this.listeners.frame.forEach((f) => f()); return; }
    if (!dirty) return;
    this.dirty--;
    this.renderRaster(dt);
    this.listeners.frame.forEach((f) => f());
  }

  renderRaster(dt = 0.016) {
    this.post.render(dt);
  }
}

export function disposeMaterial(m: Material) {
  for (const v of Object.values(m)) if (v instanceof Texture) v.dispose();
  m.dispose();
}

/** Dispose a subtree's GPU resources. Subtrees flagged `userData.keep` (shared/cached, e.g. furniture) are skipped. */
export function disposeObject(root: Object3D) {
  if (root.userData.keep) return;
  const m = root as Mesh;
  if (m.isMesh) {
    m.geometry?.dispose();
    (m.userData.modelGeometry as { dispose(): void } | undefined)?.dispose();
    (Array.isArray(m.material) ? m.material : [m.material]).forEach(disposeMaterial);
  }
  for (const c of root.children) disposeObject(c);
}

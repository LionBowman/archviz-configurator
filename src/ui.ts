import { Pane, FolderApi } from 'tweakpane';
import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
import { Color } from 'three';
import type { Viewer, PresetName } from './viewer';
import { MODEL_FILES } from './viewer';
import type { Loader } from './loader';
import { HDR_FILES, BackgroundMode } from './environment';
import { formatHour } from './sun';
import type { ToneMapName } from './post';
import { bind, fields, refreshIndicators, setField } from './controls';
import { FpsMeter } from './fps';
import { Furniture } from './furniture';
import { InteriorLights } from './interiorLights';
import { WalkMode } from './walk';
import type { BindingApi } from '@tweakpane/core';
import type { PathTracerBackend } from './pathtracerTypes';

export interface UIContext { hdrs: string[]; models: string[]; loader: Loader; device: { touch: boolean; lowEnd: boolean } }

export type SectionName = 'Presets' | 'Render' | 'Lighting & Time' | 'Environment' | 'Model' | 'Materials' | 'Camera' | 'Post';

export interface UI {
  pane: Pane;
  panel: HTMLElement;
  sections: Record<SectionName, FolderApi>;
  isOpen(): boolean;
  open(): void;
  close(): void;
  /** Load a model with the loading overlay and keep the dropdown in sync. */
  loadModel(name: string): Promise<void>;
  isWalking(): boolean;
}

const ICON_MENU = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

export function createUI(viewer: Viewer, ctx: UIContext): UI {
  document.body.classList.toggle('touch', ctx.device.touch);

  // ---------------------------------------------------------------- shell
  const button = document.createElement('button');
  button.className = 'panel-toggle';
  button.setAttribute('aria-label', 'Open settings');
  button.innerHTML = ICON_MENU;

  const panel = document.createElement('aside');
  panel.className = 'panel';
  panel.setAttribute('aria-hidden', 'true');
  panel.innerHTML = '<header class="panel-head"><span>Scene</span></header><div class="panel-body"></div>';
  document.body.append(panel, button);

  const pane = new Pane({ container: panel.querySelector('.panel-body') as HTMLElement });
  pane.registerPlugin(EssentialsPlugin);

  let open = false;
  const setOpen = (v: boolean) => {
    open = v;
    panel.classList.toggle('open', v);
    panel.setAttribute('aria-hidden', String(!v));
    button.classList.toggle('active', v);
    button.innerHTML = v ? ICON_CLOSE : ICON_MENU;
    button.setAttribute('aria-label', v ? 'Close settings' : 'Open settings');
  };
  button.addEventListener('click', () => setOpen(!open));
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) setOpen(false); });

  const names: SectionName[] = ['Presets', 'Render', 'Lighting & Time', 'Environment', 'Model', 'Materials', 'Camera', 'Post'];
  const sections = Object.fromEntries(names.map((n) => [n, pane.addFolder({ title: n, expanded: n === 'Lighting & Time' })])) as Record<SectionName, FolderApi>;
  // Accordion: keep the panel short on tablets.
  for (const f of Object.values(sections)) f.on('fold', (e) => {
    if (e.expanded && ctx.device.touch) for (const o of Object.values(sections)) if (o !== f) o.expanded = false;
  });

  const ui: UI = { pane, panel, sections, isOpen: () => open, open: () => setOpen(true), close: () => setOpen(false), loadModel: async () => {}, isWalking: () => false };

  // ---------------------------------------------------------------- Render
  const render = { toneMap: viewer.toneMap as ToneMapName, exposure: viewer.renderer.toneMappingExposure, dpr: viewer.renderer.getPixelRatio() };
  const R = sections.Render;
  bind(R, render, 'toneMap', { label: 'tone map', options: { AgX: 'AgX', ACES: 'ACES', Neutral: 'Neutral' } })
    .on('change', (e) => viewer.setToneMapping(e.value));
  bind(R, render, 'exposure', { min: 0.2, max: 3, step: 0.01 }).on('change', (e) => viewer.setExposure(e.value));
  bind(R, render, 'dpr', { label: 'pixel ratio', min: 0.5, max: ctx.device.touch ? 1.5 : 2, step: 0.25 })
    .on('change', (e) => { viewer.renderer.setPixelRatio(e.value); viewer.resize(); });
  const fps = new FpsMeter(viewer, viewer.container);
  bind(R, fps, 'visible', { label: 'FPS meter' }, { id: 'Render/fps' });
  setupPathTracerUI(viewer, R, ctx);

  // ---------------------------------------------------------------- Lighting & Time
  const L = sections['Lighting & Time'];
  const sunInfo = { info: '' };
  const refreshSunInfo = () => {
    const s = viewer.sunState;
    sunInfo.info = `elev ${s.elevation.toFixed(0)}°  az ${((s.azimuth + viewer.northOffset + 360) % 360).toFixed(0)}°  ${Math.round(s.kelvin)}K`;
  };
  const sunChanged = () => { viewer.updateSun(); refreshSunInfo(); };
  bind(L, viewer, 'timeOfDay', { label: 'time', min: 6, max: 20, step: 0.25, format: formatHour }).on('change', sunChanged);
  bind(L, viewer, 'northOffset', { label: 'north offset', min: -180, max: 180, step: 1 }).on('change', sunChanged);
  bind(L, viewer, 'sunPeak', { label: 'sun strength', min: 0, max: 10, step: 0.1 }).on('change', sunChanged);
  bind(L, viewer, 'shadowSoftness', { label: 'softness', min: 0, max: 10, step: 0.5 }).on('change', sunChanged);
  // Interior pendant lights (only for models with a light layout)
  const lamps = new InteriorLights(viewer);
  const lampApply = () => lamps.apply();
  const lampBindings = [
    bind(L, lamps, 'enabled', { label: 'interior lights' }, { id: 'Lighting & Time/interiorLights' }).on('change', lampApply),
    bind(L, lamps, 'brightness', { label: 'light brightness', min: 0, max: 8, step: 0.05 }, { id: 'Lighting & Time/lightBrightness' }).on('change', lampApply),
    bind(L, lamps, 'kelvin', { label: 'light colour (K)', min: 2000, max: 6500, step: 50 }, { id: 'Lighting & Time/lightKelvin' }).on('change', lampApply),
    bind(L, lamps, 'shadows', { label: 'light shadows' }, { id: 'Lighting & Time/lightShadows' }).on('change', lampApply),
  ];
  const syncLampUI = () => lampBindings.forEach((b) => (b.hidden = !lamps.available));
  viewer.listeners.model.add(syncLampUI);
  syncLampUI();
  const shadowState = { res: viewer.sun.shadow.mapSize.x };
  bind(L, shadowState, 'res', { label: 'shadow detail', options: { '1024': 1024, '2048': 2048, '4096': 4096, '8192 (desktop)': 8192 } }).on('change', (e) => {
    const sh = viewer.sun.shadow;
    sh.mapSize.set(e.value, e.value);
    sh.map?.dispose();
    (sh as any).map = null; // re-created at the new size on the next render
    viewer.changed();
  });
  bind(L, viewer, 'sunEnabled', { label: 'sun' }).on('change', sunChanged);
  bind(L, viewer.ground.catcher.material, 'opacity', { label: 'shadow opacity', min: 0, max: 1, step: 0.01 })
    .on('change', () => viewer.changed());
  refreshSunInfo();
  bind(L, sunInfo, 'info', { label: 'sun', readonly: true, interval: 300 });

  // ---------------------------------------------------------------- Environment
  const E = sections.Environment;
  const env = viewer.env;
  const envState = { hdr: ctx.hdrs[0] ?? '', bgColor: `#${env.bgColor.getHexString()}` };
  const envChanged = () => { env.apply(); viewer.changed(); };
  if (ctx.hdrs.length > 1) {
    bind(E, envState, 'hdr', { label: 'HDR', options: Object.fromEntries(ctx.hdrs.map((h) => [h, h])) })
      .on('change', async (e) => {
        ctx.loader.show('Loading environment');
        await env.load(HDR_FILES[e.value]);
        ctx.loader.hide();
        viewer.changed();
      });
  }
  bind(E, env, 'intensity', { min: 0, max: 3, step: 0.01 }).on('change', envChanged);
  const rotBinding = bind(E, env, 'rotationDeg', { label: 'rotation', min: -180, max: 180, step: 1 }).on('change', envChanged);
  // Keeps the HDR's own sun (reflections, sky light) in line with the shadow-casting sun as time/north change.
  bind(E, env, 'alignToSun', { label: 'align HDR sun' }).on('change', () => { rotBinding.disabled = env.alignToSun; envChanged(); });
  bind(E, env, 'mode', {
    label: 'background',
    options: { 'Studio gradient': 'gradient', 'Solid colour': 'color', 'Blurred HDR': 'blurred', 'Visible HDR': 'hdr' } satisfies Record<string, BackgroundMode>,
  }).on('change', envChanged);
  bind(E, envState, 'bgColor', { label: 'bg colour', view: 'color' }).on('change', (e) => {
    env.bgColor.copy(new Color(e.value));
    document.documentElement.style.setProperty('--bg', e.value);
    envChanged();
  });
  bind(E, env, 'bgBrightness', { label: 'bg brightness', min: 0.2, max: 5, step: 0.05 }).on('change', envChanged);
  bind(E, env, 'blur', { label: 'bg blur', min: 0, max: 1, step: 0.01 }).on('change', envChanged);

  // ---------------------------------------------------------------- Model
  const M = sections.Model;
  const modelState = { model: viewer.modelName };
  let syncingModel = false;
  ui.loadModel = async (name: string) => {
    if (name === viewer.modelName) return;
    ctx.loader.show('Loading model');
    try { await viewer.loadModel(name, (p) => ctx.loader.progress(p)); } finally { ctx.loader.hide(); }
  };
  const modelOptions = Object.fromEntries(Object.keys(MODEL_FILES).map((m) => [m.replace(/\.(glb|gltf)$/i, ''), m]));
  const modelBinding = bind(M, modelState, 'model', { options: modelOptions }, { track: false })
    .on('change', (e) => { if (!syncingModel) void ui.loadModel(e.value); });
  const contact = viewer.ground.contact;
  const furniture = new Furniture(viewer);
  const furnitureBinding = bind(M, furniture, 'enabled', { label: 'furniture' }).on('change', (e) => furniture.setEnabled(e.value));
  const syncFurnitureUI = async () => { furnitureBinding.hidden = !(await furniture.available()); };
  viewer.listeners.model.add(syncFurnitureUI);
  void syncFurnitureUI().then(() => furniture.populate());
  bind(M, contact, 'enabled', { label: 'contact shadow' }).on('change', () => viewer.bakeContactShadow());
  bind(M, contact, 'opacity', { label: 'contact opacity', min: 0, max: 1, step: 0.01 }).on('change', () => viewer.bakeContactShadow());
  bind(M, contact, 'blur', { label: 'contact blur', min: 0.5, max: 8, step: 0.1 }).on('change', () => viewer.bakeContactShadow());

  // ---------------------------------------------------------------- Camera
  const C = sections.Camera;
  let walkRef: WalkMode | null = null;
  const walk = new WalkMode(viewer);
  walkRef = walk;
  ui.isWalking = () => walk.active;
  setupWalkUI(walk, C, ctx);
  const presets: (PresetName | 'inside')[] = ['home', 'front', 'corner', 'close-up', 'aerial', 'inside'];
  const goView = (name: PresetName | 'inside') => {
    if (name === 'inside') walkRef?.enter();
    else { walkRef?.exit(false); viewer.goToPreset(name); }
  };
  (C.addBlade({ view: 'buttongrid', size: [3, 2], cells: (x: number, y: number) => ({ title: presets[y * 3 + x] }), label: 'views' }) as any)
    .on('click', (e: { index: [number, number] }) => goView(presets[e.index[1] * 3 + e.index[0]]));
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
    const i = Number(e.key) - 1;
    if (i >= 0 && i < presets.length) goView(presets[i]);
  });
  bind(C, viewer.camera, 'fov', { min: 20, max: 70, step: 1 }).on('change', () => { viewer.camera.updateProjectionMatrix(); viewer.changed(); });
  bind(C, viewer.controls, 'autoRotate', { label: 'auto rotate' }).on('change', () => viewer.changed());
  bind(C, viewer.controls, 'autoRotateSpeed', { label: 'rotate speed', min: 0.1, max: 6, step: 0.1 }).on('change', () => viewer.changed());

  // ---------------------------------------------------------------- Post
  const P = sections.Post;
  const s = viewer.post.settings;
  const rebuild = () => { viewer.post.rebuild(); viewer.changed(); }; // toggles: pass chain changes
  const live = () => { viewer.post.applyParams(); viewer.changed(); }; // sliders: no shader recompiles
  const tab = P.addTab({ pages: [{ title: 'Lighting' }, { title: 'Lens' }, { title: 'Finish' }] });
  const [pl, pc, pf] = tab.pages as unknown as FolderApi[];
  // Lighting-ish: AO, bloom, AA
  bind(pl, s, 'ao', { label: 'ambient occl.' }, { id: 'Post/ao' }).on('change', rebuild);
  bind(pl, s, 'aoQuality', { label: 'AO quality', options: { Performance: 'Performance', Low: 'Low', Medium: 'Medium', High: 'High', Ultra: 'Ultra' } }, { id: 'Post/aoQuality' })
    .on('change', (e) => { viewer.post.setQuality(e.value); viewer.changed(); });
  bind(pl, s, 'aoIntensity', { label: 'AO intensity', min: 0, max: 6, step: 0.1 }, { id: 'Post/aoIntensity' }).on('change', live);
  bind(pl, s, 'aoRadius', { label: 'AO radius', min: 0.1, max: 5, step: 0.05 }, { id: 'Post/aoRadius' }).on('change', live);
  bind(pl, s, 'bloom', {}, { id: 'Post/bloom' }).on('change', rebuild);
  bind(pl, s, 'bloomIntensity', { label: 'bloom amt', min: 0, max: 1, step: 0.01 }, { id: 'Post/bloomIntensity' }).on('change', live);
  bind(pl, s, 'bloomThreshold', { label: 'bloom threshold', min: 0.5, max: 1.5, step: 0.01 }, { id: 'Post/bloomThreshold' }).on('change', live);
  bind(pl, s, 'smaa', { label: 'SMAA' }, { id: 'Post/smaa' }).on('change', rebuild);
  bind(pl, s, 'msaa', { label: 'MSAA', options: { off: 0, '2×': 2, '4×': 4, '8×': 8 } }, { id: 'Post/msaa' }).on('change', rebuild);
  // Lens: depth of field (autofocus on the orbit target / walk look point), chromatic aberration, vignette
  bind(pc, s, 'dof', { label: 'depth of field' }, { id: 'Post/dof' }).on('change', rebuild);
  bind(pc, s, 'dofRange', { label: 'focus range (m)', min: 0.2, max: 15, step: 0.1 }, { id: 'Post/dofRange' }).on('change', live);
  bind(pc, s, 'dofBokeh', { label: 'bokeh size', min: 0.5, max: 6, step: 0.1 }, { id: 'Post/dofBokeh' }).on('change', live);
  bind(pc, s, 'ca', { label: 'chromatic aberr.' }, { id: 'Post/ca' }).on('change', rebuild);
  bind(pc, s, 'caAmount', { label: 'CA amount', min: 0, max: 3, step: 0.05 }, { id: 'Post/caAmount' }).on('change', live);
  bind(pc, s, 'vignette', {}, { id: 'Post/vignette' }).on('change', rebuild);
  bind(pc, s, 'vignetteDarkness', { label: 'vignette amt', min: 0, max: 1, step: 0.01 }, { id: 'Post/vignetteDarkness' }).on('change', live);
  // Finish: grading + film grain
  bind(pf, s, 'grading', { label: 'colour grading' }, { id: 'Post/grading' }).on('change', rebuild);
  bind(pf, s, 'contrast', { min: -0.5, max: 0.5, step: 0.01 }, { id: 'Post/contrast' }).on('change', live);
  bind(pf, s, 'saturation', { min: -0.6, max: 0.6, step: 0.01 }, { id: 'Post/saturation' }).on('change', live);
  bind(pf, s, 'brightness', { min: -0.3, max: 0.3, step: 0.01 }, { id: 'Post/brightness' }).on('change', live);
  bind(pf, s, 'grain', { label: 'film grain' }, { id: 'Post/grain' }).on('change', rebuild);
  bind(pf, s, 'grainAmount', { label: 'grain amt', min: 0, max: 0.3, step: 0.005 }, { id: 'Post/grainAmount' }).on('change', live);

  /** One click to a tuned "camera" finish; every value stays editable, resettable and saved in presets. */
  const PHOTOREAL: Record<string, unknown> = {
    'Post/ao': true, 'Post/aoQuality': ctx.device.touch ? 'Medium' : 'High', 'Post/aoIntensity': 2.6, 'Post/aoRadius': 1.4,
    'Post/bloom': true, 'Post/bloomIntensity': 0.18, 'Post/bloomThreshold': 0.85,
    'Post/ca': true, 'Post/caAmount': 0.5, 'Post/vignette': true, 'Post/vignetteDarkness': 0.3,
    'Post/grading': true, 'Post/contrast': 0.08, 'Post/saturation': -0.06, 'Post/brightness': 0,
    'Post/grain': true, 'Post/grainAmount': 0.04, 'Lighting & Time/shadowSoftness': 4,
  };
  P.addButton({ title: 'Photoreal look' }).on('click', () => {
    for (const [id, v] of Object.entries(PHOTOREAL)) { const f = fields.get(id); if (f) setField(f, v); }
  });

  // refresh() fires change handlers, so guard against re-loading the model we just loaded.
  viewer.listeners.model.add(() => { syncingModel = true; modelState.model = viewer.modelName; modelBinding.refresh(); syncingModel = false; refreshIndicators(); });
  return ui;
}

// ---------------------------------------------------------------- Path tracer (lazy)
type Engine = 'webgl' | 'webgpu';

function setupPathTracerUI(viewer: Viewer, R: FolderApi, ctx: UIContext) {
  const badge = document.createElement('div');
  badge.className = 'pt-badge';
  document.body.appendChild(badge);

  const hasWebGPU = 'gpu' in navigator;
  const backends: Partial<Record<Engine, PathTracerBackend>> = {};
  let current: PathTracerBackend | null = null;
  const pt = {
    // WebGPU + OIDN is much faster and handles the roof glazing correctly, so prefer it where available.
    enabled: false, engine: (hasWebGPU ? 'webgpu' : 'webgl') as Engine, denoise: hasWebGPU, denoiseStrength: 2.5,
    maxSamples: ctx.device.touch ? 128 : 512, bounces: 6, scale: ctx.device.touch ? 0.5 : 1,
  };
  const opts: BindingApi[] = [];

  /** Create (once) and return the backend for an engine; both modules are code-split. */
  const getBackend = async (engine: Engine): Promise<PathTracerBackend> => {
    if (!backends[engine]) {
      badge.textContent = engine === 'webgpu' ? 'Loading WebGPU path tracer + OIDN…' : 'Loading path tracer…';
      badge.classList.add('show');
      if (engine === 'webgpu') {
        const { WebGPUPathTracerController } = await import('./pathtracerWebGPU');
        backends.webgpu = await WebGPUPathTracerController.create(viewer, ctx.device.touch);
      } else {
        const { PathTracerController } = await import('./pathtracer');
        backends.webgl = new PathTracerController(viewer, ctx.device.touch);
      }
    }
    return backends[engine]!;
  };

  const applyOpts = (restart = true) => {
    if (!current) return;
    current.maxSamples = pt.maxSamples;
    current.bounces = pt.bounces;
    current.renderScale = pt.scale;
    current.denoiseStrength = pt.denoiseStrength;
    current.denoise = pt.denoise;
    if (restart) current.reset(); else current.redisplay();
  };

  let switching = Promise.resolve();
  const sync = () => {
    // Serialise enable/disable/engine switches (each may lazy-load a module).
    switching = switching.then(async () => {
      let want = pt.enabled ? await getBackend(pt.engine).catch((e) => { console.error(e); return null; }) : null;
      if (pt.enabled && !want && pt.engine === 'webgpu') {
        // WebGPU present but unusable (adapter/feature limits): fall back to the WebGL engine.
        pt.engine = 'webgl';
        pt.denoise = false;
        engineBinding?.refresh();
        denoiseBinding.refresh();
        want = await getBackend('webgl');
      }
      if (want !== current) {
        current?.disable();
        current = want;
        if (current) { applyOpts(); await current.enable(); }
      }
      opts.forEach((o) => (o.disabled = !pt.enabled));
      strength.hidden = pt.engine !== 'webgl';
      if (!current) badge.classList.remove('show');
    });
  };

  const toggle = bind(R, pt, 'enabled', { label: 'path tracing' }, { id: 'Render/pathTracing' });
  if (ctx.device.touch || ctx.device.lowEnd) toggle.label = 'path tracing (slow)';
  toggle.on('change', sync);
  let engineBinding: BindingApi | null = null;
  if (hasWebGPU) {
    engineBinding = bind(R, pt, 'engine', { label: 'PT engine', options: { 'WebGL (three-gpu-pathtracer)': 'webgl', 'WebGPU + OIDN denoise': 'webgpu' } })
      .on('change', (e) => {
        // OIDN is the point of the WebGPU engine; the WebGL blur filter is opt-in.
        pt.denoise = e.value === 'webgpu';
        denoiseBinding.refresh();
        sync();
      });
  }
  const denoiseBinding = bind(R, pt, 'denoise').on('change', () => applyOpts(false));
  opts.push(denoiseBinding);
  const strength = bind(R, pt, 'denoiseStrength', { label: 'denoise radius', min: 0.5, max: 6, step: 0.1 }).on('change', () => applyOpts(false));
  opts.push(strength);
  opts.push(bind(R, pt, 'maxSamples', { label: 'max samples', min: 16, max: 4096, step: 16 }).on('change', () => applyOpts()));
  opts.push(bind(R, pt, 'bounces', { min: 1, max: 16, step: 1 }).on('change', () => applyOpts()));
  opts.push(bind(R, pt, 'scale', { label: 'render scale', min: 0.25, max: 1, step: 0.05 }).on('change', () => applyOpts()));
  opts.forEach((o) => (o.disabled = true));

  // Standalone comparison page (vendored by `npm run setup:erichlof`); only shown when present.
  // (dev servers answer unknown paths with the app's index.html, so check the content, not the status)
  fetch(`${import.meta.env.BASE_URL}erichlof/GLTF_Model_Viewer.html`).then((r) => (r.ok ? r.text() : '')).then((html) => {
    if (!html.includes('PathTracing Renderer')) return;
    R.addButton({ title: 'Compare: erichlof renderer ↗' }).on('click', () => window.open(`${import.meta.env.BASE_URL}erichlof/GLTF_Model_Viewer.html`, '_blank'));
  }).catch(() => {});

  const engineName: Record<Engine, string> = { webgl: 'Path traced', webgpu: 'Path traced (WebGPU)' };
  viewer.listeners.frame.add(() => {
    if (!current?.active) return;
    const st = current.status();
    badge.classList.add('show');
    badge.dataset.state = st.state;
    badge.innerHTML = `<i></i>${engineName[pt.engine]} · ${st.samples}/${st.max} spp · ${st.state}`;
  });
}

// ---------------------------------------------------------------- Walk inside
const ICON_WALK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2-6 3 3v3M8 11l3-3 3 1 2 3h3M11 8l-1 5 2 2"/></svg>';
const ICON_ORBIT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><ellipse cx="12" cy="12" rx="9" ry="4"/><circle cx="12" cy="12" r="2"/></svg>';

function setupWalkUI(walk: WalkMode, C: FolderApi, ctx: UIContext) {
  const btn = document.createElement('button');
  btn.className = 'walk-toggle';
  document.body.appendChild(btn);
  const hint = document.createElement('div');
  hint.className = 'walk-hint';
  hint.textContent = ctx.device.touch
    ? 'Drag to look · tap the floor to walk there'
    : 'Drag to look · WASD / arrows / wheel to move · Q/E turn · Shift run · click the floor to walk there · Esc to leave';
  document.body.appendChild(hint);
  const label = (on: boolean) => {
    btn.innerHTML = on ? `${ICON_ORBIT}<span>Back to orbit</span>` : `${ICON_WALK}<span>Walk inside</span>`;
    btn.classList.toggle('active', on);
    hint.classList.toggle('show', on);
    if (on) setTimeout(() => hint.classList.remove('show'), 6000);
  };
  btn.addEventListener('click', () => walk.toggle());
  walk.listeners.add(label);
  label(false);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && walk.active && !document.querySelector('.panel.open')) walk.exit(); });
  C.addButton({ title: 'Walk inside (first person)' }).on('click', () => walk.enter());
}

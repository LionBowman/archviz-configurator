import { Material, Mesh, MeshPhysicalMaterial, Raycaster, Vector2 } from 'three';
import type { BindingApi, FolderApi } from '@tweakpane/core';
import type { Viewer } from './viewer';
import type { UI } from './ui';
import type { Loader } from './loader';
import { MaterialLibrary, applyWallUVs, disposeMaterialDeep, getUVScale, metresPerUV, restoreModelUVs, setUVScale } from './materials';
import { bind, refreshIndicators, sameValue } from './controls';
import { iorToReflection, reflectionToIor } from './glass';

/** Editable material values (what the panel shows for the selected surface). */
export interface SurfaceParams {
  color: string; roughness: number; metalness: number; normal: number; uvScale: number;
  clearcoat: number; transmission: number; displacement: number;
  /** Head-on reflectance relative to plain glass, via IOR (1 = IOR 1.5; glass defaults to 2). */
  reflection: number;
}
const PARAM_KEYS: (keyof SurfaceParams)[] = ['color', 'roughness', 'metalness', 'normal', 'uvScale', 'clearcoat', 'transmission', 'displacement', 'reflection'];

/** Per-surface state stored in presets: only what differs from the surface's defaults. */
export interface SurfaceSnapshot {
  library?: string;
  mapping?: 'wall' | 'model';
  flipV?: boolean;
  params?: Partial<SurfaceParams>;
}

export interface MaterialEditor {
  snapshot(): Record<string, SurfaceSnapshot>;
  apply(snap: Record<string, SurfaceSnapshot>): Promise<void>;
  resetAll(): Promise<void>;
}

/** A "surface" = all meshes sharing one source material (glTF material slot). */
interface Slot {
  name: string;
  meshes: Mesh[];
  original: MeshPhysicalMaterial;
  current: MeshPhysicalMaterial;
  metresPerUV: number;
  /** metres per UV unit of the model's own UVs */
  modelMetresPerUV: number;
  wallUV: boolean;
  flipV: boolean;
  defaultWallUV: boolean;
}

const ORIGINAL = '__original';
/** Real-world tile size of the model's own brick texture: ~14 courses × 75 mm (UK brick + joint). */
const MODEL_BRICK_TILE_M = 1.05;

/**
 * Normal strength without losing each axis' sign. three's GLTFLoader stores glTF normal maps with
 * normalScale.y = -1 (textures aren't flipped), so writing the same positive value to both axes inverted the
 * green channel: grooves (paving grout, brick joints) rendered as ridges after any edit, reset or preset.
 * Signs are captured once per material so a strength of 0 doesn't lose them.
 */
function setNormalStrength(m: MeshPhysicalMaterial, strength: number) {
  const sign = (m.userData.normalSign ??= [Math.sign(m.normalScale.x) || 1, Math.sign(m.normalScale.y) || 1]) as [number, number];
  m.normalScale.set(strength * sign[0], strength * sign[1]);
}

function readParams(m: MeshPhysicalMaterial, modelScale: number): SurfaceParams {
  return {
    color: `#${m.color.getHexString()}`, roughness: m.roughness, metalness: m.metalness, normal: Math.abs(m.normalScale.x),
    uvScale: getUVScale(m), clearcoat: m.clearcoat, transmission: m.transmission,
    displacement: (m.displacementScale ?? 0) / modelScale,
    reflection: iorToReflection(m.ior),
  };
}

export async function createMaterialEditor(viewer: Viewer, ui: UI, loader: Loader): Promise<MaterialEditor> {
  const library = new MaterialLibrary(viewer.renderer);
  await library.init();

  const folder = ui.sections.Materials;
  let slots: Slot[] = [];
  let selected: Slot | null = null;
  /** Tweakpane's refresh() fires change handlers; ignore them while we push state into the UI. */
  let syncing = false;

  const state = {
    surface: '', library: ORIGINAL, mapping: 'model' as 'wall' | 'model', flipV: false,
    color: '#ffffff', roughness: 0.5, metalness: 0, normal: 1, uvScale: 1, clearcoat: 0, transmission: 0, displacement: 0, reflection: 1,
  };

  // ------------------------------------------------------------ material helpers

  /** Remember a material's starting values (reset target). uvScale is stored relative to the UV space it was captured in. */
  const captureBaseline = (slot: Slot, m: MeshPhysicalMaterial) => {
    m.userData.baseline = readParams(m, viewer.modelScale);
    m.userData.baselineMpu = slot.metresPerUV;
  };

  const baselineOf = (slot: Slot, m = slot.current): SurfaceParams => {
    const b = { ...(m.userData.baseline as SurfaceParams) };
    b.uvScale *= slot.metresPerUV / (m.userData.baselineMpu as number); // same real-world size in the current UV space
    return b;
  };

  const writeParams = (slot: Slot, m: MeshPhysicalMaterial, p: Partial<SurfaceParams>) => {
    if (p.color !== undefined) m.color.set(p.color);
    if (p.roughness !== undefined) m.roughness = p.roughness;
    if (p.metalness !== undefined) m.metalness = p.metalness;
    if (p.normal !== undefined) setNormalStrength(m, p.normal);
    if (p.uvScale !== undefined) setUVScale(m, p.uvScale);
    if (p.clearcoat !== undefined) m.clearcoat = p.clearcoat;
    if (p.transmission !== undefined) {
      if ((m.transmission > 0) !== (p.transmission > 0)) m.needsUpdate = true;
      m.transmission = p.transmission;
      if (slot.current === m) slot.meshes.forEach((x) => (x.castShadow = m.transmission === 0));
    }
    if (p.reflection !== undefined) m.ior = reflectionToIor(p.reflection);
    if (p.displacement !== undefined) {
      m.displacementScale = p.displacement * viewer.modelScale;
      m.displacementBias = -m.displacementScale / 2;
    }
  };

  /** Push the slot's UV orientation flags onto a material and re-apply its repeat. */
  const syncOrientation = (slot: Slot, m: MeshPhysicalMaterial, scaleFactor = 1) => {
    m.userData.wallUV = slot.wallUV;
    m.userData.flipV = slot.flipV;
    setUVScale(m, getUVScale(m) * scaleFactor);
  };

  const setMapping = (slot: Slot, wall: boolean) => {
    if (slot.wallUV === wall) return;
    const before = slot.metresPerUV;
    slot.wallUV = wall;
    slot.metresPerUV = wall ? 1 : slot.modelMetresPerUV;
    for (const mesh of slot.meshes) {
      if (wall) applyWallUVs(mesh, viewer.modelScale); else restoreModelUVs(mesh);
    }
    // Keep the texture's real-world size when the UV space changes.
    for (const m of new Set([slot.original, slot.current])) syncOrientation(slot, m, slot.metresPerUV / before);
    viewer.geometryChanged();
  };

  const setFlip = (slot: Slot, flip: boolean) => {
    slot.flipV = flip;
    for (const m of new Set([slot.original, slot.current])) syncOrientation(slot, m);
  };

  const assign = (slot: Slot, mat: MeshPhysicalMaterial) => {
    const old = slot.current;
    if (old === mat) return;
    slot.current = mat;
    if (mat !== slot.original) { syncOrientation(slot, mat); captureBaseline(slot, mat); }
    for (const mesh of slot.meshes) {
      mesh.material = mat;
      mesh.castShadow = mat.transmission === 0;
    }
    if (old !== slot.original) disposeMaterialDeep(old);
    viewer.changed();
  };

  /** Swap the slot to a library material (or back to the model's own). */
  const setLibrary = async (slot: Slot, id: string) => {
    if (id === ORIGINAL || !library.get(id)) { assign(slot, slot.original); return; }
    if (slot.current.userData.libraryId === id) return;
    const entry = library.get(id)!;
    if (entry.maps) loader.show(`Loading ${entry.name}`);
    try {
      assign(slot, await library.create(id, slot.metresPerUV));
    } finally { if (entry.maps) loader.hide(); }
  };

  /** Back to the surface's starting state: model material, default mapping, no flip, original values. */
  const resetSlot = (slot: Slot) => {
    assign(slot, slot.original);
    setFlip(slot, false);
    setMapping(slot, slot.defaultWallUV);
    writeParams(slot, slot.original, baselineOf(slot, slot.original));
  };

  // ------------------------------------------------------------ slots
  const largest = (meshes: Mesh[]) => {
    const n = (m: Mesh) => m.geometry.index?.count ?? m.geometry.attributes.position.count;
    return meshes.reduce((a, b) => (n(b) > n(a) ? b : a));
  };

  const collectSlots = () => {
    const byMat = new Map<Material, Slot>();
    const used = new Set<string>();
    viewer.model?.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh || Array.isArray(m.material)) return;
      let slot = byMat.get(m.material);
      if (!slot) {
        let name = m.material.name || m.name || 'Surface';
        for (let i = 2; used.has(name); i++) name = `${m.material.name || 'Surface'} ${i}`;
        used.add(name);
        const mat = m.material as MeshPhysicalMaterial;
        slot = { name, meshes: [], original: mat, current: mat, metresPerUV: 1, modelMetresPerUV: 1, wallUV: false, flipV: false, defaultWallUV: false };
        byMat.set(m.material, slot);
      }
      slot.meshes.push(m);
    });
    slots = [...byMat.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const s of slots) {
      s.metresPerUV = s.modelMetresPerUV = metresPerUV(largest(s.meshes), viewer.modelScale);
      // Brick needs courses that line up around corners → real-world wall projection by default.
      // The model's own brick UVs are also upside down (v runs up the wall) and inconsistently scaled,
      // so size its texture explicitly instead of carrying the UV-density estimate over.
      if (/brick/i.test(s.name)) {
        s.defaultWallUV = true;
        setMapping(s, true);
        s.original.userData.uvScale = 1 / MODEL_BRICK_TILE_M;
        syncOrientation(s, s.original);
      }
      captureBaseline(s, s.original);
    }
  };

  // ------------------------------------------------------------ UI sync
  const select = (slot: Slot | null) => {
    selected = slot;
    syncing = true;
    state.surface = slot?.name ?? '';
    surfaceBinding?.refresh();
    syncing = false;
    viewer.post.setSelection(slot?.meshes ?? []);
    pullState();
    viewer.changed();
  };

  /** Copy the selected surface's values into the panel (without re-triggering edits). */
  const pullState = () => {
    const m = selected?.current;
    editors.forEach((b) => (b.disabled = !m));
    if (m && selected) {
      state.library = (m.userData.libraryId as string) ?? ORIGINAL;
      state.mapping = selected.wallUV ? 'wall' : 'model';
      state.flipV = selected.flipV;
      Object.assign(state, readParams(m, viewer.modelScale));
      displacementBinding.hidden = !m.displacementMap;
    }
    syncing = true;
    editors.forEach((b) => b.refresh());
    syncing = false;
    refreshIndicators();
  };

  // ------------------------------------------------------------ UI
  let surfaceBinding: BindingApi | null = null;
  const buildSurfaceList = () => {
    surfaceBinding?.dispose();
    surfaceBinding = folder.addBinding(state, 'surface', {
      label: 'surface', index: 0,
      options: { '— tap model or choose —': '', ...Object.fromEntries(slots.map((s) => [s.name, s.name])) },
    });
    surfaceBinding.on('change', (e) => { if (!syncing) select(slots.find((s) => s.name === e.value) ?? null); });
  };

  const libOptions: Record<string, string> = { 'Original (from model)': ORIGINAL };
  for (const e of library.entries) libOptions[`${e.category} · ${e.name}`] = e.id;

  const editors: BindingApi[] = [];
  /** Material field: reset target = the selected surface's starting value. */
  const field = <K extends keyof typeof state & string>(key: K, params: object, getDefault: (s: Slot) => unknown, onChange: (s: Slot, v: (typeof state)[K]) => void | Promise<void>) => {
    const b = bind(folder, state, key, params as any, { id: `Materials/${key}`, scope: 'material', getDefault: () => (selected ? getDefault(selected) : state[key]) });
    b.on('change', async (e) => {
      if (syncing || !selected) return;
      await onChange(selected, e.value as (typeof state)[K]);
      viewer.changed();
    });
    editors.push(b);
    return b;
  };
  const param = (key: keyof SurfaceParams, params: object) =>
    field(key, params, (s) => baselineOf(s)[key], (s, v) => writeParams(s, s.current, { [key]: v }));

  field('library', { label: 'material', options: libOptions }, () => ORIGINAL, async (s, v) => { await setLibrary(s, v); pullState(); });
  field('mapping', { label: 'UV mapping', options: { 'Wall projection (corners)': 'wall', 'Model UVs': 'model' } },
    (s) => (s.defaultWallUV ? 'wall' : 'model'), (s, v) => { setMapping(s, v === 'wall'); pullState(); });
  field('flipV', { label: 'flip vertical' }, () => false, (s, v) => setFlip(s, v));
  param('color', { view: 'color' });
  param('roughness', { min: 0, max: 1, step: 0.01 });
  param('metalness', { min: 0, max: 1, step: 0.01 });
  param('normal', { label: 'normal str.', min: 0, max: 3, step: 0.05 });
  param('uvScale', { label: 'UV scale', min: 0.05, max: 20, step: 0.05 });
  param('clearcoat', { min: 0, max: 1, step: 0.01 });
  param('transmission', { min: 0, max: 1, step: 0.01 });
  param('reflection', { min: 0, max: 4, step: 0.05 });
  const displacementBinding = param('displacement', { label: 'height (m)', min: 0, max: 0.05, step: 0.001 });
  folder.addButton({ title: 'Reset surface' }).on('click', () => { if (selected) { resetSlot(selected); pullState(); viewer.changed(); } });
  if (!library.texturesAvailable) {
    folder.addBlade({ view: 'text', label: 'note', parse: (v: string) => v, value: 'run npm run fetch-textures', disabled: true } as any);
  }

  // ------------------------------------------------------------ picking
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const materialsOpen = () => ui.isOpen() && (folder as FolderApi).expanded;
  viewer.listeners.tap.add((e) => {
    if (!materialsOpen()) { if (ui.isOpen()) ui.close(); return; }
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, viewer.camera);
    const hit = viewer.model ? raycaster.intersectObject(viewer.model, true)[0] : undefined;
    select(hit ? slots.find((s) => s.meshes.includes(hit.object as Mesh)) ?? null : null);
  });
  folder.on('fold', (e) => { viewer.post.setSelection(e.expanded && selected ? selected.meshes : []); viewer.changed(); });

  const onModel = () => {
    // Previous model's meshes are already disposed by the viewer; free swapped-out originals too.
    for (const s of slots) if (s.current !== s.original) s.original.dispose();
    collectSlots();
    buildSurfaceList();
    select(null);
  };
  viewer.listeners.model.add(onModel);
  onModel();

  // ------------------------------------------------------------ presets API
  const editor: MaterialEditor = {
    snapshot() {
      const out: Record<string, SurfaceSnapshot> = {};
      for (const s of slots) {
        const snap: SurfaceSnapshot = {};
        const lib = (s.current.userData.libraryId as string) ?? ORIGINAL;
        if (lib !== ORIGINAL) snap.library = lib;
        if (s.wallUV !== s.defaultWallUV) snap.mapping = s.wallUV ? 'wall' : 'model';
        if (s.flipV) snap.flipV = true;
        const now = readParams(s.current, viewer.modelScale), base = baselineOf(s);
        const params: Partial<SurfaceParams> = {};
        for (const k of PARAM_KEYS) if (!sameValue(now[k], base[k])) (params as any)[k] = now[k];
        if (Object.keys(params).length) snap.params = params;
        if (Object.keys(snap).length) out[s.name] = snap;
      }
      return out;
    },
    async apply(snap) {
      for (const s of slots) {
        resetSlot(s);
        const p = snap[s.name];
        if (!p) continue;
        if (p.mapping) setMapping(s, p.mapping === 'wall');
        if (p.flipV) setFlip(s, true);
        if (p.library) await setLibrary(s, p.library);
        if (p.params) writeParams(s, s.current, p.params);
      }
      pullState();
      viewer.changed();
    },
    async resetAll() {
      await editor.apply({});
    },
  };
  return editor;
}

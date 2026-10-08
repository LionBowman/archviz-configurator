import { Vector3 } from 'three';
import type { BindingApi } from '@tweakpane/core';
import type { Viewer } from './viewer';
import { MODEL_FILES } from './viewer';
import type { UI } from './ui';
import type { MaterialEditor, SurfaceSnapshot } from './materialEditor';
import { fields, isChanged, refreshIndicators, setField } from './controls';
import { BUILT_IN_PRESETS } from './builtinPresets';

/**
 * A preset stores only values that differ from the defaults. Applying one first returns everything
 * to defaults, so the result is always exactly "defaults + this preset".
 */
export interface Preset {
  name: string;
  savedAt: string;
  model: string;
  scene: Record<string, unknown>;
  materials: Record<string, SurfaceSnapshot>;
  camera?: { position: number[]; target: number[]; fov: number };
}

const STORAGE_KEY = 'archviz.presets.v1';

function loadStored(): Preset[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'); } catch { return []; }
}
function store(list: Preset[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* private mode etc. – export still works */ }
}

export interface PresetsApi {
  /** Current state as a preset (only values that differ from the defaults). */
  capture(name: string, includeCamera?: boolean): Preset;
  apply(p: Preset): Promise<void>;
  flash(text: string, ms?: number): void;
}

export function createPresets(viewer: Viewer, ui: UI, editor: MaterialEditor): PresetsApi {
  const folder = ui.sections.Presets;
  let presets = loadStored();
  const st = { name: '', selected: '', camera: false };
  const nextName = () => { let i = presets.length + 1; while (presets.some((p) => p.name === `Preset ${i}`)) i++; return `Preset ${i}`; };
  st.name = nextName();
  /** Built-ins first (read-only), then the user's own. */
  const all = (): Preset[] => [...BUILT_IN_PRESETS, ...presets];
  const isBuiltIn = (p: Preset) => BUILT_IN_PRESETS.some((b) => b.name === p.name);
  st.selected = all()[0]?.name ?? '';

  // ------------------------------------------------------------ capture / apply
  const capture = (name: string, includeCamera = st.camera): Preset => {
    const scene: Record<string, unknown> = {};
    fields.forEach((f) => { if (f.scope === 'scene' && isChanged(f)) scene[f.id] = f.obj[f.key]; });
    const p: Preset = { name, savedAt: new Date().toISOString(), model: viewer.modelName, scene, materials: editor.snapshot() };
    if (includeCamera) {
      p.camera = { position: viewer.camera.position.toArray(), target: viewer.controls.target.toArray(), fov: viewer.camera.fov };
    }
    return p;
  };

  const resetScene = (values: Record<string, unknown> = {}) => {
    fields.forEach((f) => { if (f.scope === 'scene') setField(f, f.id in values ? values[f.id] : f.getDefault()); });
  };

  let busy = false;
  const apply = async (p: Preset) => {
    if (busy) return;
    busy = true;
    try {
      if (MODEL_FILES[p.model]) await ui.loadModel(p.model);
      resetScene(p.scene);
      await editor.apply(p.materials);
      if (p.camera) {
        const fov = fields.get('Camera/fov');
        if (fov) setField(fov, p.camera.fov);
        viewer.flyTo(new Vector3().fromArray(p.camera.position), new Vector3().fromArray(p.camera.target));
      }
      refreshIndicators();
    } finally { busy = false; }
  };

  // ------------------------------------------------------------ UI
  folder.addBinding(st, 'name', { label: 'name' });
  folder.addBinding(st, 'camera', { label: 'incl. camera' });
  folder.addButton({ title: 'Save current as preset' }).on('click', () => {
    let name = st.name.trim() || nextName();
    if (BUILT_IN_PRESETS.some((b) => b.name === name)) name = `${name.replace(/^★s*/, '')} (copy)`;
    const p = capture(name);
    presets = [...presets.filter((x) => x.name !== name), p];
    store(presets);
    st.selected = name;
    st.name = nextName();
    rebuildList();
    folder.refresh();
    flash(`Saved “${name}” (${Object.keys(p.scene).length} scene, ${Object.keys(p.materials).length} surface changes)`);
  });

  let list: BindingApi | null = null;
  const rebuildList = () => {
    list?.dispose();
    const options = Object.fromEntries(all().map((p) => [p.name, p.name]));
    if (!all().some((p) => p.name === st.selected)) st.selected = all()[0]?.name ?? '';
    list = folder.addBinding(st, 'selected', { label: 'preset', options, index: 3 });
  };
  rebuildList();

  const current = () => all().find((p) => p.name === st.selected);
  (folder.addBlade({ view: 'buttongrid', size: [3, 1], cells: (x: number) => ({ title: ['Apply', 'Overwrite', 'Delete'][x] }), label: '' } as any) as any)
    .on('click', async (e: { index: [number, number] }) => {
      const p = current();
      if (!p) return;
      if (e.index[0] === 0) { await apply(p); flash(`Applied “${p.name}”`); }
      if (e.index[0] > 0 && isBuiltIn(p)) { flash('Built-in presets are read-only: apply it, then “Save current as preset” to make your own copy'); return; }
      if (e.index[0] === 1) {
        presets = presets.map((x) => (x.name === p.name ? capture(p.name) : x));
        store(presets);
        flash(`Updated “${p.name}”`);
      }
      if (e.index[0] === 2 && confirm(`Delete preset “${p.name}”?`)) {
        presets = presets.filter((x) => x !== p);
        store(presets);
        rebuildList();
      }
    });

  (folder.addBlade({ view: 'buttongrid', size: [2, 1], cells: (x: number) => ({ title: ['Export JSON', 'Import JSON'][x] }), label: '' } as any) as any)
    .on('click', (e: { index: [number, number] }) => (e.index[0] === 0 ? exportJSON() : importJSON()));

  folder.addButton({ title: 'Reset everything to defaults' }).on('click', async () => {
    if (busy) return;
    resetScene();
    await editor.resetAll();
    refreshIndicators();
    flash('All values reset');
  });

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(presets, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'archviz-presets.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const importJSON = () => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/json,.json' });
    input.onchange = async () => {
      try {
        const data = JSON.parse(await input.files![0].text());
        const incoming: Preset[] = (Array.isArray(data) ? data : [data]).filter((p) => p && typeof p.name === 'string' && p.scene);
        presets = [...presets.filter((p) => !incoming.some((i) => i.name === p.name)), ...incoming];
        store(presets);
        st.selected = incoming[0]?.name ?? st.selected;
        rebuildList();
        flash(`Imported ${incoming.length} preset(s)`);
      } catch { flash('Could not read that file'); }
    };
    input.click();
  };

  // ------------------------------------------------------------ toast
  const toast = document.createElement('div');
  toast.className = 'toast';
  document.body.appendChild(toast);
  let timer = 0;
  function flash(text: string, ms = 2200) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(timer);
    timer = window.setTimeout(() => toast.classList.remove('show'), ms);
  }

  return { capture, apply, flash };
}

import './style.css';
import { device, MODEL_FILES, Viewer } from './viewer';
import { HDR_FILES } from './environment';
import { Loader } from './loader';
import { createUI } from './ui';
import { createMaterialEditor } from './materialEditor';
import { createPresets } from './presets';
import { setupShare } from './share';

async function main() {
  const loader = new Loader(document.getElementById('loader')!);
  const viewer = new Viewer(document.getElementById('viewport')!);
  (window as any).viewer = viewer;

  const hdrs = Object.keys(HDR_FILES);
  const models = Object.keys(MODEL_FILES);
  const params = new URLSearchParams(location.search);
  const firstModel = params.get('model') && MODEL_FILES[params.get('model')!] ? params.get('model')! : models.includes('project.glb') ? 'project.glb' : models[0];

  loader.show('Loading environment');
  if (hdrs.length) await viewer.env.load(HDR_FILES[hdrs[0]]);
  loader.show('Loading model');
  if (firstModel) await viewer.loadModel(firstModel, (p) => loader.progress(p));
  loader.hide();

  const ui = createUI(viewer, { hdrs, models, loader, device });
  const editor = await createMaterialEditor(viewer, ui, loader);
  const presets = createPresets(viewer, ui, editor);
  setupShare(viewer, ui, presets, () => ui.isWalking());
}

main().catch((e) => {
  console.error(e);
  document.querySelector('.loader-label')!.textContent = 'Failed to load — see console';
});

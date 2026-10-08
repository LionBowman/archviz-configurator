import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Viewer } from './viewer';
import { disposeObject } from './viewer';

/**
 * Interior furniture (CC0, Poly Haven; fetched by scripts/fetch-furniture.mjs into public/furniture/).
 * Layouts are per model, in the model's own coordinates in metres (before the viewer's normalisation),
 * so they scale and move with it. Furniture is parented to the model pivot.
 */
interface Item {
  id: string; // Poly Haven id, or 'rug'
  x: number; z: number;
  /** Rotation about Y in degrees. All Poly Haven seating faces +Z. */
  ry?: number;
  /** Height above the floor (e.g. a plant on a side table). */
  y?: number;
  size?: [number, number];
  /** Uniform scale to bring a model to real-world proportions (Poly Haven pieces vary). */
  scale?: number;
}

/** project.glb: floor at y = 0.15 m. Lounge in the bay end (+X), dining in the left wing (−X). */
const LAYOUTS: Record<string, { floorY: number; items: Item[] }> = {
  'project.glb': {
    floorY: 0.15,
    items: [
      // lounge
      { id: 'rug', x: 2.35, z: -0.35, size: [2.4, 1.7] },
      // sofa ×1.15 → 2.08 m wide, 0.82 m high (a 3-seater); its back sits ~0.1 m off the wall
      { id: 'sofa_02', x: 2.35, z: -1.57, scale: 1.15 },
      // coffee table ×0.85 → Ø1.1 m, 0.42 m high
      { id: 'coffee_table_round_01', x: 2.35, z: -0.25, scale: 0.85 },
      // lounge chair ×0.95 → 0.97 m high, in proportion with the sofa
      { id: 'modern_arm_chair_01', x: 2.1, z: 1.35, ry: 180, scale: 0.95 },
      { id: 'potted_plant_02', x: 3.25, z: 0.7 },
      { id: 'side_table_01', x: 0.95, z: -1.75 },
      { id: 'potted_plant_04', x: 0.95, z: -1.75, y: 0.55 },
      // dining: table ×0.76 → Ø1.06 m, 0.76 m high (was a 1 m-high table); chairs tucked in on the diagonals
      { id: 'round_wooden_table_01', x: -1.6, z: -0.72, scale: 0.76 },
      ...[45, 135, 225, 315].map((a) => {
        const t = (a * Math.PI) / 180;
        return { id: 'dining_chair_02', x: -1.6 + 0.78 * Math.sin(t), z: -0.72 + 0.78 * Math.cos(t), ry: a + 180 };
      }),
    ],
  },
};

export class Furniture {
  enabled = true;
  readonly group = new Group();
  private loader = new GLTFLoader();
  private cache = new Map<string, Promise<Object3D>>();
  private manifest: Promise<Record<string, string> | null>;
  private token = 0;

  constructor(private viewer: Viewer) {
    this.group.name = '__furniture';
    this.group.userData.keep = true; // shared with the load cache: never disposed with the model
    this.manifest = fetch(`${import.meta.env.BASE_URL}furniture/manifest.json`)
      .then((r) => (r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : null))
      .catch(() => null);
    viewer.listeners.model.add(() => void this.populate());
  }

  /** Whether furniture exists for the current model (models + layout available). */
  async available() {
    return !!(await this.manifest) && !!LAYOUTS[this.viewer.modelName];
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    void this.populate();
  }

  private load(id: string, path: string) {
    let p = this.cache.get(id);
    if (!p) {
      p = this.loader.loadAsync(`${import.meta.env.BASE_URL}furniture/${path}`).then((g) => {
        g.scene.traverse((o) => { const m = o as Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
        return g.scene;
      });
      this.cache.set(id, p);
    }
    return p;
  }

  /** (Re)build the furniture group for the current model. */
  async populate() {
    const token = ++this.token;
    const v = this.viewer;
    this.group.removeFromParent();
    this.clear();
    const layout = LAYOUTS[v.modelName];
    const manifest = await this.manifest;
    if (!this.enabled || !layout || !manifest || !v.model) { v.geometryChanged(); return; }

    const objects = await Promise.all(layout.items.map(async (it) => {
      if (it.id === 'rug') return rug(it.size ?? [2, 1.4]);
      if (!manifest[it.id]) return null;
      return (await this.load(it.id, manifest[it.id])).clone(); // geometry/materials shared with the cached original
    }));
    if (token !== this.token) return;
    layout.items.forEach((it, i) => {
      const o = objects[i];
      if (!o) return;
      o.position.set(it.x, layout.floorY + (it.y ?? 0) + (it.id === 'rug' ? 0.004 : 0), it.z);
      o.rotation.y = ((it.ry ?? 0) * Math.PI) / 180;
      if (it.scale) o.scale.setScalar(it.scale);
      this.group.add(o);
    });
    v.model.add(this.group); // pivot space = model metres
    v.model.updateMatrixWorld(true);
    v.geometryChanged();
  }

  private clear() {
    // Clones share geometry/materials with the cache, so only the rug owns resources.
    for (const c of [...this.group.children]) {
      if (c.userData.ownsResources) disposeObject(c);
      this.group.remove(c);
    }
  }
}

function rug([w, d]: [number, number]) {
  const m = new Mesh(new BoxGeometry(w, 0.008, d), new MeshStandardMaterial({ color: 0xb8ab98, roughness: 1 }));
  m.receiveShadow = true;
  m.name = 'rug';
  m.userData.ownsResources = true;
  return m;
}

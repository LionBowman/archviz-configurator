import {
  Color, ConeGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, PointLight, Raycaster, SphereGeometry, Vector3,
} from 'three';
import type { Viewer } from './viewer';
import { kelvinToRGB } from './sun';

/**
 * Interior pendant lights: a point light per fitting plus a visible cord, shade and emissive bulb.
 * Positions are per model, in the model's own metres (same space as the furniture layout).
 */
/** ceilingY is a fallback; the real ceiling above the fitting is found by ray-casting upwards. */
interface Fitting { x: number; z: number; ceilingY: number; dropY: number }

/** project.glb: one pendant over the coffee table, one over the dining table. */
const LAYOUTS: Record<string, Fitting[]> = {
  'project.glb': [
    { x: 2.35, z: -0.25, ceilingY: 2.6, dropY: 2.15 },
    { x: -1.6, z: -0.72, ceilingY: 2.6, dropY: 2.0 },
  ],
};

/** Base intensity (cd per unit brightness) chosen so 1.0 reads like a warm room light at default exposure. */
const BASE_CANDELA = 2.2;

export class InteriorLights {
  enabled = true;
  brightness = 1;
  kelvin = 2700;
  shadows = false;
  readonly group = new Group();
  private lights: PointLight[] = [];
  private bulbs: MeshStandardMaterial[] = [];
  private shadeMat = new MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.45, metalness: 0.6, side: DoubleSide });

  constructor(private viewer: Viewer) {
    this.group.name = '__interior_lights';
    viewer.listeners.model.add(() => this.build());
    this.build(); // the first model may already be loaded
  }

  get available() {
    return !!LAYOUTS[this.viewer.modelName];
  }

  /** Recreate fittings for the current model (they're parented to its pivot and disposed with it). */
  build() {
    const v = this.viewer;
    this.group.removeFromParent();
    this.group.clear();
    this.lights = [];
    this.bulbs = [];
    const layout = LAYOUTS[v.modelName];
    if (!layout || !v.model) return;

    for (const f of layout) {
      const fitting = new Group();
      fitting.position.set(f.x, 0, f.z);
      const cordLen = this.ceilingAbove(f) - f.dropY;
      const cord = new Mesh(new CylinderGeometry(0.004, 0.004, cordLen, 6), this.shadeMat);
      cord.position.y = f.dropY + cordLen / 2;
      // open cone shade, bulb hanging just inside it
      const shade = new Mesh(new ConeGeometry(0.2, 0.22, 32, 1, true), this.shadeMat);
      shade.position.y = f.dropY - 0.06;
      shade.castShadow = true;
      const bulbMat = new MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, roughness: 0.3 });
      const bulb = new Mesh(new SphereGeometry(0.045, 20, 12), bulbMat);
      bulb.position.y = f.dropY - 0.12;
      const light = new PointLight(0xffffff, 1, 0, 2);
      light.position.y = f.dropY - 0.14;
      light.shadow.mapSize.set(512, 512);
      light.shadow.bias = -0.002;
      fitting.add(cord, shade, bulb, light);
      this.group.add(fitting);
      this.lights.push(light);
      this.bulbs.push(bulbMat);
    }
    this.apply();
  }

  /** Ceiling height (model metres) directly above a fitting, so the cord meets the ceiling. */
  private ceilingAbove(f: Fitting) {
    const pivot = this.viewer.model!;
    pivot.updateMatrixWorld(true);
    const from = pivot.localToWorld(new Vector3(f.x, f.dropY, f.z));
    const hit = new Raycaster(from, new Vector3(0, 1, 0)).intersectObject(pivot, true).find((h) => !this.group.getObjectById(h.object.id));
    return hit ? pivot.worldToLocal(hit.point.clone()).y : f.ceilingY;
  }

  /** Push settings onto lights/bulbs; attaches or detaches the group (the WebGPU tracer ignores `visible`). */
  apply() {
    const v = this.viewer;
    const color = kelvinToRGB(this.kelvin, new Color());
    // Lights live in the scaled model pivot, but inverse-square falloff is in scene units: compensate.
    const s = v.modelScale;
    for (const l of this.lights) {
      l.color.copy(color);
      l.intensity = BASE_CANDELA * this.brightness * s * s;
      l.castShadow = this.shadows;
    }
    for (const b of this.bulbs) {
      b.emissive.copy(color);
      b.emissiveIntensity = 4 * this.brightness;
    }
    const attach = this.enabled && this.lights.length > 0 && !!v.model;
    if (attach && this.group.parent !== v.model) { v.model!.add(this.group); v.model!.updateMatrixWorld(true); v.geometryChanged(); }
    if (!attach && this.group.parent) { this.group.removeFromParent(); v.geometryChanged(); }
    v.changed();
  }
}

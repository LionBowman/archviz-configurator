// Lazy-loaded: only imported when the user enables path tracing (WebGL backend).
import { WebGLPathTracer, DenoiseMaterial } from 'three-gpu-pathtracer';
import type { Viewer } from './viewer';
import type { PathTracerBackend, PathTracerStatus } from './pathtracerTypes';

export class PathTracerController implements PathTracerBackend {
  readonly pt: WebGLPathTracer;
  maxSamples = 512;
  active = false;
  /** Edge-preserving blur at display time (glslSmartDeNoise). Accumulation itself is untouched. */
  denoise = false;
  private readonly denoiseMat = new DenoiseMaterial({ sigma: 2.5, kSigma: 1, threshold: 0.03 } as any);
  private needsScene = true;
  private needsUpdate = false;
  private needsRedisplay = false;
  private wasInteracting = false;
  private building: Promise<void> | null = null;
  private readonly onChanged = () => { this.needsUpdate = true; this.viewer.markInteracting(180); };
  private readonly onModel = () => { this.needsScene = true; };

  constructor(private viewer: Viewer, touch: boolean) {
    const pt = (this.pt = new WebGLPathTracer(viewer.renderer));
    pt.bounces = 6;
    pt.transmissiveBounces = 8;
    pt.filterGlossyFactor = 0.5;
    pt.minSamples = 3;
    pt.fadeDuration = 350;
    pt.renderDelay = 0;
    pt.dynamicLowRes = false;
    pt.renderScale = touch ? 0.5 : 1;
    pt.tiles.set(touch ? 3 : 2, touch ? 3 : 2);
    pt.rasterizeScene = true;
    pt.rasterizeSceneCallback = () => viewer.renderRaster();

    // Same as the library default, but optionally swaps in the denoise material for the final blit.
    pt.renderToCanvasCallback = (target, renderer, quad) => {
      const base = quad.material as any;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      if (this.denoise) {
        const d = this.denoiseMat as any;
        d.map = target.texture;
        d.opacity = base.opacity;
        d.blending = base.blending;
        d.transparent = base.transparent;
        quad.material = this.denoiseMat;
        quad.render(renderer);
        quad.material = base;
      } else {
        quad.render(renderer);
      }
      renderer.autoClear = autoClear;
    };
  }

  get bounces() { return this.pt.bounces; }
  set bounces(v: number) { this.pt.bounces = v; }
  get renderScale() { return this.pt.renderScale; }
  set renderScale(v: number) { this.pt.renderScale = v; }
  get denoiseStrength() { return (this.denoiseMat as any).sigma as number; }
  set denoiseStrength(v: number) { (this.denoiseMat as any).sigma = v; }

  async enable() {
    const v = this.viewer;
    this.active = true;
    v.env.setPathTracing(true);
    v.ground.setPathTracing(true, v.env.bgColor);
    v.post.setSelection([]);
    v.listeners.changed.add(this.onChanged);
    v.listeners.model.add(this.onModel);
    v.listeners.geometry.add(this.onModel);
    this.needsScene = true;
    v.frameHandler = this;
    v.invalidate();
  }

  disable() {
    const v = this.viewer;
    this.active = false;
    if (v.frameHandler === this) v.frameHandler = null;
    v.listeners.changed.delete(this.onChanged);
    v.listeners.model.delete(this.onModel);
    v.listeners.geometry.delete(this.onModel);
    v.env.setPathTracing(false);
    v.ground.setPathTracing(false, v.env.bgColor);
    v.invalidate(2);
  }

  reset() { this.pt.reset(); this.viewer.invalidate(); }

  redisplay() { this.needsRedisplay = true; this.viewer.invalidate(); }

  status(): PathTracerStatus {
    const samples = Math.floor(this.pt.samples);
    const preparing = !!(this.pt as any).isCompiling || !!this.building;
    const state = preparing ? 'preparing' : this.viewer.interacting ? 'preview' : samples >= this.maxSamples ? 'converged' : 'converging';
    return { samples, max: this.maxSamples, state };
  }

  private async rebuild() {
    const v = this.viewer;
    v.ground.setPathTracing(true, v.env.bgColor);
    // Let the "preparing" badge paint, then build the BVH synchronously (no worker setup needed).
    await new Promise((r) => setTimeout(r, 50));
    this.pt.setScene(v.scene, v.camera);
  }

  frame(v: Viewer, dirty: boolean, interacting: boolean): boolean {
    if (!this.active) return false;

    // While moving (camera, tweens, slider drags): plain raster preview.
    if (interacting || this.building) {
      this.wasInteracting = true;
      if (dirty || this.building) v.renderRaster();
      return true;
    }

    if (this.needsScene) {
      this.needsScene = this.needsUpdate = false;
      this.building = this.rebuild().finally(() => { this.building = null; v.invalidate(); });
      v.renderRaster();
      return true;
    }
    if (this.needsUpdate) {
      this.needsUpdate = false;
      v.ground.setPathTracing(true, v.env.bgColor);
      this.pt.updateMaterials();
      this.pt.updateLights();
      this.pt.updateEnvironment();
      this.pt.updateCamera();
    } else if (this.wasInteracting) {
      this.pt.updateCamera();
    }
    this.wasInteracting = false;

    // Keep sampling until converged; one extra sample re-blits after a display-only change.
    if (this.pt.samples < this.maxSamples || this.needsRedisplay) {
      this.needsRedisplay = false;
      this.pt.renderSample();
    }
    return true;
  }

  dispose() {
    this.disable();
    this.pt.dispose();
    this.denoiseMat.dispose();
  }
}

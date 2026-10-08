// Lazy-loaded WebGPU backend: three-gpu-pathtracer's WebGPUPathTracer + Open Image Denoise (OIDN).
// Renders into its own WebGPU canvas laid over the WebGL canvas; the WebGL canvas keeps doing the raster
// preview (with our post stack) while the camera or a setting is moving.
import { WebGPURenderer } from 'three/webgpu';
import { WebGPUPathTracer, OIDNDenoiser } from 'three-gpu-pathtracer/webgpu';
import { initUNetFromURL } from 'oidn-web';
import type { Viewer } from './viewer';
import type { PathTracerBackend, PathTracerStatus } from './pathtracerTypes';

/** OIDN guided model (colour + albedo + normal), served from public/denoise/. */
const WEIGHTS_URL = `${import.meta.env.BASE_URL}denoise/rt_hdr_alb_nrm.tza`;

export const webgpuAvailable = () => typeof navigator !== 'undefined' && 'gpu' in navigator;

export class WebGPUPathTracerController implements PathTracerBackend {
  active = false;
  denoiseStrength = 0; // not used: OIDN has no strength knob
  private readonly pt: WebGPUPathTracer;
  private readonly denoiser: OIDNDenoiser;
  private readonly canvas: HTMLCanvasElement;
  private readonly resizeObserver: ResizeObserver;
  private _denoise = true;
  private _maxSamples = 256;
  private samples = 0;
  private polling = false;
  private frameCount = 0;
  private needsScene = true;
  private needsUpdate = false;
  private wasInteracting = false;
  private building: Promise<void> | null = null;
  private readonly onChanged = () => { this.needsUpdate = true; this.viewer.markInteracting(180); };
  private readonly onModel = () => { this.needsScene = true; };

  static async create(viewer: Viewer, touch: boolean) {
    const renderer = new WebGPURenderer({ antialias: false, alpha: false });
    await renderer.init();
    return new WebGPUPathTracerController(viewer, renderer, touch);
  }

  private constructor(private viewer: Viewer, private renderer: WebGPURenderer, touch: boolean) {
    this.canvas = renderer.domElement;
    this.canvas.className = 'pt-canvas';
    viewer.container.appendChild(this.canvas);

    const pt = (this.pt = new WebGPUPathTracer(renderer));
    pt.maxBounces = 6;
    pt.maxSamples = this._maxSamples;
    pt.renderScale = touch ? 0.5 : 1;
    pt.renderDelay = 0;
    pt.fadeDuration = 250;
    pt.dynamicLowRes = true; // blurry path-traced preview for the first samples instead of a raster

    this.denoiser = new OIDNDenoiser({ initUNetFromURL, auxWeightsUrl: WEIGHTS_URL });
    pt.setDenoiser(this.denoiser);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(viewer.container);
    this.resize();
  }

  get maxSamples() { return this._maxSamples; }
  set maxSamples(v: number) { this._maxSamples = v; this.pt.maxSamples = v; }
  get bounces() { return this.pt.maxBounces; }
  set bounces(v: number) { this.pt.maxBounces = v; }
  get renderScale() { return this.pt.renderScale; }
  set renderScale(v: number) { this.pt.renderScale = v; }
  get denoise() { return this._denoise; }
  set denoise(v: boolean) {
    if (v === this._denoise) return;
    this._denoise = v;
    this.pt.setDenoiser(v ? this.denoiser : null);
  }

  private resize() {
    const c = this.viewer.container;
    this.renderer.setPixelRatio(this.viewer.renderer.getPixelRatio());
    this.renderer.setSize(c.clientWidth, c.clientHeight);
  }

  private show(on: boolean) {
    this.canvas.classList.toggle('visible', on);
  }

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
    this.show(false);
    if (v.frameHandler === this) v.frameHandler = null;
    v.listeners.changed.delete(this.onChanged);
    v.listeners.model.delete(this.onModel);
    v.listeners.geometry.delete(this.onModel);
    v.env.setPathTracing(false);
    v.ground.setPathTracing(false, v.env.bgColor);
    v.invalidate(2);
  }

  reset() {
    this.pt.reset();
    this.samples = 0;
    this.viewer.invalidate();
  }

  redisplay() { this.reset(); }

  private get settled() {
    return this.samples >= this._maxSamples && (!this._denoise || this.denoiser.complete);
  }

  status(): PathTracerStatus {
    const state = this.building || this.needsScene ? 'preparing'
      : this.viewer.interacting ? 'preview'
      : this.samples < this._maxSamples ? 'converging'
      : this._denoise && !this.denoiser.complete ? 'denoising'
      : 'converged';
    return { samples: this.samples, max: this._maxSamples, state };
  }

  private async rebuild() {
    const v = this.viewer;
    v.ground.setPathTracing(true, v.env.bgColor);
    await new Promise((r) => setTimeout(r, 50));
    this.pt.setScene(v.scene, v.camera);
    this.samples = 0;
  }

  frame(v: Viewer, dirty: boolean, interacting: boolean): boolean {
    if (!this.active) return false;

    if (interacting || this.building) {
      this.wasInteracting = true;
      this.show(false);
      if (dirty || this.building) v.renderRaster();
      return true;
    }

    if (this.needsScene) {
      this.needsScene = this.needsUpdate = false;
      this.building = this.rebuild().finally(() => { this.building = null; v.invalidate(); });
      v.renderRaster();
      return true;
    }

    // Keep output identical to the raster view's tone mapping/exposure.
    this.renderer.toneMapping = v.renderer.toneMapping;
    this.renderer.toneMappingExposure = v.renderer.toneMappingExposure;

    if (this.needsUpdate) {
      this.needsUpdate = false;
      v.ground.setPathTracing(true, v.env.bgColor);
      this.pt.updateMaterials();
      this.pt.updateLights();
      this.pt.updateEnvironment();
      this.pt.updateCamera();
      this.samples = 0;
    } else if (this.wasInteracting) {
      this.pt.updateCamera();
      this.samples = 0;
    }
    this.wasInteracting = false;

    if (!this.settled) {
      this.pt.renderSample();
      this.show(true);
      // Sample counts live on the GPU; read them back every few frames.
      if (!this.polling && this.frameCount++ % 6 === 0) {
        this.polling = true;
        this.pt.getSampleCountsAsync().then((c) => { this.samples = Math.floor(c.min); }).finally(() => { this.polling = false; });
      }
    }
    return true;
  }

  dispose() {
    this.disable();
    this.resizeObserver.disconnect();
    this.pt.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

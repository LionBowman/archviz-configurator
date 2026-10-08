import { Camera, HalfFloatType, Object3D, Scene, Vector2, Vector3, WebGLRenderer } from 'three';
import {
  BlendFunction, BloomEffect, BrightnessContrastEffect, ChromaticAberrationEffect, DepthOfFieldEffect, EffectComposer,
  EffectPass, HueSaturationEffect, NoiseEffect, OutlineEffect, RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect,
  ToneMappingMode, VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

export type ToneMapName = 'AgX' | 'ACES' | 'Neutral';
export const TONE_MODES: Record<ToneMapName, ToneMappingMode> = {
  AgX: ToneMappingMode.AGX, ACES: ToneMappingMode.ACES_FILMIC, Neutral: ToneMappingMode.NEUTRAL,
};
export type AOQuality = 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra';

/**
 * Pass chain (each EffectPass may hold only one convolution effect):
 *   Render → N8AO → [DOF] → [outline, bloom, tone map] → [chromatic aberration] → [SMAA] → [grade, vignette, grain]
 * Grading, vignette and grain run after tone mapping and SMAA, like a camera/film finish.
 */
export class Post {
  readonly composer: EffectComposer;
  readonly ao: N8AOPostPass;
  readonly smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });
  readonly bloom = new BloomEffect({ intensity: 0.12, luminanceThreshold: 0.92, luminanceSmoothing: 0.2, mipmapBlur: true, radius: 0.6 });
  readonly tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  readonly outline: OutlineEffect;
  readonly dof: DepthOfFieldEffect;
  readonly ca = new ChromaticAberrationEffect({ offset: new Vector2(), radialModulation: true, modulationOffset: 0.25 });
  readonly grade = new BrightnessContrastEffect();
  readonly saturation = new HueSaturationEffect();
  readonly vignette = new VignetteEffect({ offset: 0.35, darkness: 0.35 });
  readonly grain = new NoiseEffect({ premultiply: true, blendFunction: BlendFunction.SCREEN });

  /** Scene units per metre (set by the viewer when a model loads) – DOF ranges are given in metres. */
  unitsPerMetre = 1;

  settings = {
    ao: true, aoIntensity: 2.2, aoRadius: 1.2, aoQuality: 'Medium' as AOQuality,
    smaa: true,
    /** Hardware multisampling of the scene render. Smooths thin sub-pixel slivers SMAA can't (e.g. the
     *  model's flush, coplanar frame profiles, which otherwise shimmer as wavy lines). */
    msaa: 4,
    bloom: true, bloomIntensity: 0.12, bloomThreshold: 0.92,
    dof: false, dofRange: 3, dofBokeh: 2,
    ca: false, caAmount: 0.6,
    vignette: false, vignetteDarkness: 0.35,
    grain: false, grainAmount: 0.06,
    grading: false, contrast: 0, saturation: 0, brightness: 0,
  };

  constructor(renderer: WebGLRenderer, private scene: Scene, private camera: Camera) {
    this.composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: Math.min(4, renderer.capabilities.maxSamples) });
    const { width, height } = renderer.getDrawingBufferSize(new Vector2());
    this.ao = new N8AOPostPass(scene, camera, width || 1, height || 1);
    this.ao.configuration.gammaCorrection = false;
    this.ao.configuration.transparencyAware = true;
    this.ao.setQualityMode('Medium');
    this.outline = new OutlineEffect(scene, camera, {
      edgeStrength: 3, visibleEdgeColor: 0x2f7dff, hiddenEdgeColor: 0x2f7dff, blur: true, xRay: false,
    });
    this.dof = new DepthOfFieldEffect(camera, { focusDistance: 10, focusRange: 3, bokehScale: 2 });
    this.rebuild();
  }

  /** Autofocus point for depth of field (the orbit target / walk look-at point). */
  setFocusTarget(target: Vector3) {
    this.dof.target = target;
  }

  setQuality(mode: AOQuality) {
    this.settings.aoQuality = mode;
    this.ao.setQualityMode(mode);
  }

  setSelection(objects: Object3D[]) {
    this.outline.selection.set(objects);
  }

  /** Push slider values onto the effects (cheap; no pass rebuild). */
  applyParams() {
    const s = this.settings;
    this.ao.configuration.intensity = s.aoIntensity;
    this.ao.configuration.aoRadius = s.aoRadius;
    this.ao.configuration.distanceFalloff = s.aoRadius * 0.5;
    this.bloom.intensity = s.bloom ? s.bloomIntensity : 0;
    this.bloom.luminanceMaterial.threshold = s.bloomThreshold;
    this.dof.cocMaterial.focusRange = s.dofRange * this.unitsPerMetre;
    this.dof.bokehScale = s.dofBokeh;
    const caOffset = s.caAmount * 0.001;
    this.ca.offset.set(caOffset, caOffset);
    this.vignette.darkness = s.vignetteDarkness;
    this.grain.blendMode.opacity.value = s.grainAmount;
    this.grade.contrast = s.contrast;
    this.grade.brightness = s.brightness;
    this.saturation.saturation = s.saturation;
  }

  private moving = false;

  /** Called by the viewer: drop MSAA while the camera/scene is moving, restore it for the still frame. */
  setMotion(moving: boolean) {
    this.moving = moving;
    this.applyMsaa();
  }

  private applyMsaa() {
    const c = this.composer;
    const msaa = this.moving ? 0 : Math.min(this.settings.msaa, c.getRenderer().capabilities.maxSamples);
    if (c.multisampling !== msaa) c.multisampling = msaa;
  }

  /** Recreate the pass chain after toggles. */
  rebuild() {
    const s = this.settings;
    const c = this.composer;
    this.applyMsaa(); // clamps to the device maximum (8× isn't available everywhere)
    this.applyParams();
    c.removeAllPasses();
    c.addPass(new RenderPass(this.scene, this.camera));
    if (s.ao) c.addPass(this.ao);
    if (s.dof) c.addPass(new EffectPass(this.camera, this.dof));
    c.addPass(new EffectPass(this.camera, this.outline, ...(s.bloom ? [this.bloom] : []), this.tone));
    if (s.ca) c.addPass(new EffectPass(this.camera, this.ca));
    if (s.smaa) c.addPass(new EffectPass(this.camera, this.smaa));
    const finish = [
      ...(s.grading ? [this.grade, this.saturation] : []),
      ...(s.vignette ? [this.vignette] : []),
      ...(s.grain ? [this.grain] : []),
    ];
    if (finish.length) c.addPass(new EffectPass(this.camera, ...finish));
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h);
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}

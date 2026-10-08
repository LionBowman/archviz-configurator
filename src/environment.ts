import {
  Color, DataTexture, DataUtils, EquirectangularReflectionMapping, FloatType, LinearFilter, LoadingManager,
  MathUtils, PMREMGenerator, RGBAFormat, Scene, Texture, Vector3, WebGLRenderer,
} from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

export type BackgroundMode = 'color' | 'gradient' | 'blurred' | 'hdr';

/** All HDR/EXR files in /Hdr are discovered at build time. */
export const HDR_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob('/Hdr/*.{hdr,exr}', { query: '?url', import: 'default', eager: true }) as Record<string, string>)
    .map(([path, url]) => [path.split('/').pop()!, url]),
);

export class EnvironmentManager {
  equirect: Texture | null = null;
  private pmrem: PMREMGenerator;
  private pmremTarget: ReturnType<PMREMGenerator['fromEquirectangular']> | null = null;
  private backdrop: DataTexture;

  mode: BackgroundMode = 'gradient';
  bgColor = new Color('#f1f2f4');
  bgBrightness = 2.4;
  blur = 0.35;
  intensity = 0.53;
  /** Time-of-day multiplier. */
  factor = 1;
  rotationDeg = 82;
  /** Rotate the HDR so its own sun sits where the directional (shadow-casting) sun is. Overrides rotationDeg. */
  alignToSun = false;
  /** Direction of the HDR's brightest pixel in texture space (null if the HDR has no clear sun). */
  hdrSunDir: Vector3 | null = null;
  /** Current directional-sun direction (set by the viewer). */
  sunDir = new Vector3(0, 1, 0);
  /** Path tracer needs the raw equirect, raster uses the PMREM. */
  private pathTracing = false;

  constructor(renderer: WebGLRenderer, private scene: Scene) {
    this.pmrem = new PMREMGenerator(renderer);
    this.backdrop = new DataTexture(new Float32Array(2 * 64 * 4), 2, 64, RGBAFormat, FloatType);
    this.backdrop.mapping = EquirectangularReflectionMapping;
    this.backdrop.magFilter = this.backdrop.minFilter = LinearFilter;
  }

  async load(url: string, manager?: LoadingManager) {
    const loader = /\.exr($|\?)/i.test(url) ? new EXRLoader(manager) : new HDRLoader(manager);
    const tex = await loader.loadAsync(url);
    tex.mapping = EquirectangularReflectionMapping;
    this.equirect?.dispose();
    this.pmremTarget?.dispose();
    this.equirect = tex;
    this.hdrSunDir = findSun(tex);
    this.pmremTarget = this.pmrem.fromEquirectangular(tex);
    this.apply();
  }

  setPathTracing(on: boolean) {
    this.pathTracing = on;
    this.apply();
  }

  /** Push all state onto the scene. */
  apply() {
    const s = this.scene;
    s.environment = this.pathTracing ? this.equirect : (this.pmremTarget?.texture ?? null);
    s.environmentIntensity = this.intensity * this.factor;
    const rot = MathUtils.degToRad(this.effectiveRotationDeg);
    s.environmentRotation.set(0, rot, 0);
    s.backgroundRotation.set(0, rot, 0);

    if ((this.mode === 'blurred' || this.mode === 'hdr') && this.equirect) {
      s.background = this.equirect;
      s.backgroundBlurriness = this.mode === 'blurred' ? this.blur : 0;
      s.backgroundIntensity = s.environmentIntensity;
    } else {
      this.updateBackdrop();
      s.background = this.backdrop;
      s.backgroundBlurriness = 0;
      s.backgroundIntensity = this.bgBrightness;
    }
  }

  /** Rotation actually applied: aligned to the sun, or the manual value. */
  get effectiveRotationDeg() {
    if (!this.alignToSun || !this.hdrSunDir) return this.rotationDeg;
    // environmentRotation.y = θ rotates texture directions by θ about Y (azimuth measured as atan2(x, z)).
    const az = (d: Vector3) => Math.atan2(d.x, d.z);
    return MathUtils.radToDeg(az(this.sunDir) - az(this.hdrSunDir));
  }

  /** Neutral studio backdrop as a tiny equirect texture (works in raster + path tracer). */
  private updateBackdrop() {
    const data = this.backdrop.image.data as Float32Array;
    const c = this.bgColor;
    const h = 64;
    const gradient = this.mode === 'gradient';
    for (let y = 0; y < h; y++) {
      const e = (y / (h - 1)) * 2 - 1; // -1 bottom .. 1 top
      const k = !gradient ? 1 : e >= 0 ? MathUtils.lerp(1, 0.78, Math.pow(e, 0.7)) : MathUtils.lerp(1, 0.9, -e);
      for (let x = 0; x < 2; x++) {
        const i = (y * 2 + x) * 4;
        data[i] = c.r * k; data[i + 1] = c.g * k; data[i + 2] = c.b * k; data[i + 3] = 1;
      }
    }
    this.backdrop.needsUpdate = true;
  }

  /** Linear backdrop colour as seen at the horizon (used for the path-traced floor). */
  get horizonColor() {
    return this.bgColor;
  }
}

/**
 * Texture-space direction of an HDR's sun (its brightest pixel), inverse of three's equirect lookup:
 * u = atan(z, x) / 2π + 0.5, v = asin(y) / π + 0.5. Returns null when nothing stands out (overcast HDRs).
 */
function findSun(tex: Texture): Vector3 | null {
  const img = tex.image as { data: ArrayLike<number>; width: number; height: number };
  if (!img?.data) return null;
  const half = img.data instanceof Uint16Array;
  const get = (i: number) => (half ? DataUtils.fromHalfFloat(img.data[i]) : img.data[i]);
  const { width: W, height: H } = img;
  let best = 0, bx = 0, by = 0, sum = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const l = 0.2126 * get(i) + 0.7152 * get(i + 1) + 0.0722 * get(i + 2);
    sum += l;
    if (l > best) { best = l; bx = x; by = y; }
  }
  if (best < 50 * (sum / (W * H))) return null;
  const u = (bx + 0.5) / W;
  const v = tex.flipY ? 1 - (by + 0.5) / H : (by + 0.5) / H; // data row 0 is the top when flipY
  const phi = (u - 0.5) * 2 * Math.PI, el = (v - 0.5) * Math.PI;
  return new Vector3(Math.cos(el) * Math.cos(phi), Math.sin(el), Math.cos(el) * Math.sin(phi));
}

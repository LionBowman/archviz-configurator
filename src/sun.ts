import { Color, MathUtils, Vector3 } from 'three';

export interface SunState {
  /** Elevation above horizon, degrees. */
  elevation: number;
  /** Compass azimuth, degrees (0 = north, 90 = east), before north offset. */
  azimuth: number;
  /** Unit vector from scene origin towards the sun (world space, -Z = north). */
  direction: Vector3;
  color: Color;
  intensity: number;
  /** Multiplier for environment intensity (dimmer near dawn/dusk). */
  envFactor: number;
  kelvin: number;
}

/**
 * Simple, plausible sun model (mid-latitude summer-ish day, no date/geo):
 * sunrise ~05:30, solar noon 13:00, sunset ~20:30, max elevation ~62°.
 */
export function computeSun(hour: number, northOffsetDeg = 0, peakIntensity = 4): SunState {
  const rise = 5.5, set = 20.5, maxElev = 62;
  const t = MathUtils.clamp((hour - rise) / (set - rise), 0, 1);
  const elevation = Math.max(1.5, maxElev * Math.sin(Math.PI * t));
  const azimuth = 70 + 220 * t; // ENE at sunrise → S at noon → WNW at sunset

  const az = MathUtils.degToRad(azimuth + northOffsetDeg);
  const el = MathUtils.degToRad(elevation);
  // north = -Z, east = +X
  const direction = new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();

  // Colour temperature: ~2200K at horizon → ~5800K high sun.
  const kelvin = 2200 + 3600 * (1 - Math.exp(-elevation / 14));
  const color = kelvinToRGB(kelvin, new Color());

  // Air-mass-ish attenuation.
  const s = Math.sin(el);
  const intensity = peakIntensity * Math.pow(s, 0.6) * MathUtils.smoothstep(elevation, 0, 8);
  const envFactor = 0.45 + 0.55 * MathUtils.smoothstep(elevation, 0, 30);

  return { elevation, azimuth, direction, color, intensity, envFactor, kelvin };
}

/** Tanner Helland black-body approximation, returns linear-ish sRGB Color. */
export function kelvinToRGB(kelvin: number, target: Color): Color {
  const t = kelvin / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v: number) => MathUtils.clamp(v, 0, 255) / 255;
  return target.setRGB(c(r), c(g), c(b), 'srgb');
}

export function formatHour(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm === 60 ? 0 : mm).padStart(2, '0')}`;
}

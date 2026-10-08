import { Material, MeshPhysicalMaterial, ShaderChunk } from 'three';

/** Default reflection boost for glazing: F0 4% → ~8% so reflections read when looking at glass head-on. */
export const GLASS_REFLECTION = 2;
/** three.js clamps IOR to [1, 2.333]; that caps "reflection" at 4 (F0 ≈ 16%). */
const MAX_IOR = 2.333;

/*
 * "Reflection" is head-on reflectance relative to plain glass (F0 = 4% at IOR 1.5), driven through IOR.
 * Not specularIntensity: it also scales F90, so values > 1 reflect > 100% at grazing angles and
 * the transmitted light goes negative (shallow roof glazing rendered black). IOR keeps F90 = 1, and both
 * path tracers understand it.
 */
export function reflectionToIor(r: number) {
  const s = Math.sqrt(Math.max(0, r) * 0.04);
  return Math.min(MAX_IOR, (1 + s) / (1 - s));
}
export function iorToReflection(ior: number) {
  return ((ior - 1) / (ior + 1)) ** 2 / 0.04;
}

/**
 * three.js reads the "behind the glass" buffer with a bicubic B-spline filter, which visibly softens the
 * view through glass even at roughness 0 (and compounds on double-sided panes). For smooth glass use a plain
 * bilinear read of the full-resolution level; rough/frosted glass keeps three's blur. Call before any compile.
 */
export function patchTransmissionSampling() {
  const from = 'return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );';
  const chunk = ShaderChunk.transmission_pars_fragment;
  if (chunk.includes('archviz')) return;
  if (!chunk.includes(from)) { console.warn('glass: three transmission chunk changed; sharp sampling not applied'); return; }
  (ShaderChunk as Record<string, string>).transmission_pars_fragment = chunk.replace(from,
    // Keyed on roughness, not LOD: three clamps roughness to >= 0.0525, which alone gives LOD ~0.6.
    `if ( roughness < 0.08 ) return textureLod( transmissionSamplerMap, fragCoord.xy, 0.0 ); // archviz: sharp smooth glass\n\t\t${from}`);
}

export function isGlass(m: Material) {
  return (m as MeshPhysicalMaterial).transmission > 0;
}

/** Architectural glazing defaults: thin (no refraction offset), smooth, and a little more reflective. */
export function tuneGlass(m: MeshPhysicalMaterial) {
  if (!isGlass(m)) return;
  m.ior = Math.max(m.ior, reflectionToIor(GLASS_REFLECTION));
}

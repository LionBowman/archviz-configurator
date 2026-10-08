import { ShaderChunk } from 'three';

/**
 * Stable, grain-free soft sun shadows.
 *
 * three.js r186 PCF takes only 5 shadow-map samples and rotates them per *screen pixel* (interleaved gradient
 * noise on gl_FragCoord). Without temporal AA that shows as grey mottling/rippling along soft shadow edges on
 * large flat faces (e.g. the eaves' shadow on the white frame posts), and the grain crawls as the camera
 * moves. Replace it for directional/spot lights with 16 Vogel-disk samples in a fixed pattern: each tap is
 * still hardware-filtered (2×2), so edges are smooth and stay put. Point-light shadows keep three's version.
 * Call before any material compiles.
 */
export function patchShadowFiltering() {
  const chunk = ShaderChunk.shadowmap_pars_fragment;
  if (chunk.includes('archviz')) return;
  // Anchored on code, not comments: three's build strips GLSL comments from its chunks.
  const re = /float phi = interleavedGradientNoise\( gl_FragCoord\.xy \) \* PI2;\s*shadow = \(\s*texture\( shadowMap, vec3\([\s\S]*?\) \* 0\.2;/;
  if (!re.test(chunk)) { console.warn('shadows: three PCF chunk changed; stable filtering not applied'); return; }
  (ShaderChunk as Record<string, string>).shadowmap_pars_fragment = chunk.replace(re, `// archviz: 16 fixed Vogel taps (no per-pixel noise) → smooth, stable soft shadows
				shadow = 0.0;
				for ( int i = 0; i < 16; i ++ ) {
					shadow += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( i, 16, 0.0 ) * radius, shadowCoord.z ) );
				}
				shadow *= 0.0625;`);
}

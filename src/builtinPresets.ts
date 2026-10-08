import type { Preset } from './presets';

/** Leo's start view for project.glb (also the model's "home" camera view). */
const LEO_CAMERA = { position: [-5.796, 1.686, 6.197], target: [-0.002, 1.431, -0.002], fov: 35 };

/**
 * Read-only presets shipped with the app (listed with a ★, can't be overwritten/deleted; save a copy instead).
 * Presets store only differences from the defaults, which since this release *are* "Leo Test".
 */
export const BUILT_IN_PRESETS: (Preset & { builtIn: true; note: string })[] = [
  {
    builtIn: true,
    name: '★ Default (Leo Test)',
    note: 'The app defaults: 11:30 sun, north 39°, sun 3.3, field.hdr at 0.53 / 82°.',
    savedAt: '2026-10-08T15:29:40.987Z',
    model: 'project.glb',
    scene: {},
    materials: {},
    camera: LEO_CAMERA,
  },
  {
    builtIn: true,
    name: '★ Photoreal (suggested)',
    note: 'Leo Test, plus: garden HDRI aligned to the sun, crisper shadows, camera-style post, stronger surface relief and glass reflections.',
    savedAt: '2026-10-08T18:00:00.000Z',
    model: 'project.glb',
    scene: {
      // Environment: residential garden HDRI with a crisp sun, rotated so its sun matches the shadow-casting sun
      'Environment/hdr': 'suburban_garden_2k.hdr',
      'Environment/alignToSun': true,
      'Environment/intensity': 0.6,
      // Sun: same time/orientation as Leo Test; clear-sky sun → slightly crisper, higher-resolution shadows
      'Lighting & Time/sunPeak': 3.0,
      'Lighting & Time/shadowSoftness': 2.5,
      'Lighting & Time/res': 4096,
      // Post: the "Photoreal look" camera finish (DOF off for exterior shots)
      'Post/ao': true, 'Post/aoQuality': 'High', 'Post/aoIntensity': 2.6, 'Post/aoRadius': 1.4,
      'Post/bloom': true, 'Post/bloomIntensity': 0.18, 'Post/bloomThreshold': 0.85,
      'Post/ca': true, 'Post/caAmount': 0.5,
      'Post/vignette': true, 'Post/vignetteDarkness': 0.3,
      'Post/grading': true, 'Post/contrast': 0.08, 'Post/saturation': -0.04,
      'Post/grain': true, 'Post/grainAmount': 0.035,
    },
    materials: {
      // Grout and brick joints read as recessed; glazing reflects the garden head-on
      Paving: { params: { normal: 2.2 } },
      ExternalBrick: { params: { normal: 1.5 } },
      'glass.000': { params: { reflection: 2.5 } },
    },
    camera: LEO_CAMERA,
  },
];

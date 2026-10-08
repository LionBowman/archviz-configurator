import type { Material, MeshStandardMaterial, Texture } from 'three';

/** Below this RMS deviation (0–255 units) a normal map carries no visible relief, only compression noise. */
const FLAT_THRESHOLD = 2;

/**
 * Drop normal maps that are effectively flat. Some exported materials (here the uPVC frames and roof panels)
 * carry a near-uniform normal map whose only real content is JPEG 8×8 block noise; stretched along long
 * frame posts it renders as grey horizontal blotches. Measured once per texture on load.
 */
export function dropFlatNormalMaps(materials: Iterable<Material>) {
  const cache = new Map<Texture, number>();
  for (const mat of materials) {
    const m = mat as MeshStandardMaterial;
    if (!m.normalMap) continue;
    const dev = cache.get(m.normalMap) ?? normalDeviation(m.normalMap);
    cache.set(m.normalMap, dev);
    if (dev >= FLAT_THRESHOLD) continue;
    m.normalMap = null;
    m.userData.flatNormalDropped = dev;
    m.needsUpdate = true;
    console.info(`[materials] ${m.name}: normal map is flat (deviation ${dev.toFixed(2)}), disabled to avoid compression artefacts`);
  }
}

function normalDeviation(tex: Texture): number {
  const img = tex.image as CanvasImageSource & { width: number; height: number };
  if (!img?.width) return Infinity; // unknown → keep
  const w = Math.min(img.width, 1024), h = Math.min(img.height, 1024);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return Infinity;
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < d.length; i += 4 * 7) {
    const x = d[i] - 128, y = d[i + 1] - 128;
    sx += x; sy += y; sxx += x * x; syy += y * y; n++;
  }
  return Math.sqrt((sxx / n - (sx / n) ** 2 + syy / n - (sy / n) ** 2) / 2);
}

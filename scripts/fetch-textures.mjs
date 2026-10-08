// Downloads a small curated CC0 PBR texture set (2k JPG) from Poly Haven into public/textures/.
// Usage: node scripts/fetch-textures.mjs [--dry-run] [--force]
// Glass and metal trim are procedural (no textures needed) — see src/materials.ts.
import { mkdir, writeFile, access } from 'fs/promises';

const RES = '2k';
const OUT = 'public/textures';

/** id → { category, displacement? } */
export const SET = {
  red_brick_03:           { name: 'Red brick',            category: 'Brick',    displacement: true },
  brick_wall_001:         { name: 'Buff brick',           category: 'Brick',    displacement: true },
  red_bricks_04:          { name: 'Weathered brick',      category: 'Brick',    displacement: true },
  white_plaster_02:       { name: 'White render',         category: 'Render' },
  painted_plaster_wall:   { name: 'Painted plaster',      category: 'Render' },
  exterior_wall_cladding: { name: 'Timber cladding',      category: 'Timber' },
  japanese_cedar_planks:  { name: 'Cedar planks',         category: 'Timber' },
  roof_slates_02:         { name: 'Slate roof',           category: 'Roof',     displacement: true },
  clay_roof_tiles_02:     { name: 'Clay roof tiles',      category: 'Roof',     displacement: true },
  concrete_floor_01:      { name: 'Smooth concrete',      category: 'Concrete' },
};

// Poly Haven map key → our file name
const MAPS = { Diffuse: 'albedo', nor_gl: 'normal', Rough: 'roughness', AO: 'ao', Displacement: 'height' };

const dry = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const exists = (p) => access(p).then(() => true, () => false);

const manifest = {};
let total = 0;
for (const [id, meta] of Object.entries(SET)) {
  const files = await (await fetch(`https://api.polyhaven.com/files/${id}`)).json();
  const info = await (await fetch(`https://api.polyhaven.com/info/${id}`)).json();
  const maps = {};
  const jobs = [];
  for (const [key, out] of Object.entries(MAPS)) {
    if (key === 'Displacement' && !meta.displacement) continue;
    const f = files[key]?.[RES]?.jpg;
    if (!f) continue;
    maps[out] = `${id}/${out}.jpg`;
    jobs.push({ url: f.url, size: f.size, path: `${OUT}/${id}/${out}.jpg` });
  }
  const size = jobs.reduce((a, j) => a + j.size, 0);
  total += size;
  // dimensions = [width, height] in mm → real-world tile size in metres for UV scaling
  const dims = info.dimensions ? info.dimensions.map((d) => d / 1000) : [2, 2];
  manifest[id] = { ...meta, maps, size: dims };
  console.log(`${dry ? '[dry] ' : ''}${meta.category.padEnd(9)} ${id.padEnd(24)} ${Object.keys(maps).join(', ').padEnd(40)} ${(size / 1e6).toFixed(1)} MB`);
  if (dry) continue;
  await mkdir(`${OUT}/${id}`, { recursive: true });
  for (const j of jobs) {
    if (!force && (await exists(j.path))) continue;
    const res = await fetch(j.url);
    if (!res.ok) throw new Error(`${res.status} ${j.url}`);
    await writeFile(j.path, Buffer.from(await res.arrayBuffer()));
  }
}
console.log(`Total: ${(total / 1e6).toFixed(1)} MB${dry ? ' (dry run, nothing downloaded)' : ''}`);
if (!dry) {
  await writeFile(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
  await writeFile(`${OUT}/LICENSE.txt`, 'All textures: CC0 1.0, Poly Haven (https://polyhaven.com/license)\n');
  console.log(`Wrote ${OUT}/manifest.json`);
}

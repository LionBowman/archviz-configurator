// Downloads a small set of CC0 furniture models (glTF, 1k textures) from Poly Haven into public/furniture/.
// Usage: node scripts/fetch-furniture.mjs [--dry-run] [--force]
// Placement lives in src/furniture.ts; models are real-world scale in metres.
import { mkdir, writeFile, access } from 'fs/promises';
import { dirname } from 'path';

const RES = '1k';
const OUT = 'public/furniture';
export const MODELS = [
  'sofa_02', 'modern_arm_chair_01', 'coffee_table_round_01', 'side_table_01',
  'potted_plant_02', 'potted_plant_04', 'round_wooden_table_01', 'dining_chair_02',
];

const dry = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const exists = (p) => access(p).then(() => true, () => false);

const manifest = {};
let total = 0;
for (const id of MODELS) {
  const files = await (await fetch(`https://api.polyhaven.com/files/${id}`)).json();
  const g = files.gltf?.[RES]?.gltf;
  if (!g) { console.warn(`skip ${id}: no ${RES} glTF`); continue; }
  const jobs = [{ url: g.url, path: `${OUT}/${id}/${id}.gltf`, size: g.size }];
  for (const [rel, f] of Object.entries(g.include ?? {})) jobs.push({ url: f.url, path: `${OUT}/${id}/${rel}`, size: f.size });
  const size = jobs.reduce((a, j) => a + j.size, 0);
  total += size;
  manifest[id] = `${id}/${id}.gltf`;
  console.log(`${dry ? '[dry] ' : ''}${id.padEnd(24)} ${String(jobs.length).padStart(2)} files ${(size / 1e6).toFixed(1)} MB`);
  if (dry) continue;
  for (const j of jobs) {
    if (!force && (await exists(j.path))) continue;
    const res = await fetch(j.url);
    if (!res.ok) throw new Error(`${res.status} ${j.url}`);
    await mkdir(dirname(j.path), { recursive: true });
    await writeFile(j.path, Buffer.from(await res.arrayBuffer()));
  }
}
console.log(`Total: ${(total / 1e6).toFixed(1)} MB${dry ? ' (dry run)' : ''}`);
if (!dry) {
  await writeFile(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
  await writeFile(`${OUT}/LICENSE.txt`, 'All models: CC0 1.0, Poly Haven (https://polyhaven.com/license)\n');
}

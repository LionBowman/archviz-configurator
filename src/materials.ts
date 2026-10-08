import { tuneGlass } from './glass';
import {
  BufferAttribute, BufferGeometry, Color, Matrix4, Vector3, DoubleSide, LoadingManager, Material, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, NoColorSpace,
  RepeatWrapping, SRGBColorSpace, Texture, TextureLoader, Vector2, WebGLRenderer,
} from 'three';

export type MapKind = 'albedo' | 'normal' | 'roughness' | 'ao' | 'height';

export interface LibraryEntry {
  id: string;
  name: string;
  category: string;
  /** Base colour (tint when textured, full colour when procedural/fallback). */
  color: string;
  roughness: number;
  metalness: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  transmission?: number;
  ior?: number;
  thickness?: number;
  /** Texture paths relative to /textures, filled from manifest.json. */
  maps?: Partial<Record<MapKind, string>>;
  /** Real-world size of one texture tile in metres. */
  size?: [number, number];
  /** Default displacement scale (metres) when a height map exists. Off by default – needs dense meshes. */
  displacement?: number;
}

/**
 * Curated library. Textured entries match scripts/fetch-textures.mjs; until those are fetched
 * they fall back to the flat colour/roughness below so the demo always works.
 */
const LIBRARY: LibraryEntry[] = [
  { id: 'red_brick_03', name: 'Red brick', category: 'Brick', color: '#8a4a3a', roughness: 0.9, metalness: 0 },
  { id: 'brick_wall_001', name: 'Buff brick', category: 'Brick', color: '#b89a7a', roughness: 0.9, metalness: 0 },
  { id: 'red_bricks_04', name: 'Weathered brick', category: 'Brick', color: '#7d4636', roughness: 0.92, metalness: 0 },
  { id: 'white_plaster_02', name: 'White render', category: 'Render', color: '#ecebe6', roughness: 0.85, metalness: 0 },
  { id: 'painted_plaster_wall', name: 'Painted plaster', category: 'Render', color: '#ddd8cc', roughness: 0.8, metalness: 0 },
  { id: 'exterior_wall_cladding', name: 'Timber cladding', category: 'Timber', color: '#8b6a4a', roughness: 0.75, metalness: 0 },
  { id: 'japanese_cedar_planks', name: 'Cedar planks', category: 'Timber', color: '#9a6b47', roughness: 0.7, metalness: 0 },
  { id: 'roof_slates_02', name: 'Slate roof', category: 'Roof', color: '#3c4044', roughness: 0.7, metalness: 0 },
  { id: 'clay_roof_tiles_02', name: 'Clay roof tiles', category: 'Roof', color: '#9a4f35', roughness: 0.8, metalness: 0 },
  { id: 'concrete_floor_01', name: 'Smooth concrete', category: 'Concrete', color: '#a7a6a2', roughness: 0.8, metalness: 0 },
  // Procedural
  { id: 'glass_clear', name: 'Clear glass', category: 'Glass', color: '#f4faf7', roughness: 0.02, metalness: 0, transmission: 1, ior: 1.52, thickness: 0.01 },
  { id: 'glass_tinted', name: 'Solar-tint glass', category: 'Glass', color: '#9fb3b8', roughness: 0.03, metalness: 0, transmission: 0.92, ior: 1.52, thickness: 0.01 },
  { id: 'alu_anthracite', name: 'Anthracite alu (RAL 7016)', category: 'Metal trim', color: '#383e42', roughness: 0.42, metalness: 0.85, clearcoat: 0.4, clearcoatRoughness: 0.3 },
  { id: 'alu_brushed', name: 'Brushed aluminium', category: 'Metal trim', color: '#c9ccce', roughness: 0.28, metalness: 1 },
  { id: 'upvc_white', name: 'White uPVC', category: 'Metal trim', color: '#f3f3f1', roughness: 0.38, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.25 },
];

const MAP_SLOTS: Record<MapKind, 'map' | 'normalMap' | 'roughnessMap' | 'aoMap' | 'displacementMap'> = {
  albedo: 'map', normal: 'normalMap', roughness: 'roughnessMap', ao: 'aoMap', height: 'displacementMap',
};
const TEXTURE_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'displacementMap', 'emissiveMap', 'clearcoatNormalMap', 'bumpMap'] as const;

export class MaterialLibrary {
  readonly entries: LibraryEntry[] = LIBRARY.map((e) => ({ ...e }));
  texturesAvailable = false;
  private loader: TextureLoader;
  private cache = new Map<string, Promise<Texture>>();
  private maxAniso: number;

  constructor(renderer: WebGLRenderer, manager?: LoadingManager) {
    this.loader = new TextureLoader(manager);
    this.maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }

  /** Reads public/textures/manifest.json (written by scripts/fetch-textures.mjs) if present. */
  async init() {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}textures/manifest.json`);
      if (!res.ok || !res.headers.get('content-type')?.includes('json')) return;
      const manifest = (await res.json()) as Record<string, { maps: LibraryEntry['maps']; size?: [number, number] }>;
      for (const e of this.entries) {
        const m = manifest[e.id];
        if (!m) continue;
        e.maps = m.maps;
        e.size = m.size;
        e.color = '#ffffff';
        this.texturesAvailable = true;
      }
    } catch { /* no textures fetched – flat fallbacks */ }
  }

  get(id: string) {
    return this.entries.find((e) => e.id === id);
  }

  private loadTexture(path: string, srgb: boolean): Promise<Texture> {
    const url = `${import.meta.env.BASE_URL}textures/${path}`;
    let p = this.cache.get(url);
    if (!p) {
      p = this.loader.loadAsync(url).then((t) => {
        t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
        t.wrapS = t.wrapT = RepeatWrapping;
        t.anisotropy = this.maxAniso;
        return t;
      });
      this.cache.set(url, p);
    }
    // Each material gets its own Texture object (own repeat) sharing the same GPU source.
    return p.then((t) => t.clone());
  }

  /** Build a MeshPhysicalMaterial from a library entry. `metresPerUV` converts the mesh's UV space into metres. */
  async create(id: string, metresPerUV = 1): Promise<MeshPhysicalMaterial> {
    const e = this.get(id)!;
    const m = new MeshPhysicalMaterial({
      name: e.name, color: new Color(e.color), roughness: e.roughness, metalness: e.metalness,
      clearcoat: e.clearcoat ?? 0, clearcoatRoughness: e.clearcoatRoughness ?? 0,
      transmission: e.transmission ?? 0, ior: e.ior ?? 1.5, thickness: e.thickness ?? 0,
    });
    if (m.transmission > 0) { m.side = DoubleSide; m.envMapIntensity = 1; }
    if (e.maps) {
      const loaded = await Promise.all(Object.entries(e.maps).map(async ([kind, path]) =>
        [kind as MapKind, await this.loadTexture(path!, kind === 'albedo')] as const));
      for (const [kind, tex] of loaded) (m as any)[MAP_SLOTS[kind]] = tex;
      m.roughness = 1; // roughness map carries the value
      if (m.displacementMap) { m.displacementScale = 0; m.displacementBias = 0; }
    }
    tuneGlass(m);
    m.userData.libraryId = id;
    // Default UV scale: tiles at real-world size.
    const tile = e.size?.[0] ?? 1;
    setUVScale(m, e.maps ? metresPerUV / tile : 1);
    return m;
  }
}

/** Uniform UV repeat across all maps of a material (clones shared textures on first use). */
export function setUVScale(m: Material, scale: number) {
  m.userData.uvScale = scale;
  for (const key of TEXTURE_KEYS) {
    const t = (m as any)[key] as Texture | null;
    if (!t) continue;
    if (!t.userData.owned) {
      const c = t.clone();
      c.userData.owned = true;
      c.wrapS = c.wrapT = RepeatWrapping;
      (m as any)[key] = c;
      m.userData.ownsTextures = true;
    }
    const tex = (m as any)[key] as Texture;
    // Wall-projected UVs run v = +height. glTF textures (flipY=false) have image-top at v=0, so they need a V flip
    // to stand upright; TextureLoader textures (flipY=true) are already upright. User "flip" inverts on top.
    const auto = m.userData.wallUV && !tex.flipY ? -1 : 1;
    tex.repeat.set(scale, scale * auto * (m.userData.flipV ? -1 : 1));
  }
  m.needsUpdate = true;
}

/**
 * Replace a mesh's UVs with a "wall projection" in real-world metres: v = height, u = distance along the
 * wall's horizontal tangent (per triangle, so angled bays aren't stretched). Brick courses therefore line up
 * across every corner. Horizontal faces (sills, copings) get a plan (x/z) projection.
 * Returns metres per UV unit (always 1). Original geometry is kept for restoreModelUVs().
 */
export function applyWallUVs(mesh: Mesh, modelScale: number): number {
  const src = (mesh.userData.modelGeometry as BufferGeometry | undefined) ?? mesh.geometry;
  mesh.userData.modelGeometry = src;
  const g = src.index ? src.toNonIndexed() : src.clone(); // corners need split vertices
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  mesh.updateWorldMatrix(true, false);
  const toMetres = mesh.matrixWorld.clone().premultiply(new Matrix4().makeScale(1 / modelScale, 1 / modelScale, 1 / modelScale));
  const p = [new Vector3(), new Vector3(), new Vector3()];
  const n = new Vector3(), t = new Vector3(), e1 = new Vector3(), e2 = new Vector3();
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i + 2 < pos.count; i += 3) {
    for (let k = 0; k < 3; k++) p[k].fromBufferAttribute(pos, i + k).applyMatrix4(toMetres);
    n.crossVectors(e1.subVectors(p[1], p[0]), e2.subVectors(p[2], p[0])).normalize();
    const horizontal = Math.abs(n.y) > 0.7;
    if (!horizontal) t.crossVectors(up, n).normalize();
    for (let k = 0; k < 3; k++) {
      uv[(i + k) * 2] = horizontal ? p[k].x : p[k].dot(t);
      uv[(i + k) * 2 + 1] = horizontal ? p[k].z : p[k].y;
    }
  }
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  if (mesh.geometry !== src) mesh.geometry.dispose();
  mesh.geometry = g;
  return 1;
}

export function restoreModelUVs(mesh: Mesh) {
  const src = mesh.userData.modelGeometry as BufferGeometry | undefined;
  if (!src || mesh.geometry === src) return;
  mesh.geometry.dispose();
  mesh.geometry = src;
}

export function getUVScale(m: Material) {
  return (m.userData.uvScale as number | undefined) ?? 1;
}

/** Upgrade glTF standard materials to physical so every slot supports clearcoat/transmission editing. */
export function toPhysical(m: Material): MeshPhysicalMaterial {
  if ((m as MeshPhysicalMaterial).isMeshPhysicalMaterial) return m as MeshPhysicalMaterial;
  const p = new MeshPhysicalMaterial();
  if ((m as MeshStandardMaterial).isMeshStandardMaterial) MeshStandardMaterial.prototype.copy.call(p, m as MeshStandardMaterial);
  p.name = m.name;
  return p;
}

/** Estimate metres per UV unit for a mesh (world-space area / UV area), assuming source units are metres. */
export function metresPerUV(mesh: Mesh, sourceScale: number): number {
  const g = mesh.geometry;
  const pos = g.attributes.position, uv = g.attributes.uv;
  if (!uv) return 1;
  const idx = g.index;
  const count = idx ? idx.count : pos.count;
  const step = Math.max(3, Math.floor(count / 3 / 500) * 3); // sample ≤ ~500 triangles
  const a = new Vector2(), b = new Vector2(), c = new Vector2();
  let areaW = 0, areaUV = 0;
  const v = (i: number) => (idx ? idx.getX(i) : i);
  const p3 = (i: number) => { const j = v(i); return [pos.getX(j), pos.getY(j), pos.getZ(j)]; };
  for (let t = 0; t + 2 < count; t += step) {
    const [x0, y0, z0] = p3(t), [x1, y1, z1] = p3(t + 1), [x2, y2, z2] = p3(t + 2);
    const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0, vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
    areaW += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const uvAt = (o: Vector2, i: number) => o.set(uv.getX(v(i)), uv.getY(v(i)));
    uvAt(a, t); uvAt(b, t + 1); uvAt(c, t + 2);
    areaUV += 0.5 * Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
  }
  const s = mesh.matrixWorld.getMaxScaleOnAxis() / sourceScale; // undo the viewer's normalisation scale
  if (areaUV < 1e-9 || areaW < 1e-9) return 1;
  return Math.sqrt(areaW / areaUV) * s;
}

export function disposeMaterialDeep(m: Material) {
  if (m.userData.ownsTextures || m.userData.libraryId) {
    for (const key of TEXTURE_KEYS) ((m as any)[key] as Texture | null)?.dispose();
  }
  m.dispose();
}

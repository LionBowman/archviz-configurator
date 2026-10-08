// Vendors erichlof's THREE.js-PathTracing-Renderer glTF viewer demo (CC0) into public/erichlof/
// and points it at this project's model + HDR, as a standalone side-by-side comparison page.
// Usage: node scripts/setup-erichlof.mjs [--force]      → then open /erichlof/ on the dev server.
import { mkdir, writeFile, readFile, copyFile, access } from 'fs/promises';
import { dirname } from 'path';

const SRC = 'https://raw.githubusercontent.com/erichlof/THREE.js-PathTracing-Renderer/gh-pages/';
const OUT = 'public/erichlof/';
const MODEL = process.env.MODEL ?? 'Models/project.glb';
const HDR = process.env.HDR ?? 'Hdr/field.hdr';

const FILES = [
  'LICENSE',
  'GLTF_Model_Viewer.html',
  'css/Gltf_Viewer.css',
  'js/three.module.min.js', 'js/three.core.min.js', 'js/BufferGeometryUtils.js', 'js/stats.module.js',
  'js/lil-gui.module.min.js', 'js/HDRLoader.js', 'js/GLTFLoader.js', 'js/MobileJoystickControls.js',
  'js/BVH_Quick_Builder.js', 'js/PathTracingCommon.js', 'js/InitCommon.js', 'js/GLTF_Model_Viewer.js',
  'shaders/common_PathTracing_Vertex.glsl', 'shaders/Gltf_Viewer_Fragment.glsl',
  'shaders/ScreenCopy_Fragment.glsl', 'shaders/ScreenOutput_Fragment.glsl',
  'textures/BlueNoise_R_128.png',
];

const force = process.argv.includes('--force');
const exists = (p) => access(p).then(() => true, () => false);

for (const f of FILES) {
  const out = OUT + f;
  if (!force && (await exists(out))) continue;
  const res = await fetch(SRC + f);
  if (!res.ok) throw new Error(`${res.status} ${f}`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
  console.log('fetched', f);
}

// Our assets.
await mkdir(OUT + 'models', { recursive: true });
await copyFile(MODEL, OUT + 'models/model.glb');
await copyFile(HDR, OUT + 'textures/environment.hdr');

// Point the demo at them (idempotent string patches on the pristine upstream file).
const viewerPath = OUT + 'js/GLTF_Model_Viewer.js';
let js = await readFile(viewerPath, 'utf8');
const patch = (re, to, what) => {
  if (js.includes('/* archviz-patched */') ) return;
  if (!re.test(js)) throw new Error(`patch failed: ${what}`);
  js = js.replace(re, to);
};
patch(/let modelPaths = \[[\s\S]*?\];/, 'let modelPaths = ["models/model.glb"];', 'modelPaths');
patch(/'textures\/daytime\.hdr'/, "'textures/environment.hdr'", 'hdr path');
patch(/let modelRotationY = Math\.PI;/, 'let modelRotationY = 0;', 'rotation');
// Upstream bakes each mesh with its *local* `matrix`, which GLTFLoader leaves stale (identity) until
// updateMatrixWorld() runs, so node-level scale/rotation (our model: mm units, Z-up) were dropped.
patch(/if \(meshGroup\.scene\)\s*\n\s*meshGroup = meshGroup\.scene;/,
  'if (meshGroup.scene)\n\t\t\t\tmeshGroup = meshGroup.scene;\n\t\t\tmeshGroup.updateMatrixWorld(true);', 'updateMatrixWorld');
patch(/child\.geometry\.applyMatrix4\(child\.matrix\.multiply\(matrixStack\[matrixStack\.length - 1\]\)\);/,
  'child.geometry.applyMatrix4(child.matrixWorld);', 'world matrix');
// Upstream de-duplicates textures by `image.src`, but GLTFLoader yields ImageBitmaps (no src), so every
// textured material collapsed onto one texture. Compare the image objects instead.
js = js.replaceAll('.image.src', '.image');
// The demo reads only scalar metalness/roughness. glTF metal/rough *maps* scale those factors (our brick:
// factor 1 × map ≈ 0), so ignoring the map made bricks fully metallic. Treat mapped metalness as dielectric.
patch(/this\.metalness = material\.metalness \|\| 0\.0;/,
  'this.metalness = material.metalnessMap ? 0.0 : (material.metalness || 0.0);', 'metalness map');
// Glass is detected by opacity upstream; glTF glazing uses KHR_materials_transmission (opacity 1).
patch(/this\.type = material\.opacity < 1 \? 2 : 1;/,
  'this.type = (material.opacity < 1 || material.transmission > 0) ? 2 : 1;', 'transmission → glass type');
patch(/this\.opacity = material\.opacity \|\| 1\.0;/,
  'this.opacity = material.transmission > 0 ? 0.1 : (material.opacity || 1.0);', 'transmission opacity');
// Frame the conservatory (≈100 × 36 × 76 units after the demo's ×10 scale) from a front corner.
patch(/cameraControlsObject\.position\.set\(-100, 120, 0\);/, 'cameraControlsObject.position.set(90, 45, 110);', 'camera position');
patch(/cameraControlsPitchObject\.rotation\.x = -0\.95;/, 'cameraControlsPitchObject.rotation.x = -0.21;', 'camera pitch');
patch(/cameraControlsYawObject\.rotation\.y = Math\.PI \/ -1\.333;/, 'cameraControlsYawObject.rotation.y = 0.708;', 'camera yaw');
if (!js.includes('/* archviz-patched */')) js = `/* archviz-patched */\n${js}`;
await writeFile(viewerPath, js);

// ---------------------------------------------------------------- shader fixes
/** Replace exactly one occurrence (fails loudly if upstream changed). */
const once = (src, from, to, what) => {
  if (src.includes(to)) return src; // already patched
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`shader patch "${what}": expected 1 match, found ${n}`);
  return src.replace(from, to);
};

const fragPath = OUT + 'shaders/Gltf_Viewer_Fragment.glsl';
let frag = await readFile(fragPath, 'utf8');
// 1) Two-sided triangles. The demo's test culls back faces, but glTF "doubleSided" surfaces (every material in
//    our Blender export) may be wound the other way: the paving faces point down, so camera rays passed
//    through it while sun rays from the demo's ground below were blocked → black. Opaque surfaces become
//    two-sided; glass keeps culling (its pass-through logic and 5-bounce budget rely on it). Duplicating
//    triangles instead breaks the demo's BVH builder (identical bounds can't be partitioned).
const SCENE_INTERSECT = '\nfloat SceneIntersect( )'; // line start: the name also appears in a closing comment
frag = once(frag, SCENE_INTERSECT, `// archviz: two-sided variant of BVH_TriangleIntersect that reports back-face hits
float BVH_TriangleIntersect2(in vec3 p0, in vec3 p1, in vec3 p2, vec3 rayOrigin, vec3 rayDirection, out float u, out float v, out bool backFace)
{
	vec3 e0 = p1 - p0, e1 = p0 - p2;
	vec3 N = cross(e1, e0);
	float det = dot(N, rayDirection);
	vec3 e2 = (1.0 / det) * (p0 - rayOrigin);
	vec3 i = cross(rayDirection, e2);
	vec3 b = vec3(0.0, dot(i, e1), dot(i, e0));
	b.x = 1.0 - (b.y + b.z);
	u = b.y; v = b.z;
	float t = dot(N, e2);
	backFace = det > 0.0;
	return det != 0.0 && t > 0.0 && all(greaterThanEqual(b, vec3(0))) ? t : INFINITY;
}

${SCENE_INTERSECT}`, 'two-sided intersect fn');
frag = once(frag,
  '\t\td = BVH_TriangleIntersect( vec3(vd0.xyz), vec3(vd0.w, vd1.xy), vec3(vd1.zw, vd2.x), rayOrigin, rayDirection, tu, tv );',
  ['\t\tbool backFace; // archviz: two-sided, except glass',
   '\t\td = BVH_TriangleIntersect2( vec3(vd0.xyz), vec3(vd0.w, vd1.xy), vec3(vd1.zw, vd2.x), rayOrigin, rayDirection, tu, tv, backFace );',
   '\t\tif (backFace && d < t && int(texelFetch(tTriangleTexture, ivec2( mod(id + 6.0, 2048.0), (id + 6.0) * INV_TEXTURE_WIDTH ), 0).x) == REFR)',
   '\t\t\td = INFINITY;'].join('\n'), 'two-sided leaf test');
// 2) Albedo textures were uploaded and indexed per triangle but never sampled. GLSL ES 3.0 needs constant
//    indices into sampler arrays, hence the if-chain. LOD 0: screen-space derivatives are meaningless here
//    and jittered accumulation antialiases anyway.
// 3) Sky clamp: indirect (bounced) rays read the HDR at full strength. field.hdr contains the real sun
//    (~10,000× the mean), on top of the demo's analytic sun → double sun + fireflies that take ages to
//    average out. Clamp the HDR only for indirect lighting; direct views of the sky stay untouched.
frag = once(frag, 'vec3 Get_HDR_Color(vec3 rayDirection)',
  `// archviz: constant-index albedo lookup + clamped sky for indirect light
#define SKY_CLAMP 4.0
vec3 SampleAlbedo(int id, vec2 uv)
{
	if (id == 0) return textureLod(tAlbedoTextures[0], uv, 0.0).rgb;
	if (id == 1) return textureLod(tAlbedoTextures[1], uv, 0.0).rgb;
	if (id == 2) return textureLod(tAlbedoTextures[2], uv, 0.0).rgb;
	if (id == 3) return textureLod(tAlbedoTextures[3], uv, 0.0).rgb;
	if (id == 4) return textureLod(tAlbedoTextures[4], uv, 0.0).rgb;
	if (id == 5) return textureLod(tAlbedoTextures[5], uv, 0.0).rgb;
	if (id == 6) return textureLod(tAlbedoTextures[6], uv, 0.0).rgb;
	if (id == 7) return textureLod(tAlbedoTextures[7], uv, 0.0).rgb;
	return vec3(1);
}

vec3 Get_HDR_Color(vec3 rayDirection);
vec3 Get_Sky_Color(vec3 rayDirection)
{
	vec3 c = Get_HDR_Color(rayDirection);
	float m = max(c.r, max(c.g, c.b));
	return m > SKY_CLAMP ? c * (SKY_CLAMP / m) : c;
}

vec3 Get_HDR_Color(vec3 rayDirection)`, 'albedo + sky helpers');
frag = once(frag, '\t\tt = SceneIntersect();\n',
  '\t\tt = SceneIntersect();\n\t\tif (t < INFINITY && hitAlbedoTextureID > -1) hitColor *= SampleAlbedo(hitAlbedoTextureID, hitUV); // archviz\n', 'apply albedo');
frag = once(frag, '\t\thitType = box.type;\n\t\thitObjectID = float(objectCount);',
  '\t\thitType = box.type;\n\t\thitAlbedoTextureID = -1; // archviz: ground has no texture\n\t\thitObjectID = float(objectCount);', 'ground texture id');
frag = once(frag, 'accumCol += mask * Get_HDR_Color(rayDirection) * uSkyLightIntensity * 0.5;',
  'accumCol += mask * Get_Sky_Color(rayDirection) * uSkyLightIntensity * 0.5;', 'clamp diffuse sky');
frag = once(frag, 'else  // sky rays going through glass, hitting another surface\n\t\t\t\t\tmask *= Get_HDR_Color(rayDirection) * uSkyLightIntensity;',
  'else  // sky rays going through glass, hitting another surface\n\t\t\t\t\tmask *= Get_Sky_Color(rayDirection) * uSkyLightIntensity;', 'clamp glass sky');
await writeFile(fragPath, frag);

// ---------------------------------------------------------------- orbit / pan controls
await copyFile('scripts/erichlof/ArchvizOrbitControls.js', OUT + 'js/ArchvizOrbitControls.js');

const htmlPath = OUT + 'GLTF_Model_Viewer.html';
let html = await readFile(htmlPath, 'utf8');
if (!html.includes('ArchvizOrbitControls')) {
  html = html.replace('<script defer src="js/GLTF_Model_Viewer.js"></script>',
    '<script defer src="js/GLTF_Model_Viewer.js"></script>\n\t\t<script defer src="js/ArchvizOrbitControls.js"></script>');
  if (!html.includes('ArchvizOrbitControls')) throw new Error('html patch failed: controls script');
}
if (!html.includes('archviz-back')) {
  html = html.replace('<div id="container"></div>',
    '<div id="container"></div>\n\t\t<a id="archviz-back" href="../" style="position:fixed;right:16px;top:16px;z-index:10;padding:10px 14px;border-radius:999px;background:rgba(255,255,255,.85);color:#1b1d21;font:13px system-ui,sans-serif;text-decoration:none">← Back to configurator</a>');
}
await writeFile(htmlPath, html);
await writeFile(OUT + 'index.html', '<!doctype html><meta http-equiv="refresh" content="0; url=GLTF_Model_Viewer.html">');
await writeFile(OUT + 'README.txt',
  'Vendored from https://github.com/erichlof/THREE.js-PathTracing-Renderer (CC0, see LICENSE).\n' +
  'Re-generate with: node scripts/setup-erichlof.mjs --force\n');
console.log(`Ready: open /erichlof/ on the dev server (model: ${MODEL}, hdr: ${HDR})`);

# Archviz Configurator Demo

Photoreal three.js viewer for architectural models with a clean, product-configurator look. It has a realtime PBR renderer (default) and an optional progressive path tracer.

Stack: Vite + TypeScript, three r186, three-gpu-pathtracer, postprocessing + N8AO, Tweakpane 4.

## Run

```bash
npm install
npm run fetch-textures   # optional: ~90 MB of CC0 PBR textures from Poly Haven (see below)
npm run dev              # http://localhost:5173
npm run build            # production build in dist/ (static, relative paths)
```

`?model=denis.glb` in the URL picks the start model.

## Sharing with someone else

- **Share / viewer links:** the share button (bottom-right) or Presets → *Copy share link* / *Copy viewer link* puts the whole current view into the link: camera, lighting, environment, post, materials and model. A *viewer link* opens a clean client view with no settings panel, just rotate / share / walk-inside. Links are about 300 characters and need no server.
- **The app must be reachable** for a link to work for anyone else (a `localhost` link only works on your PC):
  - **Same Wi-Fi:** run `npm run share:lan`, then open the printed `Network:` address (e.g. `http://192.168.1.20:4173`). Create the link there and send it. Your PC must stay on, and Windows may ask to allow Node through the firewall.
  - **GitHub Pages:** all downloaded assets (textures, furniture, HDRs, erichlof page, denoise data) are already in the repo folders and committed, so no fetch scripts run online. `.github/workflows/deploy-pages.yml` builds and publishes on every push to `main`. One-time setup: create the repo, push, then go to *Settings → Pages → Source: GitHub Actions*. The site appears at `https://<user>.github.io/<repo>/` (relative paths, so the sub-folder works). About 117 MB to commit; the largest file is 6.3 MB, well under GitHub's 100 MB limit.
  - **Anywhere:** run `npm run build` and upload the `dist/` folder to any static host (Netlify drop, Vercel, GitHub Pages, Cloudflare Pages, an S3 bucket). Paths are relative, so any sub-folder works. Open the hosted URL, then create links from there. `dist/` is ~120 MB, mostly the optional texture library in `public/textures`. Delete unused sets to slim it down.
- **Rotate button:** toggles auto-rotate. It's the same setting as Camera → *auto rotate*, with *rotate speed* beside it, so it's saved in presets and share links.

## Adding content

| What | Where | Notes |
|---|---|---|
| Models | `Models/*.glb` (or `.gltf`) | Found automatically at build time and listed in **Model**. Draco, Meshopt and KTX2 compression are supported. Use `.glb` (or embedded `.gltf`); a `.gltf` with external `.bin`/textures should go in `public/` instead. Models are centred, scaled to a 10-unit max dimension and placed on the ground. |
| HDR environments | `Hdr/*.hdr` / `*.exr` | Found automatically. The first one is the default; a picker appears when there are several. |
| Library materials | `src/materials.ts` → `LIBRARY` | Flat entries (colour, roughness, metalness, clearcoat, transmission) work without textures. |
| Textured materials | `scripts/fetch-textures.mjs` → `SET` | Add a Poly Haven id and re-run `npm run fetch-textures`. It writes `public/textures/<id>/{albedo,normal,roughness,ao,height}.jpg` plus `manifest.json`, then add a matching entry to `LIBRARY`. Any CC0 set works if you follow the same folder layout and manifest. |

UV scale is set automatically from each mesh's UV density and the texture's real-world size (assuming the source model is in metres), and can be adjusted per surface.

## Using it

- **Panel** (top-right button): Render · Lighting & Time · Environment · Model · Materials · Camera · Post. Escape, or a tap on empty canvas, closes it.
- **Materials**: open the section, then tap the model (or use the *surface* dropdown) to select a glTF material slot. The selection is outlined. Swap it to a library material, or edit colour, roughness, metalness, normal strength, UV scale, clearcoat, transmission and height. *Reset surface* restores the original.
- **Reset icons**: every editable field has a ↺ icon that turns blue when the value differs from its starting value. Click it to reset that field. For material fields the starting value is the selected surface's own: its model material, or the library material as first applied.
- **Built-in presets** (`src/builtinPresets.ts`, read-only, marked ★): *Default (Leo Test)* is also the app's default state and the model's *home* view. *Photoreal (suggested)* adds:
  - the `suburban_garden` HDRI with its sun aligned to the shadow-casting sun (Environment → *align HDR sun*);
  - crisper 4096 shadows;
  - the camera-style post finish;
  - stronger paving/brick relief and glazing reflections.
- **Presets** (top section): *Save current as preset* stores only the changed values (scene settings plus per-surface material swaps, UV mapping and edits, and optionally the camera view). *Apply* resets everything to defaults and then applies the preset, so combinations never leak into each other. Presets are kept in this browser's localStorage. Use *Export/Import JSON* to back them up or share them. *Reset everything to defaults* clears all changes.
- **Furniture** (Model → *furniture*): CC0 Poly Haven pieces (`npm run fetch-furniture` → `public/furniture/`, ~11 MB). The layout is per model in `src/furniture.ts` (`LAYOUTS`, in the model's own metres). Only `project.glb` has one; add an entry to furnish other models.
- **Interior lights** (Lighting & Time): pendant fittings over the coffee and dining tables, each a point light with a visible shade and glowing bulb. Controls: on/off, brightness, colour temperature (K) and optional light shadows (costlier). Positions are per model in `src/interiorLights.ts` (`LAYOUTS`); the cords auto-extend to the ceiling. Most effective with a late time of day and lower Environment intensity.
- **Walk inside** (bottom-right button, or Camera → *Walk inside*): first-person view at 1.6 m eye height. Drag to look. Move with WASD / arrows / wheel, Q/E to turn, Shift to run, or tap/click the floor to walk there. Walls, glazing and furniture block movement. Esc or *Back to orbit* returns to the previous view. Tip: set Environment → background to *Visible HDR* so the windows show the garden instead of the white studio.
- **Post → Lighting / Lens / Finish**: AO (with quality), bloom (amount + threshold) and SMAA; depth of field (auto-focuses on the orbit target, or straight ahead when walking), chromatic aberration and vignette; colour grading (contrast / saturation / brightness) and film grain. **Photoreal look** applies a tuned combination in one click. Lighting & Time → *shadow detail* sets the shadow map resolution.
- **Camera**: keys `1`–`4` (or the buttons) for the front / corner / close-up / aerial presets.
- **Path tracing engines** (Render → *PT engine*, shown when the browser has WebGPU):
  - *WebGPU + OIDN denoise* (default where available): `three-gpu-pathtracer/webgpu` on its own canvas over the WebGL one. When it reaches *max samples* it runs Intel Open Image Denoise (weights in `public/denoise/`), so 16–64 samples look clean. Much faster than the WebGL engine and renders the roof glazing correctly.
  - *WebGL*: the original engine (also used automatically if WebGPU fails to start). *denoise* here is a light edge-preserving blur (*denoise radius*), which softens noise but also fine texture. It is not comparable to OIDN.
- **erichlof comparison**: `npm run setup:erichlof` vendors erichlof's glTF viewer demo (CC0) into `public/erichlof/` with this project's model and HDR. A *Compare: erichlof renderer ↗* button then appears in Render. It's a standalone page with its own GUI. The script fixes our copy of the demo in several ways:
  - Model loading: node transforms, texture matching, metal/rough maps and transmission glass.
  - Shader: colour textures are now sampled, and opaque surfaces are two-sided (the paving was black). Bounced light reads a clamped HDR, because `field.hdr` contains the real sun and the demo adds its own, which caused never-settling speckles.
  - Camera: orbit/pan/zoom replaces the pointer-lock fly camera, which restarted accumulation on every mouse twitch (`scripts/erichlof/ArchvizOrbitControls.js`). Left-drag orbits, right-drag / middle-drag / shift+drag pans, the wheel zooms, a double-click re-frames. One finger orbits, two fingers pan and pinch.

  It still has no normal or roughness maps and no studio backdrop. Performance is limited by its design (one sample per frame at full resolution, no denoiser), not by model size: the model is only about 18k triangles. Lower *pixel_Resolution* in its GUI for speed.
- **Path tracing** (Render section): loaded only when switched on. It shows raster while the camera or a slider moves and accumulates when idle, with sample count and status in the bottom-left badge. Off by default everywhere and labelled *slow* on touch or low-end devices. The first enable compiles a large shader, which can take 10–60 s on Windows/ANGLE-D3D.

## Notes

- Realtime: AgX tone mapping (ACES/Neutral selectable), HDR → PMREM environment, a time-of-day sun (simple solar arc, black-body colour, air-mass falloff) with a shadow frustum fitted to the model and its projected shadow, an invisible shadow-catcher ground plus a baked contact shadow, and N8AO + bloom + SMAA.
- Backgrounds: studio gradient / solid colour / blurred HDR / visible HDR. The neutral backdrops are tiny equirect textures, so the raster and path-traced images match.
- In path-traced mode the shadow catcher becomes a real diffuse floor that fades out at the edges, because the path tracer's matte surfaces don't catch shadows.
- Performance: DPR is capped (≤2 desktop, ≤1.5 touch), frames render only on demand, shadow maps redraw only on change, AO runs at low quality and half resolution on touch, and replaced materials, textures and models are disposed.
- `WebGLPathTracer` is marked deprecated upstream in favour of `WebGPUPathTracer`. It is used here as specified and still works on three r186.

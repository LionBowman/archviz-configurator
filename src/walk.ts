import { MathUtils, Raycaster, Vector2, Vector3 } from 'three';
import type { Viewer } from './viewer';

/**
 * First-person "walk inside" mode at eye height.
 *   Look: drag (mouse or one finger).  Move: WASD / arrow keys / wheel, or tap the floor to walk there.
 *   Collides with the model and furniture (walls, glazing, chairs…); never leaves the floor level it started on.
 * OrbitControls are disabled while active; leaving restores the previous orbit view.
 */
export class WalkMode {
  active = false;
  /** Eye height and body radius in metres. */
  eyeHeight = 1.6;
  speed = 1.4; // m/s
  private yaw = 0;
  private pitch = 0;
  private pos = new Vector3(); // eye position (scene units)
  private floorY = 0;
  private glide: Vector3 | null = null;
  private keys = new Set<string>();
  private saved: { pos: Vector3; target: Vector3; fov: number } | null = null;
  private ray = new Raycaster();
  private drag: { x: number; y: number } | null = null;
  readonly listeners = new Set<(active: boolean) => void>();

  constructor(private viewer: Viewer) {
    viewer.listeners.step.add((dt) => this.update(dt));
    viewer.listeners.model.add(() => { if (this.active) this.exit(false); });
    const el = viewer.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { if (this.active && e.isPrimary) { this.drag = { x: e.clientX, y: e.clientY }; this.glide = null; } });
    addEventListener('pointermove', (e) => {
      if (!this.active || !this.drag || !e.isPrimary) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag = { x: e.clientX, y: e.clientY };
      // "grab the world" feel: drag right → look left
      this.yaw += dx * 0.0035;
      this.pitch = MathUtils.clamp(this.pitch + dy * 0.0035, -1.2, 1.2);
      this.apply();
    });
    addEventListener('pointerup', () => { this.drag = null; });
    el.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.tryMove(this.forward(), -e.deltaY * 0.002 * this.m);
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (!this.active || e.target instanceof HTMLInputElement) return;
      if (/^(Key[WASDQE]|Arrow(Up|Down|Left|Right)|ShiftLeft|ShiftRight)$/.test(e.code)) { this.keys.add(e.code); this.glide = null; e.preventDefault(); }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    viewer.listeners.tap.add((e) => this.onTap(e));
  }

  /** Metres → scene units. */
  private get m() { return this.viewer.modelScale; }

  private forward() {
    return new Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  enter() {
    const v = this.viewer;
    if (this.active || !v.model) return;
    this.saved = { pos: v.camera.position.clone(), target: v.controls.target.clone(), fov: v.camera.fov };

    // Start at the centre of the model, on the floor found by casting down from eye height.
    const c = v.bounds.getCenter(new Vector3());
    const probe = new Vector3(c.x, v.bounds.min.y + this.eyeHeight * this.m, c.z);
    this.ray.set(probe, new Vector3(0, -1, 0));
    const floor = this.ray.intersectObject(v.model, true)[0];
    this.floorY = floor ? floor.point.y : v.bounds.min.y;
    this.pos.set(c.x, this.floorY + this.eyeHeight * this.m, c.z);

    // Face along the longer side of the building.
    const size = v.bounds.getSize(new Vector3());
    this.yaw = size.x >= size.z ? -Math.PI / 2 : 0; // look towards +X or −Z
    this.pitch = -0.08;

    this.active = true;
    v.controls.enabled = false;
    v.camera.fov = 65;
    v.camera.updateProjectionMatrix();
    this.apply();
    v.changed();
    this.listeners.forEach((f) => f(true));
  }

  exit(restore = true) {
    const v = this.viewer;
    if (!this.active) return;
    this.active = false;
    this.keys.clear();
    this.glide = null;
    v.controls.enabled = true;
    if (this.saved) {
      v.camera.fov = this.saved.fov;
      v.camera.updateProjectionMatrix();
      if (restore) v.flyTo(this.saved.pos, this.saved.target);
    }
    v.changed();
    this.listeners.forEach((f) => f(false));
  }

  toggle() { if (this.active) this.exit(); else this.enter(); }

  private apply() {
    const cam = this.viewer.camera;
    cam.position.copy(this.pos);
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    // keep the orbit target in front, so DOF autofocus and leaving the mode behave sensibly
    this.viewer.controls.target.copy(this.pos).addScaledVector(this.lookDir(), 2 * this.m);
    this.viewer.invalidate();
  }

  private lookDir() {
    return new Vector3(0, 0, -1).applyEuler(this.viewer.camera.rotation);
  }

  /** Move horizontally, sliding along walls; returns true if it moved. */
  private tryMove(dir: Vector3, dist: number) {
    if (Math.abs(dist) < 1e-6) return false;
    const d = dir.clone().setY(0).normalize().multiplyScalar(Math.sign(dist));
    const step = Math.abs(dist);
    const candidates = [d, new Vector3(d.x, 0, 0), new Vector3(0, 0, d.z)].filter((c) => c.lengthSq() > 1e-6);
    for (const c of candidates) {
      const n = c.clone().normalize();
      const s = step * Math.abs(c === d ? 1 : c.length());
      if (this.blocked(n, s)) continue;
      this.pos.addScaledVector(n, s);
      this.apply();
      return true;
    }
    return false;
  }

  /** Horizontal collision at knee, waist and chest height, keeping ~0.3 m clearance. */
  private blocked(dir: Vector3, dist: number) {
    const v = this.viewer;
    const radius = 0.3 * this.m;
    for (const h of [0.35, 0.9, 1.4]) {
      const o = new Vector3(this.pos.x, this.floorY + h * this.m, this.pos.z);
      this.ray.set(o, dir);
      this.ray.far = dist + radius;
      if (this.ray.intersectObject(v.model!, true).length) return true;
    }
    return false;
  }

  private onTap(e: PointerEvent) {
    const v = this.viewer;
    if (!this.active || !v.model || document.querySelector('.panel.open')) return;
    const rect = v.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.far = Infinity;
    this.ray.setFromCamera(ndc, v.camera);
    const hit = this.ray.intersectObject(v.model, true)[0];
    if (!hit) return;
    // Walk to the tapped spot (floor or the base of whatever was tapped), stopping short of walls.
    const target = hit.point.clone().setY(this.pos.y);
    const toTarget = target.clone().sub(this.pos).setY(0);
    const len = toTarget.length();
    const stopShort = hit.point.y > this.floorY + 0.25 * this.m ? 0.6 * this.m : 0;
    if (len - stopShort < 0.05 * this.m) return;
    this.glide = this.pos.clone().addScaledVector(toTarget.normalize(), len - stopShort);
  }

  private update(dt: number) {
    if (!this.active) return false;
    const k = this.keys;
    const fwd = this.forward();
    const right = new Vector3(-fwd.z, 0, fwd.x);
    const run = k.has('ShiftLeft') || k.has('ShiftRight') ? 2 : 1;
    const step = this.speed * run * dt * this.m;
    let moved = false;
    const dir = new Vector3();
    if (k.has('KeyW') || k.has('ArrowUp')) dir.add(fwd);
    if (k.has('KeyS') || k.has('ArrowDown')) dir.sub(fwd);
    if (k.has('KeyD')) dir.add(right);
    if (k.has('KeyA')) dir.sub(right);
    if (k.has('ArrowLeft') || k.has('KeyQ')) { this.yaw += 1.6 * dt; moved = true; }
    if (k.has('ArrowRight') || k.has('KeyE')) { this.yaw -= 1.6 * dt; moved = true; }
    if (dir.lengthSq() > 0) moved = this.tryMove(dir, step) || moved;
    if (this.glide) {
      const to = this.glide.clone().sub(this.pos).setY(0);
      const len = to.length();
      if (len < 0.01 * this.m || !this.tryMove(to, Math.min(len, step * 1.2))) this.glide = null;
      else moved = true;
    }
    if (moved) this.apply();
    return moved;
  }
}

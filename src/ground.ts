import {
  CanvasTexture, Color, Group, Mesh, MeshDepthMaterial, MeshStandardMaterial, Object3D, OrthographicCamera,
  PlaneGeometry, Scene, ShaderMaterial, ShadowMaterial, WebGLRenderTarget, WebGLRenderer, MeshBasicMaterial,
} from 'three';
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js';

/**
 * Ground = invisible shadow catcher (raster) + baked contact shadow (raster)
 * + a real diffuse floor with radial fade used by the path tracer.
 */
export class Ground extends Group {
  readonly catcher: Mesh<PlaneGeometry, ShadowMaterial>;
  readonly floor: Mesh<PlaneGeometry, MeshStandardMaterial>;
  readonly contact: ContactShadow;

  constructor() {
    super();
    this.name = '__ground';
    this.catcher = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: 0.45, color: 0x101418 }));
    this.catcher.rotation.x = -Math.PI / 2;
    this.catcher.receiveShadow = true;
    this.catcher.userData.helper = true;

    this.floor = new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial({
      roughness: 0.95, metalness: 0, alphaMap: radialFade(), transparent: true, depthWrite: false,
    }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.floor.visible = false;
    this.floor.userData.helper = true;

    this.contact = new ContactShadow();
    this.add(this.catcher, this.floor, this.contact);
  }

  /** Size everything for a model of the given radius (model sits at y=0). */
  fit(radius: number) {
    this.catcher.scale.setScalar(radius * 12);
    this.floor.scale.setScalar(radius * 14);
    this.contact.resize(radius * 2.6);
  }

  setPathTracing(on: boolean, floorColor: Color) {
    this.floor.visible = on;
    this.floor.material.color.copy(floorColor);
    this.catcher.visible = !on;
    this.contact.visible = !on && this.contact.enabled;
    // Raster-only helpers are detached while path tracing: the WebGPU tracer ignores `visible`.
    if (on) this.remove(this.catcher, this.contact);
    else if (!this.catcher.parent) this.add(this.catcher, this.contact);
  }
}

function radialFade() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(128, 128, 30, 128, 128, 128);
  grd.addColorStop(0, '#fff');
  grd.addColorStop(1, '#000');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  return new CanvasTexture(c);
}

/** Baked contact shadow (adapted from three.js webgl_shadow_contact example). Rendered once per model load. */
export class ContactShadow extends Group {
  enabled = true;
  opacity = 0.55;
  blur = 2.5;
  private rt = new WebGLRenderTarget(512, 512);
  private rtBlur = new WebGLRenderTarget(512, 512);
  private plane: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private blurPlane = new Mesh(new PlaneGeometry(1, 1).rotateX(Math.PI / 2));
  private cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private depthMat = new MeshDepthMaterial({ depthTest: false, depthWrite: false });
  private hBlur = new ShaderMaterial({ ...HorizontalBlurShader, depthTest: false });
  private vBlur = new ShaderMaterial({ ...VerticalBlurShader, depthTest: false });
  private size = 1;

  constructor() {
    super();
    this.rt.texture.generateMipmaps = this.rtBlur.texture.generateMipmaps = false;
    this.plane = new Mesh(new PlaneGeometry(1, 1).rotateX(Math.PI / 2), new MeshBasicMaterial({
      map: this.rt.texture, transparent: true, depthWrite: false, opacity: this.opacity,
    }));
    this.plane.position.y = 0.002;
    this.plane.renderOrder = 1;
    this.plane.userData.helper = true;
    this.blurPlane.visible = false;
    this.cam.rotation.x = Math.PI / 2; // look up from below the ground
    // blurPlane is rendered on its own (never part of the scene graph).
    this.add(this.plane, this.cam);

    const darkness = { value: 1.4 };
    this.depthMat.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = darkness;
      shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );',
      )}`;
    };
  }

  resize(size: number) {
    this.size = size;
    this.plane.scale.set(size, -1, size);
    this.blurPlane.scale.set(size, 1, size);
    const h = size * 0.35; // only geometry close to the ground contributes
    Object.assign(this.cam, { left: -size / 2, right: size / 2, top: size / 2, bottom: -size / 2, near: 0, far: h });
    this.cam.updateProjectionMatrix();
  }

  /** Render the model's footprint from below into the shadow texture. */
  bake(renderer: WebGLRenderer, scene: Scene) {
    this.plane.material.opacity = this.opacity;
    if (!this.enabled) return;
    const hidden: Object3D[] = [];
    scene.traverse((o) => { if (o.userData.helper && o.visible) { hidden.push(o); o.visible = false; } });
    const bg = scene.background;
    scene.background = null;
    scene.overrideMaterial = this.depthMat;
    const prevClear = renderer.getClearAlpha();
    renderer.setClearAlpha(0);
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, this.cam);
    scene.overrideMaterial = null;
    const amount = this.blur / this.size * 4;
    this.blurPass(renderer, amount);
    this.blurPass(renderer, amount * 0.4);
    renderer.setRenderTarget(null);
    renderer.setClearAlpha(prevClear);
    scene.background = bg;
    hidden.forEach((o) => (o.visible = true));
  }

  private blurPass(renderer: WebGLRenderer, amount: number) {
    this.blurPlane.visible = true;
    this.blurPlane.material = this.hBlur;
    this.hBlur.uniforms.tDiffuse.value = this.rt.texture;
    this.hBlur.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(this.rtBlur);
    renderer.render(this.blurPlane, this.cam);
    this.blurPlane.material = this.vBlur;
    this.vBlur.uniforms.tDiffuse.value = this.rtBlur.texture;
    this.vBlur.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.blurPlane, this.cam);
    this.blurPlane.visible = false;
  }
}

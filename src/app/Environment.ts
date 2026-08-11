import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { RenderParams } from '../core/params.js';

/**
 * Sky, sun, shadows and fog.
 *
 * Two details do most of the work here:
 *
 * - The PMREM environment map generated from the sky is what gives
 *   `MeshStandardMaterial` real ambient light. Without it the whole city reads
 *   as a pile of flat-shaded blocks, and glass stops looking like glass.
 * - The shadow camera is snapped to shadow-texel increments every frame.
 *   Without that the shadows crawl and shimmer while the camera moves, and the
 *   scene looks cheap without it being obvious why.
 */
export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: Sky;

  private pmrem: THREE.PMREMGenerator;
  /** Holds the sky only while the environment map is being captured. */
  private envScene = new THREE.Scene();
  envRT: THREE.WebGLRenderTarget | null = null;
  /** False on software rasterisers; see the note in the constructor. */
  supportsPmrem = true;
  private lastSunKey = '';
  private target = new THREE.Object3D();
  private sunDir = new THREE.Vector3();

  constructor(
    private scene: THREE.Scene,
    private renderer: THREE.WebGLRenderer,
    private params: RenderParams,
  ) {
    this.sky = new Sky();
    this.sky.scale.setScalar(10000);
    scene.add(this.sky);

    const u = this.sky.material.uniforms;
    u.turbidity!.value = 4.2;
    u.rayleigh!.value = 1.8;
    u.mieCoefficient!.value = 0.006;
    u.mieDirectionalG!.value = 0.75;

    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.5);
    this.sun.castShadow = true;
    scene.add(this.sun);
    scene.add(this.target);
    this.sun.target = this.target;

    this.hemi = new THREE.HemisphereLight(0xafc7de, 0x6e6a60, 0.35);
    scene.add(this.hemi);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();

    // PMREM produces a half-float cube-UV texture and samples it with linear
    // filtering. Software rasterisers (SwiftShader, used for headless capture)
    // do not expose OES_texture_half_float_linear, and sampling it there
    // returns black — which zeroes out every MeshStandardMaterial in the scene.
    // Every real GPU supports it; when it is missing, fall back to stronger
    // hemisphere ambient so the city is still lit correctly.
    this.supportsPmrem = renderer.getContext().getExtension('OES_texture_half_float_linear') !== null;
    if (!this.supportsPmrem) {
      console.warn(
        '[Environment] OES_texture_half_float_linear unavailable — using ambient ' +
          'lighting instead of an image-based environment map.',
      );
    }

    this.applyShadowSettings();
    this.update(true);
  }

  private applyShadowSettings(): void {
    const s = this.sun.shadow;
    s.mapSize.set(this.params.shadowMapSize, this.params.shadowMapSize);
    const e = this.params.shadowExtent / 2;
    const cam = s.camera;
    cam.left = -e;
    cam.right = e;
    cam.top = e;
    cam.bottom = -e;
    cam.near = 1;
    cam.far = 900;
    cam.updateProjectionMatrix();
    s.bias = -0.0004;
    s.normalBias = 0.05;
    s.map?.dispose();
    s.map = null;
  }

  setShadowsEnabled(on: boolean): void {
    this.sun.castShadow = on;
    this.renderer.shadowMap.enabled = on;
  }

  setShadowMapSize(size: number): void {
    this.params.shadowMapSize = size;
    this.applyShadowSettings();
  }

  /**
   * Sun direction from the time of day. Azimuth runs east to west through the
   * south, so south-facing balconies actually catch the light — which is what
   * makes deriving balcony placement from world orientation pay off.
   */
  private computeSunDirection(hour: number): THREE.Vector3 {
    const t = Math.min(1, Math.max(0, (hour - 6) / 12)); // 06:00 -> 18:00
    const elevation = Math.sin(t * Math.PI) * 62 + 3;
    const azimuth = -80 + t * 160; // degrees east(-) to west(+) of south
    const el = elevation * (Math.PI / 180);
    const az = azimuth * (Math.PI / 180);
    // +Z is south in this project's plan-to-world mapping.
    return new THREE.Vector3(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      Math.cos(az) * Math.cos(el),
    ).normalize();
  }

  update(force = false): void {
    const key = `${this.params.timeOfDay.toFixed(2)}`;
    if (key === this.lastSunKey && !force) return;
    this.lastSunKey = key;

    this.sunDir.copy(this.computeSunDirection(this.params.timeOfDay));
    this.sky.material.uniforms.sunPosition!.value.copy(this.sunDir);

    const elevationFactor = Math.max(0.05, this.sunDir.y);
    this.sun.intensity = 0.6 + elevationFactor * 2.6;
    // Warm the sun and cool the ambient as the sun drops.
    this.sun.color.setHSL(0.09, 0.55 * (1 - elevationFactor) + 0.06, 0.62);
    // Without an environment map the hemisphere light has to stand in for the
    // whole sky dome, so it is raised to roughly the irradiance the IBL would
    // have contributed. Otherwise every north-facing wall goes black.
    this.hemi.intensity = this.supportsPmrem
      ? 0.22 + elevationFactor * 0.3
      : 1.15 + elevationFactor * 0.55;

    if (this.supportsPmrem) {
      // Regenerate the environment map only when the sun actually moves. The
      // sky is moved into a dedicated Scene for the capture and put back
      // afterwards, because `fromScene` expects a Scene.
      this.envRT?.dispose();
      this.envScene.add(this.sky);
      this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 20000);
      this.scene.add(this.sky);
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = 1.0;
    }

    if (this.params.fog) {
      const horizon = new THREE.Color().setHSL(0.58, 0.16, 0.40 + elevationFactor * 0.20);
      this.scene.fog = new THREE.FogExp2(horizon.getHex(), this.params.fogDensity);
      this.renderer.setClearColor(horizon);
    } else {
      this.scene.fog = null;
    }
  }

  /**
   * Keep the shadow frustum centred on the view, snapped to texel increments so
   * the shadow map does not crawl as the camera moves.
   */
  followCamera(focus: THREE.Vector3): void {
    const cam = this.sun.shadow.camera;
    const texel = (cam.right - cam.left) / this.params.shadowMapSize;

    // Build the light's basis and snap the focus point within it.
    const forward = this.sunDir.clone().negate();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize();
    const up = new THREE.Vector3().crossVectors(forward, right).normalize();

    const fx = Math.round(focus.dot(right) / texel) * texel;
    const fy = Math.round(focus.dot(up) / texel) * texel;
    const fz = focus.dot(forward);
    const snapped = new THREE.Vector3()
      .addScaledVector(right, fx)
      .addScaledVector(up, fy)
      .addScaledVector(forward, fz);

    this.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(this.sunDir, 400);
    this.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  dispose(): void {
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
  }
}

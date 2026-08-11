import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

/**
 * Two camera modes.
 *
 * Orbit is for the overview and for screenshots. Walk is what actually sells the
 * project: a suburb only reads correctly from street level, where the fences,
 * the car pads and the 910 mm façade rhythm are the things you see.
 */
export type CameraMode = 'orbit' | 'walk';

const EYE_HEIGHT = 1.62;
const WALK_SPEED = 4.2;
const RUN_SPEED = 10.5;

export class Controls {
  readonly orbit: OrbitControls;
  readonly walk: PointerLockControls;
  private mode: CameraMode = 'orbit';
  private keys = new Set<string>();
  private velocity = new THREE.Vector3();
  private onModeChange?: (mode: CameraMode) => void;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private domElement: HTMLElement,
    private bounds: number,
  ) {
    this.orbit = new OrbitControls(camera, domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxPolarAngle = 88 * (Math.PI / 180);
    this.orbit.minDistance = 8;
    this.orbit.maxDistance = 900;
    this.orbit.target.set(0, 0, 0);

    this.walk = new PointerLockControls(camera, domElement);
    this.walk.enabled = false;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.walk.addEventListener('unlock', () => {
      if (this.mode === 'walk') this.setMode('orbit');
    });
  }

  onChange(fn: (mode: CameraMode) => void): void {
    this.onModeChange = fn;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    this.keys.add(e.code);
    // W toggles walk mode, but only when not already walking (where it moves).
    if (e.code === 'KeyW' && this.mode === 'orbit' && !e.repeat) {
      this.setMode('walk');
    }
    if (e.code === 'Escape' && this.mode === 'walk') this.setMode('orbit');
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  get currentMode(): CameraMode {
    return this.mode;
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'walk') {
      // Drop the camera to eye height at whatever it was looking at.
      const target = this.orbit.target.clone();
      const dir = this.camera.position.clone().sub(target).setY(0).normalize();
      this.camera.position.copy(target).addScaledVector(dir, 12);
      this.camera.position.y = EYE_HEIGHT;
      this.camera.lookAt(target.x, EYE_HEIGHT, target.z);
      this.orbit.enabled = false;
      this.walk.enabled = true;
      this.walk.lock();
    } else {
      this.walk.enabled = false;
      this.walk.unlock();
      this.orbit.enabled = true;
      this.orbit.target.set(this.camera.position.x, 0, this.camera.position.z - 30);
      this.camera.position.y = Math.max(35, this.camera.position.y);
    }
    this.onModeChange?.(mode);
  }

  update(dt: number): void {
    if (this.mode === 'orbit') {
      this.orbit.update();
      return;
    }

    // The ground is flat, so walking needs no raycasting — just clamp y.
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED;
    const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);

    this.velocity.set(strafe, 0, -forward);
    if (this.velocity.lengthSq() > 0) {
      this.velocity.normalize().multiplyScalar(speed * dt);
      this.velocity.applyQuaternion(this.camera.quaternion);
      this.velocity.y = 0;
      this.camera.position.add(this.velocity);
    }
    this.camera.position.y = EYE_HEIGHT;
    const b = this.bounds;
    this.camera.position.x = Math.min(b, Math.max(-b, this.camera.position.x));
    this.camera.position.z = Math.min(b, Math.max(-b, this.camera.position.z));
  }

  /** Point the camera at a preset view; used by the screenshot tool. */
  setView(position: THREE.Vector3Like, target: THREE.Vector3Like): void {
    this.setMode('orbit');
    this.camera.position.set(position.x, position.y, position.z);
    this.orbit.target.set(target.x, target.y, target.z);
    this.orbit.update();
  }

  /** Point of interest the shadow frustum should follow. */
  get focus(): THREE.Vector3 {
    return this.mode === 'orbit' ? this.orbit.target : this.camera.position;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.orbit.dispose();
    this.walk.dispose();
    void this.domElement;
  }
}

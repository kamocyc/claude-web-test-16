import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

import type { Polygon, Vec2 } from '../core/types.js';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Building footprints, in a uniform grid, so the street modes can be stopped by
 * a wall.
 *
 * Walking through a house was tolerable — at 4 m/s you have to mean it. Driving
 * makes it the normal case: a hundred metres goes by in seconds, so without this
 * the car spends most of its time inside the town rather than on it, and the
 * mode is unusable. A point test against the footprint plus a margin is enough;
 * there is no vehicle body to model. The ground is not flat, but the road is
 * graded, so the car follows the carriageway's design height rather than the
 * land under it.
 */
class ObstacleGrid {
  private cells = new Map<number, number[]>();
  private polys: Polygon[] = [];
  private cell = 16;

  set(polys: Polygon[]): void {
    this.cells.clear();
    this.polys = polys;
    for (let i = 0; i < polys.length; i++) {
      const p = polys[i]!;
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (const v of p) {
        minX = Math.min(minX, v.x);
        minZ = Math.min(minZ, v.y);
        maxX = Math.max(maxX, v.x);
        maxZ = Math.max(maxZ, v.y);
      }
      for (let cx = Math.floor(minX / this.cell); cx <= Math.floor(maxX / this.cell); cx++) {
        for (let cz = Math.floor(minZ / this.cell); cz <= Math.floor(maxZ / this.cell); cz++) {
          const k = cx * 8192 + cz;
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(i);
        }
      }
    }
  }

  get empty(): boolean {
    return this.polys.length === 0;
  }

  blocked(x: number, z: number, margin: number): boolean {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const p: Vec2 = { x, y: z };
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = this.cells.get((cx + i) * 8192 + (cz + j));
        if (!list) continue;
        for (const k of list) {
          const poly = this.polys[k]!;
          if (inside(poly, p)) return true;
          for (let a = 0, n = poly.length; a < n; a++) {
            if (distToSegment(p, poly[a]!, poly[(a + 1) % n]!) < margin) return true;
          }
        }
      }
    }
    return false;
  }
}

function inside(poly: Polygon, p: Vec2): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Three camera modes.
 *
 * Orbit is for the overview and for screenshots. Walk is what actually sells the
 * project: a suburb only reads correctly from street level, where the fences,
 * the car pads and the 910 mm façade rhythm are the things you see.
 *
 * Drive is what sells the *zoning*. Walking shows you one street; the thing a
 * 用途地域 map produces is the experience of leaving the houses behind, passing
 * the shops, and arriving among the sheds — and that is several hundred metres,
 * which is a long walk and a short drive. So the third mode is not a faster walk
 * with a lower camera: it steers rather than strafes, carries its speed, and
 * cannot turn on the spot, because those are what make the distance read as
 * distance rather than as a fly-through.
 */
/** Ground height in world space, given plan coordinates. */
export type GroundSampler = (x: number, z: number) => number;

export type CameraMode = 'orbit' | 'walk' | 'drive';

const EYE_HEIGHT = 1.62;
const WALK_SPEED = 4.2;
const RUN_SPEED = 10.5;

/** Driver's eye in an ordinary saloon, not a bus. */
const DRIVE_EYE = 1.18;
const DRIVE_TOP_SPEED = 16; // ≈ 58 km/h, a wide suburban road
const DRIVE_SLOW_SPEED = 8.5; // ≈ 31 km/h, a 生活道路
const DRIVE_ACCEL = 7.5;
const DRIVE_BRAKE = 16;
/** Rolling resistance, so releasing the throttle coasts rather than stops. */
const DRIVE_DRAG = 0.9;
const DRIVE_REVERSE_SPEED = 4;
/** Radians per second of steering at full lock. */
const DRIVE_STEER = 1.15;
/** Half-width kept clear of a wall: roughly a car, and roughly a shoulder. */
const DRIVE_MARGIN = 0.95;
const WALK_MARGIN = 0.35;

export class Controls {
  readonly orbit: OrbitControls;
  readonly walk: PointerLockControls;
  private mode: CameraMode = 'orbit';
  private keys = new Set<string>();
  private velocity = new THREE.Vector3();
  private walkAt: GroundSampler = () => 0;
  private driveAt: GroundSampler = () => 0;
  /** Smoothed eye height, so a stair riser does not snap the view. */
  private eyeY = 0;
  private onModeChange?: (mode: CameraMode) => void;
  /** Drive mode: the car's own heading and speed, independent of where you look. */
  private heading = 0;
  private speed = 0;
  private obstacles = new ObstacleGrid();

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
      if (this.mode !== 'orbit') this.setMode('orbit');
    });
  }

  onChange(fn: (mode: CameraMode) => void): void {
    this.onModeChange = fn;
  }

  /** Building footprints the street modes should not pass through. */
  setObstacles(footprints: Polygon[]): void {
    this.obstacles.set(footprints);
  }

  /**
   * Where the ground is, for the street modes.
   *
   * Two samplers, not one, because they answer different questions. Walking
   * follows whatever you are standing on — the pavement, a levelled garden, the
   * top of a 擁壁 — while driving follows the *road*: the carriageway is graded
   * through cuttings and over embankments, and a car that took its height from
   * the raw terrain would submerge itself every time the street was in cut.
   */
  setGround(walkAt: GroundSampler, driveAt: GroundSampler): void {
    this.walkAt = walkAt;
    this.driveAt = driveAt;
  }

  /**
   * Move, sliding along whatever is in the way.
   *
   * Trying each axis separately after the combined move fails is what turns a
   * wall from a full stop into something you scrape along. Without it, clipping
   * a corner at 30 km/h stops the car dead, which feels like a bug even though
   * it is technically correct.
   */
  private step(dx: number, dz: number, margin: number): boolean {
    const p = this.camera.position;
    if (this.obstacles.empty) {
      p.x += dx;
      p.z += dz;
      return true;
    }
    if (!this.obstacles.blocked(p.x + dx, p.z + dz, margin)) {
      p.x += dx;
      p.z += dz;
      return true;
    }
    let moved = false;
    if (dx !== 0 && !this.obstacles.blocked(p.x + dx, p.z, margin)) {
      p.x += dx;
      moved = true;
    }
    if (dz !== 0 && !this.obstacles.blocked(p.x, p.z + dz, margin)) {
      p.z += dz;
      moved = true;
    }
    return moved;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    this.keys.add(e.code);
    // W toggles walk mode, but only when not already walking (where it moves).
    if (e.code === 'KeyW' && this.mode === 'orbit' && !e.repeat) {
      this.setMode('walk');
    }
    // C for the car. Not a letter the driving controls use, so it can also be
    // pressed while walking to get in.
    if (e.code === 'KeyC' && this.mode !== 'drive' && !e.repeat) {
      this.setMode('drive');
    }
    if (e.code === 'Escape' && this.mode !== 'orbit') this.setMode('orbit');
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  get currentMode(): CameraMode {
    return this.mode;
  }

  /**
   * Ease the eye toward a target height.
   *
   * The ground under a Japanese hill suburb is a staircase — every lot is a
   * level pad a riser or two above its neighbour — so sampling it and assigning
   * straight to `position.y` makes the view jump at every boundary. A first-order
   * lag at about 12/s is enough to read as walking rather than as teleporting,
   * and short enough not to feel like swimming.
   */
  private settleEye(target: number, dt: number): void {
    const k = 1 - Math.exp(-12 * Math.max(0, dt));
    if (Math.abs(this.eyeY - target) > 6) this.eyeY = target;
    else this.eyeY += (target - this.eyeY) * k;
    this.camera.position.y = this.eyeY;
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    const previous = this.mode;
    this.mode = mode;
    if (mode === 'walk' || mode === 'drive') {
      const eye = mode === 'drive' ? DRIVE_EYE : EYE_HEIGHT;
      // Getting into the car where you were standing, rather than being teleported
      // back to the orbit target.
      if (previous === 'orbit') {
        const target = this.orbit.target.clone();
        const dir = this.camera.position.clone().sub(target).setY(0).normalize();
        this.camera.position.copy(target).addScaledVector(dir, 12);
        this.camera.lookAt(target.x, eye, target.z);
      }
      const sampler = mode === 'drive' ? this.driveAt : this.walkAt;
      this.eyeY = sampler(this.camera.position.x, this.camera.position.z) + eye;
      this.camera.position.y = this.eyeY;
      if (mode === 'drive') {
        // Start pointing where the camera already points, at a standstill.
        const look = new THREE.Vector3();
        this.camera.getWorldDirection(look);
        this.heading = Math.atan2(look.x, look.z);
        this.speed = 0;
      }
      this.orbit.enabled = false;
      this.walk.enabled = true;
      if (!this.walk.isLocked) this.walk.lock();
    } else {
      this.walk.enabled = false;
      this.walk.unlock();
      this.orbit.enabled = true;
      const here = this.walkAt(this.camera.position.x, this.camera.position.z);
      this.orbit.target.set(this.camera.position.x, here, this.camera.position.z - 30);
      this.camera.position.y = Math.max(35 + this.walkAt(this.camera.position.x, this.camera.position.z), this.camera.position.y);
    }
    this.onModeChange?.(mode);
  }

  update(dt: number): void {
    if (this.mode === 'orbit') {
      this.orbit.update();
      return;
    }
    if (this.mode === 'drive') {
      this.drive(dt);
      return;
    }

    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED;
    const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);

    this.velocity.set(strafe, 0, -forward);
    if (this.velocity.lengthSq() > 0) {
      this.velocity.normalize().multiplyScalar(speed * dt);
      this.velocity.applyQuaternion(this.camera.quaternion);
      this.velocity.y = 0;
      this.step(this.velocity.x, this.velocity.z, WALK_MARGIN);
    }
    this.settleEye(this.walkAt(this.camera.position.x, this.camera.position.z) + EYE_HEIGHT, dt);
    const b = this.bounds;
    this.camera.position.x = Math.min(b, Math.max(-b, this.camera.position.x));
    this.camera.position.z = Math.min(b, Math.max(-b, this.camera.position.z));
  }

  /**
   * One tick of the car.
   *
   * Steering is scaled by speed and vanishes at a standstill, which is the one
   * detail that stops this feeling like a hovering camera: you cannot pivot on
   * the spot, so you have to approach a corner rather than snap to it. The
   * mouse still looks around independently — glancing at a shopfront while
   * driving past it is most of the reason to have this mode at all — so the
   * steering rotates the *view* by the same delta rather than replacing it.
   */
  private drive(dt: number): void {
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const throttle =
      (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const steer =
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0) -
      (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0);
    const handbrake = this.keys.has('Space');

    const top = fast ? DRIVE_TOP_SPEED : DRIVE_SLOW_SPEED;
    if (handbrake) {
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), DRIVE_BRAKE * dt);
    } else if (throttle > 0) {
      this.speed = Math.min(top, this.speed + DRIVE_ACCEL * dt);
    } else if (throttle < 0) {
      // Down is the brake while moving forward, and reverse once stopped.
      this.speed =
        this.speed > 0.1
          ? Math.max(0, this.speed - DRIVE_BRAKE * dt)
          : Math.max(-DRIVE_REVERSE_SPEED, this.speed - DRIVE_ACCEL * dt);
    } else {
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), DRIVE_DRAG * dt);
    }

    if (steer !== 0 && Math.abs(this.speed) > 0.2) {
      // Full lock only at walking pace; a car does not scythe round at 58 km/h.
      const authority = Math.min(1, 4 / Math.max(2, Math.abs(this.speed)));
      const delta = steer * DRIVE_STEER * authority * dt * Math.sign(this.speed);
      this.heading += delta;
      this.camera.rotateOnWorldAxis(UP, delta);
    }

    const moved = this.step(
      Math.sin(this.heading) * this.speed * dt,
      Math.cos(this.heading) * this.speed * dt,
      DRIVE_MARGIN,
    );
    // Hitting something square on scrubs most of the speed off rather than all
    // of it, so nudging free of a wall does not need a standing start.
    if (!moved && this.speed !== 0) this.speed *= 0.25;
    this.settleEye(this.driveAt(this.camera.position.x, this.camera.position.z) + DRIVE_EYE, dt);

    const b = this.bounds;
    const x = Math.min(b, Math.max(-b, this.camera.position.x));
    const z = Math.min(b, Math.max(-b, this.camera.position.z));
    // Hitting the edge of the world stops the car rather than sliding it along.
    if (x !== this.camera.position.x || z !== this.camera.position.z) this.speed = 0;
    this.camera.position.x = x;
    this.camera.position.z = z;
  }

  /** Current speed in km/h, for the HUD. */
  get speedKmh(): number {
    return this.mode === 'drive' ? Math.abs(this.speed) * 3.6 : 0;
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

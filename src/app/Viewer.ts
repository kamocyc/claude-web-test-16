import * as THREE from 'three';

export interface ViewerStats {
  fps: number;
  drawCalls: number;
  triangles: number;
}

/** Renderer, scene, camera and the render loop. Everything else plugs into it. */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly container: HTMLElement;

  private updaters: ((dt: number) => void)[] = [];
  private raf = 0;
  private lastTime = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  stats: ViewerStats = { fps: 0, drawCalls: 0, triangles: 0 };

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      52,
      container.clientWidth / container.clientHeight,
      0.1,
      2500,
    );
    this.camera.position.set(120, 95, 150);

    window.addEventListener('resize', this.onResize);
  }

  private onResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  onUpdate(fn: (dt: number) => void): void {
    this.updaters.push(fn);
  }

  start(): void {
    const loop = (time: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = this.lastTime === 0 ? 0.016 : Math.min(0.1, (time - this.lastTime) / 1000);
      this.lastTime = time;

      for (const u of this.updaters) u(dt);
      this.renderer.render(this.scene, this.camera);

      this.fpsAccum += dt;
      this.fpsFrames++;
      if (this.fpsAccum >= 0.5) {
        this.stats = {
          fps: this.fpsFrames / this.fpsAccum,
          drawCalls: this.renderer.info.render.calls,
          triangles: this.renderer.info.render.triangles,
        };
        this.fpsAccum = 0;
        this.fpsFrames = 0;
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
  }

  /** Remove and dispose everything under a group, keeping the group itself. */
  static clearGroup(group: THREE.Object3D): void {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
    }
  }
}

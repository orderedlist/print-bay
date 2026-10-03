// three.js scene for a model: the mesh, or its sliced toolpaths with x-ray and
// layer controls (ported from the prototype viewer/index.html).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

export const BED = 260;

export const FEATURE_COLORS: Record<string, string> = {
  "Outer wall": "#ff8a3d", "Inner wall": "#ffd84a", "Overhang wall": "#3d5afe",
  "Sparse infill": "#c2362f", "Internal solid infill": "#a05cd6", "Gap infill": "#e8e8e8",
  "Top surface": "#ff5c8a", "Bottom surface": "#5aa9e6", "Bridge": "#3f7fc0",
  "Internal Bridge": "#9cc9ef", "Brim": "#2f9e6e", "Support": "#4caf50",
  "Support interface": "#2e7d32", "Custom": "#7aa6a8",
};
const WALLS = new Set(["Outer wall", "Inner wall", "Overhang wall"]);
const NOT_PART = new Set(["Brim", "Custom", "Support", "Support interface", "Support transition"]);

interface PathType { name: string; offset: number; count: number; layerStarts: number[]; line: THREE.LineSegments }
export interface Toolpaths { layers: number[]; types: PathType[] }

/** Very dark filament vanishes against the stage; lift it just enough to read. */
export function displayColor(hex: string | null): THREE.Color {
  const c = new THREE.Color(hex ?? "#9a9a96");
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  if (hsl.l < 0.2) c.setHSL(hsl.h, hsl.s, 0.2);
  return c;
}

export function parseMesh(buffer: ArrayBuffer): { geometry: THREE.BufferGeometry; size: THREE.Vector3 } {
  const geometry = new STLLoader().parse(buffer);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const center = box.getCenter(new THREE.Vector3());
  geometry.translate(-center.x, -center.y, -box.min.z); // centered on the bed
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return { geometry, size: box.getSize(new THREE.Vector3()) };
}

export function addLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6a6458, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-300, -400, 600);
  const rim = new THREE.DirectionalLight(0xffffff, 0.8);
  rim.position.set(400, 300, 200);
  scene.add(key, rim);
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
  readonly controls: OrbitControls;
  private mesh: THREE.Mesh | null = null;
  private paths = new THREE.Group();
  private data: Toolpaths | null = null;
  private resizer: ResizeObserver;

  layer = 0;
  single = false;
  xray = true;
  hidden = new Set(["Brim", "Custom"]);

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    host.append(this.renderer.domElement);
    this.camera.up.set(0, 0, 1); // models are Z-up
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.background = new THREE.Color("#0d0e10");
    addLights(this.scene);

    const grid = new THREE.GridHelper(BED, 13, "#2c2f33", "#2c2f33");
    grid.rotation.x = Math.PI / 2;
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(BED, BED)),
      new THREE.LineBasicMaterial({ color: "#4a4f55" }));
    this.scene.add(grid, edge, this.paths);
    this.paths.position.set(-BED / 2, -BED / 2, 0); // G-code is in bed coordinates

    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.resizer.disconnect();
    this.renderer.setAnimationLoop(null);
    this.clearPaths();
    this.mesh?.geometry.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---- mesh ----

  setMesh(geometry: THREE.BufferGeometry, hex: string | null) {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: displayColor(hex), roughness: 0.65, metalness: 0.05,
    }));
    this.scene.add(this.mesh);
  }

  showMesh() {
    if (this.mesh) this.mesh.visible = true;
    this.paths.visible = false;
    if (!this.mesh) return;
    const size = this.mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z, 60);
    this.camera.position.set(-r * 1.4, -r * 1.9, size.z / 2 + r * 1.1);
    this.controls.target.set(0, 0, size.z / 2);
    this.controls.update();
  }

  // ---- toolpaths ----

  private clearPaths() {
    for (const c of this.paths.children) (c as THREE.LineSegments).geometry.dispose();
    this.paths.clear();
    this.data = null;
  }

  setToolpaths(buffer: ArrayBuffer | null): Toolpaths | null {
    this.clearPaths();
    if (!buffer) return null;
    const n = new DataView(buffer).getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, n)));
    const all = new Float32Array(buffer, 4 + n);
    for (const t of meta.types as PathType[]) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(all.subarray(t.offset * 6, (t.offset + t.count) * 6), 3));
      t.line = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({
        color: FEATURE_COLORS[t.name] ?? "#999", transparent: true,
      }));
      this.paths.add(t.line);
    }
    this.data = meta;
    this.layer = meta.layers.length - 1;
    this.updatePaths();
    return meta;
  }

  showPaths() {
    if (this.mesh) this.mesh.visible = false;
    this.paths.visible = true;
    this.framePaths();
  }

  updatePaths() {
    const d = this.data;
    if (!d) return;
    const xray = this.xray && !this.single; // a single layer is already a cross-section
    for (const t of d.types) {
      const from = this.single ? t.layerStarts[this.layer] : 0;
      const to = t.layerStarts[this.layer + 1];
      t.line.geometry.setDrawRange(from * 2, (to - from) * 2);
      t.line.visible = !this.hidden.has(t.name);
      const faded = xray && WALLS.has(t.name);
      const material = t.line.material as THREE.LineBasicMaterial;
      material.opacity = faded ? 0.06 : 1;
      material.depthWrite = !faded;
      t.line.renderOrder = faded ? 1 : 0;
    }
  }

  /** Bounds of the part itself: brim, purge lines and supports left out. */
  private partBounds(from: number, to: number): THREE.Box3 {
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    for (const t of this.data!.types) {
      if (NOT_PART.has(t.name)) continue;
      const pos = t.line.geometry.attributes.position.array;
      for (let i = t.layerStarts[from] * 6; i < t.layerStarts[to] * 6; i += 3)
        box.expandByPoint(p.set(pos[i], pos[i + 1], pos[i + 2]));
    }
    return box.translate(this.paths.position);
  }

  /** Whole print: three-quarter view. Single layer: straight down onto it. */
  framePaths() {
    const d = this.data;
    if (!d) return;
    const whole = this.partBounds(0, d.layers.length);
    let box = this.single ? this.partBounds(this.layer, this.layer + 1) : whole;
    if (box.isEmpty()) { // e.g. a support-only layer: the part's outline at this height
      box = whole.clone();
      box.min.z = box.max.z = d.layers[this.layer];
    }
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.controls.target.copy(center);
    if (this.single) {
      const fov = THREE.MathUtils.degToRad(this.camera.fov);
      const fit = Math.max(size.x / this.camera.aspect, size.y, 20) / 2 / Math.tan(fov / 2);
      this.camera.position.set(center.x, center.y - 1, center.z + fit * 1.15);
    } else {
      const r = Math.max(size.x, size.y, size.z, 60);
      this.camera.position.set(center.x - r * 1.6, center.y - r * 2.2, center.z + r * 1.6);
    }
    this.controls.update();
  }
}

// ---- thumbnails: one shared offscreen renderer ----

let thumbRenderer: THREE.WebGLRenderer | null = null;
const thumbs = new Map<string, Promise<{ url: string; size: THREE.Vector3 }>>();

export function thumbnail(key: string, meshUrl: string, hex: string | null) {
  if (!thumbs.has(key)) {
    thumbs.set(key, (async () => {
      const res = await fetch(meshUrl);
      if (!res.ok) throw new Error(await res.text());
      const { geometry, size } = parseMesh(await res.arrayBuffer());
      thumbRenderer ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
      thumbRenderer.setSize(560, 400, false);
      const scene = new THREE.Scene();
      addLights(scene);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: displayColor(hex), roughness: 0.65 }));
      scene.add(mesh);
      const camera = new THREE.PerspectiveCamera(30, 560 / 400, 1, 5000);
      camera.up.set(0, 0, 1);
      const r = Math.max(size.x, size.y, size.z);
      camera.position.set(-r * 1.5, -r * 2.0, size.z / 2 + r * 1.3);
      camera.lookAt(0, 0, size.z / 2);
      thumbRenderer.render(scene, camera);
      const url = thumbRenderer.domElement.toDataURL("image/png");
      geometry.dispose();
      return { url, size };
    })());
  }
  return thumbs.get(key)!;
}

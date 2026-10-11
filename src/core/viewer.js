// The 3D view: a scene of parts. Z is up (printer convention). Renders only when
// something changed; frames run only while the camera settles.
//
// Mouse: right drag orbits, middle drag pans, wheel zooms, Ctrl + left drag orbits,
// Shift + right drag pans. Left click picks, left drag on a part moves it on the plate,
// left drag on empty space draws a selection box.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const C = { bg: 0x0a0a0a, body: 0x9c9c9c, bodySel: 0xc8c8c8, inside: 0x2d5a2d, edge: 0x000000, edgeSel: 0x7dcf7d,
  hole: 0x8a8a8a, grid: 0x222222, gridMajor: 0x3a3a3a, plate: 0x111411, pick: 0x7dcf7d, box: 0x7dcf7d };
const EDGE_MAX_TRIS = 400000;

export class Viewer {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(C.bg);
    this.renderer.localClippingEnabled = true;
    el.appendChild(this.renderer.domElement);
    const dom = this.renderer.domElement;
    dom.tabIndex = 0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(160, -220, 170);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.18;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.addEventListener('change', () => this.request());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x303030, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(0.4, 0.8, 0.3);
    this.camera.add(key);
    this.scene.add(this.camera);

    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    this.clipOn = false;
    this.mats = {
      body: new THREE.MeshLambertMaterial({ color: C.body, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      bodySel: new THREE.MeshLambertMaterial({ color: C.bodySel, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      inside: new THREE.MeshBasicMaterial({ color: C.inside, side: THREE.BackSide }),
      hole: new THREE.MeshLambertMaterial({ color: C.hole, flatShading: true, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
      edge: new THREE.LineBasicMaterial({ color: C.edge, transparent: true, opacity: 0.5 }),
      edgeSel: new THREE.LineBasicMaterial({ color: C.edgeSel }),
      holeEdge: new THREE.LineDashedMaterial({ color: 0xb0b0b0, dashSize: 2, gapSize: 1.5 }),
      pick: new THREE.MeshBasicMaterial({ color: C.pick, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    };

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.objs = new Map();     // part id -> {group, mesh, edges, key, tris, part}
    this.selected = new Set();
    this.makePlate(200);

    // events the app listens to
    this.onPick = null;        // (id|null, faceIndex, event)
    this.onBox = null;         // (ids[], event) after a selection box
    this.onDragStart = null;   // (id, event) -> bool (start a move)
    this.onDrag = null;        // (dx, dy, event) plate millimetres since the start
    this.onDragEnd = null;

    this.boxEl = document.createElement('div');
    this.boxEl.className = 'selbox';
    el.appendChild(this.boxEl);
    this.pointer(dom);
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
  }

  // ---- input -------------------------------------------------------------------------------
  pointer(dom) {
    let down = null;
    const plateAt = (e, z) => {
      const ray = this.ray(e);
      const p = new THREE.Vector3();
      return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), p) ? p : null;
    };
    dom.addEventListener('contextmenu', e => e.preventDefault());
    dom.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (e.ctrlKey) {   // Ctrl + left: orbit
        this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        return;
      }
      this.controls.mouseButtons.LEFT = null;
      const hit = this.hit(e);
      down = { x: e.clientX, y: e.clientY, hit, moving: false, boxing: false };
      if (hit) down.plane = plateAt(e, hit.point.z);
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', e => {
      if (!down) return;
      const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (!down.moving && !down.boxing && dist > 4) {
        if (down.hit && this.onDragStart?.(down.hit.id, e)) down.moving = true;
        else if (!down.hit) down.boxing = true;
      }
      if (down.moving && down.plane) {
        const p = plateAt(e, down.plane.z);
        if (p) this.onDrag?.(p.x - down.plane.x, p.y - down.plane.y, e);
      }
      if (down.boxing) {
        const r = dom.getBoundingClientRect();
        const x0 = Math.min(down.x, e.clientX) - r.left, y0 = Math.min(down.y, e.clientY) - r.top;
        Object.assign(this.boxEl.style, { display: 'block', left: x0 + 'px', top: y0 + 'px',
          width: Math.abs(e.clientX - down.x) + 'px', height: Math.abs(e.clientY - down.y) + 'px' });
      }
    });
    dom.addEventListener('pointerup', e => {
      if (e.button !== 0 || !down) return;
      const d = down;
      down = null;
      if (d.moving) { this.onDragEnd?.(e); return; }
      if (d.boxing) {
        this.boxEl.style.display = 'none';
        this.onBox?.(this.inBox(d.x, d.y, e.clientX, e.clientY), e);
        return;
      }
      this.onPick?.(d.hit ? d.hit.id : null, d.hit ? d.hit.face : -1, e);
    });
  }

  ray(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    return ray;
  }

  /** Nearest part under the pointer: {id, face (local triangle), point}. */
  hit(e) {
    const ray = this.ray(e);
    const meshes = [...this.objs.values()].filter(o => o.group.visible).map(o => o.mesh);
    const h = ray.intersectObjects(meshes, false).find(x => !(this.clipOn && this.clipPlane.distanceToPoint(x.point) < 0));
    return h ? { id: h.object.userData.id, face: h.faceIndex, point: h.point } : null;
  }

  /** Parts the selection box touches: any of the part's points (sampled), any of its
   *  triangle middles, or the box's own centre lying on it. */
  inBox(x0, y0, x1, y1) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const lo = [Math.min(x0, x1) - r.left, Math.min(y0, y1) - r.top], hi = [Math.max(x0, x1) - r.left, Math.max(y0, y1) - r.top];
    const out = [];
    const v = new THREE.Vector3();
    const inside = () => {
      if (v.z > 1) return false;   // behind the camera
      const sx = ((v.x + 1) / 2) * r.width, sy = ((1 - v.y) / 2) * r.height;
      return sx >= lo[0] && sx <= hi[0] && sy >= lo[1] && sy <= hi[1];
    };
    for (const [id, o] of this.objs) {
      if (!o.group.visible) continue;
      o.group.updateMatrixWorld();
      const m = o.group.matrixWorld, t = o.tris;
      const n = t.length / 9;
      const stride = Math.max(1, Math.floor(n / 4000));
      let hit = false;
      for (let f = 0; f < n && !hit; f += stride) {
        const i = f * 9;
        for (let k = 0; k < 9 && !hit; k += 3) { v.set(t[i + k], t[i + k + 1], t[i + k + 2]).applyMatrix4(m).project(this.camera); hit = inside(); }
        if (!hit) { v.set((t[i] + t[i + 3] + t[i + 6]) / 3, (t[i + 1] + t[i + 4] + t[i + 7]) / 3, (t[i + 2] + t[i + 5] + t[i + 8]) / 3).applyMatrix4(m).project(this.camera); hit = inside(); }
      }
      if (hit) out.push(id);
    }
    // a box drawn wholly inside one big part touches no point of it: take what is under its centre
    if (!out.length) {
      const e = { clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2 };
      const h = this.hit(e);
      if (h) out.push(h.id);
    }
    return out;
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.request();
  }

  request() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.controls.update();
      if (this.clipOn) this.updateClip();
      this.renderer.render(this.scene, this.camera);
    });
  }

  // ---- parts -------------------------------------------------------------------------------
  /** Show these parts. meshes: Map(id -> {key, tris}) in each part's own frame. */
  sync(parts, meshes) {
    const seen = new Set();
    for (const p of parts) {
      seen.add(p.id);
      const m = meshes.get(p.id);
      let o = this.objs.get(p.id);
      if (!m) continue;
      if (!o || o.key !== m.key || o.hole !== !!p.hole) {
        if (o) this.drop(o);
        o = this.build(p, m);
        this.objs.set(p.id, o);
      }
      o.part = p;
      if (o.body) o.body.color.set(p.color || C.body);   // colour never needs a rebuild
      this.place(o.group, p.xform);
      o.group.visible = !p.hidden;
    }
    for (const [id, o] of this.objs) if (!seen.has(id)) { this.drop(o); this.objs.delete(id); }
    this.paintSelection();
    this.request();
  }

  build(p, m) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.tris, 3));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const group = new THREE.Group();
    const hole = !!p.hole;
    // each solid gets its own material so it can carry its own colour
    const body = hole ? null : new THREE.MeshLambertMaterial({ color: p.color || C.body, flatShading: true, polygonOffset: true,
      polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: this.clipOn ? [this.clipPlane] : null });
    const mesh = new THREE.Mesh(g, hole ? this.mats.hole : body);
    mesh.userData = { id: p.id, hole };
    group.add(mesh);
    if (!hole) group.add(new THREE.Mesh(g, this.mats.inside));
    let edges = null;
    if (m.tris.length / 9 <= EDGE_MAX_TRIS) {
      edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 40), hole ? this.mats.holeEdge : this.mats.edge);
      if (hole) edges.computeLineDistances();
      group.add(edges);
    }
    this.root.add(group);
    return { group, mesh, edges, body, key: m.key, tris: m.tris, hole, part: p };
  }

  drop(o) {
    o.group.traverse(c => { if (c.geometry) c.geometry.dispose(); });
    o.body?.dispose();
    this.root.remove(o.group);
  }

  place(obj, x) {
    obj.position.set(...(x?.pos || [0, 0, 0]));
    const r = (x?.rot || [0, 0, 0]).map(d => (d * Math.PI) / 180);
    obj.rotation.set(r[0], r[1], r[2], 'XYZ');
    obj.scale.set(...(x?.scale || [1, 1, 1]));
  }

  /** Move a part's display without a rebuild (live drag). */
  setXform(id, x) { const o = this.objs.get(id); if (o) { this.place(o.group, x); this.request(); } }

  /** Preview a different mesh for one part (tool steps), or null to go back. */
  preview(id, tris) {
    const o = this.objs.get(id);
    if (!o) return;
    if (o.previewMesh) { o.group.remove(o.previewMesh); o.previewMesh.geometry.dispose(); o.previewMesh = null; }
    o.group.children.forEach(c => { if (c !== o.previewMesh) c.visible = !tris; });
    if (tris) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
      g.computeVertexNormals();
      o.previewMesh = new THREE.Mesh(g, this.mats.bodySel);
      o.group.add(o.previewMesh);
    }
    this.request();
  }

  select(ids) {
    this.selected = new Set(ids);
    this.paintSelection();
    this.request();
  }
  paintSelection() {
    for (const [id, o] of this.objs) {
      const on = this.selected.has(id);
      // selected: lit up (lightness, works on any colour) and green outline (shape cue)
      if (o.body) o.body.emissive.setHex(on ? 0x3a3a3a : 0x000000);
      if (o.edges && !o.hole) o.edges.material = on ? this.mats.edgeSel : this.mats.edge;
    }
  }

  /** Highlight picked triangles on one part (tool face picks). */
  setFacePick(id, list) {
    if (this.pickMesh) { this.pickMesh.parent?.remove(this.pickMesh); this.pickMesh.geometry.dispose(); this.pickMesh = null; }
    const o = id && this.objs.get(id);
    if (o && list?.length) {
      const a = new Float32Array(list.length * 9);
      list.forEach((f, i) => a.set(o.tris.subarray(f * 9, f * 9 + 9), i * 9));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(a, 3));
      this.pickMesh = new THREE.Mesh(g, this.mats.pick);
      o.group.add(this.pickMesh);
    }
    this.request();
  }

  /** Which plate axes the arrow keys mean from this view: the one of +X, -X, +Y, -Y that
   *  moves on screen most nearly right, and the one most nearly up. Works from any angle,
   *  below the plate included. Returns {right: [x, y], up: [x, y]}. */
  screenAxes(at) {
    const c = at || this.controls.target;
    const r = this.renderer.domElement.getBoundingClientRect();
    const p0 = new THREE.Vector3(c.x, c.y, c.z).project(this.camera);
    const L = Math.max(1, this.camera.position.distanceTo(this.controls.target) / 20);
    const cands = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(a => {
      const p = new THREE.Vector3(c.x + a[0] * L, c.y + a[1] * L, c.z).project(this.camera);
      const sx = (p.x - p0.x) * r.width, sy = -(p.y - p0.y) * r.height;   // screen y grows down
      const l = Math.hypot(sx, sy) || 1;
      return { a, sx: sx / l, sy: sy / l };
    });
    const right = cands.reduce((b, k) => (k.sx > b.sx ? k : b));
    const up = cands.filter(k => k.a[0] !== right.a[0] || k.a[1] !== right.a[1]).filter(k => !(k.a[0] === -right.a[0] && k.a[1] === -right.a[1]))
      .reduce((b, k) => (-k.sy > -b.sy ? k : b));
    return { right: right.a, up: up.a };
  }

  /** World bounding box of some parts (all when ids is empty). */
  bounds(ids) {
    const b = new THREE.Box3();
    for (const [id, o] of this.objs) if ((!ids?.length || ids.includes(id)) && o.group.visible) b.expandByObject(o.group);
    return b.isEmpty() ? null : b;
  }

  // ---- plate, cut, camera -------------------------------------------------------------------
  makePlate(size) {
    const half = size / 2;
    const p = [], c = [];
    const minor = new THREE.Color(C.grid), major = new THREE.Color(C.gridMajor);
    for (let v = -half; v <= half + 1e-9; v += 10) {
      const k = Math.abs(v % 50) < 1e-6 ? major : minor;
      p.push(v, -half, 0, v, half, 0, -half, v, 0, half, v, 0);
      c.push(k.r, k.g, k.b, k.r, k.g, k.b, k.r, k.g, k.b, k.r, k.g, k.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: C.plate, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));
    plate.position.z = -0.01;
    this.plate = new THREE.Group();
    this.plate.add(plate, lines);
    this.scene.add(this.plate);
  }

  setClip(axis, t) { this.clipAxis = axis; this.clipT = t; this.updateClip(); this.request(); }
  updateClip() {
    const b = this.bounds();
    const on = !!this.clipAxis && !!b;
    if (on !== this.clipOn) {
      this.clipOn = on;
      for (const m of [...Object.values(this.mats), ...[...this.objs.values()].map(o => o.body).filter(Boolean)]) m.clippingPlanes = on ? [this.clipPlane] : null;
    }
    if (!on) return;
    const i = { x: 0, y: 1, z: 2 }[this.clipAxis];
    const lo = b.min.getComponent(i), hi = b.max.getComponent(i);
    const s = this.camera.position.getComponent(i) >= this.controls.target.getComponent(i) ? 1 : -1;
    const n = new THREE.Vector3(); n.setComponent(i, -s);
    this.clipPlane.set(n, s * (lo + (hi - lo) * this.clipT));
  }

  /** kind: iso | top | front | right; ids: fit these (default all, or the plate). */
  view(kind, ids) {
    const b = this.bounds(ids) || new THREE.Box3(new THREE.Vector3(-60, -60, 0), new THREE.Vector3(60, 60, 20));
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(5, b.getSize(new THREE.Vector3()).length() / 2);
    const d = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.1;
    const dir = { iso: [0.55, -0.75, 0.55], top: [0, -0.0001, 1], front: [0, -1, 0.0001], right: [1, 0, 0.0001] }[kind] || null;
    const v = dir ? new THREE.Vector3(...dir).normalize() : this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(v, d);
    this.camera.near = Math.max(0.05, d / 2000);
    this.camera.far = d * 40;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.request();
  }
}

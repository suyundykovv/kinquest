// 3D-фигура Разведчика для «Чертёжной мастерской»: вращение пальцем, добавить/убрать кубик касанием.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const PALETTE = [0xf4a261, 0xe9c46a, 0x2a9d8f, 0xe76f51, 0x8ab17d, 0x9b8ce8];

export function createBlueprintStage(container, { onEdit, onRotate }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(4.2, 5.2, 7.2);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8c3a5, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(4, 8, 6);
  scene.add(sun);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 5;
  controls.maxDistance = 14;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.target.set(0, 0.8, 0);

  // Считаем «поворот», если за один жест камера повернулась больше чем на 20°.
  let startAz = 0, startPol = 0;
  controls.addEventListener('start', () => { startAz = controls.getAzimuthalAngle(); startPol = controls.getPolarAngle(); });
  controls.addEventListener('end', () => {
    const d = Math.abs(controls.getAzimuthalAngle() - startAz) + Math.abs(controls.getPolarAngle() - startPol);
    if (d > 0.35) onRotate && onRotate();
  });

  const group = new THREE.Group();
  scene.add(group);
  const cubeGeo = new THREE.BoxGeometry(0.96, 0.96, 0.96);
  const edgeGeo = new THREE.EdgesGeometry(cubeGeo);
  const tileGeo = new THREE.BoxGeometry(0.98, 0.08, 0.98);

  let state = { w: 3, d: 3, grid: [[0]], highlight: null };
  let mode = 'add';
  let pickables = [];

  function build() {
    group.clear();
    pickables = [];
    const { w, d, grid, highlight } = state;
    const ox = (w - 1) / 2, oz = (d - 1) / 2;
    // Подставка с меткой «ПЕРЕД», чтобы Разведчик и Хранитель смотрели с одной стороны.
    const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.2, d + 0.6), new THREE.MeshLambertMaterial({ color: 0xc8a27a }));
    base.position.y = -0.14;
    group.add(base);
    const front = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.22, 0.32), new THREE.MeshLambertMaterial({ color: 0xffc531 }));
    front.position.set(0, -0.12, oz + 0.62);
    group.add(front);
    group.add(makeLabel('ПЕРЕД', 0, 0.05, oz + 0.95));
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const isHi = highlight && highlight.z === z && highlight.x === x;
        const tile = new THREE.Mesh(tileGeo, new THREE.MeshLambertMaterial({ color: isHi ? 0xff7a59 : (x + z) % 2 ? 0xf3e2c7 : 0xead3b0 }));
        tile.position.set(x - ox, 0, z - oz);
        tile.userData = { x, z, floor: true };
        group.add(tile);
        pickables.push(tile);
        const h = grid[z][x];
        for (let y = 0; y < h; y++) {
          const color = isHi ? 0xff7a59 : PALETTE[(x + z * 2) % PALETTE.length];
          const m = new THREE.Mesh(cubeGeo, new THREE.MeshLambertMaterial({ color }));
          m.position.set(x - ox, 0.52 + y, z - oz);
          m.userData = { x, z, y };
          const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0x2b2140, transparent: true, opacity: 0.35 }));
          m.add(edges);
          group.add(m);
          pickables.push(m);
        }
      }
    }
  }

  function makeLabel(text, x, y, z) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#2b2140';
    g.font = 'bold 40px Rubik, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(c);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.4), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
    return mesh;
  }

  // Касание без перетаскивания = правка кубика.
  const ray = new THREE.Raycaster();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    if (!hit) return;
    const { x, z } = hit.object.userData;
    onEdit && onEdit({ x, z, delta: mode === 'add' ? 1 : -1 });
  });

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    frame();
  }

  // Камера отодвигается так, чтобы фигура целиком помещалась и в узком (телефон), и в широком окне.
  let framedFor = '';
  function frame() {
    const key = `${state.w}x${state.d}:${camera.aspect.toFixed(2)}`;
    if (key === framedFor) return;
    framedFor = key;
    const size = Math.max(state.w, state.d, 3) + 1.5;
    const dist = (size * 1.55) / Math.min(1, camera.aspect * 1.1);
    const dir = new THREE.Vector3(0.5, 0.62, 0.88).normalize();
    camera.position.copy(dir.multiplyScalar(dist)).add(controls.target);
    controls.minDistance = dist * 0.6;
    controls.maxDistance = dist * 1.6;
    controls.update();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  let alive = true;
  (function loop() {
    if (!alive) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  })();

  return {
    update(next) {
      const same = JSON.stringify(next) === JSON.stringify(state);
      state = next;
      if (!same) build();
      resize();
    },
    setMode(m) { mode = m; },
    destroy() { alive = false; ro.disconnect(); renderer.dispose(); container.innerHTML = ''; },
  };
}

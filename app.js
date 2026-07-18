import * as THREE from "three";

// ---------- STL parsing (handles both binary and ASCII STL) ----------
function parseSTL(buffer) {
  const dv = new DataView(buffer);

  const isBinary = (() => {
    if (buffer.byteLength < 84) return false;
    const triCount = dv.getUint32(80, true);
    const expected = 84 + triCount * 50;
    return expected === buffer.byteLength && triCount > 0;
  })();

  if (isBinary) {
    const triCount = dv.getUint32(80, true);
    const positions = new Float32Array(triCount * 9);
    const normals = new Float32Array(triCount * 9);
    let offset = 84;
    for (let i = 0; i < triCount; i++) {
      const nx = dv.getFloat32(offset, true);
      const ny = dv.getFloat32(offset + 4, true);
      const nz = dv.getFloat32(offset + 8, true);
      offset += 12;
      for (let v = 0; v < 3; v++) {
        const vx = dv.getFloat32(offset, true);
        const vy = dv.getFloat32(offset + 4, true);
        const vz = dv.getFloat32(offset + 8, true);
        offset += 12;
        const idx = (i * 3 + v) * 3;
        positions[idx] = vx;
        positions[idx + 1] = vy;
        positions[idx + 2] = vz;
        normals[idx] = nx;
        normals[idx + 1] = ny;
        normals[idx + 2] = nz;
      }
      offset += 2;
    }
    if (triCount === 0) throw new Error("empty");
    return { positions, normals };
  }

  // ASCII fallback
  const text = new TextDecoder().decode(buffer);
  const positions = [];
  const normals = [];
  const facetRe = /facet\s+normal\s+([\-0-9.eE+]+)\s+([\-0-9.eE+]+)\s+([\-0-9.eE+]+)[\s\S]*?outer loop([\s\S]*?)endloop/g;
  const vRe = /vertex\s+([\-0-9.eE+]+)\s+([\-0-9.eE+]+)\s+([\-0-9.eE+]+)/g;
  let m;
  while ((m = facetRe.exec(text)) !== null) {
    const nx = parseFloat(m[1]), ny = parseFloat(m[2]), nz = parseFloat(m[3]);
    let vm;
    vRe.lastIndex = 0;
    while ((vm = vRe.exec(m[4])) !== null) {
      positions.push(parseFloat(vm[1]), parseFloat(vm[2]), parseFloat(vm[3]));
      normals.push(nx, ny, nz);
    }
  }
  if (positions.length === 0) throw new Error("unparseable");
  return { positions: new Float32Array(positions), normals: new Float32Array(normals) };
}

const AXIS_COLOR = { x: "#e5484d", y: "#3dd68c", z: "#4c9eff" };

// ---------- STEP/IGES parsing via occt-import-js (WASM OpenCascade build) ----------
// Loaded lazily from a CDN the first time a .stp/.step file is opened, so STL-only
// users never pay for the (fairly large) WASM download.
const OCCT_CDN_URL = "https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/occt-import-js.js";
let occtModulePromise = null;
function loadOcct() {
  if (occtModulePromise) return occtModulePromise;
  occtModulePromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = OCCT_CDN_URL;
    script.onload = () => {
      if (typeof window.occtimportjs !== "function") {
        reject(new Error("CAD engine script loaded but did not initialize"));
        return;
      }
      window.occtimportjs().then(resolve).catch(reject);
    };
    script.onerror = () => reject(new Error("Failed to load CAD engine from CDN"));
    document.head.appendChild(script);
  });
  return occtModulePromise;
}


// ---------- DOM references ----------
const mount = document.getElementById("three-mount");
const viewport = document.getElementById("viewport");
const dropzoneHint = document.getElementById("dropzone-hint");
const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("error-banner");
const fileInput = document.getElementById("file-input");
const screenshotBtn = document.getElementById("screenshot-btn");
const lockBtn = document.getElementById("lock-btn");
const resetBtn = document.getElementById("reset-btn");
const fitBtn = document.getElementById("fit-btn");
const dimsSection = document.getElementById("dims-section");
const dimsBox = document.getElementById("dims-box");
const gridToggle = document.getElementById("grid-toggle");
const filenameDisplay = document.getElementById("filename-display");
const bgButtons = document.querySelectorAll(".bg-btn");

const axisRows = {
  x: document.querySelector('.axis-row[data-axis="x"]'),
  y: document.querySelector('.axis-row[data-axis="y"]'),
  z: document.querySelector('.axis-row[data-axis="z"]'),
};

// ---------- app state ----------
let fileName = null;
let baseSize = null; // { x, y, z } unscaled bounding box size
let scale = { x: 1, y: 1, z: 1 };
let locked = false;
let background = "dark";

// ---------- three.js setup ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
mount.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#0d0f13");

const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100000);

const hemi = new THREE.HemisphereLight(0xffffff, 0x30323a, 1.1);
scene.add(hemi);
const dir1 = new THREE.DirectionalLight(0xffffff, 1.1);
dir1.position.set(1, 1.6, 1.2);
scene.add(dir1);
const dir2 = new THREE.DirectionalLight(0xffffff, 0.4);
dir2.position.set(-1, -0.5, -1);
scene.add(dir2);

const grid = new THREE.GridHelper(10, 20, 0x4c9eff, 0x2a2f37);
grid.material.transparent = true;
grid.material.opacity = 0.35;
scene.add(grid);

let model = null; // a THREE.Group ("pivot") wrapping one or more meshes, centered at origin

function resize() {
  const w = mount.clientWidth;
  const h = mount.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
resize();
new ResizeObserver(resize).observe(mount);

// ---------- custom orbit / pan / zoom controls ----------
const cam = {
  radius: 10,
  theta: Math.PI / 4,
  phi: Math.PI / 3,
  target: new THREE.Vector3(0, 0, 0),
  dragging: false,
  panning: false,
  lastX: 0,
  lastY: 0,
  minR: 0.01,
  maxR: 100000,
};

function updateCamera() {
  const { radius, theta, phi, target } = cam;
  camera.position.set(
    target.x + radius * Math.sin(phi) * Math.sin(theta),
    target.y + radius * Math.cos(phi),
    target.z + radius * Math.sin(phi) * Math.cos(theta)
  );
  camera.lookAt(target);
}
updateCamera();

const dom = renderer.domElement;
dom.addEventListener("pointerdown", (e) => {
  cam.dragging = true;
  cam.panning = e.button === 2 || e.shiftKey;
  cam.lastX = e.clientX;
  cam.lastY = e.clientY;
  dom.setPointerCapture(e.pointerId);
});
dom.addEventListener("pointermove", (e) => {
  if (!cam.dragging) return;
  const dx = e.clientX - cam.lastX;
  const dy = e.clientY - cam.lastY;
  cam.lastX = e.clientX;
  cam.lastY = e.clientY;
  if (cam.panning) {
    const panSpeed = cam.radius * 0.0015;
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const right = new THREE.Vector3().crossVectors(camDir, camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, camDir).normalize();
    cam.target.addScaledVector(right, -dx * panSpeed);
    cam.target.addScaledVector(up, dy * panSpeed);
  } else {
    cam.theta -= dx * 0.006;
    cam.phi -= dy * 0.006;
    cam.phi = Math.max(0.05, Math.min(Math.PI - 0.05, cam.phi));
  }
  updateCamera();
});
function endDrag(e) {
  cam.dragging = false;
  cam.panning = false;
  try { dom.releasePointerCapture(e.pointerId); } catch {}
}
dom.addEventListener("pointerup", endDrag);
dom.addEventListener("pointerleave", endDrag);
dom.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = Math.exp(e.deltaY * 0.001);
  cam.radius = Math.max(cam.minR, Math.min(cam.maxR, cam.radius * factor));
  updateCamera();
}, { passive: false });
dom.addEventListener("contextmenu", (e) => e.preventDefault());

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();

// ---------- background handling ----------
function applyBackground() {
  if (background === "transparent") {
    scene.background = null;
    renderer.setClearAlpha(0);
    viewport.classList.add("bg-transparent");
  } else if (background === "light") {
    scene.background = new THREE.Color("#f4f2ee");
    renderer.setClearAlpha(1);
    viewport.classList.remove("bg-transparent");
  } else {
    scene.background = new THREE.Color("#0d0f13");
    renderer.setClearAlpha(1);
    viewport.classList.remove("bg-transparent");
  }
}
bgButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    background = btn.dataset.bg;
    bgButtons.forEach((b) => b.classList.toggle("active", b === btn));
    applyBackground();
  });
});

gridToggle.addEventListener("change", () => {
  grid.visible = gridToggle.checked;
});

// ---------- building the 3D model ----------
// specs: array of { positions: Float32Array, normals: Float32Array|null, index: Uint32Array|null, color: [r,g,b]|null }
// One spec per part. A plain STL produces a single spec with no index (flat triangle soup).
// A STEP assembly can produce many specs, one per solid/part, each indexed and optionally colored.
function buildModel(specs) {
  if (model) {
    scene.remove(model);
    model.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
    model = null;
  }

  const rawGroup = new THREE.Group();
  for (const spec of specs) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(spec.positions, 3));
    if (spec.normals) geometry.setAttribute("normal", new THREE.BufferAttribute(spec.normals, 3));
    if (spec.index) geometry.setIndex(new THREE.BufferAttribute(spec.index, 1));
    if (!spec.normals) geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: spec.color ? new THREE.Color(spec.color[0], spec.color[1], spec.color[2]) : "#d7d2c6",
      metalness: 0.08,
      roughness: 0.55,
      flatShading: !spec.index,
      side: THREE.DoubleSide,
    });
    rawGroup.add(new THREE.Mesh(geometry, material));
  }

  const pivot = new THREE.Group();
  pivot.add(rawGroup);
  scene.add(pivot);
  model = pivot;

  rawGroup.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(rawGroup);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  pivot.position.copy(center).multiplyScalar(-1);

  baseSize = { x: size.x || 0.001, y: size.y || 0.001, z: size.z || 0.001 };

  scale = { x: 1, y: 1, z: 1 };
  pivot.scale.set(1, 1, 1);
  setControlsEnabled(true);
  syncAxisUI();
  updateDims();

  const sphereRadius = size.length() / 2;
  const radius = Math.max(sphereRadius * 2.6, 0.5);
  cam.radius = radius;
  cam.target.set(0, 0, 0);
  cam.minR = radius * 0.03;
  cam.maxR = radius * 40;

  const gridSize = Math.max(size.length() * 2, 2);
  grid.scale.setScalar(gridSize / 10);
  grid.position.y = box.min.y - center.y;
}

function onModelLoaded(name) {
  fileName = name;
  filenameDisplay.textContent = fileName;
  screenshotBtn.disabled = false;
  document.getElementById("upload-label").textContent = "Load another file";
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.style.display = "block";
  if (!model) dropzoneHint.style.display = "flex";
}

function handleSTL(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const { positions, normals } = parseSTL(reader.result);
      buildModel([{ positions, normals, index: null, color: null }]);
      onModelLoaded(file.name);
    } catch (err) {
      showError("Couldn't read this as an STL file. Check it's a valid .stl export.");
    } finally {
      loadingEl.style.display = "none";
    }
  };
  reader.onerror = () => {
    showError("Something went wrong reading the file.");
    loadingEl.style.display = "none";
  };
  reader.readAsArrayBuffer(file);
}

async function handleStep(file) {
  try {
    loadingEl.textContent = "Loading CAD engine (first time only)\u2026";
    const occt = await loadOcct();
    loadingEl.textContent = "Parsing model\u2026";
    const buffer = await file.arrayBuffer();
    const result = occt.ReadStepFile(new Uint8Array(buffer), null);
    if (!result.success || !result.meshes || result.meshes.length === 0) {
      throw new Error("no geometry");
    }
    const specs = result.meshes.map((m) => ({
      positions: Float32Array.from(m.attributes.position.array),
      normals: m.attributes.normal ? Float32Array.from(m.attributes.normal.array) : null,
      index: Uint32Array.from(m.index.array),
      color: m.color || null,
    }));
    buildModel(specs);
    onModelLoaded(file.name);
  } catch (err) {
    showError("Couldn't read this STEP file. It may be malformed, use unsupported entities, or the CAD engine failed to load (check your internet connection).");
  } finally {
    loadingEl.style.display = "none";
    loadingEl.textContent = "Parsing model\u2026";
  }
}

function routeFile(file) {
  if (!file) return;
  errorEl.style.display = "none";
  loadingEl.style.display = "flex";
  dropzoneHint.style.display = "none";

  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "stl") {
    handleSTL(file);
  } else if (ext === "stp" || ext === "step") {
    handleStep(file);
  } else {
    loadingEl.style.display = "none";
    showError("Unsupported file type. Please upload a .stl, .stp, or .step file.");
  }
}

fileInput.addEventListener("change", (e) => routeFile(e.target.files?.[0]));

viewport.addEventListener("dragover", (e) => {
  e.preventDefault();
  viewport.classList.add("dragover");
});
viewport.addEventListener("dragleave", () => viewport.classList.remove("dragover"));
viewport.addEventListener("drop", (e) => {
  e.preventDefault();
  viewport.classList.remove("dragover");
  const file = e.dataTransfer.files?.[0];
  if (file) routeFile(file);
});

// ---------- axis scale controls ----------
function setControlsEnabled(enabled) {
  ["x", "y", "z"].forEach((axis) => {
    axisRows[axis].querySelector(".num-input").disabled = !enabled;
    axisRows[axis].querySelector(".range-input").disabled = !enabled;
  });
  resetBtn.disabled = !enabled;
  fitBtn.disabled = !enabled;
}

function syncAxisUI() {
  ["x", "y", "z"].forEach((axis) => {
    axisRows[axis].querySelector(".num-input").value = Number(scale[axis].toFixed(3));
    axisRows[axis].querySelector(".range-input").value = scale[axis];
  });
}

function setAxis(axis, value) {
  if (locked) {
    scale = { x: value, y: value, z: value };
  } else {
    scale[axis] = value;
  }
  if (model) model.scale.set(scale.x, scale.y, scale.z);
  syncAxisUI();
  updateDims();
}

["x", "y", "z"].forEach((axis) => {
  const numInput = axisRows[axis].querySelector(".num-input");
  const rangeInput = axisRows[axis].querySelector(".range-input");
  numInput.addEventListener("input", () => {
    const v = parseFloat(numInput.value);
    if (!isNaN(v) && v > 0) setAxis(axis, v);
  });
  rangeInput.addEventListener("input", () => setAxis(axis, parseFloat(rangeInput.value)));
});

lockBtn.addEventListener("click", () => {
  locked = !locked;
  lockBtn.textContent = locked ? "Uniform scale locked" : "Lock axes together";
});

resetBtn.addEventListener("click", () => {
  scale = { x: 1, y: 1, z: 1 };
  if (model) model.scale.set(1, 1, 1);
  syncAxisUI();
  updateDims();
});

fitBtn.addEventListener("click", () => {
  if (!model || !baseSize) return;
  const sx = baseSize.x * scale.x;
  const sy = baseSize.y * scale.y;
  const sz = baseSize.z * scale.z;
  const diag = Math.sqrt(sx * sx + sy * sy + sz * sz);
  cam.radius = Math.max(diag * 0.9, 0.1);
  cam.target.set(0, 0, 0);
});

function updateDims() {
  if (!baseSize) return;
  dimsSection.style.display = "block";
  const dx = baseSize.x * scale.x;
  const dy = baseSize.y * scale.y;
  const dz = baseSize.z * scale.z;
  dimsBox.innerHTML = `
    <span><span style="color:${AXIS_COLOR.x}">X</span> ${dx.toFixed(2)}</span>
    <span><span style="color:${AXIS_COLOR.y}">Y</span> ${dy.toFixed(2)}</span>
    <span><span style="color:${AXIS_COLOR.z}">Z</span> ${dz.toFixed(2)}</span>
  `;
}

// ---------- screenshot ----------
screenshotBtn.addEventListener("click", () => {
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = (fileName ? fileName.replace(/\.(stl|stp|step)$/i, "") : "model") + "-view.png";
  a.click();
});
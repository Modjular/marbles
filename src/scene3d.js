// The 3D view: scene, renderer, lighting, environment, the desk placeholder, the
// orbit/pan/pinch/fly camera, and the bank/roll twist-handle interaction. It owns
// all the THREE scene objects and the groups other modules add into (physics.js
// adds marble + collider-debug meshes to the groups exported here). The track
// geometry itself comes from track.js; this module just turns it into meshes and
// draws it. A bank-handle drag mutates the shared spline model and asks the
// orchestrator (via bus hooks) for a rebuild.

import * as THREE from "three";
import { nodes } from "./spline.js";
import {
  buildRailTubeGeometry, computeCentroid, RAIL_RADIAL_SEGMENTS,
} from "./track.js";
import {
  RAIL_MATERIAL, DESK_MATERIAL, PATH_LINE_MATERIAL, SAMPLE_POINT_MATERIAL,
  NODE_POINT_MATERIAL,
} from "./materials.js";
import { hooks } from "./bus.js";

export const wrap3d = document.getElementById("canvas3d-wrap");
export const canvas3d = document.getElementById("debug-canvas");
export const empty3d = document.getElementById("canvas3d-empty");

export const scene3d = new THREE.Scene();
export const renderer3d = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: true });
renderer3d.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

// Fallback sky color, shown until (unless) the panorama skybox below loads.
scene3d.background = new THREE.Color(0xbfd0e0);
scene3d.add(new THREE.HemisphereLight(0xffffff, 0x6b6146, 0.85));
const dirLight3d = new THREE.DirectionalLight(0xfff2d0, 1.2);
dirLight3d.position.set(6, 10, 5);
scene3d.add(dirLight3d);

// ---- Environment map ----
// The env map is what makes the metallic marbles/rails read as metal instead of
// flat black, independent of the visible background. We hold onto the PMREM render
// target so it can be disposed when the skybox load replaces it (otherwise the GPU
// target leaks).
let envRenderTarget = null;
function buildEnvironment3D() {
  const envScene = new THREE.Scene();
  const sphereGeo = new THREE.SphereGeometry(40, 24, 16);
  const posAttr = sphereGeo.getAttribute("position");
  const colors = new Float32Array(posAttr.count * 3);
  const top = new THREE.Color(0xffffff), bottom = new THREE.Color(0xc9c2a0), sun = new THREE.Color(0xfff4d6);
  const tmp = new THREE.Vector3();
  for (let i = 0; i < posAttr.count; i++) {
    tmp.fromBufferAttribute(posAttr, i).normalize();
    const h = tmp.y * 0.5 + 0.5;
    const c = bottom.clone().lerp(top, Math.pow(h, 0.7));
    const sunAmount = Math.max(0, tmp.dot(new THREE.Vector3(0.4, 0.6, 0.3).normalize()) - 0.75) * 4;
    c.lerp(sun, THREE.MathUtils.clamp(sunAmount, 0, 1));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  sphereGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  envScene.add(new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })));
  const pmrem = new THREE.PMREMGenerator(renderer3d);
  const rt = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  envRenderTarget = rt;
  return rt.texture;
}
scene3d.environment = buildEnvironment3D();

// ---- Desk placeholder ----
// A wood surface floating in the skybox, repositioned each rebuild (see
// updateDeskVisual) to sit one unit below the track's last node.
const DESK_SIZE = 26;
export const deskMesh = new THREE.Mesh(new THREE.PlaneGeometry(DESK_SIZE, DESK_SIZE), DESK_MATERIAL);
deskMesh.rotation.x = -Math.PI / 2;
scene3d.add(deskMesh);
export const deskGrid = new THREE.GridHelper(DESK_SIZE, DESK_SIZE / 2, 0x8a7256, 0xc4b49a);
scene3d.add(deskGrid);
export const DESK_HALF = DESK_SIZE / 2;

// Positions the desk visuals under `anchor`; returns the desk's Y so the caller
// can place the matching physics floor. Does not early-out -- the caller
// (main.js updateRoomAndDesk) owns the "anchor unchanged" skip.
export function updateDeskVisual(anchor) {
  const deskY = anchor.y - 1;
  deskMesh.position.set(anchor.x, deskY, anchor.z);
  deskGrid.position.set(anchor.x, deskY + 0.003, anchor.z);
  return deskY;
}

// ---- Optional remote placeholder textures ----
// Both loads need CORS headers from the remote host; if a load fails the fallback
// color/background set above simply stays in place instead of anything breaking.
const textureLoader = new THREE.TextureLoader();
textureLoader.setCrossOrigin("anonymous");

const DESK_TEXTURE_URL = "https://upload.wikimedia.org/wikipedia/commons/3/34/Swietenia_macrophylla_wood.jpg";
textureLoader.load(DESK_TEXTURE_URL, (tex) => {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  DESK_MATERIAL.map = tex;
  DESK_MATERIAL.needsUpdate = true;
}, undefined, (err) => {
  console.warn("Desk texture failed to load:", DESK_TEXTURE_URL, err);
});

const SKYBOX_TEXTURE_URL = "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f0/Franklin_Park_photosphere%2C_May_2019.jpg/3840px-Franklin_Park_photosphere%2C_May_2019.jpg";
textureLoader.load(SKYBOX_TEXTURE_URL, (tex) => {
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  scene3d.background = tex;
  const pmrem = new THREE.PMREMGenerator(renderer3d);
  const skyRT = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  if (envRenderTarget) envRenderTarget.dispose(); // release the procedural env RT we're replacing
  envRenderTarget = skyRT;
  scene3d.environment = skyRT.texture;
}, undefined, (err) => {
  console.warn("Skybox failed to load:", SKYBOX_TEXTURE_URL, err);
});

// ---- Scene groups ----
// Exported so physics.js can drop collider-debug wireframes and marble meshes in,
// and ui.js can toggle their visibility.
export const debugPointsGroup = new THREE.Group();
scene3d.add(debugPointsGroup);
export const trackMeshGroup = new THREE.Group();
scene3d.add(trackMeshGroup);
export const colliderDebugGroup = new THREE.Group();
scene3d.add(colliderDebugGroup);
export const marbleGroup = new THREE.Group();
scene3d.add(marbleGroup);

let pathLine = null, samplePoints = null, nodePoints = null;

// ---- Bank/roll twist handles ----
// Hovering (mouse) or tapping (touch, via Edit) a red node reveals a dial -- a
// ring plus a draggable handle sphere in the plane perpendicular to the rail at
// that node. Dragging it sets that node's `bank` (roll around the direction of
// travel). Radii are hit-test sizes in world units, sized up a bit for touch.
const NODE_PICK_RADIUS = 0.09;
const NODE_PICK_GEOMETRY = new THREE.SphereGeometry(NODE_PICK_RADIUS, 10, 8);
const NODE_PICK_MATERIAL = new THREE.MeshBasicMaterial({ color: 0xef4a5f });
const HANDLE_RING_RADIUS = 0.4;
const HANDLE_SPHERE_RADIUS = 0.08;
const HANDLE_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x287b60 });
const HANDLE_RING_MATERIAL = new THREE.LineBasicMaterial({ color: 0x287b60, transparent: true, opacity: 0.65 });
const HANDLE_RING_SEGMENTS = 40;

const nodePickGroup = new THREE.Group();
scene3d.add(nodePickGroup);
let nodePickMeshes = []; // one small sphere per node, userData.nodeIndex, for raycasting

const handleGroup = new THREE.Group();
handleGroup.visible = false;
scene3d.add(handleGroup);
const handleSphere = new THREE.Mesh(new THREE.SphereGeometry(HANDLE_SPHERE_RADIUS, 12, 8), HANDLE_MATERIAL);
handleGroup.add(handleSphere);
const handleRing = new THREE.LineLoop(new THREE.BufferGeometry(), HANDLE_RING_MATERIAL);
handleGroup.add(handleRing);

let nodeFrameData = []; // per node: { pos, tangent, normal0, binormal0 } at bank=0
let hoveredNodeIndex = -1;
let draggingNodeIndex = -1;

function updateHandleVisual(nodeIndex) {
  const nf = nodeFrameData[nodeIndex];
  if (!nf) { handleGroup.visible = false; return; }
  const bank = nodes[nodeIndex].bank || 0;
  const ringPositions = [];
  for (let k = 0; k < HANDLE_RING_SEGMENTS; k++) {
    const theta = (k / HANDLE_RING_SEGMENTS) * Math.PI * 2;
    const p = nf.pos.clone()
      .addScaledVector(nf.normal0, Math.cos(theta) * HANDLE_RING_RADIUS)
      .addScaledVector(nf.binormal0, Math.sin(theta) * HANDLE_RING_RADIUS);
    ringPositions.push(p.x, p.y, p.z);
  }
  handleRing.geometry.setAttribute("position", new THREE.Float32BufferAttribute(ringPositions, 3));
  handleRing.geometry.attributes.position.needsUpdate = true;
  handleRing.geometry.computeBoundingSphere();

  handleSphere.position.copy(
    nf.pos.clone()
      .addScaledVector(nf.normal0, Math.cos(bank) * HANDLE_RING_RADIUS)
      .addScaledVector(nf.binormal0, Math.sin(bank) * HANDLE_RING_RADIUS)
  );
  handleGroup.visible = true;
}

export function rebuildNodeHandles(nodeMarkers) {
  while (nodePickGroup.children.length) nodePickGroup.remove(nodePickGroup.children[0]);
  nodePickMeshes = [];
  for (let i = 0; i < nodeMarkers.length; i++) {
    const mesh = new THREE.Mesh(NODE_PICK_GEOMETRY, NODE_PICK_MATERIAL);
    mesh.position.copy(nodeMarkers[i]);
    mesh.userData.nodeIndex = i;
    nodePickGroup.add(mesh);
    nodePickMeshes.push(mesh);
  }
  if (hoveredNodeIndex >= nodeMarkers.length) hoveredNodeIndex = -1;
  if (draggingNodeIndex >= nodeMarkers.length) draggingNodeIndex = -1;
  if (hoveredNodeIndex !== -1) updateHandleVisual(hoveredNodeIndex);
  else handleGroup.visible = false;
}

// Re-shows the dial for the currently-hovered node after a rebuild moved things.
export function refreshHoveredHandle() {
  if (hoveredNodeIndex !== -1) updateHandleVisual(hoveredNodeIndex);
}

const raycaster3d = new THREE.Raycaster();
function ndcFromEvent3D(e) {
  const rect = canvas3d.getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
}

// ---- Track visual rebuild helpers (called by the orchestrator) ----
export function rebuildDebugPoints(pathPoints, nodeMarkers) {
  if (pathLine) { debugPointsGroup.remove(pathLine); pathLine.geometry.dispose(); pathLine = null; }
  if (samplePoints) { debugPointsGroup.remove(samplePoints); samplePoints.geometry.dispose(); samplePoints = null; }
  if (nodePoints) { debugPointsGroup.remove(nodePoints); nodePoints.geometry.dispose(); nodePoints = null; }
  if (pathPoints.length >= 2) {
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pathPoints);
    pathLine = new THREE.Line(lineGeo, PATH_LINE_MATERIAL);
    debugPointsGroup.add(pathLine);
    const ptGeo = new THREE.BufferGeometry().setFromPoints(pathPoints);
    samplePoints = new THREE.Points(ptGeo, SAMPLE_POINT_MATERIAL);
    debugPointsGroup.add(samplePoints);
  }
  if (nodeMarkers.length >= 1) {
    const nodeGeo = new THREE.BufferGeometry().setFromPoints(nodeMarkers);
    nodePoints = new THREE.Points(nodeGeo, NODE_POINT_MATERIAL);
    debugPointsGroup.add(nodePoints);
  }
}

// Builds both rail tubes into trackMeshGroup and returns the raw positions/indices
// (for the physics colliders) plus the total vertex count.
export function rebuildRailMesh(pathPoints, frames) {
  clearRailMesh();
  const railMeshesBySide = [];
  for (const side of [-1, 1]) {
    const { geo, positions, indices } = buildRailTubeGeometry(pathPoints, frames, side);
    trackMeshGroup.add(new THREE.Mesh(geo, RAIL_MATERIAL));
    railMeshesBySide.push({ positions, indices });
  }
  return { railMeshesBySide, totalVerts: pathPoints.length * RAIL_RADIAL_SEGMENTS * 2 };
}

export function clearRailMesh() {
  while (trackMeshGroup.children.length) {
    const child = trackMeshGroup.children.pop();
    child.geometry.dispose();
  }
}

// Captures each node's *unbanked* frame -- the fixed reference the twist dial and
// its drag math are defined against, stable regardless of the node's bank value.
export function updateNodeFrames(pathPoints, nodeMarkers, frames, nodePathIndex) {
  if (frames) {
    nodeFrameData = nodePathIndex.map((pi) => ({
      pos: pathPoints[pi].clone(),
      tangent: frames.tangents[pi].clone(),
      normal0: frames.normals[pi].clone(),
      binormal0: frames.binormals[pi].clone(),
    }));
  } else {
    nodeFrameData = nodePathIndex.map((pi, ni) => ({
      pos: (nodeMarkers[ni] || new THREE.Vector3()).clone(),
      tangent: new THREE.Vector3(1, 0, 0),
      normal0: new THREE.Vector3(0, 1, 0),
      binormal0: new THREE.Vector3(0, 0, 1),
    }));
  }
}

export function setEmptyVisible(on) {
  empty3d.style.display = on ? "flex" : "none";
}

// ---- Orbit camera ----
let azimuth = Math.PI / 4, elevation = 0.5, orbitRadius = 8;
let camZoom3d = 1;
const orbitTarget = new THREE.Vector3(0, -1, 0);

const perspectiveCamera3d = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
let viewSize3d = 4;
const orthoCamera3d = new THREE.OrthographicCamera(-viewSize3d, viewSize3d, viewSize3d, -viewSize3d, 0.1, 100);
let projectionMode = "perspective";
let camera3d = perspectiveCamera3d;

export function updateCamera3D() {
  const ce = Math.cos(elevation);
  const pos = new THREE.Vector3(
    orbitTarget.x + orbitRadius * ce * Math.sin(azimuth),
    orbitTarget.y + orbitRadius * Math.sin(elevation),
    orbitTarget.z + orbitRadius * ce * Math.cos(azimuth)
  );
  for (const cam of [perspectiveCamera3d, orthoCamera3d]) {
    cam.position.copy(pos);
    cam.lookAt(orbitTarget);
    cam.zoom = camZoom3d;
    cam.updateProjectionMatrix();
  }
}

export function resize3D() {
  const rect = wrap3d.getBoundingClientRect();
  // The 3D wrap starts display:none, so the first ResizeObserver fire reports 0x0
  // -- skip it rather than setting a degenerate 0-aspect camera / 0-size renderer.
  if (rect.width === 0 || rect.height === 0) return;
  const aspect = rect.width / rect.height;
  perspectiveCamera3d.aspect = aspect;
  perspectiveCamera3d.updateProjectionMatrix();
  orthoCamera3d.left = -viewSize3d * aspect;
  orthoCamera3d.right = viewSize3d * aspect;
  orthoCamera3d.top = viewSize3d;
  orthoCamera3d.bottom = -viewSize3d;
  orthoCamera3d.updateProjectionMatrix();
  renderer3d.setSize(rect.width, rect.height);
}
new ResizeObserver(resize3D).observe(wrap3d);

export function setProjectionMode(mode) {
  projectionMode = mode;
  camera3d = mode === "isometric" ? orthoCamera3d : perspectiveCamera3d;
  resize3D();
  updateCamera3D();
}

// Recenter the orbit pivot on the track's centroid so long/lopsided tracks don't
// orbit around empty space.
export function recenter(points) {
  orbitTarget.copy(computeCentroid(points));
}

export function render() {
  renderer3d.render(scene3d, camera3d);
}

// ---- Bank-edit affordance (touch) ----
let editBankingsMode = false;
const editBankingsBtn = document.getElementById("edit-bankings-btn");
export function setEditBankings(on) {
  editBankingsMode = on;
  editBankingsBtn.classList.toggle("active", on);
  if (!on && hoveredNodeIndex !== -1) {
    hoveredNodeIndex = -1;
    handleGroup.visible = false;
  }
}
editBankingsBtn.addEventListener("click", () => setEditBankings(!editBankingsMode));

// ---- Pointer interaction: orbit / pan / pinch / bank-drag / hover ----
let orbiting = false, lastOrbitX = 0, lastOrbitY = 0;
let panning3d = false, lastPanX = 0, lastPanY = 0;
const activePointers3d = new Map(); // pointerId -> {x, y}
let twoFingerLastMid = null, twoFingerLastDist = null;

function twoFingerPoints() {
  const pts = [...activePointers3d.values()];
  return pts.length >= 2 ? [pts[0], pts[1]] : null;
}
function midOf(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function distOf(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

canvas3d.addEventListener("pointerdown", (e) => {
  canvas3d.setPointerCapture(e.pointerId);
  activePointers3d.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers3d.size >= 2) {
    orbiting = false;
    draggingNodeIndex = -1;
    panning3d = false;
    wrap3d.classList.add("dragging");
    const pts = twoFingerPoints();
    twoFingerLastMid = midOf(pts[0], pts[1]);
    twoFingerLastDist = distOf(pts[0], pts[1]);
    return;
  }

  if (e.button === 1) {
    e.preventDefault(); // stop the browser's middle-click autoscroll cursor
    panning3d = true;
    lastPanX = e.clientX;
    lastPanY = e.clientY;
    wrap3d.classList.add("dragging");
    return;
  }
  if (handleGroup.visible) {
    raycaster3d.setFromCamera(ndcFromEvent3D(e), camera3d);
    if (raycaster3d.intersectObject(handleSphere, false).length) {
      draggingNodeIndex = hoveredNodeIndex;
      return; // grabbed the twist handle -- don't also start orbiting
    }
  }
  if (editBankingsMode) {
    raycaster3d.setFromCamera(ndcFromEvent3D(e), camera3d);
    const hits = raycaster3d.intersectObjects(nodePickMeshes, false);
    if (hits.length) {
      const idx = hits[0].object.userData.nodeIndex;
      hoveredNodeIndex = idx;
      updateHandleVisual(idx);
      return; // tap-selected a node's dial -- don't also start orbiting
    } else if (hoveredNodeIndex !== -1) {
      hoveredNodeIndex = -1;
      handleGroup.visible = false;
      // fall through -- this same touch can still orbit
    }
  }
  orbiting = true;
  lastOrbitX = e.clientX;
  lastOrbitY = e.clientY;
  wrap3d.classList.add("dragging");
});

canvas3d.addEventListener("pointermove", (e) => {
  if (activePointers3d.has(e.pointerId)) {
    activePointers3d.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
  if (activePointers3d.size >= 2) {
    const pts = twoFingerPoints();
    const mid = midOf(pts[0], pts[1]);
    const d = distOf(pts[0], pts[1]);
    if (twoFingerLastMid) {
      const dx = mid.x - twoFingerLastMid.x, dy = mid.y - twoFingerLastMid.y;
      const panScale = (orbitRadius / camZoom3d) * 0.0016;
      const camRight = new THREE.Vector3().setFromMatrixColumn(camera3d.matrixWorld, 0);
      const camUp = new THREE.Vector3().setFromMatrixColumn(camera3d.matrixWorld, 1);
      orbitTarget.addScaledVector(camRight, -dx * panScale);
      orbitTarget.addScaledVector(camUp, dy * panScale);
      if (twoFingerLastDist > 1e-3) {
        camZoom3d = THREE.MathUtils.clamp(camZoom3d * (d / twoFingerLastDist), 0.3, 6);
      }
      updateCamera3D();
    }
    twoFingerLastMid = mid;
    twoFingerLastDist = d;
    return;
  }
  if (panning3d) {
    const dx = e.clientX - lastPanX, dy = e.clientY - lastPanY;
    lastPanX = e.clientX; lastPanY = e.clientY;
    const panScale = (orbitRadius / camZoom3d) * 0.0016;
    const camRight = new THREE.Vector3().setFromMatrixColumn(camera3d.matrixWorld, 0);
    const camUp = new THREE.Vector3().setFromMatrixColumn(camera3d.matrixWorld, 1);
    orbitTarget.addScaledVector(camRight, -dx * panScale);
    orbitTarget.addScaledVector(camUp, dy * panScale);
    updateCamera3D();
    return;
  }
  if (draggingNodeIndex !== -1) {
    const nf = nodeFrameData[draggingNodeIndex];
    if (nf) {
      raycaster3d.setFromCamera(ndcFromEvent3D(e), camera3d);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(nf.tangent, nf.pos);
      const hitPoint = new THREE.Vector3();
      if (raycaster3d.ray.intersectPlane(plane, hitPoint)) {
        const offset = hitPoint.sub(nf.pos);
        nodes[draggingNodeIndex].bank = Math.atan2(offset.dot(nf.binormal0), offset.dot(nf.normal0));
        updateHandleVisual(draggingNodeIndex);
        hooks.scheduleTrackRebuild({ recenterCamera: false });
      }
    }
    return;
  }
  if (orbiting) {
    const dx = e.clientX - lastOrbitX, dy = e.clientY - lastOrbitY;
    lastOrbitX = e.clientX; lastOrbitY = e.clientY;
    azimuth -= dx * 0.008;
    elevation = THREE.MathUtils.clamp(elevation + dy * 0.008, -1.5, 1.5);
    updateCamera3D();
    return;
  }
  // Hover test (mice/trackpads only): reveal the twist handle over a node and keep
  // it revealed while moving around the dial, by checking distance from the node
  // within its own perpendicular plane (out to the handle's radius).
  raycaster3d.setFromCamera(ndcFromEvent3D(e), camera3d);
  const hits = raycaster3d.intersectObjects(nodePickMeshes, false);
  if (hits.length) {
    const idx = hits[0].object.userData.nodeIndex;
    if (idx !== hoveredNodeIndex) {
      hoveredNodeIndex = idx;
      updateHandleVisual(idx);
    }
  } else if (hoveredNodeIndex !== -1) {
    const nf = nodeFrameData[hoveredNodeIndex];
    let stillOnDial = false;
    if (nf) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(nf.tangent, nf.pos);
      const hitPoint = new THREE.Vector3();
      if (raycaster3d.ray.intersectPlane(plane, hitPoint)) {
        stillOnDial = hitPoint.distanceTo(nf.pos) <= HANDLE_RING_RADIUS * 1.3;
      }
    }
    if (!stillOnDial) {
      hoveredNodeIndex = -1;
      handleGroup.visible = false;
    }
  }
});

function endOrbit(e) {
  activePointers3d.delete(e.pointerId);
  try { canvas3d.releasePointerCapture(e.pointerId); } catch (_) {}
  if (activePointers3d.size >= 2) {
    const pts = twoFingerPoints();
    twoFingerLastMid = midOf(pts[0], pts[1]);
    twoFingerLastDist = distOf(pts[0], pts[1]);
    return;
  }
  twoFingerLastMid = null;
  twoFingerLastDist = null;
  if (activePointers3d.size === 1) {
    const [remaining] = activePointers3d.values();
    orbiting = true;
    lastOrbitX = remaining.x;
    lastOrbitY = remaining.y;
    return;
  }
  orbiting = false;
  panning3d = false;
  draggingNodeIndex = -1;
  wrap3d.classList.remove("dragging");
}
canvas3d.addEventListener("pointerup", endOrbit);
canvas3d.addEventListener("pointercancel", endOrbit);
canvas3d.addEventListener("wheel", (e) => {
  e.preventDefault();
  camZoom3d = THREE.MathUtils.clamp(camZoom3d * (e.deltaY > 0 ? 1 / 1.1 : 1.1), 0.3, 6);
  updateCamera3D();
}, { passive: false });

// ---- WASD fly camera (desktop only) ----
const FLY_KEY_CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);
const pressedFlyKeys = new Set();
function isTypingIntoControl(el) {
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}
window.addEventListener("keydown", (e) => {
  if (!FLY_KEY_CODES.has(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingIntoControl(document.activeElement)) return;
  pressedFlyKeys.add(e.code);
});
window.addEventListener("keyup", (e) => { pressedFlyKeys.delete(e.code); });
window.addEventListener("blur", () => pressedFlyKeys.clear());

const FLY_SPEED = 4; // world units/second at the default orbitRadius scale
export function applyFlyCamera(dt) {
  if (pressedFlyKeys.size === 0) return;
  const camRight = new THREE.Vector3().setFromMatrixColumn(camera3d.matrixWorld, 0);
  const camForward = new THREE.Vector3().setFromMatrixColumn(camera3d.matrixWorld, 2).multiplyScalar(-1);
  const step = FLY_SPEED * (orbitRadius / 8) * dt;
  if (pressedFlyKeys.has("KeyW")) orbitTarget.addScaledVector(camForward, step);
  if (pressedFlyKeys.has("KeyS")) orbitTarget.addScaledVector(camForward, -step);
  if (pressedFlyKeys.has("KeyD")) orbitTarget.addScaledVector(camRight, step);
  if (pressedFlyKeys.has("KeyA")) orbitTarget.addScaledVector(camRight, -step);
  updateCamera3D();
}

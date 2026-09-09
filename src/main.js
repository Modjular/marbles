// Bootstrap + orchestrator. Wires the cross-module hooks, defines the single
// "rebuild every 3D layer from the current model" pass, runs the animation loop,
// and kicks the whole thing off. Importing physics.js (via the modules below)
// blocks on box3d's wasm init through top-level await, so by the time this module's
// body runs the engine is ready.

import * as THREE from "three";
import { nodes } from "./spline.js";
import { computeTrack3D, computeLevelFrames, applyBankToFrames } from "./track.js";
import * as scene from "./scene3d.js";
import * as physics from "./physics.js";
import { getView } from "./ui.js";
import { initEditor2D } from "./editor2d.js";
import { hooks } from "./bus.js";
import "./recording.js"; // attaches the Record button + registers cancelRecording
import "./audio.js";     // physical-audio seam: loaded and ready, inert until enabled

// Positions the desk (visual) and its floor collider under the track's last node.
function updateRoomAndDesk(anchor) {
  const deskY = scene.updateDeskVisual(anchor);
  physics.updateFloor(anchor, deskY);
}

// Recomputes the 3D path, then rebuilds every layer that depends on it (debug
// points, node handles, rail mesh, colliders) and optionally recenters the orbit
// camera on the track's centroid.
function rebuildTrack3D({ recenterCamera = true } = {}) {
  const { pathPoints, nodeMarkers, bankPerPoint, nodePathIndex } = computeTrack3D();
  physics.setSpawnPath(nodeMarkers, pathPoints);
  scene.setEmptyVisible(nodes.length < 2);
  scene.rebuildNodeHandles(nodeMarkers);
  updateRoomAndDesk(nodeMarkers.length ? nodeMarkers[nodeMarkers.length - 1] : new THREE.Vector3(0, 0, 0));
  scene.rebuildDebugPoints(pathPoints, nodeMarkers);

  let vertexCount = 0, colliderTriCount = 0;
  if (pathPoints.length >= 2) {
    const frames = computeLevelFrames(pathPoints);
    // Capture unbanked frames for the twist handles BEFORE banking mutates them.
    scene.updateNodeFrames(pathPoints, nodeMarkers, frames, nodePathIndex);
    applyBankToFrames(frames, bankPerPoint);
    const { railMeshesBySide, totalVerts } = scene.rebuildRailMesh(pathPoints, frames);
    physics.rebuildColliders(railMeshesBySide);
    vertexCount = totalVerts;
    colliderTriCount = railMeshesBySide.reduce((sum, { indices }) => sum + indices.length / 3, 0);
  } else {
    scene.updateNodeFrames(pathPoints, nodeMarkers, null, nodePathIndex);
    scene.clearRailMesh();
    physics.rebuildColliders([]);
  }
  scene.refreshHoveredHandle();
  document.getElementById("stat-vertices").textContent = String(vertexCount);
  document.getElementById("stat-collider-tris").textContent = String(colliderTriCount);

  // Recenter only on structural rebuilds, never while dragging a bank handle (that
  // path already has the user actively orbiting/panning, and snapping the pivot
  // back to centroid mid-drag felt like the camera teleporting).
  if (recenterCamera) scene.recenter(pathPoints.length ? pathPoints : nodeMarkers);
  scene.updateCamera3D();
}

// rAF-coalesced rebuild: a slider or bank-handle drag fires its DOM event far
// faster than a full rebuild (tens of ms) can run, so collapse a burst into one
// rebuild per frame. If any queued request wanted a recenter, the coalesced one does.
let trackRebuildQueued = false;
let trackRebuildRecenter = true;
function scheduleTrackRebuild(opts = {}) {
  const recenterCamera = opts.recenterCamera !== false;
  if (trackRebuildQueued) {
    trackRebuildRecenter = trackRebuildRecenter || recenterCamera;
    return;
  }
  trackRebuildQueued = true;
  trackRebuildRecenter = recenterCamera;
  requestAnimationFrame(() => {
    trackRebuildQueued = false;
    rebuildTrack3D({ recenterCamera: trackRebuildRecenter });
  });
}

// Publish the orchestrator entry points so scene3d.js (bank drag), physics.js
// (world rebuild), and ui.js (view switch / sliders) can trigger a rebuild without
// importing this module.
hooks.rebuildTrack3D = rebuildTrack3D;
hooks.scheduleTrackRebuild = scheduleTrackRebuild;

// ---- FPS counter (opt-in via Settings -> General) ----
const fpsCounterEl = document.getElementById("fps-counter");
const showFpsCheck = document.getElementById("show-fps-check");
showFpsCheck.addEventListener("change", () => {
  fpsCounterEl.style.display = showFpsCheck.checked ? "block" : "none";
});
let fpsSmoothed = 0;
let fpsLastLabelUpdate = 0;
let lastFrameTime = performance.now() / 1000;

function animate3D() {
  requestAnimationFrame(animate3D);
  const now = performance.now() / 1000;
  const frameTime = Math.min(now - lastFrameTime, 0.25);
  lastFrameTime = now;

  if (showFpsCheck.checked && frameTime > 0) {
    const instantFps = 1 / frameTime;
    fpsSmoothed = fpsSmoothed ? fpsSmoothed * 0.9 + instantFps * 0.1 : instantFps;
    if (now - fpsLastLabelUpdate > 0.25) {
      fpsLastLabelUpdate = now;
      fpsCounterEl.textContent = Math.round(fpsSmoothed) + " fps";
    }
  }

  if (getView() === "play") {
    scene.applyFlyCamera(frameTime);
    physics.tick(frameTime); // steps the sim + syncs marble meshes when running
    scene.render();
  } else {
    physics.resetAccumulator();
  }
}

// ---- Boot ----
initEditor2D();
scene.updateCamera3D();
animate3D();

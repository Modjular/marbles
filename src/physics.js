// Everything box3d: the world's lifecycle, the rail colliders, the desk floor, the
// marbles, and the fixed-timestep stepping. It owns the `physicsWorld` handle
// (which is torn down and recreated when the contact-tuning sliders change, since
// box3d exposes no live setter for those) so nothing outside this module ever
// holds a stale world reference. Marble and collider-debug meshes are added into
// the groups exported by scene3d.js; contact events are surfaced through onContacts
// for the planned physical-audio work.

import * as THREE from "three";
import Box3D from "box3d-wasm";
import { config } from "./config.js";
import { WORLD_UP } from "./track.js";
import { MARBLE_R, MARBLE_MATERIAL, MARBLE_GEOMETRY, COLLIDER_DEBUG_MATERIAL } from "./materials.js";
import { marbleGroup, colliderDebugGroup, DESK_HALF } from "./scene3d.js";
import { hooks } from "./bus.js";

// box3d-wasm is async (it instantiates the wasm module). Top-level await here means
// any module importing physics.js -- ultimately main.js -- waits until the engine
// is ready, which is exactly what we want before touching the world.
export const b3 = await Box3D();

function makeWorldDef() {
  return {
    gravity: { x: 0, y: -9.8, z: 0 },
    enableSleep: false,
    enableContinuous: true, // helps the small/fast marble not tunnel through a rail
    contactHertz: config.contactHertz,
    contactDampingRatio: config.contactDampingRatio,
  };
}
let physicsWorld = new b3.World(makeWorldDef());
export function getWorld() { return physicsWorld; }

// ---- Colliders ----
// Each rail collides as a single static triangle mesh, built from the exact same
// positions/indices as its visual tube (see track.js / scene3d.js) -- collision
// geometry IS the rendered rail. Uses Body.createMesh(), the binding added on top
// of box3d-wasm (see wasm/BUILD.txt).
let colliderBodies = [];
export function rebuildColliders(railMeshesBySide) {
  for (const body of colliderBodies) body.destroy();
  colliderBodies = [];
  while (colliderDebugGroup.children.length) {
    const child = colliderDebugGroup.children.pop();
    child.geometry.dispose();
  }
  for (const { positions, indices } of railMeshesBySide) {
    // Body.createMesh wants an array of {x,y,z} vectors, not a flat array.
    const vertices = new Array(positions.length / 3);
    for (let i = 0; i < vertices.length; i++) {
      vertices[i] = { x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] };
    }
    const body = physicsWorld.createBody({ type: "static" });
    body.createMesh({ vertices, indices, friction: config.railFriction, restitution: config.railRestitution });
    colliderBodies.push(body);

    const debugGeo = new THREE.BufferGeometry();
    debugGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    debugGeo.setIndex(indices);
    colliderDebugGroup.add(new THREE.Mesh(debugGeo, COLLIDER_DEBUG_MATERIAL));
  }
}

// ---- Desk floor collider ----
let floorBody = null;
let lastFloorAnchor = null;
export function updateFloor(anchor, deskY) {
  // Bank-handle drags rebuild the track (and call this) every pointermove even
  // though the anchor never moves during that interaction -- skip the
  // destroy/recreate of the floor body when the anchor is unchanged, rather than
  // hammering the WASM boundary and disturbing anything resting on it.
  if (lastFloorAnchor && lastFloorAnchor.distanceToSquared(anchor) < 1e-10) return;
  lastFloorAnchor = anchor.clone();
  if (floorBody) floorBody.destroy();
  floorBody = physicsWorld.createBody({ type: "static", position: { x: anchor.x, y: deskY - 0.25, z: anchor.z } });
  floorBody.createBox({ halfExtents: { x: DESK_HALF, y: 0.25, z: DESK_HALF }, friction: 0.4, restitution: 0.05 });
}

// ---- World rebuild (contact-tuning changes) ----
// contactHertz/contactDampingRatio have no live setter, so retuning them means
// tearing down the whole world and everything in it and rebuilding from scratch.
// Coalesced through requestAnimationFrame since the sliders fire a rapid burst of
// input events while dragged.
let worldRebuildQueued = false;
export function scheduleWorldRebuild() {
  if (worldRebuildQueued) return;
  worldRebuildQueued = true;
  requestAnimationFrame(() => {
    worldRebuildQueued = false;
    recreatePhysicsWorld();
  });
}
export function recreatePhysicsWorld() {
  stopSim(); // clears marbles and (via cancelRecording) aborts any capture
  for (const body of colliderBodies) body.destroy();
  colliderBodies = [];
  if (floorBody) { floorBody.destroy(); floorBody = null; }
  physicsWorld.destroy();
  physicsWorld = new b3.World(makeWorldDef());
  lastFloorAnchor = null; // force updateFloor to recreate the floor against the new world
  hooks.rebuildTrack3D({ recenterCamera: false });
}

// ---- Marbles ----
const MAX_MARBLES = 20;
const SPAWN_INTERVAL = 2;   // seconds between auto-spawns while playing
const SPAWN_KICK_SPEED = 1.2;
const PHYSICS_DT = 1 / 60;

let liveMarbles = [];       // { body, mesh }
let latestNodeMarkers = []; // spawnMarble reads index 0
let latestPathPoints = [];  // spawnMarble reads the initial tangent
let simRunning = false;
let simStarted = false;
let spawnTimer = 0;
let physicsAccumulator = 0;

// Refreshed by the orchestrator every rebuild, so a marble always spawns at the
// current node 0 with the current starting tangent.
export function setSpawnPath(nodeMarkers, pathPoints) {
  latestNodeMarkers = nodeMarkers;
  latestPathPoints = pathPoints;
}

const simPlayPauseBtn = document.getElementById("sim-playpause-btn");
function updateSimUI() {
  simPlayPauseBtn.textContent = !simStarted ? "Play" : (simRunning ? "Pause" : "Resume");
}
function updateMarbleStat() {
  document.getElementById("stat-marbles").textContent = String(liveMarbles.length);
}

export function spawnMarble() {
  if (latestNodeMarkers.length === 0) return;
  if (liveMarbles.length >= MAX_MARBLES) {
    const old = liveMarbles.shift();
    old.body.destroy();
    marbleGroup.remove(old.mesh);
  }
  // A small clearance above node 0 so the marble doesn't spawn interpenetrating
  // the rail mesh -- it settles onto the rails within the first few steps.
  const spawnPos = latestNodeMarkers[0].clone().addScaledVector(WORLD_UP, MARBLE_R * 1.2);
  let kick = { x: 0, y: 0, z: 0 };
  if (latestPathPoints.length >= 2) {
    const tangent = latestPathPoints[1].clone().sub(latestPathPoints[0]).normalize();
    kick = { x: tangent.x * SPAWN_KICK_SPEED, y: tangent.y * SPAWN_KICK_SPEED, z: tangent.z * SPAWN_KICK_SPEED };
  }
  const body = physicsWorld.createBody({
    type: "dynamic",
    position: { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z },
    linearVelocity: kick,
  });
  body.createSphere({ radius: MARBLE_R, density: 1, friction: 0.2, restitution: 0.05 });
  const mesh = new THREE.Mesh(MARBLE_GEOMETRY, MARBLE_MATERIAL);
  marbleGroup.add(mesh);
  liveMarbles.push({ body, mesh });
  updateMarbleStat();
}

export function clearMarbles() {
  for (const m of liveMarbles) { m.body.destroy(); marbleGroup.remove(m.mesh); }
  liveMarbles = [];
  updateMarbleStat();
}

// ---- Contact events (seam for physical audio) ----
// audio.js registers here; if nothing is listening we never even ask box3d for the
// events, so there's zero per-step cost until the feature is switched on.
let contactListener = null;
export function onContacts(cb) { contactListener = cb; }

// ---- Sim control + stepping ----
export function startSim() {
  simStarted = true;
  simRunning = true;
  spawnTimer = 0;
  spawnMarble();
  updateSimUI();
}
export function stopSim() {
  hooks.cancelRecording(); // a reset (or a world rebuild, which calls stopSim) aborts any capture
  clearMarbles();
  simStarted = false;
  simRunning = false;
  updateSimUI();
}
export function togglePlayPause() {
  if (!simStarted) startSim();
  else { simRunning = !simRunning; updateSimUI(); }
}
export function pauseSim() { simRunning = false; }
export function resetAccumulator() { physicsAccumulator = 0; }
export function isStarted() { return simStarted; }
export function isRunning() { return simRunning; }

// Advances the simulation by one rendered frame's worth of time (fixed-step,
// accumulator-based) and syncs each marble mesh to its body. No-op while paused.
export function tick(frameTime) {
  if (!simRunning) return;
  spawnTimer += frameTime;
  while (spawnTimer >= SPAWN_INTERVAL) {
    spawnTimer -= SPAWN_INTERVAL;
    spawnMarble();
  }
  physicsAccumulator += frameTime;
  while (physicsAccumulator >= PHYSICS_DT) {
    physicsWorld.step(PHYSICS_DT, 8);
    physicsAccumulator -= PHYSICS_DT;
  }
  if (contactListener) contactListener(physicsWorld.getContactEvents());
  for (const m of liveMarbles) {
    const p = m.body.getPosition(), r = m.body.getRotation();
    m.mesh.position.set(p.x, p.y, p.z);
    m.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
}

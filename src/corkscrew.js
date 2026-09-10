// The way marbles get back to the top: an Archimedes-screw lift standing at the
// centre of the desk, fed by a shallow cone floor that funnels every stray marble
// down to its base.
//
// Box3D only creates contacts for a mesh shape on a STATIC body, so the screw's
// helical ramp -- the surface marbles ride -- can't itself rotate. Instead the
// whole helix (central column, outer wall, ramp) is a static mesh, and the only
// moving parts are a set of long, thin vertical capsules on ONE kinematic body
// that spins about the central axis. As they sweep round they shove any marble
// resting on the ramp along the channel; because the ramp climbs in that same
// sweep direction, "pushed along" means "pushed up", and the marble spirals to
// the top and tips off wherever it likes (catching it again is left to the user).
//
// This module is pure builder + a small manager: it owns no globals of the world
// or the scene, so it can't form an import cycle. physics.js hands it the current
// box3d world and the THREE group to draw into (both of which are torn down and
// recreated when the contact-tuning sliders fire), it builds every collider and
// mesh against those, and it hands back a per-frame paddle sync. This mirrors the
// "model -> {render geometry, collider positions/indices}" shape the rail builder
// in track.js already uses.

import * as THREE from "three";
import {
  SCREW_STRUCTURE_MATERIAL, SCREW_RAMP_MATERIAL, PADDLE_MATERIAL, DESK_MATERIAL,
} from "./materials.js";

// ---- Cone floor (replaces the old flat plane) ----
// A gentle inverted cone: flat-ish out at the rim, sloping down to the screw base
// at the centre so marbles that land anywhere on the desk roll inward to the
// intake. FLOOR_RADIUS is passed in (it tracks the desk size); the rest is here.
const FLOOR_DEPTH = 1.8;   // how far the centre sits below the rim -- a slight incline over the whole desk
const FLOOR_RINGS = 20;
const FLOOR_SEGS = 48;

// ---- Screw dimensions ----
const COLUMN_R = 0.22;     // central static column radius
const OUTER_R = 0.85;      // inner face of the outer containing wall
const SCREW_HEIGHT = 5.0;  // world units the lift rises above its base
const SCREW_TURNS = 4;     // helix revolutions over that height
const RAMP_SEGS_PER_TURN = 24;
const WALL_BOTTOM = 0.45;  // the wall starts this far up, leaving the base open so funnelled marbles can roll in
const WALL_RINGS = 20;
const WALL_SEGS = 44;

// ---- Rotating paddles (the only moving parts) ----
const PADDLE_COUNT = 4;
const PADDLE_R = 0.07;                              // thin
const PADDLE_RADIUS = (COLUMN_R + OUTER_R) / 2;     // sit mid-channel so they sweep the marbles
const PADDLE_SPIN = 6.0;                            // rad/s (magnitude) -- faster carries marbles up quicker

// Helix handedness. The ramp winds and the paddles spin off this ONE constant so
// they always stay coupled: +ve angular velocity about +Y turns a point from +Z
// toward +X (its polar angle decreases), so to drive marbles toward the ramp's
// rising (+HELIX_SIGN) direction the paddles must spin the opposite way. If a
// build ever has marbles pushed DOWN instead of up, negate PADDLE_SPIN alone
// (flipping HELIX_SIGN turns the ramp AND the paddles, which changes nothing).
const HELIX_SIGN = 1;
const PADDLE_OMEGA = -HELIX_SIGN * PADDLE_SPIN;

// ---- Triangle-winding helpers ----
// box3d mesh triangles collide on one side (the side their winding faces), so a
// floor/ramp whose normals point the wrong way lets marbles fall straight through.
// Rather than track winding by hand across a helicoid, emit each triangle in
// whichever order makes its normal agree with a reference direction.
const _ab = new THREE.Vector3(), _ac = new THREE.Vector3(), _n = new THREE.Vector3();
function pushTri(positions, indices, ia, ib, ic, refX, refY, refZ) {
  _ab.set(
    positions[ib * 3] - positions[ia * 3],
    positions[ib * 3 + 1] - positions[ia * 3 + 1],
    positions[ib * 3 + 2] - positions[ia * 3 + 2]
  );
  _ac.set(
    positions[ic * 3] - positions[ia * 3],
    positions[ic * 3 + 1] - positions[ia * 3 + 1],
    positions[ic * 3 + 2] - positions[ia * 3 + 2]
  );
  _n.crossVectors(_ab, _ac);
  if (_n.x * refX + _n.y * refY + _n.z * refZ >= 0) indices.push(ia, ib, ic);
  else indices.push(ia, ic, ib);
}

function makeGeo(positions, indices, uvs) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (uvs) geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Vertices are emitted in world space (like the rail colliders in physics.js),
// so every collider body is created at the origin and the positions carry the
// placement -- no per-body transform to keep in sync.

function buildConeFloor(cx, cz, deskY, floorRadius) {
  const baseY = deskY - FLOOR_DEPTH;
  const floorY = (r) => deskY - FLOOR_DEPTH * (1 - r / floorRadius);
  const positions = [], uvs = [], indices = [];
  // ring 0 is the single centre vertex (the cone apex, at the screw base)
  positions.push(cx, baseY, cz);
  uvs.push(0.5, 0.5);
  for (let i = 1; i <= FLOOR_RINGS; i++) {
    const r = (i / FLOOR_RINGS) * floorRadius;
    const y = floorY(r);
    for (let j = 0; j < FLOOR_SEGS; j++) {
      const th = (j / FLOOR_SEGS) * Math.PI * 2;
      const x = Math.cos(th) * r, z = Math.sin(th) * r;
      positions.push(cx + x, y, cz + z);
      uvs.push(x / (2 * floorRadius) + 0.5, z / (2 * floorRadius) + 0.5);
    }
  }
  const ringStart = (i) => 1 + (i - 1) * FLOOR_SEGS; // index of ring i's first vertex
  // apex fan
  for (let j = 0; j < FLOOR_SEGS; j++) {
    const a = ringStart(1) + j, b = ringStart(1) + ((j + 1) % FLOOR_SEGS);
    pushTri(positions, indices, 0, a, b, 0, 1, 0);
  }
  for (let i = 1; i < FLOOR_RINGS; i++) {
    for (let j = 0; j < FLOOR_SEGS; j++) {
      const j2 = (j + 1) % FLOOR_SEGS;
      const a = ringStart(i) + j, b = ringStart(i) + j2;
      const c = ringStart(i + 1) + j, d = ringStart(i + 1) + j2;
      pushTri(positions, indices, a, c, b, 0, 1, 0);
      pushTri(positions, indices, b, c, d, 0, 1, 0);
    }
  }
  return { positions, indices, uvs, baseY };
}

// The helical ramp: a spiral ribbon from the column out to the wall, climbing one
// SCREW_HEIGHT over SCREW_TURNS turns. Normals point up (marbles ride the top).
function buildRamp(cx, cz, baseY) {
  const N = SCREW_TURNS * RAMP_SEGS_PER_TURN;
  const positions = [], indices = [];
  for (let s = 0; s <= N; s++) {
    const frac = s / N;
    const phi = HELIX_SIGN * frac * SCREW_TURNS * Math.PI * 2;
    const y = baseY + frac * SCREW_HEIGHT;
    const c = Math.cos(phi), sn = Math.sin(phi);
    positions.push(cx + COLUMN_R * c, y, cz + COLUMN_R * sn); // inner edge
    positions.push(cx + OUTER_R * c, y, cz + OUTER_R * sn);   // outer edge
  }
  for (let s = 0; s < N; s++) {
    const inA = s * 2, outA = s * 2 + 1, inB = (s + 1) * 2, outB = (s + 1) * 2 + 1;
    pushTri(positions, indices, inA, outA, inB, 0, 1, 0);
    pushTri(positions, indices, outA, outB, inB, 0, 1, 0);
  }
  return { positions, indices };
}

// The outer containing wall: an open cylinder from WALL_BOTTOM up to the top,
// normals facing inward so marbles bounce off it and stay in the channel.
function buildWall(cx, cz, baseY) {
  const y0 = baseY + WALL_BOTTOM, y1 = baseY + SCREW_HEIGHT;
  const positions = [], indices = [];
  for (let i = 0; i <= WALL_RINGS; i++) {
    const y = y0 + (i / WALL_RINGS) * (y1 - y0);
    for (let j = 0; j < WALL_SEGS; j++) {
      const th = (j / WALL_SEGS) * Math.PI * 2;
      positions.push(cx + Math.cos(th) * OUTER_R, y, cz + Math.sin(th) * OUTER_R);
    }
  }
  for (let i = 0; i < WALL_RINGS; i++) {
    for (let j = 0; j < WALL_SEGS; j++) {
      const j2 = (j + 1) % WALL_SEGS;
      const a = i * WALL_SEGS + j, b = i * WALL_SEGS + j2;
      const c = (i + 1) * WALL_SEGS + j, d = (i + 1) * WALL_SEGS + j2;
      // reference "inward" = from this quad's rough centre back toward the axis
      const rx = cx - positions[a * 3], rz = cz - positions[a * 3 + 2];
      pushTri(positions, indices, a, c, b, rx, 0, rz);
      pushTri(positions, indices, b, c, d, rx, 0, rz);
    }
  }
  return { positions, indices };
}

// ---- Manager state (all against the world/group most recently passed to rebuild) ----
let machineBodies = [];   // every box3d body we own, static + the one kinematic paddle
let paddleBody = null;    // the spinning kinematic body
let paddleGroup = null;   // its matching visuals, synced each frame
let group = null;         // the scene group we draw into

function addMeshCollider(world, positions, indices) {
  const vertices = new Array(positions.length / 3);
  for (let i = 0; i < vertices.length; i++) {
    vertices[i] = { x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] };
  }
  const body = world.createBody({ type: "static" });
  body.createMesh({ vertices, indices, friction: 0.35, restitution: 0.02 });
  machineBodies.push(body);
}

// Tears down every body and mesh from the previous build. Called before each
// rebuild and, crucially, before physics.js destroys the world (mesh shapes don't
// clone their data, so their bodies must be destroyed to free it -- see BUILD.txt).
export function destroy() {
  for (const body of machineBodies) body.destroy();
  machineBodies = [];
  paddleBody = null;
  if (group) {
    while (group.children.length) {
      const child = group.children.pop();
      // child may be a plain Mesh or the paddleGroup (whose bars are nested), so
      // walk the subtree and dispose every geometry we created.
      child.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
  }
  paddleGroup = null;
}

// Rebuilds the whole lift + cone floor centred at (cx, cz) with its rim at deskY,
// wiring colliders into `world` and meshes into `sceneGroup`.
export function rebuild(world, sceneGroup, cx, cz, deskY, floorRadius) {
  group = sceneGroup;
  destroy();

  // Cone floor -- collider + visual (reusing the desk's wood material).
  const floor = buildConeFloor(cx, cz, deskY, floorRadius);
  const baseY = floor.baseY;
  addMeshCollider(world, floor.positions, floor.indices);
  group.add(new THREE.Mesh(makeGeo(floor.positions, floor.indices, floor.uvs), DESK_MATERIAL));

  // Central column -- a static capsule collider (rounded ends are harmless) plus a
  // cylinder visual.
  const column = world.createBody({ type: "static", position: { x: cx, y: baseY, z: cz } });
  column.createCapsule({
    center1: { x: 0, y: 0, z: 0 },
    center2: { x: 0, y: SCREW_HEIGHT, z: 0 },
    radius: COLUMN_R, density: 1, friction: 0.35, restitution: 0.02,
  });
  machineBodies.push(column);
  const columnMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(COLUMN_R, COLUMN_R, SCREW_HEIGHT, 20),
    SCREW_STRUCTURE_MATERIAL
  );
  columnMesh.position.set(cx, baseY + SCREW_HEIGHT / 2, cz);
  group.add(columnMesh);

  // Helical ramp + outer wall -- static mesh colliders + visuals.
  const ramp = buildRamp(cx, cz, baseY);
  addMeshCollider(world, ramp.positions, ramp.indices);
  group.add(new THREE.Mesh(makeGeo(ramp.positions, ramp.indices), SCREW_RAMP_MATERIAL));

  const wall = buildWall(cx, cz, baseY);
  addMeshCollider(world, wall.positions, wall.indices);
  group.add(new THREE.Mesh(makeGeo(wall.positions, wall.indices), SCREW_STRUCTURE_MATERIAL));

  // Paddles: ONE kinematic body at the axis mid-height, carrying PADDLE_COUNT
  // vertical capsules spaced evenly around it, spun about +Y. Kinematic bodies
  // move by their own velocity and ignore the marbles they shove, which is exactly
  // what a driven screw does.
  const paddleMidY = baseY + SCREW_HEIGHT / 2;
  const halfLen = SCREW_HEIGHT / 2 - PADDLE_R;
  paddleBody = world.createBody({
    type: "kinematic",
    position: { x: cx, y: paddleMidY, z: cz },
    angularVelocity: { x: 0, y: PADDLE_OMEGA, z: 0 },
  });
  if (typeof paddleBody.setAngularVelocity === "function") {
    paddleBody.setAngularVelocity({ x: 0, y: PADDLE_OMEGA, z: 0 });
  }
  paddleGroup = new THREE.Group();
  paddleGroup.position.set(cx, paddleMidY, cz);
  const paddleGeo = new THREE.CylinderGeometry(PADDLE_R, PADDLE_R, halfLen * 2, 8);
  for (let k = 0; k < PADDLE_COUNT; k++) {
    const a = (k / PADDLE_COUNT) * Math.PI * 2;
    const px = Math.cos(a) * PADDLE_RADIUS, pz = Math.sin(a) * PADDLE_RADIUS;
    paddleBody.createCapsule({
      center1: { x: px, y: -halfLen, z: pz },
      center2: { x: px, y: halfLen, z: pz },
      radius: PADDLE_R, density: 1, friction: 0.5, restitution: 0.0,
    });
    const bar = new THREE.Mesh(paddleGeo, PADDLE_MATERIAL);
    bar.position.set(px, 0, pz);
    paddleGroup.add(bar);
  }
  machineBodies.push(paddleBody);
  group.add(paddleGroup);
}

// Syncs the paddle visuals to the kinematic body box3d has been spinning. Called
// once per physics frame (see physics.js tick). No-op until the first rebuild.
export function tick() {
  if (!paddleBody || !paddleGroup) return;
  const p = paddleBody.getPosition(), r = paddleBody.getRotation();
  paddleGroup.position.set(p.x, p.y, p.z);
  paddleGroup.quaternion.set(r.x, r.y, r.z, r.w);
}

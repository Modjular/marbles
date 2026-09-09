// Turns the 2D spline + elevation model into 3D geometry: the sampled path, the
// per-point orientation frames, the banking, and the twin-rail tube meshes. All
// pure geometry -- it returns positions/indices and THREE geometries but owns no
// scene objects, no physics, and no DOM. This is the module future generated
// shapes (wind chimes, etc.) will grow alongside: each such shape is "model ->
// {render geometry, collider positions/indices}", exactly the shape of the rail
// builder here.

import * as THREE from "three";
import { config, WORLD_UNIT_PX } from "./config.js";
import { nodes, sampleSegmentForTrack, elevationAt, recomputeAllElevAuto } from "./spline.js";

export const WORLD_UP = new THREE.Vector3(0, 1, 0);

// ---- Twin-rail dimensions ----
// Gauge is kept narrower than the marble's diameter (see materials.js MARBLE_R) so
// the marble rests balanced across the tops of both rails, like a ball on train
// tracks, rather than fitting between them.
export const RAIL_RADIUS = 0.045;
export const RAIL_GAUGE = 0.26;
export const RAIL_RADIAL_SEGMENTS = 10;

// Samples the whole spline into world space. Node 0's 2D position is the world
// origin (x=0, z=0); elevation comes from the Slope model. `samplingMode` picks
// how each segment's t-values are chosen, but both the XZ position AND the
// elevation rule always use the resulting raw t, so both modes feed the same
// downstream mesh/collider code.
export function computeTrack3D() {
  // Defensive: guarantee every node's elev/elevTangent reflects the current
  // steepness setting and neighbor chain. Cheap and idempotent for up-to-date nodes.
  recomputeAllElevAuto();

  const pathPoints = [];
  const nodeMarkers = [];
  const bankPerPoint = [];
  const nodePathIndex = new Array(nodes.length).fill(0);
  if (nodes.length === 0) return { pathPoints, nodeMarkers, bankPerPoint, nodePathIndex };
  const origin = nodes[0];
  const toWorld = (p, y) => new THREE.Vector3(
    (p.x - origin.x) / WORLD_UNIT_PX,
    y,
    (p.y - origin.y) / WORLD_UNIT_PX
  );
  for (let i = 0; i < nodes.length - 1; i++) {
    const samples = sampleSegmentForTrack(nodes[i], nodes[i + 1], config.samplingMode, config.samplesPerSegment);
    const startJ = i === 0 ? 0 : 1; // skip duplicate point shared with previous segment's end
    for (let j = startJ; j < samples.length; j++) {
      const t = samples[j].t;
      pathPoints.push(toWorld(samples[j].p, elevationAt(i, i + 1, t)));
      bankPerPoint.push(nodes[i].bank + (nodes[i + 1].bank - nodes[i].bank) * t);
    }
    nodePathIndex[i + 1] = pathPoints.length - 1; // last point pushed is exactly t=1, i.e. node i+1
  }
  if (nodes.length === 1) {
    pathPoints.push(toWorld(nodes[0], nodes[0].elev));
    bankPerPoint.push(nodes[0].bank);
  }
  for (let i = 0; i < nodes.length; i++) {
    nodeMarkers.push(toWorld(nodes[i], nodes[i].elev));
  }
  return { pathPoints, nodeMarkers, bankPerPoint, nodePathIndex };
}

// "Level" frame: unlike a rotation-minimizing frame (which avoids twist but still
// lets the rail pair bank/roll through turns), this keeps the left/right offset
// direction (binormal) always horizontal -- zero Y component -- so the two rails
// stay at equal height and read as flat, parallel lines in a straight-down view,
// the way real train tracks do. Falls back to the previous binormal on the rare
// near-vertical tangent (where up x tangent degenerates) rather than flipping.
export function computeLevelFrames(points) {
  const n = points.length;
  const tangents = new Array(n), normals = new Array(n), binormals = new Array(n);
  for (let i = 0; i < n; i++) {
    if (n === 1) { tangents[i] = new THREE.Vector3(1, 0, 0); continue; }
    if (i === 0) tangents[i] = points[1].clone().sub(points[0]).normalize();
    else if (i === n - 1) tangents[i] = points[n - 1].clone().sub(points[n - 2]).normalize();
    else tangents[i] = points[i + 1].clone().sub(points[i - 1]).normalize();
  }
  let prevBinormal = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < n; i++) {
    let binormal = new THREE.Vector3().crossVectors(WORLD_UP, tangents[i]);
    if (binormal.lengthSq() < 1e-8) {
      binormal = prevBinormal.clone();
    } else {
      binormal.normalize();
    }
    prevBinormal = binormal;
    binormals[i] = binormal;
    normals[i] = new THREE.Vector3().crossVectors(tangents[i], binormal).normalize();
  }
  return { tangents, normals, binormals };
}

// Rotates each point's (normal, binormal) pair around its own tangent by
// `bankPerPoint[k]` radians -- the user-adjustable roll/bank control (see the
// twist-handle interaction in camera3d.js), layered on top of the level frame.
export function applyBankToFrames(frames, bankPerPoint) {
  const { normals, binormals } = frames;
  for (let i = 0; i < normals.length; i++) {
    const a = bankPerPoint[i] || 0;
    if (a === 0) continue;
    const cos = Math.cos(a), sin = Math.sin(a);
    const n = normals[i], b = binormals[i];
    const newN = n.clone().multiplyScalar(cos).addScaledVector(b, sin);
    const newB = b.clone().multiplyScalar(cos).addScaledVector(n, -sin);
    normals[i] = newN;
    binormals[i] = newB;
  }
  return frames;
}

// Explicit ring-extrusion along `points`, using the shared level `frames` for
// every ring so both rails stay level and in lockstep with each other (and with
// the mesh colliders, which are built from these exact same positions/indices --
// collision geometry is the visual tube, not an approximation of it). The winding
// here already produces outward-facing normals, matching what box3d's createMesh
// needs, so the same buffers serve as both render mesh and collider.
export function buildRailTubeGeometry(points, frames, side) {
  const n = points.length;
  const railCenters = new Array(n);
  for (let i = 0; i < n; i++) {
    railCenters[i] = points[i].clone().addScaledVector(frames.binormals[i], side * RAIL_GAUGE / 2);
  }
  const positions = [];
  for (let i = 0; i < n; i++) {
    const normal = frames.normals[i], binormal = frames.binormals[i];
    for (let k = 0; k < RAIL_RADIAL_SEGMENTS; k++) {
      const theta = (k / RAIL_RADIAL_SEGMENTS) * Math.PI * 2;
      const p = railCenters[i].clone()
        .addScaledVector(normal, Math.cos(theta) * RAIL_RADIUS)
        .addScaledVector(binormal, Math.sin(theta) * RAIL_RADIUS);
      positions.push(p.x, p.y, p.z);
    }
  }
  const indices = [];
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < RAIL_RADIAL_SEGMENTS; k++) {
      const k2 = (k + 1) % RAIL_RADIAL_SEGMENTS;
      const a = i * RAIL_RADIAL_SEGMENTS + k, b = i * RAIL_RADIAL_SEGMENTS + k2;
      const c = (i + 1) * RAIL_RADIAL_SEGMENTS + k, d = (i + 1) * RAIL_RADIAL_SEGMENTS + k2;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return { geo, railCenters, positions, indices };
}

export function computeCentroid(points) {
  if (!points.length) return new THREE.Vector3(0, -1, 0);
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  return c.multiplyScalar(1 / points.length);
}

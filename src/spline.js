// The track's data model and all the pure spline math on top of it: no DOM, no
// THREE, no physics. Everything downstream (the 2D editor, the 3D geometry) reads
// from `nodes` and these sampling helpers, which keeps the curve definition in
// exactly one place.
//
// Each node stores an absolute position (x, y) plus a single tangent OFFSET
// vector (hx, hy). handleOut = pos + offset, handleIn = pos - offset -- deriving
// both handles from one shared vector is what gives free C1 (tangent) continuity:
// there is no way to move one handle without the other mirroring, because they
// are never stored as independent points.
//
// node.auto tracks whether the offset is still driven by the automatic tangent
// heuristic (recomputeAllAuto) or was overridden by the user dragging a handle.
//
// Elevation (the Slope view) piggybacks on the same node objects with its own
// independent fields -- elev (world-space Y), elevTangent (a single mirrored
// offset, same trick as hx/hy but 1D since the profile's x-axis is locked to node
// index), and elevAuto. Unlike (hx, hy), whose auto default only depends on other
// nodes, elev's auto default also tracks the steepness slider
// (config.elevationPerNode) -- see recomputeAllElevAuto.
//
// `bank` is a 3D-only property (radians of roll around the rail's own tangent at
// this node -- see the twist-handle interaction in camera3d.js) that also lives on
// the node object so it stays attached to the right node through inserts/deletes.

import { config } from "./config.js";

export const nodes = []; // { x, y, hx, hy, auto, bank, elev, elevTangent, elevAuto }

const HANDLE_LEN_DEFAULT = 55;
const HANDLE_FRACTION = 0.35; // fraction of distance-to-nearest-neighbor used for auto handle length
export const SEGMENT_SAMPLES = 28;
const ELEV_HANDLE_FRACTION = 1 / 3;

export function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
export function normalize(v) {
  const len = Math.hypot(v.x, v.y);
  return len > 1e-6 ? { x: v.x / len, y: v.y / len } : { x: 1, y: 0 };
}

// Catmull-Rom-style tangent estimate: the direction through a node is the
// direction between its neighbors, so the curve flows smoothly through every
// clicked point without the user needing to touch a handle.
function autoDir(node, prev, next) {
  if (prev && next) return normalize({ x: next.x - prev.x, y: next.y - prev.y });
  if (next) return normalize({ x: next.x - node.x, y: next.y - node.y });
  if (prev) return normalize({ x: node.x - prev.x, y: node.y - prev.y });
  return { x: 1, y: 0 };
}
function autoLen(node, prev, next) {
  let d = Infinity;
  if (prev) d = Math.min(d, dist(node, prev));
  if (next) d = Math.min(d, dist(node, next));
  if (!isFinite(d)) d = HANDLE_LEN_DEFAULT / HANDLE_FRACTION;
  return d * HANDLE_FRACTION;
}

// Re-derives the offset for every node still flagged `auto`, using its *current*
// neighbors. Called after any add/move/delete so the automatic tangents stay
// consistent with the rest of the chain.
export function recomputeAllAuto() {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node.auto) continue;
    const prev = nodes[i - 1] || null;
    const next = nodes[i + 1] || null;
    const dir = autoDir(node, prev, next);
    const len = autoLen(node, prev, next);
    node.hx = dir.x * len;
    node.hy = dir.y * len;
  }
}

// Re-derives elev (for nodes still on the steepness-slider default) and
// elevTangent (for nodes still on the auto heuristic) for every node flagged
// `elevAuto`. Two passes: elev must be settled for the whole chain before tangents
// (which read neighboring elev) are computed from it.
//
// ELEV_HANDLE_FRACTION (1/3) is the fraction that exactly reproduces a straight
// line: a cubic Bezier whose two inner control points sit at 1/3 and 2/3 traces
// its segment at constant speed. So while every node's elev is still the default
// straight ramp, the Slope view looks identical to a fixed linear descent and
// only diverges once the user drags something in it.
export function recomputeAllElevAuto() {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.elevAuto) node.elev = -i * config.elevationPerNode;
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node.elevAuto) continue;
    const prevElev = i > 0 ? nodes[i - 1].elev : null;
    const nextElev = i < nodes.length - 1 ? nodes[i + 1].elev : null;
    if (prevElev !== null && nextElev !== null) {
      node.elevTangent = (nextElev - prevElev) / 2 * ELEV_HANDLE_FRACTION;
    } else if (nextElev !== null) {
      node.elevTangent = (nextElev - node.elev) * ELEV_HANDLE_FRACTION;
    } else if (prevElev !== null) {
      node.elevTangent = (node.elev - prevElev) * ELEV_HANDLE_FRACTION;
    } else {
      node.elevTangent = 0;
    }
  }
}

export function addNode(pos) {
  const node = {
    x: pos.x, y: pos.y, hx: HANDLE_LEN_DEFAULT, hy: 0, auto: true, bank: 0,
    elev: 0, elevTangent: 0, elevAuto: true,
  };
  nodes.push(node);
  recomputeAllAuto();
  recomputeAllElevAuto();
}

export function removeNode(node) {
  const idx = nodes.indexOf(node);
  if (idx === -1) return;
  nodes.splice(idx, 1);
  recomputeAllAuto();
  recomputeAllElevAuto();
}

export function clearNodes() {
  nodes.length = 0;
}

// ---- Cubic Bezier evaluation via De Casteljau's algorithm ----
function lerp(p, q, t) { return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }; }
function deCasteljau(p0, p1, p2, p3, t) {
  const a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t);
  const d = lerp(a, b, t), e = lerp(b, c, t);
  return lerp(d, e, t);
}
export function handleOut(n) { return { x: n.x + n.hx, y: n.y + n.hy }; }
export function handleIn(n) { return { x: n.x - n.hx, y: n.y - n.hy }; }

// One segment as a dense polyline, for the 2D debug spline.
export function sampleSegment(n0, n1) {
  const p0 = { x: n0.x, y: n0.y }, p1 = handleOut(n0), p2 = handleIn(n1), p3 = { x: n1.x, y: n1.y };
  const pts = [];
  for (let i = 0; i <= SEGMENT_SAMPLES; i++) {
    pts.push(deCasteljau(p0, p1, p2, p3, i / SEGMENT_SAMPLES));
  }
  return pts;
}

// Arc-length table for one segment: `divisions` fine uniform-t samples with their
// cumulative 2D distance, used to invert "distance along the curve" back to a
// Bezier parameter t (see sampleSegmentForTrack).
function buildArcLengthTable(n0, n1, divisions) {
  const p0 = { x: n0.x, y: n0.y }, p1 = handleOut(n0), p2 = handleIn(n1), p3 = { x: n1.x, y: n1.y };
  let prev = p0;
  let acc = 0;
  const table = [{ t: 0, s: 0 }];
  for (let k = 1; k <= divisions; k++) {
    const t = k / divisions;
    const pt = deCasteljau(p0, p1, p2, p3, t);
    acc += dist(prev, pt);
    table.push({ t, s: acc });
    prev = pt;
  }
  return table;
}
function tAtArcLength(table, targetS) {
  const total = table[table.length - 1].s;
  if (targetS <= 0) return 0;
  if (targetS >= total) return 1;
  for (let i = 1; i < table.length; i++) {
    if (table[i].s >= targetS) {
      const a = table[i - 1], b = table[i];
      const frac = (targetS - a.s) / ((b.s - a.s) || 1);
      return a.t + (b.t - a.t) * frac;
    }
  }
  return 1;
}

// Samples one segment for the *track* (mesh + colliders), returning { p:{x,y}, t }
// pairs -- the elevation rule always uses the raw Bezier parameter t (see
// track.js computeTrack3D), regardless of which sampling mode picked that t, so
// both modes plug into the same downstream code.
export function sampleSegmentForTrack(n0, n1, mode, samples) {
  const p0 = { x: n0.x, y: n0.y }, p1 = handleOut(n0), p2 = handleIn(n1), p3 = { x: n1.x, y: n1.y };
  const out = [];
  if (mode === "arclength") {
    const table = buildArcLengthTable(n0, n1, Math.max(samples * 8, 100));
    const total = table[table.length - 1].s;
    for (let j = 0; j <= samples; j++) {
      const t = tAtArcLength(table, (j / samples) * total);
      out.push({ p: deCasteljau(p0, p1, p2, p3, t), t });
    }
  } else {
    for (let j = 0; j <= samples; j++) {
      const t = j / samples;
      out.push({ p: deCasteljau(p0, p1, p2, p3, t), t });
    }
  }
  return out;
}

// The elevation at Bezier parameter t within segment [i0, i1] -- the same t as the
// XZ curve's own sampling, so a sample's elevation and its XZ position always
// correspond to the same "progress" through the segment even though they're two
// independently-shaped curves. Plain scalar cubic Bezier (Bernstein form) since
// only Y ever matters here.
export function elevationAt(i0, i1, t) {
  const n0 = nodes[i0], n1 = nodes[i1];
  const y0 = n0.elev, y1 = n0.elev + n0.elevTangent;
  const y2 = n1.elev - n1.elevTangent, y3 = n1.elev;
  const mt = 1 - t;
  return mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
}

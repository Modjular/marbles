// The 2D editor view: the top-down node/curve sketcher and the Slope side-profile,
// both drawn to the same 2D canvas. Owns its canvas, its interaction modes, and its
// rendering. It mutates the shared spline model (spline.js) and redraws itself; it
// does not touch the 3D scene -- switching to 3D (ui.js) is what rebuilds that from
// the model.

import {
  nodes, dist, addNode, removeNode, recomputeAllAuto, recomputeAllElevAuto,
  sampleSegment, elevationAt, clearNodes, SEGMENT_SAMPLES,
} from "./spline.js";
import { WORLD_UNIT_PX } from "./config.js";

const wrap = document.getElementById("canvas-wrap");
const canvas = document.getElementById("editor-canvas");
const ctx = canvas.getContext("2d");
let cw = 0, ch = 0; // CSS pixel size

// The 2D dot grid spacing is the world-unit size, so one grid cell reads as one
// world unit once projected into 3D (see track.js).
const GRID_STEP = WORLD_UNIT_PX;

// Sized for a fingertip, not a mouse pointer -- a touch target under ~40 CSS px
// across is unreliable to hit on a phone.
const NODE_HIT_R = 17;
const HANDLE_HIT_R = 15;

let mode = "place"; // "place" | "edit" | "delete" | "slope"
let drag = null;    // { kind, node, which? }

// Palette pulled from CSS custom properties so the canvas tracks the page's
// light/dark scheme (style.css defines them per prefers-color-scheme).
function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

export function resizeCanvas() {
  const rect = wrap.getBoundingClientRect();
  cw = rect.width;
  ch = rect.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}
new ResizeObserver(resizeCanvas).observe(wrap);
// Redraw when the OS light/dark scheme flips so the canvas palette keeps up.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);

export function updateStats() {
  document.getElementById("stat-nodes").textContent = String(nodes.length);
  document.getElementById("stat-segments").textContent = String(Math.max(0, nodes.length - 1));
}

export function setMode(m) {
  mode = m;
  for (const btn of document.getElementById("bottom-bar-2d").children) {
    btn.classList.toggle("active", btn.dataset.mode === m);
  }
  wrap.className = "mode-" + m;
  draw();
}
document.getElementById("bottom-bar-2d").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (btn) setMode(btn.dataset.mode);
});

export function clearTrack() {
  clearNodes();
  draw();
  updateStats();
}

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function hitTestHandle(pos) {
  for (const node of nodes) {
    const outPos = { x: node.x + node.hx, y: node.y + node.hy };
    const inPos = { x: node.x - node.hx, y: node.y - node.hy };
    if (dist(pos, outPos) <= HANDLE_HIT_R) return { node, which: "out" };
    if (dist(pos, inPos) <= HANDLE_HIT_R) return { node, which: "in" };
  }
  return null;
}
function hitTestNode(pos) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (dist(pos, nodes[i]) <= NODE_HIT_R) return nodes[i];
  }
  return null;
}

// ---- Slope side-profile ----
// A side view of the track's elevation, edited as its own chain of node+tangent
// Bezier segments over the same canvas. Node x-position is locked to node index
// (evenly spread across the width) -- only elevation and its tangent drag -- so
// there's exactly one profile point per node, no separate topology to keep in sync.
const SLOPE_MARGIN_X = 32, SLOPE_MARGIN_Y = 40;
const SLOPE_HANDLE_REACH_PX = 42; // cosmetic only -- elevationAt never reads screen position
let slopeScale = null; // rebuilt every drawSlopeProfile(); pointer handlers read the last one

function slopeNodeX(i) {
  if (nodes.length <= 1) return SLOPE_MARGIN_X;
  return SLOPE_MARGIN_X + (i / (nodes.length - 1)) * (cw - SLOPE_MARGIN_X * 2);
}
function elevToScreenY(elev) {
  if (!slopeScale) return SLOPE_MARGIN_Y;
  const frac = (elev - slopeScale.min) / slopeScale.range;
  return SLOPE_MARGIN_Y + (1 - frac) * slopeScale.plotHeight;
}
function screenYToElev(y) {
  if (!slopeScale) return 0;
  const frac = 1 - (y - SLOPE_MARGIN_Y) / slopeScale.plotHeight;
  return slopeScale.min + frac * slopeScale.range;
}
function hitTestSlopeNode(pos) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const p = { x: slopeNodeX(i), y: elevToScreenY(nodes[i].elev) };
    if (dist(pos, p) <= NODE_HIT_R) return nodes[i];
  }
  return null;
}
function hitTestSlopeHandle(pos) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const x = slopeNodeX(i);
    const outPos = { x: x + SLOPE_HANDLE_REACH_PX, y: elevToScreenY(node.elev + node.elevTangent) };
    const inPos = { x: x - SLOPE_HANDLE_REACH_PX, y: elevToScreenY(node.elev - node.elevTangent) };
    if (dist(pos, outPos) <= HANDLE_HIT_R) return { node, which: "out" };
    if (dist(pos, inPos) <= HANDLE_HIT_R) return { node, which: "in" };
  }
  return null;
}

canvas.addEventListener("pointerdown", (e) => {
  const pos = pointerPos(e);
  if (mode === "place") {
    if (!hitTestNode(pos)) {
      addNode(pos);
      updateStats();
      draw();
    }
  } else if (mode === "edit") {
    const h = hitTestHandle(pos);
    if (h) {
      drag = { kind: "handle", node: h.node, which: h.which };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const n = hitTestNode(pos);
    if (n) {
      drag = { kind: "node", node: n };
      canvas.setPointerCapture(e.pointerId);
    }
  } else if (mode === "delete") {
    const n = hitTestNode(pos);
    if (n) {
      removeNode(n);
      updateStats();
      draw();
    }
  } else if (mode === "slope") {
    const h = hitTestSlopeHandle(pos);
    if (h) {
      drag = { kind: "slope-handle", node: h.node, which: h.which };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const n = hitTestSlopeNode(pos);
    if (n) {
      drag = { kind: "slope-node", node: n };
      canvas.setPointerCapture(e.pointerId);
    }
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const pos = pointerPos(e);
  if (drag.kind === "node") {
    drag.node.x = pos.x;
    drag.node.y = pos.y;
    recomputeAllAuto();
  } else if (drag.kind === "handle") {
    const node = drag.node;
    // Both handle tips derive from the same shared offset vector, so dragging
    // either one just re-solves that vector -- the opposite handle mirrors for
    // free, with no separate case needed.
    const offset = drag.which === "out"
      ? { x: pos.x - node.x, y: pos.y - node.y }
      : { x: node.x - pos.x, y: node.y - pos.y };
    node.hx = offset.x;
    node.hy = offset.y;
    node.auto = false; // manual edit overrides the automatic tangent heuristic
  } else if (drag.kind === "slope-node") {
    drag.node.elev = screenYToElev(pos.y);
    drag.node.elevAuto = false;
    recomputeAllElevAuto(); // refresh still-auto neighbors against the new elev
  } else if (drag.kind === "slope-handle") {
    const node = drag.node;
    const worldElev = screenYToElev(pos.y);
    node.elevTangent = drag.which === "out" ? (worldElev - node.elev) : (node.elev - worldElev);
    node.elevAuto = false;
  }
  draw();
});

function endDrag(e) {
  if (drag) {
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    drag = null;
  }
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// ---- Rendering ----
export function draw() {
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = cssVar("--bg-base");
  ctx.fillRect(0, 0, cw, ch);

  if (mode === "slope") {
    drawSlopeProfile();
    return;
  }

  // Dot grid -- one path for every dot, filled once, instead of a
  // beginPath/arc/fill triplet per dot.
  ctx.fillStyle = cssVar("--border-subtle");
  ctx.beginPath();
  for (let x = GRID_STEP; x < cw; x += GRID_STEP) {
    for (let y = GRID_STEP; y < ch; y += GRID_STEP) {
      ctx.moveTo(x + 1.1, y); // start each dot as its own subpath
      ctx.arc(x, y, 1.1, 0, Math.PI * 2);
    }
  }
  ctx.fill();

  // Debug spline: one continuous polyline across every segment, so any kink at a
  // node boundary is immediately visible.
  if (nodes.length >= 2) {
    ctx.strokeStyle = cssVar("--accent-primary");
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < nodes.length - 1; i++) {
      const pts = sampleSegment(nodes[i], nodes[i + 1]);
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
    }
    ctx.stroke();
  }

  // Handles (edit mode only)
  if (mode === "edit") {
    ctx.strokeStyle = cssVar("--text-dim");
    ctx.lineWidth = 1;
    ctx.fillStyle = cssVar("--accent-success");
    for (const node of nodes) {
      const outPos = { x: node.x + node.hx, y: node.y + node.hy };
      const inPos = { x: node.x - node.hx, y: node.y - node.hy };
      ctx.beginPath();
      ctx.moveTo(inPos.x, inPos.y);
      ctx.lineTo(outPos.x, outPos.y);
      ctx.stroke();
      for (const hp of [inPos, outPos]) {
        ctx.beginPath();
        ctx.arc(hp.x, hp.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Nodes
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    ctx.beginPath();
    ctx.arc(node.x, node.y, NODE_HIT_R - 2, 0, Math.PI * 2);
    ctx.fillStyle = cssVar("--bg-surface-elevated");
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = mode === "delete" ? cssVar("--accent-danger") : cssVar("--accent-primary");
    ctx.stroke();
    ctx.fillStyle = cssVar("--text-main");
    ctx.font = "10px -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i), node.x, node.y - NODE_HIT_R - 8);
  }
}

function drawSlopeProfile() {
  // Autoscale the vertical axis to fit every node elev *and* its handle offsets,
  // always including 0 so a flat track still shows a meaningful baseline.
  const ys = [0];
  for (const node of nodes) {
    ys.push(node.elev, node.elev + node.elevTangent, node.elev - node.elevTangent);
  }
  const min = Math.min(...ys), max = Math.max(...ys);
  slopeScale = { min, range: Math.max(max - min, 0.5), plotHeight: ch - SLOPE_MARGIN_Y * 2 };

  // Baseline (elev = 0)
  ctx.strokeStyle = cssVar("--border-subtle");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, elevToScreenY(0));
  ctx.lineTo(cw, elevToScreenY(0));
  ctx.stroke();

  if (nodes.length >= 2) {
    ctx.strokeStyle = cssVar("--accent-primary");
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < nodes.length - 1; i++) {
      for (let j = 0; j <= SEGMENT_SAMPLES; j++) {
        const t = j / SEGMENT_SAMPLES;
        const x = slopeNodeX(i) + (slopeNodeX(i + 1) - slopeNodeX(i)) * t;
        const y = elevToScreenY(elevationAt(i, i + 1, t));
        if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // Tangent handles (always visible here -- Slope has no place/edit/delete split).
  ctx.strokeStyle = cssVar("--text-dim");
  ctx.lineWidth = 1;
  ctx.fillStyle = cssVar("--accent-success");
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const x = slopeNodeX(i);
    const outPos = { x: x + SLOPE_HANDLE_REACH_PX, y: elevToScreenY(node.elev + node.elevTangent) };
    const inPos = { x: x - SLOPE_HANDLE_REACH_PX, y: elevToScreenY(node.elev - node.elevTangent) };
    ctx.beginPath();
    ctx.moveTo(inPos.x, inPos.y);
    ctx.lineTo(outPos.x, outPos.y);
    ctx.stroke();
    for (const hp of [inPos, outPos]) {
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Nodes
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const x = slopeNodeX(i), y = elevToScreenY(node.elev);
    ctx.beginPath();
    ctx.arc(x, y, NODE_HIT_R - 2, 0, Math.PI * 2);
    ctx.fillStyle = cssVar("--bg-surface-elevated");
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = cssVar("--accent-primary");
    ctx.stroke();
    ctx.fillStyle = cssVar("--text-main");
    ctx.font = "10px -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i), x, y - NODE_HIT_R - 8);
  }
}

export function initEditor2D() {
  setMode("place");
  resizeCanvas();
  updateStats();
}

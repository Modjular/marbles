// All the DOM control wiring: the mode/action bars, the Settings sheet, every
// slider and toggle, and the 2D<->3D view switch. This module reads and writes the
// shared config and calls into the feature modules; it holds no simulation or
// geometry logic of its own. The current view lives here (main.js's render loop
// reads it through getView).

import { config, BOX3D_DEFAULTS } from "./config.js";
import { clearTrack } from "./editor2d.js";
import * as physics from "./physics.js";
import {
  setProjectionMode, resize3D, updateCamera3D, setEditBankings,
  trackMeshGroup, debugPointsGroup, colliderDebugGroup,
} from "./scene3d.js";
import { hooks } from "./bus.js";

const $ = (id) => document.getElementById(id);

// ---- View switching ----
let currentView = "edit2d";
export function getView() { return currentView; }

const wrap2d = $("canvas-wrap");
const wrap3d = $("canvas3d-wrap");
const viewToggleFab = $("view-toggle-fab");
const bottomBar2d = $("bottom-bar-2d");
const bottomBar3d = $("bottom-bar-3d");
const clearBtnEl = $("clear-btn");

export function setView(view) {
  currentView = view;
  wrap2d.style.display = view === "edit2d" ? "" : "none";
  wrap3d.style.display = view === "play" ? "" : "none";
  $("settings-2d").style.display = view === "edit2d" ? "" : "none";
  $("settings-3d").style.display = view === "play" ? "" : "none";
  bottomBar2d.style.display = view === "edit2d" ? "" : "none";
  bottomBar3d.style.display = view === "play" ? "" : "none";
  clearBtnEl.disabled = view !== "edit2d";
  viewToggleFab.textContent = view === "edit2d" ? "3D" : "2D";
  if (view === "play") {
    // Entering 3D rebuilds the (possibly-edited) track and waits for an explicit
    // Play press rather than auto-dropping a marble.
    hooks.rebuildTrack3D();
    resize3D();
    updateCamera3D();
    physics.stopSim();
    setEditBankings(false);
  } else {
    physics.pauseSim();
  }
}
viewToggleFab.addEventListener("click", () => {
  setView(currentView === "edit2d" ? "play" : "edit2d");
});

// ---- Camera projection toggle ----
const projectionGroupEl = $("projection-group");
for (const b of projectionGroupEl.children) b.classList.toggle("active", b.dataset.projection === "perspective");
projectionGroupEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-projection]");
  if (!btn) return;
  for (const b of projectionGroupEl.children) b.classList.toggle("active", b === btn);
  setProjectionMode(btn.dataset.projection);
});

// ---- Sampling mode toggle ----
const samplingGroupEl = $("sampling-group");
for (const b of samplingGroupEl.children) b.classList.toggle("active", b.dataset.sampling === config.samplingMode);
samplingGroupEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-sampling]");
  if (!btn) return;
  config.samplingMode = btn.dataset.sampling;
  for (const b of samplingGroupEl.children) b.classList.toggle("active", b === btn);
  hooks.rebuildTrack3D();
});

// ---- Steepness slider ----
const steepnessSlider = $("steepness-slider");
const steepnessValueEl = $("steepness-value");
steepnessSlider.value = String(config.elevationPerNode);
steepnessValueEl.textContent = `${config.elevationPerNode.toFixed(2)} units`;
steepnessSlider.addEventListener("input", () => {
  config.elevationPerNode = Number(steepnessSlider.value);
  steepnessValueEl.textContent = `${config.elevationPerNode.toFixed(2)} units`;
  hooks.scheduleTrackRebuild();
});

// ---- Resolution slider ----
const resolutionSlider = $("resolution-slider");
const resolutionValueEl = $("resolution-value");
resolutionSlider.value = String(config.samplesPerSegment);
resolutionValueEl.textContent = `${config.samplesPerSegment} / segment`;
resolutionSlider.addEventListener("input", () => {
  config.samplesPerSegment = Number(resolutionSlider.value);
  resolutionValueEl.textContent = `${config.samplesPerSegment} / segment`;
  hooks.scheduleTrackRebuild();
});

// ---- Contact tuning sliders ----
// Hertz/damping have no live setter, so they go through a full world rebuild;
// friction/restitution live per-collider, so they just need the colliders rebuilt.
const contactHertzSlider = $("contact-hertz-slider");
const contactHertzValueEl = $("contact-hertz-value");
contactHertzSlider.value = String(config.contactHertz);
contactHertzValueEl.textContent = String(config.contactHertz);
contactHertzSlider.addEventListener("input", () => {
  config.contactHertz = Number(contactHertzSlider.value);
  contactHertzValueEl.textContent = String(config.contactHertz);
  physics.scheduleWorldRebuild();
});

const contactDampingSlider = $("contact-damping-slider");
const contactDampingValueEl = $("contact-damping-value");
contactDampingSlider.value = String(config.contactDampingRatio);
contactDampingValueEl.textContent = String(config.contactDampingRatio);
contactDampingSlider.addEventListener("input", () => {
  config.contactDampingRatio = Number(contactDampingSlider.value);
  contactDampingValueEl.textContent = String(config.contactDampingRatio);
  physics.scheduleWorldRebuild();
});

const railFrictionSlider = $("rail-friction-slider");
const railFrictionValueEl = $("rail-friction-value");
railFrictionSlider.value = String(config.railFriction);
railFrictionValueEl.textContent = config.railFriction.toFixed(2);
railFrictionSlider.addEventListener("input", () => {
  config.railFriction = Number(railFrictionSlider.value);
  railFrictionValueEl.textContent = config.railFriction.toFixed(2);
  hooks.scheduleTrackRebuild({ recenterCamera: false });
});

const railRestitutionSlider = $("rail-restitution-slider");
const railRestitutionValueEl = $("rail-restitution-value");
railRestitutionSlider.value = String(config.railRestitution);
railRestitutionValueEl.textContent = config.railRestitution.toFixed(2);
railRestitutionSlider.addEventListener("input", () => {
  config.railRestitution = Number(railRestitutionSlider.value);
  railRestitutionValueEl.textContent = config.railRestitution.toFixed(2);
  hooks.scheduleTrackRebuild({ recenterCamera: false });
});

$("reset-contact-tuning-btn").addEventListener("click", () => {
  config.contactHertz = BOX3D_DEFAULTS.contactHertz;
  config.contactDampingRatio = BOX3D_DEFAULTS.contactDampingRatio;
  config.railFriction = BOX3D_DEFAULTS.railFriction;
  config.railRestitution = BOX3D_DEFAULTS.railRestitution;

  contactHertzSlider.value = String(config.contactHertz);
  contactHertzValueEl.textContent = String(config.contactHertz);
  contactDampingSlider.value = String(config.contactDampingRatio);
  contactDampingValueEl.textContent = String(config.contactDampingRatio);
  railFrictionSlider.value = String(config.railFriction);
  railFrictionValueEl.textContent = config.railFriction.toFixed(2);
  railRestitutionSlider.value = String(config.railRestitution);
  railRestitutionValueEl.textContent = config.railRestitution.toFixed(2);

  // One world rebuild covers all four: it ends in rebuildTrack3D, which rebuilds
  // the colliders too, so the friction/restitution reset takes effect in the same
  // pass.
  physics.scheduleWorldRebuild();
});

// ---- Layer visibility toggles ----
const showMeshCheck = $("show-mesh-check");
const showDebugCheck = $("show-debug-check");
const showCollidersCheck = $("show-colliders-check");
function updateLayerVisibility() {
  trackMeshGroup.visible = showMeshCheck.checked;
  debugPointsGroup.visible = showDebugCheck.checked;
  colliderDebugGroup.visible = showCollidersCheck.checked;
}
for (const el of [showMeshCheck, showDebugCheck, showCollidersCheck]) {
  el.addEventListener("change", updateLayerVisibility);
}
updateLayerVisibility();

// ---- Simulation buttons ----
$("sim-playpause-btn").addEventListener("click", physics.togglePlayPause);
$("sim-reset-btn").addEventListener("click", physics.stopSim);

// ---- Clear track ----
$("clear-btn").addEventListener("click", clearTrack);

// ---- Settings sheet ----
const settingsPanel = $("settings-panel");
const settingsBackdrop = $("settings-backdrop");
function openSettings() {
  settingsPanel.classList.add("open");
  settingsBackdrop.classList.add("open");
}
function closeSettings() {
  settingsPanel.classList.remove("open");
  settingsBackdrop.classList.remove("open");
}
$("settings-fab").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", closeSettings);
settingsBackdrop.addEventListener("click", closeSettings);

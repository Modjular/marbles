// Runtime-adjustable settings, in one place so any module can read the current
// value and the UI sliders have a single source of truth to write to. Everything
// here is deliberately mutable state (the sliders change it live); constants that
// never change at runtime live next to the code that owns them (rail dimensions
// in track.js, marble/spawn tuning in physics.js, hit radii in editor2d.js).

// One 2D editor pixel-grid cell == one physics world unit. The 2D dot grid and
// the 3D world scale are intentionally the same number so "one grid cell" in the
// sketch really is "one unit" once projected into 3D (see track.js toWorld and
// editor2d.js GRID_STEP).
export const WORLD_UNIT_PX = 40;

// Live, user-tunable settings. Mutated in place by the Settings sliders (ui.js);
// read by track.js (sampling/steepness) and physics.js (contact + rail tuning).
export const config = {
  samplesPerSegment: 32,   // resolution slider: samples per spline segment
  samplingMode: "uniform", // "uniform" | "arclength"
  elevationPerNode: 0.35,  // steepness slider: world units dropped per node index

  // Contact-solver "softness". box3d has no live setter for these, so changing
  // them tears down and rebuilds the whole physics world (see physics.js).
  contactHertz: 7,         // lower = softer
  contactDampingRatio: 6,  // higher = more damped / less bouncy

  // Per-collider-shape material; changing these only needs the colliders
  // rebuilt, not the whole world.
  railFriction: 0.2,
  railRestitution: 0,
};

// box3d's own engine defaults (b3DefaultWorldDef / b3DefaultShapeDef) -- what
// you get by omitting these options entirely, NOT this app's hand-tuned starting
// values above. Wired to the "Reset to box3d defaults" button.
export const BOX3D_DEFAULTS = {
  contactHertz: 30,
  contactDampingRatio: 10,
  railFriction: 0.6,
  railRestitution: 0,
};

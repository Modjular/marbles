// A handful of cross-cutting callbacks, wired up once in main.js, so lower-level
// modules can trigger an orchestrated rebuild (or cancel a recording) without
// importing the orchestrator and creating an import cycle. main.js assigns the
// real implementations during bootstrap; until then they are harmless no-ops.
//
// Keeping these in one tiny module (rather than passing callbacks through every
// constructor) is what lets scene3d.js ask for a track rebuild when a bank handle
// is dragged, and physics.js cancel a recording when it tears the world down,
// while the dependency graph stays acyclic.
export const hooks = {
  rebuildTrack3D: () => {},       // full resample + rebuild every 3D layer
  scheduleTrackRebuild: () => {}, // rAF-coalesced rebuildTrack3D (for drags/sliders)
  cancelRecording: () => {},      // discard an in-flight capture (world torn down under it)
};

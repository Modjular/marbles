// Seam for the planned physically-calculated audio (marble<->marble,
// marble<->chime, marble<->wood). The wiring is here so the future work is "fill in
// the synth", not "find where the collision data is": physics.js already surfaces
// box3d's per-step contact events, and this module is the one place that turns them
// into sound.
//
// It is intentionally inert today. `enable()` registers a contact listener with the
// physics step; until it's called, physics.js never even asks box3d for the events,
// so there is zero runtime cost. When the audio work begins, the plan is roughly:
//
//   1. Give each body a material tag (metal marble, wood desk, future chimes) via
//      userData when it's created in physics.js.
//   2. In onContactEvents below, read box3d's begin-touch events -- each carries the
//      two shapes plus the contact point and normal impulse (impact strength).
//   3. Map (materialA, materialB) -> a sample or a synthesized strike, with gain
//      and pitch driven by the impulse, and play it through the Web Audio graph
//      built in init().
//
// See physics.js `onContacts` / `getContactEvents` for the data this receives.

import { onContacts } from "./physics.js";

let audioCtx = null;

// Lazily create the Web Audio context (must be created/resumed from a user gesture
// in most browsers -- call this from the first Play/Record tap when audio ships).
export function init() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx) audioCtx = new Ctx();
  return audioCtx;
}

// box3d contact events for one step: { beginTouch: [...], endTouch: [...] } (shape
// depends on the box3d-wasm binding). Turn begin-touch impulses into strikes here.
function onContactEvents(_events) {
  // TODO(audio): synthesize marble/chime/wood strikes from begin-touch impulses.
}

// Start listening. Call once the audio feature is ready to make sound.
export function enable() {
  init();
  onContacts(onContactEvents);
}

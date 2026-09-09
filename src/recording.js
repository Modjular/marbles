// The "Record 15s" capture. Uses box3d's own native world-state recording (an
// op-log of world mutations, not per-frame positions -- see wasm/BUILD.txt),
// captures a fixed 15s window, then hands the raw bytes to the browser as a
// download. Auto-starts the sim if idle, since an empty world has nothing to
// record.
//
// The capture is bound to a specific physics world, so it MUST be abandoned if
// that world is torn down under it (a contact-tuning slider or Reset rebuilds the
// world). physics.js calls our cancelRecording through the bus for exactly that,
// which we register below.

import { b3, getWorld, isStarted, startSim } from "./physics.js";
import { hooks } from "./bus.js";

const RECORDING_SECONDS = 15;
const recordBtn = document.getElementById("record-btn");
let activeRecording = null;
let recordCountdown = 0;
let recordIntervalId = null;

function resetRecordButton() {
  recordBtn.disabled = false;
  recordBtn.textContent = "Record 15s";
}

// Abort an in-flight recording WITHOUT touching the world or downloading anything.
// We deliberately do NOT call stopRecording() here: the world may already be
// mid-teardown, and destroying the Recording frees its buffer regardless.
export function cancelRecording() {
  if (!activeRecording) return;
  clearInterval(recordIntervalId);
  recordIntervalId = null;
  activeRecording.destroy();
  activeRecording.delete();
  activeRecording = null;
  resetRecordButton();
}
// Let physics.js abandon the capture when it rebuilds/tears down the world.
hooks.cancelRecording = cancelRecording;

function finishRecording() {
  if (!activeRecording) return; // already cancelled by a world rebuild/reset
  clearInterval(recordIntervalId);
  recordIntervalId = null;
  getWorld().stopRecording();

  const view = activeRecording.getData(); // zero-copy view -- copy out now
  const bytes = new Uint8Array(view);
  activeRecording.destroy();
  activeRecording.delete();
  activeRecording = null;

  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `marble-track-${Date.now()}.b3rec`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  resetRecordButton();
}

recordBtn.addEventListener("click", () => {
  if (activeRecording) return;
  if (!isStarted()) startSim();

  // 0 = box3d's default initial capacity (65536 bytes) -- the buffer auto-doubles
  // as the capture grows (see b3CreateRecording / the b3RecBuffer grow path in
  // box3d's recording.c), so this is not a fixed 0-byte buffer. box3d's own
  // recording tests all construct with 0 the same way.
  activeRecording = new b3.Recording(0);
  getWorld().startRecording(activeRecording);
  recordCountdown = RECORDING_SECONDS;
  recordBtn.disabled = true;
  recordBtn.textContent = `Recording… ${recordCountdown}s`;
  recordIntervalId = setInterval(() => {
    recordCountdown -= 1;
    if (recordCountdown <= 0) {
      finishRecording();
    } else {
      recordBtn.textContent = `Recording… ${recordCountdown}s`;
    }
  }, 1000);
});

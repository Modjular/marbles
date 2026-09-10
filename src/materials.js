// Every surface material the scene renders with, in one module. This is the seam
// for the planned PBR-texture work: give any of these a `.map` / `.normalMap` /
// `.roughnessMap` / `.metalnessMap` (loaded via scene.js's texture loader) and the
// look upgrades without touching the geometry or physics code that references
// them. The debug line/point materials for the sampled path stay here too so the
// whole palette lives together.

import * as THREE from "three";

// Rails render metallic and double-sided (so any winding mistake in the tube
// geometry still can't show as a visual gap -- see track.js buildRailTubeGeometry).
export const RAIL_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xb9bec7, metalness: 1.0, roughness: 0.14, side: THREE.DoubleSide });

// The desk placeholder the track ends above. Starts as a flat wood color; scene.js
// swaps in a wood texture asynchronously if it loads.
export const DESK_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xb08968, roughness: 0.85, metalness: 0.0 });

// Marble: radius is shared with physics.js (it is both the visual size and the
// collision radius, so they must agree). Bigger than half the rail gauge (see
// track.js RAIL_GAUGE) so the marble rests balanced across both rails instead of
// slipping between them.
export const MARBLE_R = 0.18;
export const MARBLE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xd7dade, metalness: 1.0, roughness: 0.2 });
export const MARBLE_GEOMETRY = new THREE.SphereGeometry(MARBLE_R, 24, 16);

// ---- Archimedes-screw lift ----
// The static structure the marbles are carried up by: the central column and the
// outer containing wall read as one brushed-metal machine; the helical ramp the
// marbles actually ride is given a warmer color so it stands out inside the tube.
// The rotating paddles (the only moving parts -- see corkscrew.js) are the accent
// red, matching the node markers, so it's obvious which pieces spin.
export const SCREW_STRUCTURE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.75, roughness: 0.35, side: THREE.DoubleSide });
export const SCREW_RAMP_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xc26b3f, metalness: 0.2, roughness: 0.6, side: THREE.DoubleSide });
export const PADDLE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xef4a5f, metalness: 0.4, roughness: 0.4 });

// Debug overlays for the sampled path (toggled in Settings -> Display).
export const PATH_LINE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x287b60 });
export const SAMPLE_POINT_MATERIAL = new THREE.PointsMaterial({ color: 0x2a2d3a, size: 4, sizeAttenuation: false });
export const NODE_POINT_MATERIAL = new THREE.PointsMaterial({ color: 0xef4a5f, size: 9, sizeAttenuation: false });
export const COLLIDER_DEBUG_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x287b60, wireframe: true });

// Auto-detecting entry point for box3d-wasm (vendored build -- see BUILD.txt
// in this directory for provenance). Wasm SIMD is baseline everywhere this
// site targets, so unlike upstream's stock entry.mjs this doesn't fall back
// to a "compat" no-SIMD flavour -- we don't vendor that flavour at all, so
// importing it here would just 404. Picks between:
//   deluxe   SIMD + threads (needs SharedArrayBuffer)
//   standard SIMD, single threaded
// Import a specific flavour directly with box3d-wasm/standard or
// box3d-wasm/deluxe (see the importmap in the page that loads this).

export default async (options) => {
  // Threads need SharedArrayBuffer. Browsers only expose it on cross-origin
  // isolated pages (COOP/COEP response headers) -- which a static GitHub
  // Pages site cannot send -- so on GitHub Pages this always resolves to the
  // standard flavour. Node.js and isolated workers always have it.
  const canThread =
    typeof SharedArrayBuffer !== 'undefined' &&
    (typeof globalThis.crossOriginIsolated === 'undefined' || globalThis.crossOriginIsolated);

  const flavour = canThread ? await import('./box3d.deluxe.mjs') : await import('./box3d.mjs');

  return await flavour.default(options);
};

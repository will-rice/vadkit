// Import every exports-map subpath with no DOM present. Any top-level use
// of a browser global (window, AudioContext, navigator) throws here, which
// is what a server-side-rendering framework would hit at module load.
const subpaths = ["vadkit", "vadkit/fireredvad", "vadkit/fsmn", "vadkit/silero", "vadkit/webrtc"];
for (const subpath of subpaths) {
  const mod = await import(subpath);
  if (Object.keys(mod).length === 0) throw new Error(`${subpath} exported nothing`);
}
console.log(`ok: ${subpaths.length} subpaths import under node ${process.version}`);

const path = require("node:path");

// One entry per build, chosen by ENTRY, so each output directory holds
// exactly one consumer's bundle and the assertions stay unambiguous.
const entry = process.env.ENTRY;
if (!entry) throw new Error("ENTRY=webrtc-only|silero is required");

module.exports = {
  mode: "production",
  target: "web",
  entry: `./src/${entry}.js`,
  output: { path: path.join(__dirname, "out", entry), clean: true },
};

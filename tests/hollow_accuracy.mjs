// How far is the hollow's inside from exact? Box: the exact inside is the box shrunk by the wall.
import { run } from '../src/tools/hollower/compute.js';
import { repair } from '../src/core/meshcheck.js';
import { box } from './shapes.mjs';

for (const voxel of [1, 0.5, 0.25]) {
  const wall = 2;
  const { tris } = repair(box(0, 0, 0, 40, 30, 20));
  const out = (await run(tris, { wall, voxel, open: false }, { selection: [], progress() {} })).tris;
  const lo = [wall, wall, wall], hi = [40 - wall, 30 - wall, 20 - wall];
  let worst = 0, sum = 0, n = 0;
  for (let i = 0; i < out.length; i += 3) {
    const p = [out[i], out[i + 1], out[i + 2]];
    if (p[0] <= 1e-6 || p[1] <= 1e-6 || p[2] <= 1e-6 || p[0] >= 40 - 1e-6 || p[1] >= 30 - 1e-6 || p[2] >= 20 - 1e-6) continue; // outer
    // signed distance to the inner box surface
    const d = [0, 1, 2].map(a => Math.max(lo[a] - p[a], p[a] - hi[a]));
    const outside = d.map(v => Math.max(v, 0));
    const sd = Math.max(...d) > 0 ? Math.hypot(...outside) : Math.max(...d);
    worst = Math.max(worst, Math.abs(sd)); sum += Math.abs(sd); n++;
  }
  console.log(`voxel ${voxel}: worst ${worst.toFixed(3)} mm, mean ${(sum / n).toFixed(4)} mm over ${n} inside vertices`);
}

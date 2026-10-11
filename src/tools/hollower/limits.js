// Settings checks shared by the panel and the compute.

export function problem(p) {
  if (!(p.wall > 0)) return 'The wall must be above zero.';
  if (p.wall < 2 * p.voxel) return `The wall must be at least twice the resolution (${(2 * p.voxel).toFixed(2)} mm). Use a finer resolution or a thicker wall.`;
  return null;
}

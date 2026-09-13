/**
 * The projection behind the three-axis scatter plot, and the geometry that makes it readable.
 *
 * ⛔ **Pure, and in `lib/`, because the plot's only real content is arithmetic.** A rotating
 * projection drawn straight into JSX cannot be checked at all: every claim about it — that the origin
 * stays put, that a stem stands under its own point, that the floor is the plane the two flat axes
 * span — is a statement about numbers, and those are pinned in `plot3d.test.ts` without a DOM.
 *
 * ⭐ **A point in an isometric scatter has no visible position** (reported 2026-09-13: *it is
 * challenging to see where the pareto planes exist*). Two marks a centimetre apart on screen can be
 * anywhere along each other's line of sight, so an unanchored icon is a claim about three
 * measurements that the reader cannot actually read off the drawing. `stemFor` gives every mark a
 * vertical bar down to the floor plane and `floorGrid` gives that plane a ruled surface, which
 * together turn "somewhere in this box" into "over *there*, this high".
 */

/** Yaw about the vertical, pitch towards the viewer — both in radians, both from the drag handler. */
export interface PlotView {
  yaw: number
  pitch: number
}

/** A projected point: where to draw it, and how far back it is for depth ordering. */
export interface PlotPoint {
  x: number
  y: number
  /** Larger is nearer the viewer. Used only to order the draw, never to scale anything. */
  depth: number
}

/**
 * The viewBox this plot is drawn in, and where the unit cube sits inside it.
 *
 * ⚠️ Constants rather than props: the SVG declares `viewBox="0 0 500 280"` and these place the origin
 * and scale the cube within it. They live beside the projection so the two cannot drift apart.
 */
export const PLOT_VIEWBOX = { width: 500, height: 280 } as const
const ORIGIN_X = 210
const ORIGIN_Y = 178
const SPAN_X = 132
const SPAN_Y = 112

/**
 * One unit-cube coordinate onto the drawing.
 *
 * ⛔ The axis roles are fixed and load-bearing: `x` and `y` span the **floor**, `z` is the one that
 * lifts a point off it. Everything below — the stems, the grid, the base marks — depends on that, so
 * a caller that swaps them does not get a rotated plot, it gets a wrong one.
 */
export function project3d(view: PlotView, x: number, y: number, z: number): PlotPoint {
  const cy = Math.cos(view.yaw)
  const sy = Math.sin(view.yaw)
  const cp = Math.cos(view.pitch)
  const sp = Math.sin(view.pitch)
  const rx = x * cy - y * sy
  const rz = x * sy + y * cy
  const ry = z * cp - rz * sp
  return { x: ORIGIN_X + rx * SPAN_X, y: ORIGIN_Y - ry * SPAN_Y, depth: z * sp + rz * cp }
}

/**
 * Where a mark's bar starts and ends: the floor directly under it, and the mark itself.
 *
 * ⚠️ A point already on the floor gets a stem of zero length rather than a special case — `foot` and
 * `top` are the same place, the line draws as nothing, and the base mark is still there to say the
 * point is anchored at zero rather than that its stem was forgotten.
 */
export function stemFor(
  view: PlotView,
  x: number,
  y: number,
  z: number
): { foot: PlotPoint; top: PlotPoint } {
  return { foot: project3d(view, x, y, 0), top: project3d(view, x, y, z) }
}

/** One ruled line on the floor plane, in drawing coordinates. */
export interface PlotSegment {
  from: PlotPoint
  to: PlotPoint
}

/**
 * The floor plane, ruled into `steps` divisions each way.
 *
 * ⛔ **The plane the two flat axes span, not a screen-aligned grid.** Its outer edges are the two
 * axis lines themselves, so a stem landing on the grid lands somewhere the axes can be read against
 * — which is the whole reason the grid is drawn rather than merely shaded.
 *
 * ⚠️ `steps + 1` lines each way, including both edges: 4 divisions is 5 lines, and the pair that
 * coincides with the axes is drawn under them rather than omitted, because the axes move as the plot
 * rotates and a grid with two edges missing reads as a tear in the surface.
 */
export function floorGrid(view: PlotView, steps = 4): PlotSegment[] {
  const segments: PlotSegment[] = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    segments.push({ from: project3d(view, t, 0, 0), to: project3d(view, t, 1, 0) })
    segments.push({ from: project3d(view, 0, t, 0), to: project3d(view, 1, t, 0) })
  }
  return segments
}

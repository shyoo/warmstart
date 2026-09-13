import { describe, expect, it } from 'vitest'
import { floorGrid, PLOT_VIEWBOX, project3d, stemFor, type PlotView } from './plot3d'

/**
 * ⛔ The claim this suite protects is that a mark's **bar says where the mark is**. An isometric
 * scatter with no anchors is unreadable — two icons a centimetre apart on screen can be anywhere
 * along each other's line of sight — so a stem that did not land directly under its own point, or a
 * floor that was not the plane the two flat axes span, would be worse than no anchor at all: it
 * would be a confident wrong one.
 */

/** The plot's own opening view, so these numbers are the ones actually drawn. */
const VIEW: PlotView = { yaw: -0.7, pitch: 0.5 }

describe('project3d', () => {
  it('puts the origin of the cube at the origin of the drawing', () => {
    const at = project3d(VIEW, 0, 0, 0)
    expect(at.x).toBeCloseTo(210, 6)
    expect(at.y).toBeCloseTo(178, 6)
    expect(at.depth).toBeCloseTo(0, 6)
  })

  /**
   * ⚠️ At the view the plot opens in. The drag handler clamps pitch to ±1.2 and leaves yaw free,
   * and at the extremes a corner of the cube does leave the viewBox — that is the SVG viewport
   * clipping a rotation nobody has to stay in, not a placement bug, and pinning it as if it were
   * would forbid the rotation instead of the fault.
   */
  it('draws the whole cube inside the viewBox at the view it opens in', () => {
    for (const x of [0, 1]) {
      for (const y of [0, 1]) {
        for (const z of [0, 1]) {
          const at = project3d(VIEW, x, y, z)
          expect(at.x).toBeGreaterThanOrEqual(0)
          expect(at.x).toBeLessThanOrEqual(PLOT_VIEWBOX.width)
          expect(at.y).toBeGreaterThanOrEqual(0)
          expect(at.y).toBeLessThanOrEqual(PLOT_VIEWBOX.height)
        }
      }
    }
  })

  /** ⛔ `z` is the axis that lifts a mark off the floor; the other two span it. */
  it('draws a rise in z as a rise on the screen', () => {
    const low = project3d(VIEW, 0.4, 0.6, 0.2)
    const high = project3d(VIEW, 0.4, 0.6, 0.9)
    expect(high.y).toBeLessThan(low.y)
    // ⚠️ And straight up: the two floor coordinates are unchanged, so the screen x cannot move.
    expect(high.x).toBeCloseTo(low.x, 6)
  })
})

describe('stemFor', () => {
  /**
   * ⛔ The property the whole feature rests on: the foot is the same place the point would be if it
   * had no height, so the bar is vertical on screen and lands on the floor under its own mark.
   */
  it('stands the bar directly under its point', () => {
    const { foot, top } = stemFor(VIEW, 0.3, 0.7, 0.8)
    expect(foot.x).toBeCloseTo(top.x, 6)
    expect(foot.y).toBeGreaterThan(top.y)
    expect(foot).toEqual(project3d(VIEW, 0.3, 0.7, 0))
  })

  it('gives a point already on the floor a bar of no length rather than no bar', () => {
    const { foot, top } = stemFor(VIEW, 0.5, 0.5, 0)
    expect(foot).toEqual(top)
  })
})

describe('floorGrid', () => {
  it('rules the plane both ways, edges included', () => {
    const grid = floorGrid(VIEW, 4)
    expect(grid).toHaveLength(10)
  })

  /**
   * ⛔ The grid is the plane the two flat axes span, so its outer edges *are* those axes. A grid that
   * did not reach them would draw a surface the axis labels do not describe.
   */
  it('meets the two flat axes at its own edges', () => {
    const grid = floorGrid(VIEW, 2)
    const origin = project3d(VIEW, 0, 0, 0)
    const xEnd = project3d(VIEW, 1, 0, 0)
    const yEnd = project3d(VIEW, 0, 1, 0)
    const has = (from: typeof origin, to: typeof origin): boolean =>
      grid.some(
        (s) =>
          Math.abs(s.from.x - from.x) < 1e-6 &&
          Math.abs(s.from.y - from.y) < 1e-6 &&
          Math.abs(s.to.x - to.x) < 1e-6 &&
          Math.abs(s.to.y - to.y) < 1e-6
      )
    expect(has(origin, yEnd)).toBe(true)
    expect(has(origin, xEnd)).toBe(true)
  })

  /** ⚠️ Flat: no ruled line may rise above the highest corner of the floor itself. */
  it('keeps every line on the floor', () => {
    const highest = Math.min(
      project3d(VIEW, 0, 0, 0).y,
      project3d(VIEW, 1, 0, 0).y,
      project3d(VIEW, 0, 1, 0).y,
      project3d(VIEW, 1, 1, 0).y
    )
    for (const segment of floorGrid(VIEW, 3)) {
      expect(segment.from.y).toBeGreaterThanOrEqual(highest - 1e-6)
      expect(segment.to.y).toBeGreaterThanOrEqual(highest - 1e-6)
    }
  })
})

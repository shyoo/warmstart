/**
 * A QR code, so the pairing URL can be scanned instead of typed.
 *
 * ⚠️ Written here rather than pulled in: this app ships nine runtime dependencies, and the one
 * thing needed is *byte mode at error-correction level M for a sixty-character URL* — versions
 * 1–10, which is 213 bytes of headroom at the top and far more than a `https://host.tailnet.ts.net`
 * address plus an eight-character code will ever need. Everything below is ISO/IEC 18004 §§6–7.
 *
 * ⛔ The whole thing is pure and returns a matrix, never markup. `qr.test.ts` decodes its own
 * output back to the input string and separately checks the Reed–Solomon syndromes are zero, which
 * is what a scanner would do — a QR that is subtly wrong looks exactly like one that is right.
 */

/** One version's error-correction layout at level M: ⛔ from the standard's table 13-22, not derived. */
interface VersionSpec {
  /** Error-correction codewords per block. */
  ec: number
  /** Blocks, as (count × data codewords). Two entries where the standard splits a version. */
  groups: Array<{ count: number; data: number }>
}

const VERSIONS: VersionSpec[] = [
  { ec: 10, groups: [{ count: 1, data: 16 }] },
  { ec: 16, groups: [{ count: 1, data: 28 }] },
  { ec: 26, groups: [{ count: 1, data: 44 }] },
  { ec: 18, groups: [{ count: 2, data: 32 }] },
  { ec: 24, groups: [{ count: 2, data: 43 }] },
  { ec: 16, groups: [{ count: 4, data: 27 }] },
  { ec: 18, groups: [{ count: 4, data: 31 }] },
  { ec: 22, groups: [{ count: 2, data: 38 }, { count: 2, data: 39 }] },
  { ec: 22, groups: [{ count: 3, data: 36 }, { count: 2, data: 37 }] },
  { ec: 26, groups: [{ count: 4, data: 43 }, { count: 1, data: 44 }] }
]

/** Alignment-pattern centre coordinates per version. Version 1 has none. */
const ALIGNMENT: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]

export interface QrMatrix {
  /** 4·version + 17, excluding the quiet zone the caller draws. */
  size: number
  /** Row-major; `true` is dark. */
  modules: boolean[][]
  version: number
  mask: number
}

// ── GF(256), primitive polynomial 0x11d ───────────────────────────────────────────────────────
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x
  LOG[x] = i
  x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!

/** ⚠️ Zero has no logarithm, so it is answered before the table is touched. */
export function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!
}

function generatorPoly(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j]! ^= gfMul(poly[j]!, EXP[i]!)
      next[j + 1]! ^= poly[j]!
    }
    poly = next
  }
  // ⛔ Reversed to highest-degree-first, which is the order `errorCorrection` divides in. Built
  // ascending and left that way, the division still round-trips against itself — every codeword
  // reads back as it was written — and is not a Reed–Solomon codeword at all, so only a real
  // scanner would ever have noticed. `qr.test.ts` checks the syndromes for exactly this reason.
  return poly.reverse()
}

/** The remainder of data·x^n modulo the generator: the block's error-correction codewords. */
export function errorCorrection(data: number[], ecLength: number): number[] {
  const gen = generatorPoly(ecLength)
  const rem = new Array<number>(ecLength).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem.shift()!
    rem.push(0)
    for (let i = 0; i < ecLength; i++) rem[i]! ^= gfMul(gen[i + 1]!, factor)
  }
  return rem
}

// ── Bit stream ────────────────────────────────────────────────────────────────────────────────
function bitsFor(text: string): { bytes: number[]; version: number } {
  const bytes = [...new TextEncoder().encode(text)]
  for (let version = 1; version <= VERSIONS.length; version++) {
    const spec = VERSIONS[version - 1]!
    const capacity = spec.groups.reduce((sum, g) => sum + g.count * g.data, 0)
    // 4 mode bits + the character count field + the payload, in bytes.
    const needed = Math.ceil((4 + (version <= 9 ? 8 : 16) + bytes.length * 8) / 8)
    if (needed <= capacity) return { bytes, version }
  }
  throw new Error(`QR: ${bytes.length} bytes does not fit version ${VERSIONS.length} at level M`)
}

function codewords(text: string): { data: number[]; version: number } {
  const { bytes, version } = bitsFor(text)
  const spec = VERSIONS[version - 1]!
  const capacity = spec.groups.reduce((sum, g) => sum + g.count * g.data, 0)
  const bits: number[] = []
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, version <= 9 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)
  // Terminator, then the byte boundary, then the standard's alternating pad.
  for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  const raw: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!
    raw.push(byte)
  }
  for (let i = 0; raw.length < capacity; i++) raw.push(i % 2 === 0 ? 0xec : 0x11)

  // Split into blocks, then interleave: data codeword i of every block, then EC codeword i of every block.
  const blocks: number[][] = []
  const eccs: number[][] = []
  let at = 0
  for (const group of spec.groups) {
    for (let b = 0; b < group.count; b++) {
      const block = raw.slice(at, at + group.data)
      at += group.data
      blocks.push(block)
      eccs.push(errorCorrection(block, spec.ec))
    }
  }
  const out: number[] = []
  const longest = Math.max(...blocks.map((b) => b.length))
  for (let i = 0; i < longest; i++) for (const block of blocks) if (i < block.length) out.push(block[i]!)
  for (let i = 0; i < spec.ec; i++) for (const block of eccs) out.push(block[i]!)
  return { data: out, version }
}

// ── Matrix ────────────────────────────────────────────────────────────────────────────────────
const FORMAT_GENERATOR = 0b10100110111
export const FORMAT_MASK = 0b101010000010010
const VERSION_GENERATOR = 0b1111100100101

/** BCH(15,5) over the 5 bits of (error-correction level, mask), then the standard's fixed mask. */
export function formatBits(mask: number): number {
  // 0b00 is level M, in the standard's own ordering — not the same order as the letters M, L, H, Q.
  const data = (0b00 << 3) | mask
  let rest = data << 10
  for (let i = 4; i >= 0; i--) if ((rest >> (i + 10)) & 1) rest ^= FORMAT_GENERATOR << i
  return ((data << 10) | rest) ^ FORMAT_MASK
}

/** BCH(18,6) over the version number. Only versions 7 and up carry it. */
function versionBits(version: number): number {
  let rest = version << 12
  for (let i = 5; i >= 0; i--) if ((rest >> (i + 12)) & 1) rest ^= VERSION_GENERATOR << i
  return (version << 12) | rest
}

const MASKS: Array<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
]

function blank(size: number): { modules: boolean[][]; fixed: boolean[][] } {
  return {
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    fixed: Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }
}

function drawFunctionPatterns(size: number, version: number, modules: boolean[][], fixed: boolean[][]): void {
  const set = (r: number, c: number, dark: boolean): void => {
    if (r < 0 || c < 0 || r >= size || c >= size) return
    modules[r]![c] = dark
    fixed[r]![c] = true
  }
  // Three finders, each with its separator ring.
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6
        set(top + r, left + c, inside && (edge || core))
      }
    }
  }
  // Timing patterns, and the alignment squares that do not collide with a finder.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  const centres = ALIGNMENT[version - 1]!
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
        }
      }
    }
  }
  set(size - 8, 8, true) // The dark module, which is always dark and never data.
  // Reserve the format areas so data placement steps over them; the real bits land later.
  // ⛔ Row 6 and column 6 are skipped: (8,6) and (6,8) are *timing* modules, and reserving them as
  // format would blank the one dark module at the head of each timing line.
  for (let i = 0; i < 9; i++) {
    if (i !== 6) set(8, i, false)
    if (i !== 6) set(i, 8, false)
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, false)
    if (size - 1 - i !== size - 8) set(size - 1 - i, 8, false)
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      set(Math.floor(i / 3), size - 11 + (i % 3), false)
      set(size - 11 + (i % 3), Math.floor(i / 3), false)
    }
  }
}

/** Which modules a version reserves for its function patterns — everything data must step over. */
export function functionModules(version: number): boolean[][] {
  const size = version * 4 + 17
  const { modules, fixed } = blank(size)
  drawFunctionPatterns(size, version, modules, fixed)
  return fixed
}

/** The zigzag: two-module columns from the right, skipping the vertical timing column. */
export function dataPositions(size: number, fixed: boolean[][]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    // ⛔ Column 6 is the vertical timing pattern: the walk *steps over* it by moving the pair one
    // column left for the rest of the walk, rather than shifting only this pair — shifting only
    // this pair visits column 4 twice and never visits column 0.
    if (right === 6) right = 5
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (const col of [right, right - 1]) {
        if (!fixed[row]![col]) out.push([row, col])
      }
    }
    upward = !upward
  }
  return out
}

function placeFormat(size: number, modules: boolean[][], mask: number): void {
  const bits = formatBits(mask)
  const bit = (i: number): boolean => ((bits >> i) & 1) === 1
  for (let i = 0; i <= 5; i++) modules[8]![i] = bit(i)
  modules[8]![7] = bit(6)
  modules[8]![8] = bit(7)
  modules[7]![8] = bit(8)
  for (let i = 9; i <= 14; i++) modules[14 - i]![8] = bit(i)
  for (let i = 0; i <= 7; i++) modules[size - 1 - i]![8] = bit(i)
  for (let i = 8; i <= 14; i++) modules[8]![size - 15 + i] = bit(i)
}

function placeVersion(size: number, version: number, modules: boolean[][]): void {
  if (version < 7) return
  const bits = versionBits(version)
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >> i) & 1) === 1
    modules[Math.floor(i / 3)]![size - 11 + (i % 3)] = dark
    modules[size - 11 + (i % 3)]![Math.floor(i / 3)] = dark
  }
}

/** The standard's four penalties. Lower is better; the winning mask is the one a scanner likes. */
export function penalty(modules: boolean[][]): number {
  const size = modules.length
  let score = 0
  const runs = (get: (a: number, b: number) => boolean): void => {
    for (let a = 0; a < size; a++) {
      let run = 1
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) run++
        else {
          if (run >= 5) score += 3 + (run - 5)
          run = 1
        }
      }
      if (run >= 5) score += 3 + (run - 5)
    }
  }
  runs((r, c) => modules[r]![c]!)
  runs((c, r) => modules[r]![c]!)
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r]![c]
      if (v === modules[r]![c + 1] && v === modules[r + 1]![c] && v === modules[r + 1]![c + 1]) score += 3
    }
  }
  // 1:1:3:1:1 with four light modules on either side — the finder pattern, appearing where it should not.
  const pattern = [true, false, true, true, true, false, true, false, false, false, false]
  const reversed = [...pattern].reverse()
  const matches = (line: boolean[], at: number, want: boolean[]): boolean =>
    want.every((w, i) => line[at + i] === w)
  for (let a = 0; a < size; a++) {
    const row = modules[a]!
    const col = modules.map((line) => line[a]!)
    for (const line of [row, col]) {
      for (let at = 0; at + pattern.length <= size; at++) {
        if (matches(line, at, pattern) || matches(line, at, reversed)) score += 40
      }
    }
  }
  const dark = modules.flat().filter(Boolean).length
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10
  return score
}

/** Encode `text` as a level-M byte-mode QR code, choosing the smallest version and best mask. */
export function qrMatrix(text: string): QrMatrix {
  const { data, version } = codewords(text)
  const size = version * 4 + 17
  let best: QrMatrix | null = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const { modules, fixed } = blank(size)
    drawFunctionPatterns(size, version, modules, fixed)
    const positions = dataPositions(size, fixed)
    positions.forEach(([row, col], i) => {
      const byte = data[i >> 3]
      const bit = byte === undefined ? 0 : (byte >> (7 - (i & 7))) & 1
      modules[row]![col] = (bit === 1) !== MASKS[mask]!(row, col)
    })
    placeVersion(size, version, modules)
    placeFormat(size, modules, mask)
    const score = penalty(modules)
    if (score < bestScore) {
      bestScore = score
      best = { size, modules, version, mask }
    }
  }
  return best!
}

/**
 * The matrix as one SVG path, with the standard's four-module quiet zone.
 *
 * ⚠️ A single path rather than a rect per module: a version-5 code is 1,369 modules, and half of
 * them as DOM nodes is a visible hitch on a settings panel that redraws every second.
 */
export function qrPath(matrix: QrMatrix, quiet = 4): { path: string; extent: number } {
  const parts: string[] = []
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.modules[r]![c]) parts.push(`M${c + quiet} ${r + quiet}h1v1h-1z`)
    }
  }
  return { path: parts.join(''), extent: matrix.size + quiet * 2 }
}

import { describe, expect, it } from 'vitest'
import { FORMAT_MASK, dataPositions, errorCorrection, functionModules, gfMul, qrMatrix, qrPath } from './qr'

/**
 * ⛔ A QR code that is subtly wrong is indistinguishable from a right one by eye, and the only
 * reader in this repo is a phone camera no suite can drive. So this file *is* the reader: it
 * reverses the encoder's own placement, reads the format information back out of the matrix, and
 * checks the Reed–Solomon syndromes — the same three things a scanner does before it trusts a code.
 *
 * ⚠️ Round-tripping through the encoder's own tables would prove nothing on its own, which is why
 * the syndrome check is here: it is an independent property of a real RS codeword and fails for
 * any arithmetic mistake in `errorCorrection`, whatever the placement does.
 */

/** Level M at each version: EC codewords per block, then the block sizes, from ISO/IEC 18004. */
const LAYOUT: Record<number, { ec: number; blocks: number[] }> = {
  1: { ec: 10, blocks: [16] },
  2: { ec: 16, blocks: [28] },
  3: { ec: 26, blocks: [44] },
  4: { ec: 18, blocks: [32, 32] },
  5: { ec: 24, blocks: [43, 43] },
  6: { ec: 16, blocks: [27, 27, 27, 27] },
  7: { ec: 18, blocks: [31, 31, 31, 31] },
  8: { ec: 22, blocks: [38, 38, 39, 39] },
  9: { ec: 22, blocks: [36, 36, 36, 37, 37] },
  10: { ec: 26, blocks: [43, 43, 43, 43, 44] }
}

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
]

/** The mask number as a scanner reads it: the format strip by the top-left finder, unmasked. */
function readMask(modules: boolean[][]): number {
  let bits = 0
  const at = (r: number, c: number): number => (modules[r]![c] ? 1 : 0)
  for (let i = 0; i <= 5; i++) bits |= at(8, i) << i
  bits |= at(8, 7) << 6
  bits |= at(8, 8) << 7
  bits |= at(7, 8) << 8
  for (let i = 9; i <= 14; i++) bits |= at(14 - i, 8) << i
  // The 5 data bits sit above the 10 BCH bits; the mask is the low 3 of those.
  return ((bits ^ FORMAT_MASK) >> 10) & 0b111
}

/** Read the interleaved codeword stream back out of the matrix, undoing the mask as it goes. */
function readCodewords(modules: boolean[][], version: number, mask: number): number[] {
  const size = version * 4 + 17
  const positions = dataPositions(size, functionModules(version))
  const bits = positions.map(([r, c]) => ((modules[r]![c] ? 1 : 0) ^ (MASKS[mask]!(r, c) ? 1 : 0)))
  const out: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!
    out.push(byte)
  }
  return out
}

/** Undo the interleave, giving each block back as data codewords followed by its EC codewords. */
function deinterleave(stream: number[], version: number): number[][] {
  const { ec, blocks } = LAYOUT[version]!
  const data: number[][] = blocks.map(() => [])
  let at = 0
  for (let i = 0; i < Math.max(...blocks); i++) {
    for (let b = 0; b < blocks.length; b++) if (i < blocks[b]!) data[b]!.push(stream[at++]!)
  }
  const parity: number[][] = blocks.map(() => [])
  for (let i = 0; i < ec; i++) for (let b = 0; b < blocks.length; b++) parity[b]!.push(stream[at++]!)
  return data.map((block, b) => [...block, ...parity[b]!])
}

/**
 * A codeword's syndromes. ⛔ Zero for every one of them is what makes it a Reed–Solomon codeword —
 * an independent fact about the arithmetic, not a replay of how it was produced.
 */
function syndromes(codeword: number[], ec: number): number[] {
  const EXP: number[] = []
  for (let i = 0, x = 1; i < 255; i++) {
    EXP.push(x)
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)
  }
  const power = (i: number): number => EXP[i % 255]!
  return Array.from({ length: ec }, (_, s) => {
    let acc = 0
    codeword.forEach((c, k) => {
      acc ^= gfMul(c, power(s * (codeword.length - 1 - k)))
    })
    return acc
  })
}

/** The byte-mode payload, read out of the de-interleaved data codewords the way a scanner does. */
function decodeText(blocks: number[][], version: number): string {
  const { ec } = LAYOUT[version]!
  const raw = blocks.flatMap((block) => block.slice(0, block.length - ec))
  const bits: number[] = []
  for (const byte of raw) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
  const take = (n: number): number => bits.splice(0, n).reduce((acc, b) => (acc << 1) | b, 0)
  expect(take(4)).toBe(0b0100) // Byte mode.
  const length = take(version <= 9 ? 8 : 16)
  return new TextDecoder().decode(new Uint8Array(Array.from({ length }, () => take(8))))
}

const SAMPLES = [
  'https://desk.tail1a2b3.ts.net:8787/#/pair?code=7GQ4M2XK',
  'http://192.168.1.24:8787/#/pair?code=00000000',
  // Multi-byte, and long enough to push past a version boundary.
  `https://a-rather-long-machine-name.tail9f8e7d.ts.net:8787/#/pair?code=ZZTV5N9P — ${'é'.repeat(20)}`
]

describe('qr', () => {
  it.each(SAMPLES)('encodes %s so a scanner reads it back', (text) => {
    const matrix = qrMatrix(text)
    expect(matrix.size).toBe(matrix.version * 4 + 17)
    // The mask has to survive into the format strip, or a scanner unmasks with the wrong one.
    expect(readMask(matrix.modules)).toBe(matrix.mask)
    const blocks = deinterleave(readCodewords(matrix.modules, matrix.version, matrix.mask), matrix.version)
    for (const block of blocks) expect(syndromes(block, LAYOUT[matrix.version]!.ec)).toEqual(new Array(LAYOUT[matrix.version]!.ec).fill(0))
    expect(decodeText(blocks, matrix.version)).toBe(text)
  })

  it('draws the three finders, the timing patterns and the dark module', () => {
    const { modules, size } = qrMatrix(SAMPLES[0]!)
    for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
      expect(modules[top]![left]).toBe(true)
      expect(modules[top + 1]![left + 1]).toBe(false) // The light ring.
      expect(modules[top + 3]![left + 3]).toBe(true) // The 3×3 core.
    }
    for (let i = 8; i < size - 8; i++) {
      expect(modules[6]![i]).toBe(i % 2 === 0)
      expect(modules[i]![6]).toBe(i % 2 === 0)
    }
    expect(modules[size - 8]![8]).toBe(true)
  })

  it('grows to the next version rather than truncating, and refuses what will not fit', () => {
    expect(qrMatrix('x'.repeat(16 - 2)).version).toBe(1)
    expect(qrMatrix('x'.repeat(200)).version).toBe(10)
    expect(() => qrMatrix('x'.repeat(300))).toThrow(/does not fit/)
  })

  it('multiplies in GF(256) and produces the expected number of EC codewords', () => {
    expect(gfMul(0, 123)).toBe(0)
    expect(gfMul(1, 123)).toBe(123)
    expect(gfMul(2, 0x80)).toBe(0x1d) // The reduction, where the top bit wraps.
    expect(errorCorrection([1, 2, 3], 10)).toHaveLength(10)
  })

  it('draws one path with a quiet zone, not a rect per module', () => {
    const matrix = qrMatrix(SAMPLES[0]!)
    const { path, extent } = qrPath(matrix)
    expect(extent).toBe(matrix.size + 8)
    expect(path.startsWith('M')).toBe(true)
    expect(path.split('M').length - 1).toBe(matrix.modules.flat().filter(Boolean).length)
  })
})

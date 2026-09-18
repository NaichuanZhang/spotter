/**
 * A 5x7 bitmap font, defined inline.
 *
 * WHY NOT A REAL FONT FILE: there is no rasteriser on this machine (see ref-raster.mjs),
 * so there is nothing that could turn a .ttf outline into pixels. A bitmap font is the
 * only dependency-free way to burn a caption into a raw RGB24 frame.
 *
 * Uppercase only, plus digits and the handful of marks the captions need. Unknown
 * characters THROW rather than silently rendering a blank — a caption that quietly
 * loses a letter is worse than a failed render, because nobody re-reads the clips.
 *
 * Each glyph is 7 rows of 5 columns; '#' is ink. One blank column of advance is added
 * between glyphs, so the advance is 6 * scale.
 */

const GLYPH_WIDTH = 5
const GLYPH_HEIGHT = 7
const GLYPH_ADVANCE = GLYPH_WIDTH + 1

const GLYPHS = {
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..##', '.####'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  "'": ['..#..', '..#..', '.....', '.....', '.....', '.....', '.....'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '>': ['#....', '.#...', '..#..', '...#.', '..#..', '.#...', '#....'],
}

/** Width in pixels of a string at a given integer scale (no trailing gap). */
export function textWidth(text, scale) {
  if (text.length === 0) return 0
  return (text.length * GLYPH_ADVANCE - 1) * scale
}

export function textHeight(scale) {
  return GLYPH_HEIGHT * scale
}

/**
 * The largest integer scale at which `text` still fits `maxWidth`.
 * Throws if even scale 1 overflows — the caller must shorten the caption instead of
 * shipping a clipped one.
 */
export function fitScale(text, maxWidth, maxScale) {
  for (let scale = maxScale; scale >= 1; scale -= 1) {
    if (textWidth(text, scale) <= maxWidth) return scale
  }
  throw new Error(`fitScale: "${text}" does not fit ${maxWidth}px even at scale 1`)
}

/**
 * Draws `text` with its top-left at (x, y). `align` is 'left' | 'centre' and, when
 * centred, x is the CENTRE. Each lit bitmap cell becomes a scale x scale rect, so the
 * result is deliberately blocky — which survives the 4x downscale to 148px better than
 * a thin antialiased typeface would.
 */
export function drawText(canvas, fillRect, text, options) {
  const { x, y, scale, rgb, alpha = 1, align = 'left' } = options
  if (!Number.isInteger(scale) || scale < 1) throw new Error(`drawText: bad scale ${scale}`)
  const upper = text.toUpperCase()
  const startX = align === 'centre' ? Math.round(x - textWidth(upper, scale) / 2) : Math.round(x)

  for (let i = 0; i < upper.length; i += 1) {
    const glyph = GLYPHS[upper[i]]
    if (!glyph) {
      throw new Error(`drawText: no 5x7 glyph for "${upper[i]}" in "${text}" — add it to ref-font.mjs`)
    }
    const originX = startX + i * GLYPH_ADVANCE * scale
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      const bits = glyph[row]
      for (let col = 0; col < GLYPH_WIDTH; col += 1) {
        if (bits[col] !== '#') continue
        fillRect(canvas, originX + col * scale, y + row * scale, scale, scale, rgb, alpha)
      }
    }
  }
}

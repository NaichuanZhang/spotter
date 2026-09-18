/**
 * A tiny RGB24 software rasteriser.
 *
 * WHY THIS EXISTS: this machine has no rasteriser at all — no rsvg-convert, no
 * ImageMagick, no Inkscape, no cairosvg, no headless Chrome. So there is nothing that
 * can turn an SVG or a <canvas> into pixels for ffmpeg. Drawing straight into a packed
 * RGB24 buffer and piping it to `ffmpeg -f rawvideo` needs zero dependencies, which is
 * why the reference clips are rendered this way rather than via any drawing library.
 *
 * Everything here is antialiased by COVERAGE, not by supersampling: a pixel's alpha is
 * how far inside the shape its centre is, measured with a signed distance. Jaggy joints
 * look like a bug rather than a diagram, and the clips are displayed at 148px wide
 * (`.refclip__video` in src/styles.css) so every edge is resampled again on the way in.
 *
 * Coordinates are floating-point pixels, y DOWNWARD, matching both the screen and the
 * normalised-landmark convention used everywhere else in this repo.
 */

/** Antialias band, in pixels, either side of a shape's true edge. */
const EDGE_FEATHER_PX = 1.0

/** Below this the blend is a no-op; skips most of a bounding box for thin strokes. */
const MIN_VISIBLE_ALPHA = 1 / 512

export function hexToRgb(hex) {
  const text = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(text)) {
    throw new Error(`hexToRgb: expected a 6-digit hex colour, got "${hex}"`)
  }
  return [
    parseInt(text.slice(0, 2), 16),
    parseInt(text.slice(2, 4), 16),
    parseInt(text.slice(4, 6), 16),
  ]
}

/** Linear interpolation between two RGB triples. `f` is clamped to [0, 1]. */
export function mixRgb(a, b, f) {
  const t = Math.min(1, Math.max(0, f))
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

export function createCanvas(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`createCanvas: bad size ${width}x${height}`)
  }
  return { width, height, data: new Uint8Array(width * height * 3) }
}

export function clear(canvas, rgb) {
  const { data } = canvas
  for (let i = 0; i < data.length; i += 3) {
    data[i] = rgb[0]
    data[i + 1] = rgb[1]
    data[i + 2] = rgb[2]
  }
}

/** Source-over blend of one pixel. Out-of-bounds writes are dropped, not clamped. */
function blend(canvas, x, y, rgb, alpha) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return
  if (alpha < MIN_VISIBLE_ALPHA) return
  const a = alpha > 1 ? 1 : alpha
  const at = (y * canvas.width + x) * 3
  const { data } = canvas
  data[at] += (rgb[0] - data[at]) * a
  data[at + 1] += (rgb[1] - data[at + 1]) * a
  data[at + 2] += (rgb[2] - data[at + 2]) * a
}

/**
 * Walks the integer pixels of a bounding box and blends whatever `coverage` reports.
 * Every shape below is one call to this with a different distance function.
 */
function rasterise(canvas, box, rgb, alpha, coverage) {
  const x0 = Math.max(0, Math.floor(box.x0))
  const y0 = Math.max(0, Math.floor(box.y0))
  const x1 = Math.min(canvas.width - 1, Math.ceil(box.x1))
  const y1 = Math.min(canvas.height - 1, Math.ceil(box.y1))
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const c = coverage(x + 0.5, y + 0.5)
      if (c > 0) blend(canvas, x, y, rgb, c * alpha)
    }
  }
}

/** Distance from a point to a segment, plus the clamped parameter along it. */
function distanceToSegment(px, py, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / lengthSq))
  const cx = a.x + dx * t
  const cy = a.y + dy * t
  return Math.hypot(px - cx, py - cy)
}

export function fillRect(canvas, x, y, width, height, rgb, alpha = 1) {
  rasterise(
    canvas,
    { x0: x, y0: y, x1: x + width, y1: y + height },
    rgb,
    alpha,
    (px, py) => {
      const cx = Math.min(px - x, x + width - px)
      const cy = Math.min(py - y, y + height - py)
      return Math.min(1, Math.max(0, cx + 0.5)) * Math.min(1, Math.max(0, cy + 0.5))
    },
  )
}

/** Round-capped thick line. `width` is the full stroke width in pixels. */
export function strokeLine(canvas, a, b, width, rgb, alpha = 1) {
  const half = width / 2
  const pad = half + EDGE_FEATHER_PX
  rasterise(
    canvas,
    {
      x0: Math.min(a.x, b.x) - pad,
      y0: Math.min(a.y, b.y) - pad,
      x1: Math.max(a.x, b.x) + pad,
      y1: Math.max(a.y, b.y) + pad,
    },
    rgb,
    alpha,
    (px, py) => Math.min(1, Math.max(0, half + 0.5 - distanceToSegment(px, py, a, b))),
  )
}

export function fillCircle(canvas, centre, radius, rgb, alpha = 1) {
  const pad = radius + EDGE_FEATHER_PX
  rasterise(
    canvas,
    { x0: centre.x - pad, y0: centre.y - pad, x1: centre.x + pad, y1: centre.y + pad },
    rgb,
    alpha,
    (px, py) => Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(px - centre.x, py - centre.y))),
  )
}

export function strokeCircle(canvas, centre, radius, width, rgb, alpha = 1) {
  const half = width / 2
  const pad = radius + half + EDGE_FEATHER_PX
  rasterise(
    canvas,
    { x0: centre.x - pad, y0: centre.y - pad, x1: centre.x + pad, y1: centre.y + pad },
    rgb,
    alpha,
    (px, py) => {
      const ring = Math.abs(Math.hypot(px - centre.x, py - centre.y) - radius)
      return Math.min(1, Math.max(0, half + 0.5 - ring))
    },
  )
}

/** Dashed segment. Used for the shoulder->toe plumb line the faults are measured from. */
export function strokeDashedLine(canvas, a, b, width, rgb, alpha, dash, gap) {
  if (dash <= 0 || gap < 0) throw new Error(`strokeDashedLine: bad dash ${dash}/${gap}`)
  const length = Math.hypot(b.x - a.x, b.y - a.y)
  if (length === 0) return
  const ux = (b.x - a.x) / length
  const uy = (b.y - a.y) / length
  for (let at = 0; at < length; at += dash + gap) {
    const end = Math.min(length, at + dash)
    strokeLine(
      canvas,
      { x: a.x + ux * at, y: a.y + uy * at },
      { x: a.x + ux * end, y: a.y + uy * end },
      width,
      rgb,
      alpha,
    )
  }
}

/** Polyline through points, as a chain of round-capped segments. */
export function strokePath(canvas, points, width, rgb, alpha = 1) {
  for (let i = 1; i < points.length; i += 1) {
    strokeLine(canvas, points[i - 1], points[i], width, rgb, alpha)
  }
}

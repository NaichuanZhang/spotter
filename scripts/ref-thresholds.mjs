/**
 * Reads the app's own fault and rep thresholds straight out of src/pose at run time.
 *
 * WHY NOT JUST WRITE THE NUMBERS DOWN: because then "the corrected half of this clip
 * reaches full depth" would be a claim about a number copied months ago rather than about
 * the number the app is actually using. Every threshold the render checks itself against
 * is read from source here, and a RENAMED or DELETED constant aborts the render with the
 * name it could not find instead of falling back to a guess. Same contract the landmark
 * extraction in scripts/extract-landmarks.mjs uses for its mirrored tunables.
 *
 * Deliberately a regex scan and not a TypeScript parse: these are frozen literal blocks
 * (`export const NAME = { key: 123, ... } as const`), a parser would be a dependency, and
 * a scan that cannot find a key fails loudly, which is the only behaviour that matters.
 */

import { readFileSync } from 'node:fs'

const REQUIRED = {
  'src/pose/repMachine.ts': {
    block: 'REP_THRESHOLDS',
    keys: ['downEnterDeg', 'upEnterDeg', 'partialAboveDeg', 'depthFullDeg', 'depthZeroDeg'],
  },
  'src/pose/faults.ts': {
    block: 'FAULT_THRESHOLDS',
    keys: ['sagDeg', 'pikeDeg', 'neckMinDeg', 'flareDeg', 'lockoutDeg'],
  },
}

/** Everything between `export const NAME = {` and the matching closing brace at column 0. */
function blockBody(source, name, file) {
  const start = source.indexOf(`export const ${name} = {`)
  if (start < 0) throw new Error(`ref-thresholds: ${file} has no "export const ${name} = {"`)
  const end = source.indexOf('\n}', start)
  if (end < 0) throw new Error(`ref-thresholds: could not find the end of ${name} in ${file}`)
  return source.slice(start, end)
}

export function readAppThresholds(root) {
  const out = {}
  for (const [file, spec] of Object.entries(REQUIRED)) {
    const body = blockBody(readFileSync(`${root}/${file}`, 'utf8'), spec.block, file)
    for (const key of spec.keys) {
      const match = new RegExp(`(?:^|[\\s{,])${key}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'm').exec(body)
      if (!match) {
        throw new Error(
          `ref-thresholds: ${file} ${spec.block} has no numeric constant named "${key}". ` +
            `It was renamed or removed — update REQUIRED in scripts/ref-thresholds.mjs rather than ` +
            `hardcoding a guess, because the reference clips assert against these numbers.`,
        )
      }
      if (key in out && out[key] !== Number(match[1])) {
        throw new Error(`ref-thresholds: "${key}" is defined twice with different values`)
      }
      out[key] = Number(match[1])
    }
  }
  return Object.freeze(out)
}

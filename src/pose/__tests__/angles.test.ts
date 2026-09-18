import { describe, expect, it } from 'vitest'
import {
  angleAt,
  bodyLineAngle,
  elbowAngle,
  elbowFlare,
  GEOMETRY,
  hipDeviation,
  lineYAt,
  measureAngles,
  neckAngle,
} from '../angles'
import { inFrame, LEFT_SHOULDER, pickSide, requiredLandmarks, RIGHT_SHOULDER } from '../landmarks'
import { occludeJoints, outOfFrameSet, sideViewPose } from './fixtures'

/** Mirror the pose left-right. Sag must stay sag: y-down is absolute. */
function mirrorX(landmarks: readonly { x: number; y: number; z: number; visibility: number }[]) {
  return landmarks.map((lm) => ({ ...lm, x: 1 - lm.x }))
}

describe('angleAt', () => {
  it('measures the interior angle at the middle point', () => {
    expect(angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })).toBeCloseTo(180, 6)
    expect(angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(90, 6)
    expect(angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(0, 6)
  })

  it('clamps the acos domain instead of returning NaN', () => {
    // Collinear points whose cosine floats just past 1.0 in IEEE754.
    const a = { x: 0.1, y: 0.30000000000000004 }
    const b = { x: 0.2, y: 0.6000000000000001 }
    const c = { x: 0.30000000000000004, y: 0.9000000000000001 }
    const angle = angleAt(a, b, c)
    expect(Number.isNaN(angle)).toBe(false)
    expect(angle).toBeCloseTo(180, 3)
  })

  it('refuses coincident points with the safe straight answer', () => {
    const p = { x: 0.5, y: 0.5 }
    expect(angleAt(p, p, { x: 0.6, y: 0.5 })).toBe(GEOMETRY.degenerateAngleDeg)
    expect(angleAt({ x: 0.6, y: 0.5 }, p, p)).toBe(GEOMETRY.degenerateAngleDeg)
  })
})

describe('lineYAt', () => {
  it('interpolates along the segment', () => {
    const a = { x: 0.2, y: 0.4 }
    const b = { x: 0.8, y: 0.7 }
    expect(lineYAt(a, b, 0.5)).toBeCloseTo(0.55, 9)
    expect(lineYAt(a, b, 0.2)).toBeCloseTo(0.4, 9)
  })

  it('refuses a segment with no usable horizontal span', () => {
    expect(lineYAt({ x: 0.5, y: 0.2 }, { x: 0.5, y: 0.9 }, 0.5)).toBeNull()
  })
})

describe('elbowAngle', () => {
  it('measures back the angle the fixture was built from', () => {
    for (const requested of [178, 150, 120, 100, 85, 70]) {
      expect(elbowAngle(sideViewPose(requested))).toBeCloseTo(requested, 6)
    }
  })
})

describe('hipDeviation sign convention', () => {
  it('reports a straight plank as no deviation', () => {
    expect(hipDeviation(sideViewPose(178, 0))).toBeCloseTo(0, 6)
    expect(bodyLineAngle(sideViewPose(178, 0))).toBeCloseTo(180, 4)
  })

  it('reports POSITIVE for sagging hips (hip below the shoulder-ankle line)', () => {
    const sag = hipDeviation(sideViewPose(178, 0.04))
    expect(sag).not.toBeNull()
    expect(sag!).toBeGreaterThan(0)
    expect(sag!).toBeGreaterThan(15)
  })

  it('reports NEGATIVE for piked hips (hip above the line)', () => {
    const pike = hipDeviation(sideViewPose(178, -0.04))
    expect(pike).not.toBeNull()
    expect(pike!).toBeLessThan(0)
    expect(pike!).toBeLessThan(-15)
  })

  it('gives sag and pike of equal size an INDISTINGUISHABLE unsigned body-line angle', () => {
    // This is the whole reason hipDeviation exists. If a future refactor derives the
    // fault from bodyLineAngle, this assertion is what proves it cannot work: the two
    // opposite postures land a fifth of a degree apart out of ~160, far inside
    // landmark noise, while the signed values are cleanly opposite.
    const sag = bodyLineAngle(sideViewPose(178, 0.04))!
    const pike = bodyLineAngle(sideViewPose(178, -0.04))!
    expect(Math.abs(sag - pike)).toBeLessThan(1)

    const signedSag = hipDeviation(sideViewPose(178, 0.04))!
    const signedPike = hipDeviation(sideViewPose(178, -0.04))!
    expect(Math.sign(signedSag)).toBe(1)
    expect(Math.sign(signedPike)).toBe(-1)
  })

  it('keeps sag positive when the body faces the other way', () => {
    const facingRight = sideViewPose(178, 0.04)
    const facingLeft = mirrorX(facingRight)
    const a = hipDeviation(facingRight)
    const b = hipDeviation(facingLeft)
    expect(a!).toBeGreaterThan(0)
    expect(b!).toBeGreaterThan(0)
    expect(b!).toBeCloseTo(a!, 6)
  })

  it('refuses to guess when the body is vertical in frame', () => {
    const pose = sideViewPose(178, 0.04)
    // Collapse the shoulder->ankle horizontal span below GEOMETRY.minBodySpanX.
    const squashed = pose.map((lm) => ({ ...lm, x: 0.5 }))
    expect(hipDeviation(squashed)).toBeNull()
  })
})

describe('neckAngle and elbowFlare', () => {
  it('reads a neutral neck as near-straight through the whole rep', () => {
    for (const elbow of [178, 130, 85]) {
      expect(neckAngle(sideViewPose(elbow))!).toBeGreaterThan(160)
    }
  })

  it('reads a side-view flare as large, which is why the fault is front-only', () => {
    // Not a defect: from the side this angle is a projection artefact. The point of
    // the assertion is that the value is NOT trustworthy, so the view gate must run.
    expect(elbowFlare(sideViewPose(178))!).toBeGreaterThan(65)
  })
})

describe('pickSide', () => {
  it('chooses the near, well-tracked limb rather than averaging in the occluded one', () => {
    const pose = sideViewPose(120)
    const pick = pickSide(pose, ['shoulder', 'elbow', 'wrist'])
    expect(pick?.side).toBe('left')
    expect(pick!.meanVisibility).toBeGreaterThan(0.9)
  })

  it('switches sides when the other one is better tracked', () => {
    const pose = sideViewPose(120).map((lm) => ({ ...lm }))
    pose[LEFT_SHOULDER] = { ...pose[LEFT_SHOULDER]!, visibility: 0.05 }
    pose[RIGHT_SHOULDER] = { ...pose[RIGHT_SHOULDER]!, visibility: 0.9 }
    expect(pickSide(pose, ['shoulder'])?.side).toBe('right')
  })

  it('does not switch to a side that is merely less bad', () => {
    // Left drops to 0.05 and right is still the occluded 0.25 — below the sidePick
    // floor, so the honest answer is "no measurement", not the better of two guesses.
    const pose = sideViewPose(120).map((lm) => ({ ...lm }))
    pose[LEFT_SHOULDER] = { ...pose[LEFT_SHOULDER]!, visibility: 0.05 }
    expect(pickSide(pose, ['shoulder'])).toBeNull()
  })

  it('returns null rather than a guess when neither side is visible', () => {
    const pose = sideViewPose(120).map((lm) => ({ ...lm, visibility: 0.01 }))
    expect(pickSide(pose, ['shoulder', 'elbow', 'wrist'])).toBeNull()
    expect(pickSide([], ['shoulder'])).toBeNull()
    expect(pickSide(null, ['shoulder'])).toBeNull()
  })
})

describe('inFrame', () => {
  it('passes a fully visible pose', () => {
    expect(inFrame(sideViewPose(178))).toEqual({ inFrame: true, missing: [] })
  })

  it('names exactly the joints that went missing', () => {
    const legless = occludeJoints(sideViewPose(178), ['hip', 'ankle'])
    const result = inFrame(legless)
    expect(result.inFrame).toBe(false)
    expect(result.missing).toEqual(['hip', 'ankle'])
  })

  it('tolerates one occluded side because a side view always has one', () => {
    // Only the far side is dropped; the near side still satisfies every requirement.
    const pose = sideViewPose(178)
    expect(inFrame(pose).inFrame).toBe(true)
  })

  it('reports every requirement missing when there is no pose at all', () => {
    const names = requiredLandmarks.map((r) => r.name)
    expect(inFrame(null)).toEqual({ inFrame: false, missing: names })
    expect(inFrame([])).toEqual({ inFrame: false, missing: names })
  })
})

describe('measureAngles', () => {
  it('produces a mutually consistent bundle from one side', () => {
    const angles = measureAngles(sideViewPose(90, 0.03))
    expect(angles).not.toBeNull()
    expect(angles!.side).toBe('left')
    expect(angles!.elbow).toBeCloseTo(90, 6)
    expect(angles!.hipDeviation).toBeGreaterThan(0)
    expect(angles!.neck).not.toBeNull()
  })

  it('returns null for every frame of an out-of-frame gap, so no reps can be invented', () => {
    const gap = outOfFrameSet().filter((f) => f.landmarks === null)
    expect(gap.length).toBeGreaterThan(0)
    for (const frame of gap) expect(measureAngles(frame.landmarks)).toBeNull()
  })
})

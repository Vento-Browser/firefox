/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Vento Behavioral Quantizer — the isolated, engine-agnostic core of the
 * behavioral/biometric fingerprint mitigation (etap 2, level 1 of section 10
 * "Действия пользователя" in FINGERPRINTING_RESEARCH.md).
 *
 * Design goal (Gleb): keep all Vento fingerprint logic in this module so it can
 * be lifted into a standalone repo. Like VentoFingerprintProfile, nothing here
 * depends on Firefox internals — only pure JS — so the exact same quantization
 * can be re-implemented byte-for-byte at the C++ injection points (WidgetEvent
 * timestamp reduction and MouseEvent screen-point coarsening) and produce
 * identical output.
 *
 * Scope / honest limitation (see the research doc): the behavioral channel
 * (mouse trajectories, keystroke dwell/flight times) can only be *blunted*, not
 * made byte-identical across two live humans, without destroying UX and without
 * the synthetic input itself becoming a bot-detection tell. So this module
 * implements the cheap, high-impact "level 1": it LOWERS THE RESOLUTION of the
 * channel by
 *   1. quantizing event timestamps onto a fixed grid with a deterministic,
 *      seed-derived phase (removes the sub-millisecond micro-timing that
 *      keystroke-dynamics biometrics rely on), and
 *   2. coarsening pointer coordinates onto a grid (removes the sub-pixel /
 *      single-pixel deltas that mouse-dynamics biometrics rely on).
 * It does NOT attempt level 2 (rewriting trajectories / resampling key
 * intervals) — that is out of scope by design.
 *
 * The important, CI-checkable property is determinism: given the same profile
 * seed, two machines derive the same phase offsets and therefore quantize any
 * given input identically. That is what test_vento_fingerprint_behavioral.js
 * asserts.
 */

import { cyrb128 } from "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs";

/**
 * Default grid sizes. Chosen to blunt biometrics while preserving UX:
 * - timestamps: 16ms ~ one animation frame. Keystroke dwell/flight times live in
 *   the 50-200ms range, so a 16ms grid erases the fine structure that identifies
 *   a typist while remaining below human-perceptible input latency.
 * - coordinates: 2 CSS px. Mouse-dynamics curvature/velocity signatures depend on
 *   sub-pixel and single-pixel deltas; a 2px grid removes them yet keeps pointer
 *   targeting usable.
 */
const DEFAULT_TIMER_PRECISION_MS = 16;
const DEFAULT_COORD_GRID_PX = 2;

/** Deterministic float in [0, 1) from a seed string (one cyrb128 word). */
function unitFromSeed(str) {
  const [a] = cyrb128(str);
  return (a >>> 0) / 4294967296;
}

/**
 * Quantizes user-input observables (event timestamps and pointer coordinates)
 * onto fixed grids whose phase is a deterministic function of the profile seed.
 *
 * The phase offset is what makes the grid alignment identical across two
 * machines running the same Vento profile, and different (uncorrelatable)
 * between two different profiles — while still destroying the sub-grid
 * information in every case.
 */
export class VentoBehavioralQuantizer {
  /**
   * @param {object} opts
   * @param {string} opts.seed  Master profile seed (same string a
   *   VentoFingerprintProfile is built from). Required; the phase offsets are
   *   derived from it so two machines with the same seed quantize identically.
   * @param {number} [opts.precisionMs]  Timestamp grid size in milliseconds.
   * @param {number} [opts.coordGridPx]  Coordinate grid size in CSS pixels.
   */
  constructor({ seed, precisionMs, coordGridPx } = {}) {
    if (typeof seed !== "string" || !seed.length) {
      throw new Error(
        "VentoBehavioralQuantizer requires a non-empty string seed"
      );
    }
    this.seed = seed;
    this.precisionMs = positiveOr(precisionMs, DEFAULT_TIMER_PRECISION_MS);
    this.coordGridPx = positiveOr(coordGridPx, DEFAULT_COORD_GRID_PX);

    // Deterministic sub-grid phase offsets in [0, grid). Derived once from the
    // seed so the whole profile shares a stable grid alignment.
    this.timerPhaseMs =
      unitFromSeed(`${seed} behavioral-timer-phase`) * this.precisionMs;
    this.coordPhasePx =
      unitFromSeed(`${seed} behavioral-coord-phase`) * this.coordGridPx;
  }

  /** Build from a VentoFingerprintProfile (or anything with a `.seed`). */
  static fromProfile(profile, opts = {}) {
    return new VentoBehavioralQuantizer({ seed: profile.seed, ...opts });
  }

  /**
   * Quantize an event timestamp (milliseconds, e.g. Event.timeStamp /
   * performance.now()) onto the timer grid. Monotonic non-decreasing in `t`, so
   * event ordering is preserved, while sub-`precisionMs` micro-timing (the
   * keystroke-dynamics signal) is discarded. Idempotent.
   */
  quantizeTimestampMs(t) {
    if (!Number.isFinite(t)) {
      return t;
    }
    const p = this.precisionMs;
    return Math.floor((t - this.timerPhaseMs) / p) * p + this.timerPhaseMs;
  }

  /**
   * Quantize a single coordinate (CSS px, e.g. MouseEvent.screenX/clientX or a
   * movementX delta) onto the coordinate grid. Idempotent.
   */
  quantizeCoord(v) {
    if (!Number.isFinite(v)) {
      return v;
    }
    const g = this.coordGridPx;
    return Math.round((v - this.coordPhasePx) / g) * g + this.coordPhasePx;
  }

  /** Quantize an {x, y} point (both coordinates on the coordinate grid). */
  quantizePoint({ x, y }) {
    return { x: this.quantizeCoord(x), y: this.quantizeCoord(y) };
  }

  /**
   * Quantize a full pointer sample: coordinates on the coordinate grid, the
   * timestamp on the timer grid. This is the shape a widget-level injection
   * point would feed through. Unknown fields are passed through untouched.
   */
  quantizePointerSample(sample) {
    const out = { ...sample };
    for (const key of ["screenX", "screenY", "clientX", "clientY", "x", "y"]) {
      if (key in out) {
        out[key] = this.quantizeCoord(out[key]);
      }
    }
    if ("t" in out) {
      out.t = this.quantizeTimestampMs(out.t);
    }
    if ("timeStamp" in out) {
      out.timeStamp = this.quantizeTimestampMs(out.timeStamp);
    }
    return out;
  }

  /** Serialize the tunables (seed lives in the profile, not duplicated here). */
  export() {
    return { precisionMs: this.precisionMs, coordGridPx: this.coordGridPx };
  }
}

function positiveOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

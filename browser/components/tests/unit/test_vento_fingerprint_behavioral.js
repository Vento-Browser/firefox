/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento behavioral-quantizer tests (section 10, level 1 of
 * FINGERPRINTING_RESEARCH.md).
 *
 * Two things are checked:
 *   - determinism: two independent quantizers built from the same seed ("two
 *     machines") quantize any input byte-for-byte identically, and different
 *     seeds get uncorrelated grid phases;
 *   - the actual mitigation: sub-grid micro-timing and sub-pixel deltas are
 *     destroyed (that is the keystroke-/mouse-dynamics signal), while ordering
 *     and idempotence are preserved.
 */

"use strict";

const { VentoBehavioralQuantizer } = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoBehavioralQuantizer.sys.mjs"
);
const { VentoFingerprintProfile } = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs"
);

const SEED = "shared-vento-seed-2f9c";

function machine(seed, opts) {
  return new VentoBehavioralQuantizer({ seed, ...opts });
}

add_task(function test_empty_seed_rejected() {
  Assert.throws(
    () => new VentoBehavioralQuantizer({ seed: "" }),
    /non-empty string seed/,
    "empty seed is rejected so there is never an undefined-phase quantizer"
  );
});

add_task(function test_timestamps_identical_across_machines() {
  const m1 = machine(SEED);
  const m2 = machine(SEED);
  for (let t = 0; t < 5000; t += 1.3) {
    Assert.equal(
      m1.quantizeTimestampMs(t),
      m2.quantizeTimestampMs(t),
      `timestamp ${t} quantized identically on two machines`
    );
  }
});

add_task(function test_coords_identical_across_machines() {
  const m1 = machine(SEED);
  const m2 = machine(SEED);
  for (let v = -50; v < 2000; v += 0.7) {
    Assert.equal(
      m1.quantizeCoord(v),
      m2.quantizeCoord(v),
      `coord ${v} quantized identically on two machines`
    );
  }
});

add_task(function test_quantization_is_idempotent() {
  const m = machine(SEED);
  for (let t = 0; t < 1000; t += 7.31) {
    const q = m.quantizeTimestampMs(t);
    Assert.equal(
      m.quantizeTimestampMs(q),
      q,
      "timestamp quantization idempotent"
    );
  }
  for (let v = 0; v < 1000; v += 3.14) {
    const q = m.quantizeCoord(v);
    Assert.equal(m.quantizeCoord(q), q, "coord quantization idempotent");
  }
});

add_task(function test_timestamps_are_monotonic() {
  const m = machine(SEED);
  let prev = -Infinity;
  for (let t = 0; t < 5000; t += 0.9) {
    const q = m.quantizeTimestampMs(t);
    Assert.greaterOrEqual(q, prev, "quantized timestamps never go backwards");
    prev = q;
  }
});

add_task(function test_sub_grid_microtiming_is_destroyed() {
  // Two events 0.4ms apart (typical keystroke-dynamics resolution) must collapse
  // to the same quantized timestamp for most phases -> the biometric micro-timing
  // is gone. Over a sweep, the vast majority of neighbouring 0.4ms pairs collapse.
  const m = machine(SEED, { precisionMs: 16 });
  let collapsed = 0;
  let total = 0;
  for (let t = 0; t < 4000; t += 1.0) {
    total++;
    if (m.quantizeTimestampMs(t) === m.quantizeTimestampMs(t + 0.4)) {
      collapsed++;
    }
  }
  Assert.greater(
    collapsed / total,
    0.9,
    "at least 90% of 0.4ms-apart events collapse onto the same grid point"
  );
});

add_task(function test_sub_grid_output_multiples_of_precision() {
  const m = machine(SEED, { precisionMs: 16, coordGridPx: 2 });
  const dt = m.quantizeTimestampMs(1234.567) - m.quantizeTimestampMs(0.0);
  Assert.equal(
    dt % 16,
    0,
    "differences between quantized timestamps are grid multiples"
  );
  const dv = m.quantizeCoord(987.3) - m.quantizeCoord(0.0);
  Assert.equal(
    dv % 2,
    0,
    "differences between quantized coords are grid multiples"
  );
});

add_task(function test_different_seeds_get_different_phase() {
  const a = machine(SEED);
  const b = machine("a-completely-different-seed");
  Assert.notEqual(
    a.timerPhaseMs,
    b.timerPhaseMs,
    "different profiles get uncorrelated timer grid phase"
  );
  Assert.notEqual(
    a.coordPhasePx,
    b.coordPhasePx,
    "different profiles get uncorrelated coord grid phase"
  );
});

add_task(function test_pointer_sample_quantized() {
  const m = machine(SEED);
  const q = m.quantizePointerSample({
    screenX: 101.7,
    screenY: 202.3,
    clientX: 51.4,
    clientY: 61.9,
    timeStamp: 1234.9,
    button: 0,
  });
  Assert.equal(q.screenX, m.quantizeCoord(101.7), "screenX quantized");
  Assert.equal(q.screenY, m.quantizeCoord(202.3), "screenY quantized");
  Assert.equal(q.clientX, m.quantizeCoord(51.4), "clientX quantized");
  Assert.equal(
    q.timeStamp,
    m.quantizeTimestampMs(1234.9),
    "timeStamp quantized"
  );
  Assert.equal(q.button, 0, "unknown fields passed through untouched");
});

add_task(function test_fromProfile_uses_profile_seed() {
  const profile = new VentoFingerprintProfile({ seed: SEED });
  const fromProfile = VentoBehavioralQuantizer.fromProfile(profile);
  const direct = machine(SEED);
  Assert.equal(
    fromProfile.quantizeTimestampMs(777.7),
    direct.quantizeTimestampMs(777.7),
    "fromProfile derives the same phase as building from the raw seed"
  );
});

add_task(function test_nonfinite_passthrough() {
  const m = machine(SEED);
  Assert.ok(
    Number.isNaN(m.quantizeTimestampMs(NaN)),
    "NaN timestamp passes through"
  );
  Assert.equal(
    m.quantizeCoord(Infinity),
    Infinity,
    "Infinity coord passes through"
  );
});

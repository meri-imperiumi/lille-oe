/**
 * Unit tests for the EmptyBilge component. The pump always runs until
 * dry: it stops only after the minimum run time once the pump current
 * (in amps, calibrated by LinearConvert upstream) has stayed below the
 * dry threshold for drytime seconds. A maxruntime failsafe stops the
 * pump even when it never reads dry. The timings are driven with a
 * mocked clock.
 *
 * Current levels follow the real Seaflo 21-series pump: ~0.84 A
 * pumping water, ~0.45 A pumping air.
 *
 * Run from the repo root with NoFlo resolvable, e.g.:
 *
 *   NODE_PATH=<path containing noflo> node --test test/
 */
const test = require('node:test');
const assert = require('node:assert');
const noflo = require('noflo');
const getComponent = require('../components/EmptyBilge.js').getComponent;

/** The component's default minimum run time, in milliseconds */
const MIN_RUN_MS = 120 * 1000;

/** Pumping water, just above the 0.65 A dry threshold */
const WET_A = 0.85;
/** Pumping air, below the default 0.65 A dry threshold */
const DRY_A = 0.45;
/** Just above the default dry threshold */
const NEARLY_DRY_A = 0.75;

/** Observed pumping-water reading: 1.51 V through the sensor calibration */
const WATER_OBSERVED_A = 0.84;
/** Observed near-idle reading: 1.47 V through the sensor calibration */
const NEAR_IDLE_OBSERVED_A = 0.17;

/** Time from trigger to a completed dry stop: min run + 5 s drytime + slack */
const DRY_STOP_MS = MIN_RUN_MS + 6 * 1000;

/**
 * Instantiate the component with a mocked clock and sockets attached.
 *
 * @param {Object} t - node:test context for timer mocking
 * @returns {Object} Component handles for driving a pump cycle
 */
function setup(t) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const c = getComponent();
  const states = [];
  const trigger = noflo.internalSocket.createSocket();
  const current = noflo.internalSocket.createSocket();
  const out = noflo.internalSocket.createSocket();
  const config = {};
  ['minruntime', 'drycurrent', 'drytime', 'maxruntime'].forEach((port) => {
    config[port] = noflo.internalSocket.createSocket();
    c.inPorts[port].attach(config[port]);
  });
  c.inPorts.trigger.attach(trigger);
  c.inPorts.current.attach(current);
  c.outPorts.out.attach(out);
  out.on('data', (value) => states.push(value));

  const send = (socket, value) => {
    socket.send(value);
    socket.disconnect();
  };
  /** Configure tuning via the control ports */
  const configure = (values) => {
    for (const [port, value] of Object.entries(values)) {
      send(config[port], value);
    }
  };
  const tickMs = (ms) => t.mock.timers.tick(ms);
  // Synchronous teardown: the poll interval is a mocked timer discarded
  // with the mock, and awaiting component shutdown would hang while a
  // cycle is still active (EmptyBilge holds activation while pumping)
  const teardown = () => {
    c.clearPollTimer();
    c.running = false;
  };
  return { states, trigger, current, send, configure, tickMs, teardown };
}

test('starts the pump and reports true on trigger', async (t) => {
  const { states, trigger, send, teardown } = setup(t);
  send(trigger, true);
  assert.deepStrictEqual(states, [true]);
  await teardown();
});

test('ignores duplicate triggers while a cycle is running', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  send(trigger, true);
  send(current, DRY_A);
  tickMs(DRY_STOP_MS);
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('keeps running while water is flowing past the minimum run time', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  send(current, WET_A);
  tickMs(MIN_RUN_MS * 2);
  assert.deepStrictEqual(states, [true]);
  await teardown();
});

test('stops after the current has read dry for the dry time', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  send(current, DRY_A);
  tickMs(DRY_STOP_MS);
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('debounces a brief dry reading into the wet phase', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  send(current, WET_A);
  tickMs(MIN_RUN_MS);
  // End-of-cycle slug flow: dips dry briefly, then wet again
  send(current, DRY_A);
  tickMs(3 * 1000);
  send(current, WET_A);
  tickMs(3 * 1000);
  assert.deepStrictEqual(states, [true], 'brief dry dip must not stop the pump');
  // Steady dry reading still stops it
  send(current, DRY_A);
  tickMs(DRY_STOP_MS);
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('does not stop while the current is just above the dry threshold', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  send(current, NEARLY_DRY_A);
  tickMs(DRY_STOP_MS);
  assert.deepStrictEqual(states, [true], 'still pumping water');
  send(current, DRY_A);
  tickMs(6 * 1000);
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('keeps running when no current reading is available', async (t) => {
  const { states, trigger, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  tickMs(MIN_RUN_MS * 2);
  assert.deepStrictEqual(states, [true]);
  await teardown();
});

test('force-stops at the max runtime even while reading wet', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  send(current, WET_A);
  tickMs(600 * 1000 + 2000);
  assert.deepStrictEqual(states, [true, false], 'maxruntime failsafe');
  await teardown();
});

test('maxruntime can be disabled with zero', async (t) => {
  const { states, trigger, current, send, configure, tickMs, teardown } = setup(t);
  configure({ maxruntime: 0 });
  send(trigger, true);
  send(current, WET_A);
  tickMs(700 * 1000);
  assert.deepStrictEqual(states, [true]);
  await teardown();
});

test('runs a new cycle after the previous one completed', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  send(current, DRY_A);
  tickMs(DRY_STOP_MS);
  assert.deepStrictEqual(states, [true, false]);

  send(trigger, true);
  assert.deepStrictEqual(states, [true, false, true]);
  send(current, DRY_A);
  tickMs(DRY_STOP_MS);
  assert.deepStrictEqual(states, [true, false, true, false]);
  await teardown();
});

test('honors a custom minimum runtime', async (t) => {
  const { states, trigger, current, send, configure, tickMs, teardown } = setup(t);
  configure({ minruntime: 2 });
  send(trigger, true);
  send(current, DRY_A);
  // With the 120s default the pump would still be running here; the
  // default 5s drytime also has to elapse after the 2s minimum
  tickMs(9 * 1000);
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('honors a custom dry time', async (t) => {
  const { states, trigger, current, send, configure, tickMs, teardown } = setup(t);
  configure({ minruntime: 2, drytime: 1 });
  send(trigger, true);
  send(current, DRY_A);
  tickMs(4 * 1000);
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('honors a custom dry current threshold', async (t) => {
  const { states, trigger, current, send, configure, tickMs, teardown } = setup(t);
  configure({ drycurrent: 0.2 });
  send(trigger, true);
  // 0.45 A: dry under the default 0.65 A threshold, wet under 0.2 A
  send(current, DRY_A);
  tickMs(DRY_STOP_MS);
  assert.deepStrictEqual(states, [true], 'above the custom threshold');
  // 0.15 A: now below the custom threshold
  send(current, 0.15);
  tickMs(6 * 1000);
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('guardrail: the observed water draw keeps the pump running', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  // 1.51 V through the sensor calibration: regression for the 1.50 V
  // premature stop during the daily 14:00 run
  send(current, WATER_OBSERVED_A);
  tickMs(DRY_STOP_MS);
  assert.deepStrictEqual(states, [true]);
  await teardown();
});

test('guardrail: the observed near-idle draw stops the pump', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  // 1.47 V through the sensor calibration
  send(current, NEAR_IDLE_OBSERVED_A);
  tickMs(DRY_STOP_MS);
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('unusable tuning values fall back to defaults', async (t) => {
  const { states, trigger, current, send, configure, tickMs, teardown } = setup(t);
  configure({
    minruntime: 'garbage',
    drycurrent: 'garbage',
    drytime: null,
    maxruntime: undefined,
  });
  send(trigger, true);
  send(current, DRY_A);
  tickMs(DRY_STOP_MS);
  assert.deepStrictEqual(
    states,
    [true, false],
    '120s, 0.65 A and 5s defaults apply',
  );
  await teardown();
});

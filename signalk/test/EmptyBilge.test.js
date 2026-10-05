/**
 * Unit tests for the EmptyBilge component. The pump always runs until
 * dry: it stops only after the minimum run time once the current sensor
 * voltage indicates it is pumping air. The 30s minimum run and 1s stop
 * polling are driven with a mocked clock.
 *
 * Run from the repo root with NoFlo resolvable, e.g.:
 *
 *   NODE_PATH=<path containing noflo> node --test test/
 */
const test = require('node:test');
const assert = require('node:assert');
const noflo = require('noflo');
const getComponent = require('../components/EmptyBilge.js').getComponent;

/** Same conversion constants as the component */
const CURRENT_OFFSET_V = 1.48;
const CURRENT_SCALE_V_PER_A = 0.0596;

/** The component's default minimum run time, in milliseconds */
const MIN_RUN_MS = 120 * 1000;

/** ~8.7 A: pumping water */
const WET_V = 2.0;
/** ~0.34 A: pumping air, well below the default 0.8 A dry threshold */
const DRY_V = 1.5;
/** ~0.9 A: still above the default dry threshold */
const NEARLY_DRY_V = CURRENT_OFFSET_V + 0.9 * CURRENT_SCALE_V_PER_A;

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
  ['minruntime', 'drycurrent', 'currentoffset', 'currentscale'].forEach(
    (port) => {
      config[port] = noflo.internalSocket.createSocket();
      c.inPorts[port].attach(config[port]);
    },
  );
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
  send(current, DRY_V);
  tickMs(MIN_RUN_MS + 2000);
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('keeps running while water is flowing past the minimum run time', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  send(current, WET_V);
  tickMs(MIN_RUN_MS * 2);
  assert.deepStrictEqual(states, [true]);
  await teardown();
});

test('stops once the voltage reads dry after the minimum run time', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  send(current, DRY_V);
  tickMs(MIN_RUN_MS + 2000);
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('does not stop while the current is just above the dry threshold', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  send(current, NEARLY_DRY_V);
  tickMs(MIN_RUN_MS + 2000);
  assert.deepStrictEqual(states, [true], 'still pumping water');
  send(current, DRY_V);
  tickMs(2000);
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

test('runs a new cycle after the previous one completed', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  send(current, DRY_V);
  tickMs(MIN_RUN_MS + 2000);
  assert.deepStrictEqual(states, [true, false]);

  send(trigger, true);
  assert.deepStrictEqual(states, [true, false, true]);
  send(current, DRY_V);
  tickMs(MIN_RUN_MS + 2000);
  assert.deepStrictEqual(states, [true, false, true, false]);
  await teardown();
});

test('stops on the next poll tick after the minimum run time has passed', async (t) => {
  const { states, trigger, current, send, tickMs, teardown } = setup(t);
  send(trigger, true);
  send(current, WET_V);
  tickMs(MIN_RUN_MS + 500); // min time reached while still wet
  send(current, DRY_V);
  tickMs(2000); // next poll sees dry
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('honors a custom minimum runtime', async (t) => {
  const { states, trigger, current, send, configure, tickMs, teardown } = setup(t);
  configure({ minruntime: 2 });
  send(trigger, true);
  send(current, DRY_V);
  // With the 30s default the pump would still be running here
  tickMs(3000);
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('honors a custom dry current threshold', async (t) => {
  const { states, trigger, current, send, configure, tickMs, teardown } = setup(t);
  configure({ drycurrent: 0.2 });
  send(trigger, true);
  // ~0.34 A: dry under the default 0.8 A threshold, wet under 0.2 A
  send(current, DRY_V);
  tickMs(MIN_RUN_MS + 2000);
  assert.deepStrictEqual(states, [true], 'above the custom threshold');
  // ~0.17 A: now below the custom threshold
  send(current, 1.49);
  tickMs(2000);
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('honors custom sensor calibration', async (t) => {
  const { states, trigger, current, send, configure, tickMs, teardown } = setup(t);
  // Custom calibration: 1.55 V reads as (1.55 - 1.5) / 0.1 = 0.5 A, dry.
  // With the default calibration it would read ~1.17 A and keep running.
  configure({ currentoffset: 1.5, currentscale: 0.1, minruntime: 1 });
  send(trigger, true);
  send(current, 1.55);
  tickMs(2000);
  assert.deepStrictEqual(states, [true, false]);
  await teardown();
});

test('unusable tuning values fall back to defaults', async (t) => {
  const { states, trigger, current, send, configure, tickMs, teardown } = setup(t);
  configure({ minruntime: 'garbage', drycurrent: 'garbage' });
  send(trigger, true);
  send(current, DRY_V);
  tickMs(MIN_RUN_MS + 2000);
  assert.deepStrictEqual(states, [true, false], '30s default and 0.8 A default apply');
  await teardown();
});

/**
 * Unit tests for the RunDailyAt component.
 *
 * Run from the repo root with NoFlo resolvable, e.g.:
 *
 *   NODE_PATH=<path containing noflo> node --test test/
 */
const test = require('node:test');
const assert = require('node:assert');
const noflo = require('noflo');
const getComponent = require('../components/RunDailyAt.js').getComponent;

/**
 * Instantiate the component with sockets attached to all ports and
 * outport listeners recording into fired/errors arrays.
 *
 * @returns {Object} Sockets plus fired/errors capture arrays
 */
function setup() {
  const c = getComponent();
  const sockets = {};
  const fired = [];
  const errors = [];
  ['datetime', 'timezone', 'time'].forEach((port) => {
    sockets[port] = noflo.internalSocket.createSocket();
    c.inPorts[port].attach(sockets[port]);
  });
  ['out', 'error'].forEach((port) => {
    sockets[port] = noflo.internalSocket.createSocket();
    c.outPorts[port].attach(sockets[port]);
  });
  sockets.out.on('data', (data) => fired.push(data));
  sockets.error.on('data', (data) => errors.push(data));

  /**
   * Run one datetime update. Control values of null leave the port at
   * whatever it holds (or its default if never sent).
   */
  const tick = (datetime, timezone = null, time = null) => {
    if (timezone !== null) {
      sockets.timezone.send(timezone);
      sockets.timezone.disconnect();
    }
    if (time !== null) {
      sockets.time.send(time);
      sockets.time.disconnect();
    }
    sockets.datetime.send(datetime);
    sockets.datetime.disconnect();
  };
  return { fired, errors, tick };
}

test('does not fire before the configured local time', () => {
  const { fired, errors, tick } = setup();
  tick('2025-11-07T11:30:00Z', 200, '14:00'); // 13:30 local
  assert.deepStrictEqual(fired, []);
  assert.deepStrictEqual(errors, []);
});

test('fires with true at the configured local time', () => {
  const { fired, errors, tick } = setup();
  tick('2025-11-07T12:00:00Z', 200, '14:00'); // 14:00 local
  assert.deepStrictEqual(fired, [true]);
  assert.deepStrictEqual(errors, []);
});

test('fires only once per local day', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T12:00:00Z', 200, '14:00');
  tick('2025-11-07T12:05:00Z', 200, '14:00');
  assert.deepStrictEqual(fired, [true]);
});

test('fires again on the next local day', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T12:00:00Z', 200, '14:00');
  tick('2025-11-08T12:00:00Z', 200, '14:00');
  assert.deepStrictEqual(fired, [true, true]);
});

test('minute boundary: no fire at 13:58 local, fires at 13:59', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T11:58:00Z', 200, '13:59'); // 13:58 local
  tick('2025-11-07T11:59:00Z', 200, '13:59'); // 13:59 local
  assert.deepStrictEqual(fired, [true]);
});

test('offset with minutes component: 930 is 15:30 hours ahead', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T04:30:00Z', 930, '14:00'); // 14:00 local (UTC+9:30)
  tick('2025-11-07T04:00:00Z', 930, '14:00'); // 13:30 local
  assert.deepStrictEqual(fired, [true]);
});

test('explicit zero offset fires at 14:00 UTC', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T14:00:00Z', 0, '14:00');
  assert.deepStrictEqual(fired, [true]);
});

test('falls back to defaults when control ports get no data', () => {
  const { fired, errors, tick } = setup();
  tick('2025-11-07T14:00:00Z'); // 14:00 UTC, default offset 0, time 14:00
  assert.deepStrictEqual(fired, [true]);
  assert.deepStrictEqual(errors, []);
});

test('honors a custom configured time', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T01:00:00Z', 0, '02:30');
  assert.deepStrictEqual(fired, []);
  tick('2025-11-07T02:30:00Z', 0, '02:30');
  assert.deepStrictEqual(fired, [true]);
});

test('negative offset: fires once even when the local day spans two UTC days', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T23:30:00Z', -930, '14:00'); // 14:00 local Nov 7
  tick('2025-11-08T00:30:00Z', -930, '14:00'); // 15:00 local Nov 7: same day
  assert.deepStrictEqual(fired, [true]);
});

test('positive offset: local day starts before the UTC day', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T12:00:00Z', 200, '14:00'); // fires on local day Nov 7
  tick('2025-11-07T23:30:00Z', 200, '14:00'); // 01:30 local Nov 8: too early
  tick('2025-11-08T12:00:00Z', 200, '14:00'); // 14:00 local Nov 8: fires
  assert.deepStrictEqual(fired, [true, true]);
});

test('timezone change within the same local date does not re-fire', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T12:00:00Z', 200, '14:00'); // 14:00 local, fires
  tick('2025-11-07T12:30:00Z', 300, '14:00'); // offset +3h: 15:30 same date
  assert.deepStrictEqual(fired, [true]);
});

test('catches up when the first update arrives after the target time', () => {
  const { fired, errors, tick } = setup();
  tick('2025-11-07T18:00:00Z', 200, '14:00'); // 20:00 local on first tick
  assert.deepStrictEqual(fired, [true]);
  assert.deepStrictEqual(errors, []);
});

test('invalid datetime goes to error without firing', () => {
  const { fired, errors, tick } = setup();
  tick('not-a-date', 0, '14:00');
  assert.deepStrictEqual(fired, []);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /Invalid datetime/);
});

test('empty datetime goes to error without firing', () => {
  const { fired, errors, tick } = setup();
  tick('', 0, '14:00');
  assert.deepStrictEqual(fired, []);
  assert.strictEqual(errors.length, 1);
});

test('invalid time configuration goes to error without firing', () => {
  const { fired, errors, tick } = setup();
  tick('2025-11-07T12:00:00Z', 0, '25:99');
  assert.deepStrictEqual(fired, []);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /Invalid time configuration/);
});

test('subsequent valid updates recover after an error', () => {
  const { fired, errors, tick } = setup();
  tick('garbage', 0, '14:00');
  tick('2025-11-07T12:00:00Z', 200, '14:00');
  assert.deepStrictEqual(errors.length, 1);
  assert.deepStrictEqual(fired, [true]);
});

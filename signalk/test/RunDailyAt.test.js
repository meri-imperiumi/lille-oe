/**
 * Unit tests for the RunDailyAt component. The trigger fires when an
 * onboard update crosses the configured local time: the previous update
 * was before it and the current one is at or after it. There is
 * deliberately no catch-up: starting after the configured time does not
 * fire until the next occurrence.
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

test('fires when onboard time crosses the configured local time', () => {
  const { fired, errors, tick } = setup();
  tick('2025-11-07T11:59:00Z', 200, '14:00'); // 13:59 local
  tick('2025-11-07T12:00:00Z', 200, '14:00'); // 14:00 local
  assert.deepStrictEqual(fired, [true]);
  assert.deepStrictEqual(errors, []);
});

test('fires only once per local day', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T11:59:00Z', 200, '14:00');
  tick('2025-11-07T12:00:00Z', 200, '14:00'); // fires
  tick('2025-11-07T12:05:00Z', 200, '14:00');
  tick('2025-11-07T18:00:00Z', 200, '14:00');
  assert.deepStrictEqual(fired, [true]);
});

test('fires again on the next local day when the time is crossed', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T11:59:00Z', 200, '14:00');
  tick('2025-11-07T12:00:00Z', 200, '14:00'); // day 1: fires
  tick('2025-11-08T11:59:00Z', 200, '14:00'); // day 2 before target
  tick('2025-11-08T12:00:00Z', 200, '14:00'); // day 2: fires
  assert.deepStrictEqual(fired, [true, true]);
});

test('minute boundary: no crossing at 13:58, fires at 13:59', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T11:58:00Z', 200, '13:59'); // 13:58 local
  tick('2025-11-07T11:59:00Z', 200, '13:59'); // 13:59 local
  assert.deepStrictEqual(fired, [true]);
});

test('offset with minutes component: 930 is 15:30 hours ahead', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T04:00:00Z', 930, '14:00'); // 13:30 local (UTC+9:30)
  tick('2025-11-07T04:30:00Z', 930, '14:00'); // 14:00 local
  assert.deepStrictEqual(fired, [true]);
});

test('explicit zero offset fires when crossing 14:00 UTC', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T13:00:00Z', 0, '14:00');
  tick('2025-11-07T14:00:00Z', 0, '14:00');
  assert.deepStrictEqual(fired, [true]);
});

test('falls back to the default time when the time port gets no data', () => {
  const { fired, errors, tick } = setup();
  tick('2025-11-07T13:00:00Z', 0); // 13:00 UTC, default time 14:00
  tick('2025-11-07T14:00:00Z', 0);
  assert.deepStrictEqual(fired, [true]);
  assert.deepStrictEqual(errors, []);
});

test('honors a custom configured time', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T01:00:00Z', 0, '02:30');
  tick('2025-11-07T02:30:00Z', 0, '02:30');
  assert.deepStrictEqual(fired, [true]);
});

test('negative offset: crossing observed within one UTC day', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T23:29:00Z', -930, '14:00'); // 13:59 local
  tick('2025-11-07T23:30:00Z', -930, '14:00'); // 14:00 local
  tick('2025-11-08T00:30:00Z', -930, '14:00'); // 15:00 local: same day
  assert.deepStrictEqual(fired, [true]);
});

test('positive offset: local day starts before the UTC day', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T11:59:00Z', 200, '14:00'); // 13:59 local Nov 7
  tick('2025-11-07T12:00:00Z', 200, '14:00'); // 14:00 local Nov 7: fires
  tick('2025-11-07T23:30:00Z', 200, '14:00'); // 01:30 local Nov 8
  tick('2025-11-08T00:30:00Z', 200, '14:00'); // 02:30 local Nov 8
  tick('2025-11-08T12:00:00Z', 200, '14:00'); // 14:00 local Nov 8: fires
  assert.deepStrictEqual(fired, [true, true]);
});

test('timezone change within the same local date does not refire', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T11:59:00Z', 200, '14:00'); // 13:59 local
  tick('2025-11-07T12:00:00Z', 200, '14:00'); // 14:00 local: fires
  tick('2025-11-07T12:30:00Z', 300, '14:00'); // offset +3h: 15:30 local
  assert.deepStrictEqual(fired, [true]);
});

test('does not catch up when started after the target time', () => {
  const { fired, errors, tick } = setup();
  // Fresh instance: first update already past 14:00 local
  tick('2025-11-07T16:00:00Z', 200, '14:00'); // 18:00 local
  tick('2025-11-07T16:01:00Z', 200, '14:00');
  assert.deepStrictEqual(fired, []);
  assert.deepStrictEqual(errors, []);
});

test('does not evaluate until a timezone offset has been received', () => {
  const { fired, errors, tick } = setup();
  // 22:00 UTC: in UTC this is past 14:00 and would misfire
  tick('2025-11-07T22:00:00Z');
  tick('2025-11-07T22:01:00Z');
  assert.deepStrictEqual(fired, []);
  assert.deepStrictEqual(errors, []);
});

test('start-up race regression: UTC+13 incident', () => {
  // 2026-01-14 22:00 UTC = 2026-01-15 11:00 local at UTC+13: a datetime
  // update evaluated with the default offset 0 read 22:00 as local and
  // misfired the daily trigger at graph start-up
  const { fired, errors, tick } = setup();
  tick('2026-01-14T22:00:00Z'); // timezone not received yet
  tick('2026-01-14T22:01:00Z', 1300); // now 11:01 local Jan 15
  tick('2026-01-14T22:02:00Z', 1300);
  assert.deepStrictEqual(fired, []);
  assert.deepStrictEqual(errors, []);
});

test('derived timezone of 0 before GPS fix does not misfire', () => {
  // At server start the timezone offset can be a real but wrong 0;
  // 22:00 UTC then read as 22:00 local and fired the catch-up
  const { fired, tick } = setup();
  tick('2026-01-14T22:00:00Z', 0); // wrong offset, reads 22:00 local
  tick('2026-01-14T22:01:00Z', 0);
  tick('2026-01-14T23:00:00Z', 1300); // offset corrects: 12:00 local
  assert.deepStrictEqual(fired, []);
});

test('evaluates normally once the timezone offset arrives', () => {
  const { fired, tick } = setup();
  tick('2025-11-07T11:00:00Z'); // no timezone yet: consumed, skipped
  tick('2025-11-07T11:30:00Z', 200); // 13:30 local
  tick('2025-11-07T11:59:00Z', 200, '14:00'); // 13:59 local
  tick('2025-11-07T12:00:00Z', 200, '14:00'); // 14:00 local: fires
  assert.deepStrictEqual(fired, [true]);
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
  tick('2025-11-07T11:59:00Z', 200, '14:00'); // 13:59 local
  tick('2025-11-07T12:00:00Z', 200, '14:00'); // 14:00 local: fires
  assert.deepStrictEqual(errors.length, 1);
  assert.deepStrictEqual(fired, [true]);
});

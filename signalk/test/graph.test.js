/**
 * Wiring tests for the bilge pump automation in graphs/main.json.
 *
 * Asserts that the daily timer and the bilge alarm trigger are wired to
 * EmptyBilge, that EmptyBilge PUTs the pump switch state, and that the
 * alarm stream can only ever start the pump (never gate stopping).
 *
 * Run from the repo root:
 *
 *   node --test test/
 */
const test = require('node:test');
const assert = require('node:assert');

const graph = require('../graphs/main.json');

/** Connection endpoints as "process.port" strings */
function endpoints(conn) {
  const result = {};
  for (const key of ['src', 'tgt']) {
    if (conn[key]) {
      result[key] = `${conn[key].process}.${conn[key].port}`;
    }
  }
  return result;
}

const processes = graph.processes;
const conns = graph.connections.map((c) => {
  const e = endpoints(c);
  return { data: c.data, src: e.src || null, tgt: e.tgt || null };
});

/** Find connections matching the given endpoints/data */
function findConn(match) {
  return conns.filter((c) => {
    if (match.src && c.src !== match.src) return false;
    if (match.tgt && c.tgt !== match.tgt) return false;
    if (match.data !== undefined && c.data !== match.data) return false;
    return true;
  });
}

/** Index of a data connection, for order-sensitive assertions */
function connIndex(src, port) {
  return graph.connections.findIndex(
    (c) => c.src && c.src.process === src && c.tgt.port === port,
  );
}

test('bilge nodes exist with the expected components', () => {
  const expected = {
    ListenDatetime: 'signalk/GetSelfStream',
    ListenTimezone: 'signalk/GetSelfStream',
    RunDailyAt: 'signalk-server-config/RunDailyAt',
    ListenBilgeAlarm: 'signalk/GetSelfStream',
    DetectBilgeAlarm: 'signalk/DetectChange',
    InvertBilgeAlarm: 'signalk/InvertBoolean',
    BilgeAlarmGate: 'signalk/And',
    EmptyBilge: 'signalk-server-config/EmptyBilge',
    ListenBilgeCurrent: 'signalk/GetSelfStream',
    ConvertBilgeCurrent: 'signalk-server-config/LinearConvert',
    PublishBilgeCurrent: 'signalk/SendPut',
    SwitchBilgePump: 'signalk/SendPut',
  };
  for (const [node, component] of Object.entries(expected)) {
    assert.strictEqual(
      processes[node] && processes[node].component,
      component,
      `node ${node}`,
    );
  }
});

test('Signal K paths are subscribed via listen-path IIPs', () => {
  const pathIips = {
    'navigation.datetime': 'ListenDatetime.in',
    'environment.time.timezoneOffset': 'ListenTimezone.in',
    'electrical.venus-input.1.inputState': 'ListenBilgeAlarm.in',
    'electrical.switches.bilgeCurrentSensor.voltage0': 'ListenBilgeCurrent.in',
    'electrical.switches.bilgeCurrentSensor.current0': 'PublishBilgeCurrent.path',
    'electrical.switches.gx.gxInternalRelay1.state': 'SwitchBilgePump.path',
  };
  for (const [path, tgt] of Object.entries(pathIips)) {
    assert.strictEqual(findConn({ data: path, tgt }).length, 1, `IIP ${path}`);
  }
});

test('daily timer is configured for 14:00 and feeds EmptyBilge', () => {
  assert.strictEqual(findConn({ data: '14:00', tgt: 'RunDailyAt.time' }).length, 1);
  assert.strictEqual(findConn({ src: 'ListenDatetime.out', tgt: 'RunDailyAt.datetime' }).length, 1);
  assert.strictEqual(findConn({ src: 'ListenTimezone.out', tgt: 'RunDailyAt.timezone' }).length, 1);
  assert.strictEqual(findConn({ src: 'RunDailyAt.out', tgt: 'EmptyBilge.trigger' }).length, 1);
});

test('alarm transition chain triggers EmptyBilge', () => {
  assert.strictEqual(findConn({ src: 'ListenBilgeAlarm.out', tgt: 'DetectBilgeAlarm.in' }).length, 1);
  assert.strictEqual(findConn({ src: 'DetectBilgeAlarm.out', tgt: 'InvertBilgeAlarm.in' }).length, 1);
  assert.strictEqual(findConn({ src: 'InvertBilgeAlarm.out', tgt: 'BilgeAlarmGate.in' }).length, 1);
  assert.strictEqual(findConn({ src: 'InvertBilgeAlarm.out', tgt: 'BilgeAlarmGate.values' }).length, 1);
  assert.strictEqual(findConn({ src: 'BilgeAlarmGate.pass', tgt: 'EmptyBilge.trigger' }).length, 1);
});

test('BilgeAlarmGate.values is wired before BilgeAlarmGate.in', () => {
  // And evaluates values synchronously when in fires, so the values edge
  // must connect first (same order the existing And gates use)
  const valuesIdx = connIndex('InvertBilgeAlarm', 'values');
  const inIdx = connIndex('InvertBilgeAlarm', 'in');
  assert.notStrictEqual(valuesIdx, -1, 'values edge exists');
  assert.notStrictEqual(inIdx, -1, 'in edge exists');
  assert.ok(valuesIdx < inIdx, 'values edge precedes in edge');
});

test('pump always runs until dry: alarm stream never gates stopping', () => {
  assert.strictEqual(
    findConn({ tgt: 'EmptyBilge.alarmstate' }).length,
    0,
    'alarm stream must not feed the stop conditions',
  );
  assert.strictEqual(
    findConn({ src: 'ConvertBilgeCurrent.out', tgt: 'EmptyBilge.current' }).length,
    1,
  );
});

test('pump state is PUT to the pump switch path', () => {
  assert.strictEqual(findConn({ src: 'EmptyBilge.out', tgt: 'SwitchBilgePump.value' }).length, 1);
  assert.strictEqual(
    findConn({ data: 'electrical.switches.gx.gxInternalRelay1.state', tgt: 'SwitchBilgePump.path' }).length,
    1,
  );
});

test('pump tuning is pinned via IIPs', () => {
  const tuningIips = {
    120: 'EmptyBilge.minruntime',
    0.65: 'EmptyBilge.drycurrent',
    5: 'EmptyBilge.drytime',
    600: 'EmptyBilge.maxruntime',
  };
  for (const [value, tgt] of Object.entries(tuningIips)) {
    assert.strictEqual(
      findConn({ data: Number(value), tgt }).length,
      1,
      `IIP ${value} -> ${tgt}`,
    );
  }
});

test('bilge current reading is derived from the sensor voltage', () => {
  // The voltage listener feeds the linear calibration, whose output
  // feeds both the pump controller and the current0 publication: the
  // calibration exists in exactly one place
  assert.strictEqual(
    findConn({ src: 'ListenBilgeCurrent.out', tgt: 'ConvertBilgeCurrent.in' }).length,
    1,
  );
  assert.strictEqual(
    findConn({ src: 'ConvertBilgeCurrent.out', tgt: 'EmptyBilge.current' }).length,
    1,
  );
  assert.strictEqual(
    findConn({ src: 'ConvertBilgeCurrent.out', tgt: 'PublishBilgeCurrent.value' }).length,
    1,
  );
  assert.strictEqual(
    findConn({ src: 'ListenBilgeCurrent.out', tgt: 'EmptyBilge.current' }).length,
    0,
    'EmptyBilge must not consume raw volts',
  );

  // The only calibration IIPs in the graph
  const calibrationIips = {
    1.46: 'ConvertBilgeCurrent.offset',
    0.0596: 'ConvertBilgeCurrent.scale',
  };
  for (const [value, tgt] of Object.entries(calibrationIips)) {
    assert.strictEqual(
      findConn({ data: Number(value), tgt }).length,
      1,
      `IIP ${value} -> ${tgt}`,
    );
  }
});

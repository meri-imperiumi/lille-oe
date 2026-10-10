/**
 * Integration tests for the bilge pump automation, using the same wiring
 * as graphs/main.json minus the Signal K readers/writers:
 *
 * - signalk/GetSelfStream is replaced by test/Feed, which streams values
 *   injected by the test. GetSelfStream emits the current path value once
 *   at startup before streaming, so tests feed that initial value
 *   explicitly where it matters (bilge alarm into DetectChange).
 * - signalk/SendPut is replaced by test/CapturePut, which records the
 *   PUT requests that would be sent to the Signal K API.
 *
 * Everything else (RunDailyAt, EmptyBilge, LinearConvert, DetectChange,
 * InvertBoolean, And, the edge layout including BilgeAlarmGate
 * values-before-in) is the real graph wiring. EmptyBilge's 120s minimum
 * run, 5s dry time and 1s stop polling are driven with a mocked clock.
 *
 * Run from the repo root with NoFlo and noflo-signalk resolvable, e.g.:
 *
 *   NODE_PATH=<paths with noflo and noflo-signalk> node --test test/
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const noflo = require('noflo');

const signalKComponent = (name) => require(`noflo-signalk/components/${name}`);

/** Observed sensor voltage while pumping water (stable in Grafana) */
const WET_V = 1.51;
/** Observed near-idle sensor voltage, i.e. pump off or nearly off */
const DRY_V = 1.47;
/** PUT target path of the pump switch, from graphs/main.json */
const PUMP_PATH = 'electrical.switches.gx.gxInternalRelay1.state';
/** PUT target path of the calibrated pump current, from graphs/main.json */
const CURRENT_PATH = 'electrical.switches.bilgeCurrentSensor.current0';
/** Same sensor calibration as graphs/main.json pins via IIPs */
const CURRENT_OFFSET_V = 1.46;
const CURRENT_SCALE_V_PER_A = 0.0596;

/**
 * Build and start a network with the bilge wiring of graphs/main.json.
 *
 * @param {Object} [tuning] - IIP values for EmptyBilge tuning ports
 * @returns {Promise<Object>} Network, value feed sockets, and the pumpPuts
 *   and currentPuts arrays collecting the PUT requests captured by
 *   test/CapturePut and test/CaptureCurrentPut
 */
async function buildNetwork(tuning = {}) {
  const pumpPuts = [];
  const currentPuts = [];
  const graph = new noflo.Graph('BilgeIntegration');
  graph.addNode('feedDatetime', 'test/Feed');
  graph.addNode('feedTimezone', 'test/Feed');
  graph.addNode('feedAlarm', 'test/Feed');
  graph.addNode('feedCurrent', 'test/Feed');
  graph.addNode('convert', 'signalk-server-config/LinearConvert');
  graph.addNode('timer', 'signalk-server-config/RunDailyAt');
  graph.addNode('detect', 'signalk/DetectChange');
  graph.addNode('invert', 'signalk/InvertBoolean');
  graph.addNode('gate', 'signalk/And');
  graph.addNode('emptybilge', 'signalk-server-config/EmptyBilge');
  graph.addNode('put', 'test/CapturePut');
  graph.addNode('putCurrent', 'test/CaptureCurrentPut');
  // Same edges as graphs/main.json (gate values edge before in edge)
  graph.addEdge('feedDatetime', 'out', 'timer', 'datetime');
  graph.addEdge('feedTimezone', 'out', 'timer', 'timezone');
  graph.addEdge('timer', 'out', 'emptybilge', 'trigger');
  graph.addEdge('feedAlarm', 'out', 'detect', 'in');
  graph.addEdge('detect', 'out', 'invert', 'in');
  graph.addEdge('invert', 'out', 'gate', 'values');
  graph.addEdge('invert', 'out', 'gate', 'in');
  graph.addEdge('gate', 'pass', 'emptybilge', 'trigger');
  graph.addEdge('feedAlarm', 'out', 'emptybilge', 'alarmstate');
  graph.addEdge('feedCurrent', 'out', 'convert', 'in');
  graph.addEdge('convert', 'out', 'emptybilge', 'current');
  graph.addEdge('convert', 'out', 'putCurrent', 'value');
  graph.addEdge('emptybilge', 'out', 'put', 'value');
  // Same IIPs as graphs/main.json
  graph.addInitial('14:00', 'timer', 'time');
  graph.addInitial(PUMP_PATH, 'put', 'path');
  graph.addInitial(CURRENT_PATH, 'putCurrent', 'path');
  graph.addInitial(
    tuning.minruntime === undefined ? 120 : tuning.minruntime,
    'emptybilge',
    'minruntime',
  );
  graph.addInitial(
    tuning.drycurrent === undefined ? 0.75 : tuning.drycurrent,
    'emptybilge',
    'drycurrent',
  );
  graph.addInitial(CURRENT_OFFSET_V, 'convert', 'offset');
  graph.addInitial(CURRENT_SCALE_V_PER_A, 'convert', 'scale');

  const loader = new noflo.ComponentLoader(os.tmpdir());
  await loader.listComponents();
  loader.registerComponent('signalk', 'DetectChange', signalKComponent('DetectChange'));
  loader.registerComponent('signalk', 'InvertBoolean', signalKComponent('InvertBoolean'));
  loader.registerComponent('signalk', 'And', signalKComponent('And'));
  loader.registerComponent(
    'signalk-server-config',
    'RunDailyAt',
    require('../components/RunDailyAt.js'),
  );
  loader.registerComponent(
    'signalk-server-config',
    'EmptyBilge',
    require('../components/EmptyBilge.js'),
  );
  loader.registerComponent(
    'signalk-server-config',
    'LinearConvert',
    require('../components/LinearConvert.js'),
  );
  loader.registerComponent('test', 'Feed', {
    getComponent: () => {
      const c = new noflo.Component();
      c.description = 'Streams test-injected values (GetSelfStream stand-in)';
      c.inPorts.add('in', { datatype: 'all' });
      c.outPorts.add('out', { datatype: 'all' });
      c.process((input, output) => {
        if (!input.hasData('in')) {
          return;
        }
        output.sendDone({ out: input.getData('in') });
      });
      return c;
    },
  });
  const capturePut = (records) => ({
    getComponent: () => {
      const c = new noflo.Component();
      c.description = 'Records PUT requests (SendPut stand-in)';
      c.inPorts.add('path', { datatype: 'string', control: true });
      c.inPorts.add('value', { datatype: 'all' });
      c.process((input, output) => {
        if (!input.hasData('value')) {
          return;
        }
        const value = input.getData('value');
        const path = input.hasData('path') ? input.getData('path') : null;
        records.push({ path, value });
        output.done();
      });
      return c;
    },
  });
  loader.registerComponent('test', 'CapturePut', capturePut(pumpPuts));
  loader.registerComponent('test', 'CaptureCurrentPut', capturePut(currentPuts));

  const network = await noflo.createNetwork(graph, {
    baseDir: os.tmpdir(),
    componentLoader: loader,
    delay: true,
  });
  await network.connect();
  await network.start();

  const feed = (nodeName) => {
    const socket = noflo.internalSocket.createSocket();
    network.getNode(nodeName).component.inPorts.in.attach(socket);
    return (value) => {
      socket.send(value);
      socket.disconnect();
    };
  };
  return { network, feed, pumpPuts, currentPuts };
}

test('daily timer starts a pump cycle at 14:00 local and runs it until dry', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, pumpPuts } = await buildNetwork();

  feed('feedTimezone')(200);
  feed('feedDatetime')('2025-11-07T11:30:00Z'); // 13:30 local: not yet
  assert.deepStrictEqual(pumpPuts, [], 'no PUT before 14:00 local');

  feed('feedDatetime')('2025-11-07T11:59:00Z'); // 13:59 local: still before
  feed('feedDatetime')('2025-11-07T12:00:00Z'); // 14:00 local: crossing fires
  assert.deepStrictEqual(pumpPuts, [{ path: PUMP_PATH, value: true }]);

  // Pumping water: stays running past the 30s minimum
  feed('feedCurrent')(WET_V);
  t.mock.timers.tick(121000);
  assert.deepStrictEqual(pumpPuts, [{ path: PUMP_PATH, value: true }]);

  // Running dry: pump stops after the 5s dry time
  feed('feedCurrent')(DRY_V);
  t.mock.timers.tick(6000);
  assert.deepStrictEqual(pumpPuts, [
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
  ]);

  await network.stop();
});

test('timer fires once per local day through the graph', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, pumpPuts } = await buildNetwork();

  feed('feedTimezone')(200);
  feed('feedDatetime')('2025-11-07T11:59:00Z'); // 13:59 local: not yet
  feed('feedDatetime')('2025-11-07T12:00:00Z'); // crossing: fires
  feed('feedCurrent')(DRY_V);
  t.mock.timers.tick(126000); // run past minimum time and dry time: stops
  feed('feedDatetime')('2025-11-07T12:05:00Z'); // same local day: no start
  assert.deepStrictEqual(pumpPuts, [
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
  ]);

  feed('feedDatetime')('2025-11-08T11:59:00Z'); // next local day, before target
  feed('feedDatetime')('2025-11-08T12:00:00Z'); // next local day: starts
  assert.deepStrictEqual(pumpPuts[2], { path: PUMP_PATH, value: true });
  feed('feedCurrent')(DRY_V);
  t.mock.timers.tick(126000);
  assert.deepStrictEqual(pumpPuts, [
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
  ]);

  await network.stop();
});

test('negative timezone offset fires at 14:00 local through the graph', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, pumpPuts } = await buildNetwork();

  feed('feedTimezone')(-930);
  feed('feedDatetime')('2025-11-07T23:29:00Z'); // 13:59 local: not yet
  feed('feedDatetime')('2025-11-07T23:30:00Z'); // 14:00 local (UTC-9:30): crossing
  assert.deepStrictEqual(pumpPuts, [{ path: PUMP_PATH, value: true }]);
  feed('feedCurrent')(DRY_V);
  t.mock.timers.tick(126000);
  assert.deepStrictEqual(pumpPuts, [
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
  ]);

  await network.stop();
});

test('bilge alarm transition starts the pump and it runs until dry', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, pumpPuts } = await buildNetwork();

  // GetSelfStream emits the initial path value once at startup; 1 = nominal
  feed('feedAlarm')(1);
  assert.deepStrictEqual(pumpPuts, [], 'initial value must not trigger the pump');

  feed('feedAlarm')(0); // alarm activates: pump starts
  assert.deepStrictEqual(pumpPuts, [{ path: PUMP_PATH, value: true }]);

  // Alarm clears mid-cycle: pump keeps running (run until dry)
  feed('feedAlarm')(1);
  feed('feedCurrent')(WET_V);
  t.mock.timers.tick(121000);
  assert.deepStrictEqual(pumpPuts, [{ path: PUMP_PATH, value: true }]);

  // Alarm re-activates while running: no duplicate start
  feed('feedAlarm')(0);
  assert.deepStrictEqual(pumpPuts, [{ path: PUMP_PATH, value: true }]);

  // Dry: stops after the 5s dry time
  feed('feedCurrent')(DRY_V);
  t.mock.timers.tick(6000);
  assert.deepStrictEqual(pumpPuts, [
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
  ]);

  await network.stop();
});

test('start-up race: datetime before timezone does not misfire at start-up', async (t) => {
  // Regression for the UTC+13 incident: at graph start the first
  // navigation.datetime update was evaluated with the timezone default
  // (UTC), so 22:00 UTC read as 22:00 local and started the pump at 11:00
  // local time. The component now waits for the timezone offset and only
  // fires on an observed crossing of the configured time.
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, pumpPuts } = await buildNetwork();

  feed('feedDatetime')('2026-01-14T22:00:00Z'); // 11:00 local next day; no offset yet
  feed('feedDatetime')('2026-01-14T22:01:00Z');
  t.mock.timers.tick(60000);
  assert.deepStrictEqual(pumpPuts, [], 'no evaluation before timezone is known');

  feed('feedTimezone')(1300); // offset arrives: now 11:01 local
  feed('feedDatetime')('2026-01-14T22:02:00Z');
  t.mock.timers.tick(60000);
  assert.deepStrictEqual(pumpPuts, [], '11:00 local is before 14:00');

  feed('feedDatetime')('2026-01-14T23:30:00Z'); // 12:30 local: still before
  feed('feedDatetime')('2026-01-15T01:00:00Z'); // 14:00 local Jan 15: fires
  assert.deepStrictEqual(pumpPuts, [{ path: PUMP_PATH, value: true }]);
  feed('feedCurrent')(DRY_V);
  t.mock.timers.tick(126000);

  await network.stop();
});

test('pump tuning IIPs configure the cycle end-to-end', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  // 2s minimum runtime and a 0.2 A dry threshold: the pumping voltage
  // (~0.84 A) then counts as still wet, and the near-idle 1.47 V
  // (~0.17 A) as dry
  const { network, feed, pumpPuts } = await buildNetwork({
    minruntime: 2,
    drycurrent: 0.2,
  });

  feed('feedAlarm')(1);
  feed('feedAlarm')(0); // alarm activates: pump starts
  feed('feedCurrent')(WET_V);
  t.mock.timers.tick(5000); // past the 2s minimum, but above 0.2 A
  assert.deepStrictEqual(pumpPuts, [{ path: PUMP_PATH, value: true }]);

  feed('feedCurrent')(DRY_V); // ~0.17 A: below the custom threshold
  t.mock.timers.tick(6000); // default 5s dry time
  assert.deepStrictEqual(pumpPuts, [
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
  ]);

  await network.stop();
});

test('active bilge alarm suspends the maxruntime failsafe', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, pumpPuts } = await buildNetwork();

  // GetSelfStream emits the initial path value once at startup; 1 = Off.
  // It feeds both DetectBilgeAlarm and the maxruntime exemption.
  feed('feedAlarm')(1);
  feed('feedAlarm')(0); // alarm activates: pump starts
  assert.deepStrictEqual(pumpPuts, [{ path: PUMP_PATH, value: true }]);
  feed('feedCurrent')(WET_V);
  t.mock.timers.tick(700 * 1000); // well past the 600s maxruntime
  assert.deepStrictEqual(pumpPuts, [{ path: PUMP_PATH, value: true }]);

  // Alarm clears: the failsafe applies again and force-stops the pump
  feed('feedAlarm')(1);
  t.mock.timers.tick(2000);
  assert.deepStrictEqual(pumpPuts, [
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
  ]);

  await network.stop();
});

test('guardrails: pumping voltage keeps running, air voltage stops it', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, pumpPuts } = await buildNetwork();

  feed('feedAlarm')(1);
  feed('feedAlarm')(0); // alarm activates: pump starts
  // Observed stable pumping-water reading (1.51 V, ~0.84 A): must not
  // be cut off
  feed('feedCurrent')(1.51);
  t.mock.timers.tick(127 * 1000);
  assert.deepStrictEqual(pumpPuts, [{ path: PUMP_PATH, value: true }]);

  // Observed pumping-air reading (1.50 V, ~0.67 A): the water/air
  // boundary sits between the two readings, so this must stop once the
  // dry time has passed
  feed('feedCurrent')(1.5);
  t.mock.timers.tick(6 * 1000);
  assert.deepStrictEqual(pumpPuts, [
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
  ]);

  await network.stop();
});

test('datetime updates alone never start the pump before 14:00 local', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, pumpPuts } = await buildNetwork();

  feed('feedTimezone')(0);
  for (let minute = 0; minute < 30; minute += 7) {
    feed('feedDatetime')(`2025-11-07T13:${String(minute).padStart(2, '0')}:00Z`);
  }
  feed('feedAlarm')(1);
  feed('feedAlarm')(1); // duplicate: DetectChange suppresses
  t.mock.timers.tick(60000);
  assert.deepStrictEqual(pumpPuts, [], 'no PUT without a trigger');

  await network.stop();
});

test('bilge current sensor voltage is published as calibrated amps', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, currentPuts } = await buildNetwork();

  const expectedAmps = (voltage) =>
    (voltage - CURRENT_OFFSET_V) / CURRENT_SCALE_V_PER_A;
  const expectPut = (voltage) => {
    feed('feedCurrent')(voltage);
    const put = currentPuts[currentPuts.length - 1];
    assert.strictEqual(put.path, CURRENT_PATH);
    assert.ok(
      Math.abs(put.value - expectedAmps(voltage)) < 0.000001,
      `${put.value} A for ${voltage} V`,
    );
  };

  // Pumping water (observed stable at 1.51 V); near-idle reading;
  // mid-band reading between air and water
  expectPut(WET_V);
  expectPut(DRY_V);
  expectPut(1.49);

  await network.stop();
});

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
 * Everything else (RunDailyAt, EmptyBilge, DetectChange, InvertBoolean,
 * And, the edge layout including BilgeAlarmGate values-before-in) is the
 * real graph wiring. EmptyBilge's 30s minimum run and 1s stop polling are
 * driven with a mocked clock.
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

/** Sensor voltage while pumping water, ~8.7 A through the current sensor */
const WET_V = 2.0;
/** Sensor voltage while pumping air, ~0.34 A: below the dry threshold */
const DRY_V = 1.5;
/** PUT target path of the pump switch, from graphs/main.json */
const PUMP_PATH = 'electrical.switches.gx.gxInternalRelay1.state';

/**
 * Build and start a network with the bilge wiring of graphs/main.json.
 *
 * @returns {Promise<Object>} Network, value feed sockets, and the puts
 *   array collecting the PUT requests captured by test/CapturePut
 */
async function buildNetwork() {
  const puts = [];
  const graph = new noflo.Graph('BilgeIntegration');
  graph.addNode('feedDatetime', 'test/Feed');
  graph.addNode('feedTimezone', 'test/Feed');
  graph.addNode('feedAlarm', 'test/Feed');
  graph.addNode('feedCurrent', 'test/Feed');
  graph.addNode('timer', 'signalk-server-config/RunDailyAt');
  graph.addNode('detect', 'signalk/DetectChange');
  graph.addNode('invert', 'signalk/InvertBoolean');
  graph.addNode('gate', 'signalk/And');
  graph.addNode('emptybilge', 'signalk-server-config/EmptyBilge');
  graph.addNode('put', 'test/CapturePut');
  // Same edges as graphs/main.json (gate values edge before in edge)
  graph.addEdge('feedDatetime', 'out', 'timer', 'datetime');
  graph.addEdge('feedTimezone', 'out', 'timer', 'timezone');
  graph.addEdge('timer', 'out', 'emptybilge', 'trigger');
  graph.addEdge('feedAlarm', 'out', 'detect', 'in');
  graph.addEdge('detect', 'out', 'invert', 'in');
  graph.addEdge('invert', 'out', 'gate', 'values');
  graph.addEdge('invert', 'out', 'gate', 'in');
  graph.addEdge('gate', 'pass', 'emptybilge', 'trigger');
  graph.addEdge('feedCurrent', 'out', 'emptybilge', 'current');
  graph.addEdge('emptybilge', 'out', 'put', 'value');
  // Same IIPs as graphs/main.json
  graph.addInitial('14:00', 'timer', 'time');
  graph.addInitial(PUMP_PATH, 'put', 'path');

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
  loader.registerComponent('test', 'CapturePut', {
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
        puts.push({ path, value });
        output.done();
      });
      return c;
    },
  });

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
  return { network, feed, puts };
}

test('daily timer starts a pump cycle at 14:00 local and runs it until dry', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, puts } = await buildNetwork();

  feed('feedTimezone')(200);
  feed('feedDatetime')('2025-11-07T11:30:00Z'); // 13:30 local: not yet
  assert.deepStrictEqual(puts, [], 'no PUT before 14:00 local');

  feed('feedDatetime')('2025-11-07T12:00:00Z'); // 14:00 local
  assert.deepStrictEqual(puts, [{ path: PUMP_PATH, value: true }]);

  // Pumping water: stays running past the 30s minimum
  feed('feedCurrent')(WET_V);
  t.mock.timers.tick(31000);
  assert.deepStrictEqual(puts, [{ path: PUMP_PATH, value: true }]);

  // Running dry: pump stops
  feed('feedCurrent')(DRY_V);
  t.mock.timers.tick(2000);
  assert.deepStrictEqual(puts, [
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
  ]);

  await network.stop();
});

test('timer fires once per local day through the graph', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, puts } = await buildNetwork();

  feed('feedTimezone')(200);
  feed('feedDatetime')('2025-11-07T12:00:00Z'); // fires
  feed('feedCurrent')(DRY_V);
  t.mock.timers.tick(31000); // run past minimum time: cycle completes dry
  feed('feedDatetime')('2025-11-07T12:05:00Z'); // same local day: no start
  assert.deepStrictEqual(puts, [
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
  ]);

  feed('feedDatetime')('2025-11-08T12:00:00Z'); // next local day: starts
  assert.deepStrictEqual(puts[2], { path: PUMP_PATH, value: true });
  feed('feedCurrent')(DRY_V);
  t.mock.timers.tick(31000);
  assert.deepStrictEqual(puts, [
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
  ]);

  await network.stop();
});

test('negative timezone offset fires at 14:00 local through the graph', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, puts } = await buildNetwork();

  feed('feedTimezone')(-930);
  feed('feedDatetime')('2025-11-07T23:30:00Z'); // 14:00 local (UTC-9:30)
  assert.deepStrictEqual(puts, [{ path: PUMP_PATH, value: true }]);
  feed('feedCurrent')(DRY_V);
  t.mock.timers.tick(31000);
  assert.deepStrictEqual(puts, [
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
  ]);

  await network.stop();
});

test('bilge alarm transition starts the pump and it runs until dry', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, puts } = await buildNetwork();

  // GetSelfStream emits the initial path value once at startup; 1 = nominal
  feed('feedAlarm')(1);
  assert.deepStrictEqual(puts, [], 'initial value must not trigger the pump');

  feed('feedAlarm')(0); // alarm activates: pump starts
  assert.deepStrictEqual(puts, [{ path: PUMP_PATH, value: true }]);

  // Alarm clears mid-cycle: pump keeps running (run until dry)
  feed('feedAlarm')(1);
  feed('feedCurrent')(WET_V);
  t.mock.timers.tick(31000);
  assert.deepStrictEqual(puts, [{ path: PUMP_PATH, value: true }]);

  // Alarm re-activates while running: no duplicate start
  feed('feedAlarm')(0);
  assert.deepStrictEqual(puts, [{ path: PUMP_PATH, value: true }]);

  // Dry: stops
  feed('feedCurrent')(DRY_V);
  t.mock.timers.tick(2000);
  assert.deepStrictEqual(puts, [
    { path: PUMP_PATH, value: true },
    { path: PUMP_PATH, value: false },
  ]);

  await network.stop();
});

test('start-up race: datetime before timezone does not misfire the catch-up', async (t) => {
  // Regression for the UTC+13 incident: at graph start the first
  // navigation.datetime update was evaluated with the timezone default
  // (UTC), so 22:00 UTC read as 22:00 local and started the pump at 11:00
  // local time. The component now waits for the timezone offset.
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, puts } = await buildNetwork();

  feed('feedDatetime')('2026-01-14T22:00:00Z'); // 11:00 local next day; no offset yet
  feed('feedDatetime')('2026-01-14T22:01:00Z');
  t.mock.timers.tick(60000);
  assert.deepStrictEqual(puts, [], 'no evaluation before timezone is known');

  feed('feedTimezone')(1300); // offset arrives: now 11:01 local
  feed('feedDatetime')('2026-01-14T22:02:00Z');
  t.mock.timers.tick(60000);
  assert.deepStrictEqual(puts, [], '11:00 local is before 14:00');

  feed('feedDatetime')('2026-01-14T23:30:00Z'); // 12:30 local: still before
  feed('feedDatetime')('2026-01-15T01:00:00Z'); // 14:00 local Jan 15: fires
  assert.deepStrictEqual(puts, [{ path: PUMP_PATH, value: true }]);
  feed('feedCurrent')(DRY_V);
  t.mock.timers.tick(31000);

  await network.stop();
});

test('datetime updates alone never start the pump before 14:00 local', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { network, feed, puts } = await buildNetwork();

  feed('feedTimezone')(0);
  for (let minute = 0; minute < 30; minute += 7) {
    feed('feedDatetime')(`2025-11-07T13:${String(minute).padStart(2, '0')}:00Z`);
  }
  feed('feedAlarm')(1);
  feed('feedAlarm')(1); // duplicate: DetectChange suppresses
  t.mock.timers.tick(60000);
  assert.deepStrictEqual(puts, [], 'no PUT without a trigger');

  await network.stop();
});

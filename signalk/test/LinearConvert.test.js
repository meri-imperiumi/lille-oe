/**
 * Unit tests for the LinearConvert component: a raw sensor reading
 * converted to engineering units via (in - offset) / scale.
 */
const test = require('node:test');
const assert = require('node:assert');
const noflo = require('noflo');
const getComponent = require('../components/LinearConvert.js').getComponent;

/** Same conversion constants as graphs/main.json pins via IIPs */
const CURRENT_OFFSET_V = 1.46;
const CURRENT_SCALE_V_PER_A = 0.0596;

/**
 * Instantiate the component with sockets attached.
 *
 * @param {Object} [controls] - Control port values to configure
 * @returns {Object} Component handles for driving conversions
 */
function setup(controls = {}) {
  const c = getComponent();
  const outputs = [];
  const inSocket = noflo.internalSocket.createSocket();
  const outSocket = noflo.internalSocket.createSocket();
  outSocket.on('data', (value) => outputs.push(value));
  c.inPorts.in.attach(inSocket);
  c.outPorts.out.attach(outSocket);
  for (const [port, value] of Object.entries(controls)) {
    const socket = noflo.internalSocket.createSocket();
    c.inPorts[port].attach(socket);
    socket.send(value);
    socket.disconnect();
  }
  const send = (value) => {
    inSocket.send(value);
    inSocket.disconnect();
  };
  return { outputs, send };
}

test('passes values through unchanged by default', () => {
  const { outputs, send } = setup();
  send(5);
  assert.deepStrictEqual(outputs, [5]);
});

test('applies the sensor calibration', () => {
  const { outputs, send } = setup({
    offset: CURRENT_OFFSET_V,
    scale: CURRENT_SCALE_V_PER_A,
  });
  // 1.51 V with idle at 1.46 V reads as ~0.84 A
  send(1.51);
  assert.strictEqual(outputs.length, 1);
  assert.ok(
    Math.abs(outputs[0] - (1.51 - CURRENT_OFFSET_V) / CURRENT_SCALE_V_PER_A)
      < 0.000001,
    `${outputs[0]} A`,
  );
});

test('control values persist across packets', () => {
  const { outputs, send } = setup({ offset: 2, scale: 2 });
  send(6);
  send(8);
  assert.deepStrictEqual(outputs, [2, 3]);
});

test('drops non-numeric readings', () => {
  const { outputs, send } = setup();
  send('not-a-number');
  assert.deepStrictEqual(outputs, []);
});

test('drops readings that would not convert to a finite result', () => {
  const { outputs, send } = setup({ scale: 0 });
  send(5);
  assert.deepStrictEqual(outputs, []);
});

test('unusable control values fall back to defaults', () => {
  const { outputs, send } = setup({ offset: 'NaN', scale: null });
  send(5);
  assert.deepStrictEqual(outputs, [5]);
});

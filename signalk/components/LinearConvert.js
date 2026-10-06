/**
 * NoFlo component for linear sensor calibration.
 *
 * Converts a raw sensor reading to engineering units:
 *
 * `out = (in - offset) / scale`
 *
 * For example, deriving amps from the bilge current sensor's voltage
 * path, where the sensor reports `offset` volts at 0 A and `scale`
 * volts per amp.
 *
 * The calibration is configurable via control ports, typically wired
 * as IIPs in the graph. Unusable readings and configurations produce
 * no output rather than NaN or Infinity.
 *
 * This mirrors signalk/LinearConvert in noflo-signalk, vendored here
 * until the installed noflo-signalk ships it.
 *
 * @module signalk-server-config/LinearConvert
 */
const noflo = require('noflo');

/** Default value subtracted from the input before scaling */
const DEFAULT_OFFSET = 0;

/** Default divisor applied after the offset is removed */
const DEFAULT_SCALE = 1;

/**
 * Coerce a control port value to a finite number, falling back to the
 * port default when it is missing or unusable. NoFlo delivers port
 * defaults via the network layer, so bare instances read undefined.
 *
 * @param {any} value - Raw control port value
 * @param {number} fallback - Default to use when value is not finite
 * @returns {number} Numeric configuration value
 */
function toNumber(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Converts a raw sensor reading with a linear calibration.
 *
 * Sends the calibrated value on `out` for each finite input reading,
 * and nothing for readings that would not convert to a finite number.
 */
class LinearConvert extends noflo.Component {
  constructor() {
    super();

    this.description = 'Converts a raw sensor reading to engineering '
      + 'units with a linear calibration: (in - offset) / scale. '
      + 'Tunable via control ports';
    this.icon = 'calculator';

    this.inPorts.add('in', {
      datatype: 'number',
      description: 'Raw sensor reading',
    });
    this.inPorts.add('offset', {
      datatype: 'number',
      description: 'Sensor output at zero reading, in input units',
      control: true,
      default: DEFAULT_OFFSET,
    });
    this.inPorts.add('scale', {
      datatype: 'number',
      description: 'Sensor scale, input units per output unit',
      control: true,
      default: DEFAULT_SCALE,
    });
    this.outPorts.add('out', {
      datatype: 'number',
      description: 'Calibrated reading',
    });

    this.process((input, output) => {
      if (!input.hasData('in')) {
        return;
      }

      const raw = Number(input.getData('in'));
      if (!Number.isFinite(raw)) {
        output.done();
        return;
      }

      const offset = toNumber(input.getData('offset'), DEFAULT_OFFSET);
      const scale = toNumber(input.getData('scale'), DEFAULT_SCALE);
      const result = (raw - offset) / scale;
      if (!Number.isFinite(result)) {
        output.done();
        return;
      }

      output.sendDone({ out: result });
    });
  }
}

/**
 * @returns {LinearConvert} A new LinearConvert component instance
 */
exports.getComponent = () => new LinearConvert();

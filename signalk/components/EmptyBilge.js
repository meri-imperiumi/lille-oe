/**
 * NoFlo component for automatic bilge pumping.
 *
 * On trigger, starts the bilge pump and keeps it running until the bilge
 * is empty, i.e. all of the following hold:
 *
 * - pump has run for at least `minruntime` seconds
 * - pump is running dry (current below `drycurrent` amps)
 *
 * The current sensor reports voltage; amps are derived with:
 * `(voltage - currentOffset) / currentScale`
 *
 * The thresholds and sensor calibration are configurable via control
 * ports, typically wired as IIPs in the graph.
 *
 * This is a generator-style component: it keeps itself activated between
 * the trigger and the stop decision, polling the control ports.
 *
 * @module signalk-server-config/EmptyBilge
 */
const noflo = require('noflo');

/** Default minimum time the pump is kept running after trigger, in seconds */
const DEFAULT_MIN_RUNTIME_S = 120;

/** How often stop conditions are evaluated while pump is running */
const POLL_INTERVAL_MS = 1000;

/** Default current sensor output at 0 A, in volts */
const DEFAULT_CURRENT_OFFSET_V = 1.46;

/** Default current sensor scale, volts per amp */
const DEFAULT_CURRENT_SCALE_V_PER_A = 0.0596;

/** Default pump current below which no water is being pumped, in amps */
const DEFAULT_DRY_CURRENT_A = 0.8;

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
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Runs the bilge pump until the bilge is empty.
 *
 * Sends `true` on `out` when the pump is started, `false` when it is
 * stopped, and nothing while waiting.
 */
class EmptyBilge extends noflo.Component {
  constructor() {
    super();

    this.description = 'Runs bilge pump on trigger until bilge is empty. '
      + 'Stops when pump has run at least minruntime seconds and pump '
      + 'current is below drycurrent amps. Tunable via control ports';
    this.icon = 'tint';

    this.inPorts.add('trigger', {
      datatype: 'all',
      description: 'Start a pump cycle',
      required: true,
    });
    this.inPorts.add('current', {
      datatype: 'number',
      description: 'Bilge pump current sensor voltage reading',
      control: true,
    });
    this.inPorts.add('minruntime', {
      datatype: 'number',
      description: 'Minimum time to run the pump before evaluating stop '
        + 'conditions, in seconds',
      control: true,
      default: DEFAULT_MIN_RUNTIME_S,
    });
    this.inPorts.add('drycurrent', {
      datatype: 'number',
      description: 'Pump current below which no water is being pumped, '
        + 'in amps',
      control: true,
      default: DEFAULT_DRY_CURRENT_A,
    });
    this.inPorts.add('currentoffset', {
      datatype: 'number',
      description: 'Current sensor output at 0 A, in volts',
      control: true,
      default: DEFAULT_CURRENT_OFFSET_V,
    });
    this.inPorts.add('currentscale', {
      datatype: 'number',
      description: 'Current sensor scale, volts per amp',
      control: true,
      default: DEFAULT_CURRENT_SCALE_V_PER_A,
    });
    this.outPorts.add('out', {
      datatype: 'boolean',
      description: 'Bilge pump switch state (true = on, false = off)',
    });

    /** Whether a pump cycle is in progress */
    this.running = false;

    /** Timestamp of pump cycle start */
    this.startedAt = 0;

    /** Timer handle for stop condition polling */
    this.pollTimer = null;

    this.process((input, output) => {
      if (!input.hasData('trigger')) {
        return;
      }
      input.getData('trigger');

      if (this.running) {
        // Already pumping; duplicate trigger is a no-op
        output.done();
        return;
      }

      this.running = true;
      this.startedAt = Date.now();
      output.send({ out: true });

      this.pollTimer = setInterval(() => {
        this.checkDone(input, output);
      }, POLL_INTERVAL_MS);
    });
  }

  /**
   * Evaluate stop conditions; stop the pump and finish the cycle when met.
   *
   * Control port values are read without consuming them, so we always see
   * the latest sensor readings and tuning. Missing or non-numeric readings
   * cause the conditions to fail, keeping the pump running.
   *
   * @param {noflo.ProcessInput} input - Process input context
   * @param {noflo.ProcessOutput} output - Process output context
   */
  checkDone(input, output) {
    if (!this.running) {
      return;
    }

    const minRunMs = toNumber(input.getData('minruntime'), DEFAULT_MIN_RUNTIME_S)
      * 1000;
    const elapsed = Date.now() - this.startedAt;
    if (elapsed < minRunMs) {
      return;
    }

    const dryCurrentA = toNumber(
      input.getData('drycurrent'),
      DEFAULT_DRY_CURRENT_A,
    );
    const offsetV = toNumber(
      input.getData('currentoffset'),
      DEFAULT_CURRENT_OFFSET_V,
    );
    const scaleVPerA = toNumber(
      input.getData('currentscale'),
      DEFAULT_CURRENT_SCALE_V_PER_A,
    );

    const voltage = Number(input.getData('current'));
    const amps = (voltage - offsetV) / scaleVPerA;
    // NaN (no reading) fails the comparison, keeping the pump running
    if (!(amps < dryCurrentA)) {
      return;
    }

    this.clearPollTimer();
    this.running = false;
    output.sendDone({ out: false });
  }

  /**
   * Clear the stop condition poll timer
   */
  clearPollTimer() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Stop polling when the network shuts down
   *
   * @returns {Promise<void>} Promise resolving when shutdown is complete
   */
  shutdown() {
    this.clearPollTimer();
    this.running = false;
    return super.shutdown();
  }
}

/**
 * @returns {EmptyBilge} A new EmptyBilge component instance
 */
exports.getComponent = () => new EmptyBilge();

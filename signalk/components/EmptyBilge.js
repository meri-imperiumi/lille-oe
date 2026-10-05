/**
 * NoFlo component for automatic bilge pumping.
 *
 * On trigger, starts the bilge pump and keeps it running until the bilge
 * is empty, i.e. all of the following hold:
 *
 * - pump has run for at least `MIN_RUN_MS`
 * - pump is running dry (current below `DRY_CURRENT_A`)
 *
 * The current sensor reports voltage; amps are derived with:
 * `(voltage - CURRENT_OFFSET_V) / CURRENT_SCALE_V_PER_A`
 *
 * This is a generator-style component: it keeps itself activated between
 * the trigger and the stop decision, polling the control ports.
 *
 * @module signalk-server-config/EmptyBilge
 */
const noflo = require('noflo');

/** Minimum time the pump is kept running after trigger, in milliseconds */
const MIN_RUN_MS = 30 * 1000;

/** How often stop conditions are evaluated while pump is running */
const POLL_INTERVAL_MS = 1000;

/** Current sensor output at 0 A, in volts */
const CURRENT_OFFSET_V = 1.48;

/** Current sensor scale, volts per amp */
const CURRENT_SCALE_V_PER_A = 0.0596;

/** Pump current below this means no water is being pumped, in amps */
const DRY_CURRENT_A = 0.8;

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
      + 'Stops when pump has run at least 30sec and pump current is '
      + 'below dry threshold';
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
   * the latest sensor readings. Missing or non-numeric readings cause the
   * conditions to fail, keeping the pump running.
   *
   * @param {noflo.ProcessInput} input - Process input context
   * @param {noflo.ProcessOutput} output - Process output context
   */
  checkDone(input, output) {
    if (!this.running) {
      return;
    }

    const elapsed = Date.now() - this.startedAt;
    if (elapsed < MIN_RUN_MS) {
      return;
    }

    const voltage = Number(input.getData('current'));
    const amps = (voltage - CURRENT_OFFSET_V) / CURRENT_SCALE_V_PER_A;
    // NaN (no reading) fails the comparison, keeping the pump running
    if (!(amps < DRY_CURRENT_A)) {
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

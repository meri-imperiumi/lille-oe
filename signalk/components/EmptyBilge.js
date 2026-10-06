/**
 * NoFlo component for automatic bilge pumping.
 *
 * On trigger, starts the bilge pump and keeps it running until the bilge
 * is empty, i.e. all of the following hold:
 *
 * - pump has run for at least `minruntime` seconds
 * - pump has been reading dry (`current` below `drycurrent` amps) for
 *   at least `drytime` consecutive seconds
 *
 * The pump is force-stopped after `maxruntime` seconds even if it still
 * reads wet, guarding against a sensor that stops reporting (missing
 * readings count as wet) or a pump that never reaches the dry threshold.
 * The failsafe does not apply while the bilge alarm is active
 * (`alarmstate` 0/false): with water in the bilge the pump keeps running
 * until the dry detection ends the cycle, however long that takes.
 *
 * The `current` port expects calibrated amps, e.g. derived from a
 * current-sensor voltage reading with signalk-server-config/LinearConvert.
 *
 * The thresholds are configurable via control ports, typically wired
 * as IIPs in the graph.
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

/** Default pump current below which no water is being pumped, in amps */
const DEFAULT_DRY_CURRENT_A = 0.65;

/** Default time the pump must read dry continuously before stopping, in seconds */
const DEFAULT_DRY_TIME_S = 5;

/** Default hard stop time after which the pump is stopped regardless, in seconds */
const DEFAULT_MAX_RUNTIME_S = 600;

/**
 * Coerce a control port value to a finite number, falling back to the
 * port default when it is missing or unusable. NoFlo delivers port
 * defaults via the network layer, so bare instances read undefined, and
 * ports with no data at all read null — which Number() would turn into
 * 0, so both must map to the fallback.
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
      + 'current has stayed below drycurrent amps for drytime seconds. '
      + 'Force-stops after maxruntime seconds unless the bilge alarm '
      + 'is active';
    this.icon = 'tint';

    this.inPorts.add('trigger', {
      datatype: 'all',
      description: 'Start a pump cycle',
      required: true,
    });
    this.inPorts.add('current', {
      datatype: 'number',
      description: 'Bilge pump current in amps',
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
    this.inPorts.add('drytime', {
      datatype: 'number',
      description: 'Time the pump must read dry continuously before it '
        + 'counts as empty, in seconds',
      control: true,
      default: DEFAULT_DRY_TIME_S,
    });
    this.inPorts.add('maxruntime', {
      datatype: 'number',
      description: 'Hard stop time regardless of the current reading, in '
        + 'seconds. 0 disables the limit. Not applied while the bilge '
        + 'alarm is active',
      control: true,
      default: DEFAULT_MAX_RUNTIME_S,
    });
    this.inPorts.add('alarmstate', {
      datatype: 'all',
      description: 'Bilge alarm state: 0/false = water in bilge (alarm '
        + 'active), 1/true = Off. While active, maxruntime is not applied',
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

    /** Consecutive dry polls in this cycle */
    this.dryPolls = 0;

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
      this.dryPolls = 0;
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

    const maxRunMs = toNumber(input.getData('maxruntime'), DEFAULT_MAX_RUNTIME_S)
      * 1000;
    // With an active bilge alarm there is water in the bilge: the pump
    // keeps running past maxruntime until the dry detection ends the
    // cycle. Missing state is treated as Off, so the failsafe applies.
    const alarmActive = toNumber(input.getData('alarmstate'), 1) === 0;
    if (maxRunMs > 0 && elapsed >= maxRunMs && !alarmActive) {
      this.stopPump(output);
      return;
    }

    const dryCurrentA = toNumber(
      input.getData('drycurrent'),
      DEFAULT_DRY_CURRENT_A,
    );
    const dryTimeMs = toNumber(input.getData('drytime'), DEFAULT_DRY_TIME_S)
      * 1000;

    const amps = Number(input.getData('current'));
    // NaN (no reading) fails the comparison, keeping the pump running
    if (!(amps < dryCurrentA)) {
      this.dryPolls = 0;
      return;
    }

    this.dryPolls += 1;
    // The dry time is sampled at the poll interval, so e.g. the default
    // 5s means five consecutive dry polls
    const dryPollsNeeded = Math.max(1, Math.ceil(dryTimeMs / POLL_INTERVAL_MS));
    if (this.dryPolls < dryPollsNeeded) {
      return;
    }

    this.stopPump(output);
  }

  /**
   * Stop the pump and finish the cycle.
   *
   * @param {noflo.ProcessOutput} output - Process output context
   */
  stopPump(output) {
    this.clearPollTimer();
    this.running = false;
    this.dryPolls = 0;
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

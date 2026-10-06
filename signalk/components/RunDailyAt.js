/**
 * NoFlo component that emits a daily trigger when the onboard local time
 * crosses a configured time of day.
 *
 * Receives the current time as a UTC ISO date string (Signal K
 * `navigation.datetime`) and the onboard timezone offset from UTC in
 * (-)hhmm encoding (Signal K `environment.time.timezoneOffset`, e.g.
 * 200 for UTC+02:00 or -930 for UTC-09:30). Onboard local time is
 * computed as UTC + offset.
 *
 * Evaluation only starts once a timezone offset has been received:
 * evaluating in UTC before the offset is known could misfire the daily
 * trigger when the graph starts.
 *
 * Fires `out` when an onboard update crosses the configured local time:
 * the previous update was before it and the current one is at or after
 * it. This happens exactly once per local day. There is deliberately no
 * catch-up: starting the system after the configured time does not
 * trigger until the next occurrence, because clock and timezone state
 * cannot be trusted right after start-up (e.g. a derived timezone
 * offset of 0 before a GPS fix, or a stale system clock).
 *
 * This is a generator-style component: it keeps the local date and time
 * of day of the last onboard update so crossings are only detected
 * between consecutive updates.
 *
 * @module signalk-server-config/RunDailyAt
 */
const noflo = require('noflo');

/** Default local time of day to fire at */
const DEFAULT_TIME = '14:00';

/** Accepted format for the `time` control port, 24h HH:MM */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Convert a (-)hhmm timezone offset to minutes.
 *
 * @param {number} hhmm - Offset in (-)hhmm encoding, e.g. 200 or -930
 * @returns {number} Offset from UTC in minutes
 */
function offsetToMinutes(hhmm) {
  const offset = Number(hhmm) || 0;
  const sign = offset < 0 ? -1 : 1;
  const abs = Math.abs(offset);
  return sign * (Math.floor(abs / 100) * 60 + (abs % 100));
}

/**
 * Fires once per day when onboard local time reaches the configured time.
 */
class RunDailyAt extends noflo.Component {
  constructor() {
    super();

    this.description = 'Fires out once per local day when the onboard '
      + 'time reaches the configured time. Needs navigation.datetime '
      + 'and environment.time.timezoneOffset';
    this.icon = 'clock-o';

    this.inPorts.add('datetime', {
      datatype: 'string',
      description: 'Current time as UTC ISO string (navigation.datetime)',
      required: true,
    });
    this.inPorts.add('timezone', {
      datatype: 'number',
      description: 'Onboard timezone offset from UTC in (-)hhmm encoding '
        + '(environment.time.timezoneOffset). Evaluation waits until '
        + 'this is received: without it, UTC would be read as local time '
        + 'and the daily catch-up could misfire at start-up',
      control: true,
    });
    this.inPorts.add('time', {
      datatype: 'string',
      description: 'Local time of day to fire at, HH:MM',
      control: true,
      default: DEFAULT_TIME,
    });
    this.outPorts.add('out', {
      datatype: 'all',
      description: 'Daily trigger, sent when an onboard update crosses '
        + 'the configured local time',
    });
    this.outPorts.add('error', {
      datatype: 'object',
    });

    /** Local date (YYYY-MM-DD) of the last onboard update */
    this.lastSeenDate = null;

    /** Minutes since local midnight of the last onboard update */
    this.lastSeenMinutes = null;

    this.process((input, output) => {
      if (!input.hasData('datetime')) {
        return;
      }
      // Always consume the triggering packet, also when the timezone is
      // not yet known. Returning without consuming it would leave the
      // port buffer one packet behind: each new update would evaluate
      // the previous one and the newest would sit unconsumed forever.
      const datetime = input.getData('datetime');
      // Without a received timezone offset the onboard local time is
      // unknown; evaluating in UTC could misfire the daily trigger
      if (!input.hasData('timezone')) {
        output.done();
        return;
      }
      const timezone = input.getData('timezone');
      // Fall back to the port default also in code: NoFlo delivers port
      // defaults via the network layer, so bare instances read undefined
      const time = input.getData('time') || DEFAULT_TIME;

      const utc = new Date(datetime);
      if (Number.isNaN(utc.getTime())) {
        output.sendDone({
          error: new Error(`Invalid datetime received: ${datetime}`),
        });
        return;
      }
      if (!TIME_PATTERN.test(String(time))) {
        output.sendDone({
          error: new Error(`Invalid time configuration, expected HH:MM: ${time}`),
        });
        return;
      }

      // Onboard local wall-clock = UTC + timezone offset
      const local = new Date(
        utc.getTime() + offsetToMinutes(timezone) * 60 * 1000,
      );
      const today = local.toISOString().slice(0, 10);
      const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();

      const [targetHh, targetMm] = time.split(':').map(Number);
      const targetMinutes = targetHh * 60 + targetMm;

      // Fire only on an observed crossing of the configured time: the
      // previous onboard update was before it and this one is at or
      // after it. Firing on the first evaluation alone (catch-up) would
      // misfire whenever clock or timezone state is untrustworthy at
      // start-up, e.g. a derived timezoneOffset of 0 before a GPS fix.
      const crossed = this.lastSeenDate === today
        && this.lastSeenMinutes < targetMinutes
        && minutes >= targetMinutes;

      this.lastSeenDate = today;
      this.lastSeenMinutes = minutes;

      if (!crossed) {
        output.done();
        return;
      }

      output.sendDone({ out: true });
    });
  }
}

/**
 * @returns {RunDailyAt} A new RunDailyAt component instance
 */
exports.getComponent = () => new RunDailyAt();

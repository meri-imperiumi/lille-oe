/**
 * NoFlo component that emits a daily trigger when the onboard local time
 * reaches a configured time of day.
 *
 * Receives the current time as a UTC ISO date string (Signal K
 * `navigation.datetime`) and the onboard timezone offset from UTC in
 * (-)hhmm encoding (Signal K `environment.time.timezoneOffset`, e.g.
 * 200 for UTC+02:00 or -930 for UTC-09:30). Onboard local time is
 * computed as UTC + offset.
 *
 * Evaluation only starts once a timezone offset has been received:
 * evaluating in UTC before the offset is known could misfire the daily
 * catch-up when the graph starts.
 *
 * Fires `out` at most once per local calendar day: the first datetime
 * update at or after the configured local time sends the trigger. This
 * also acts as catch-up when the network starts after the configured
 * time has already passed.
 *
 * This is a generator-style component: it keeps the time of the last
 * firing so repeated datetime updates don't retrigger within the same
 * local day.
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
 * Time of day of a timezone-shifted timestamp, as HH:MM.
 *
 * The timezone shift is applied to the epoch value, so the UTC getters
 * return the onboard local wall-clock time.
 *
 * @param {Date} shifted - Datetime shifted by the timezone offset
 * @returns {string} Time of day as HH:MM
 */
function timeOfDay(shifted) {
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
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
      description: 'Daily trigger, sent when local time reaches the '
        + 'configured time',
    });
    this.outPorts.add('error', {
      datatype: 'object',
    });

    /** Local date (YYYY-MM-DD) the trigger last fired on */
    this.lastFired = null;

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
      // unknown; evaluating in UTC could misfire the daily catch-up
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
      if (this.lastFired === today) {
        // Already fired today
        output.done();
        return;
      }
      if (timeOfDay(local) < time) {
        // Configured time not reached yet
        output.done();
        return;
      }

      this.lastFired = today;
      output.sendDone({ out: true });
    });
  }
}

/**
 * @returns {RunDailyAt} A new RunDailyAt component instance
 */
exports.getComponent = () => new RunDailyAt();

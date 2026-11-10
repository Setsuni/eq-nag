// Per-trigger counters and on-demand timing for the log watcher.
//
// Every trigger has a { checked, fired } pair that is always counted (two
// integer increments).  Timing only runs during a measurement.  A trigger costs
// about a microsecond, so timing all of them on every line would cost more than
// the triggers themselves; instead each line times only a few triggers, taken
// round-robin from the active list, and scales each sample up by the number of
// triggers it stands for.

/** How many triggers are timed on each log line during a measurement.  The log watcher's per-trigger check compares against exactly this many indexes. */
const timedPerLine = 2;

/** How long a measurement runs before it ends by itself. */
const measureDurationMs = 10 * 60 * 1000;

class TriggerMetrics {

    /** @type {Record<string, {checked: number, fired: number, samples: number, totalMs: number, maxMs: number}>} */
    #stats = {};

    /** @type {Record<string, [number, number]>} The counters when the measurement started. */
    #base = {};

    #measuring = false;
    #startedAt = 0;
    #lines = 0;
    #cursor = 0;
    #count = 0;
    #timed = 0;

    /** The indexes of the triggers to time on the current line, or -1; read once per line by the log watcher. */
    first = -1;
    second = -1;

    get measuring() {
        return this.#measuring;
    }

    get startedAt() {
        return this.#startedAt;
    }

    get lines() {
        return this.#lines;
    }

    /**
     * Gets the counters of a trigger, creating them if needed.
     *
     * @param {string} id The trigger id.
     */
    statsFor( id ) {
        return this.#stats[ id ] ??= { checked: 0, fired: 0, samples: 0, totalMs: 0, maxMs: 0 };
    }

    /**
     * Starts a measurement.
     *
     * @param {number} now The start time, in ms since the epoch.
     */
    begin( now ) {
        this.#base = {};
        for ( const id in this.#stats ) {
            const s = this.#stats[ id ];
            this.#base[ id ] = [ s.checked, s.fired ];
            s.samples = 0;
            s.totalMs = 0;
            s.maxMs = 0;
        }
        this.#lines = 0;
        this.#cursor = 0;
        this.#startedAt = now;
        this.#measuring = true;
    }

    /**
     * Counts a log line while measuring and picks the triggers to time on it into first and second.
     *
     * @param {number} count The number of active triggers.
     */
    sampleWindow( count ) {
        this.first = -1;
        this.second = -1;
        if ( !this.#measuring ) {
            return;
        }
        this.#lines++;
        if ( count < 1 ) {
            return;
        }
        this.#count = count;
        this.#timed = Math.min( timedPerLine, count );
        const start = this.#cursor % count;
        this.first = start;
        this.second = this.#timed > 1 ? ( start + 1 ) % count : -1;
        this.#cursor = ( start + this.#timed ) % count;
    }

    /**
     * Adds a timed call to a trigger's counters, scaled up for the triggers that were not timed.
     *
     * @param {{samples: number, totalMs: number, maxMs: number}} stats The trigger's counters.
     * @param {bigint} ns The time the trigger took, in nanoseconds.
     */
    record( stats, ns ) {
        const ms = Number( ns ) / 1e6;
        stats.samples++;
        stats.totalMs += ms * this.#count / this.#timed;
        if ( ms > stats.maxMs ) {
            stats.maxMs = ms;
        }
    }

    /**
     * Ends the measurement.
     *
     * @param {{triggerId: string}[]} triggers The triggers to report; those never checked are included with zeros.
     * @param {number} now The end time, in ms since the epoch.
     * @returns {{startedAt: number, endedAt: number, lineCount: number, triggers: Record<string, {checked: number, fired: number, samples: number, totalMs: number, maxMs: number}>}}
     */
    end( triggers, now ) {
        this.#measuring = false;
        const result = { startedAt: this.#startedAt, endedAt: now, lineCount: this.#lines, triggers: {} };
        triggers.forEach( trigger => {
            const s = this.statsFor( trigger.triggerId );
            const base = this.#base[ trigger.triggerId ] ?? [ 0, 0 ];
            result.triggers[ trigger.triggerId ] = {
                checked: s.checked - base[ 0 ],
                fired: s.fired - base[ 1 ],
                samples: s.samples,
                totalMs: s.totalMs,
                maxMs: s.maxMs,
            };
        } );
        return result;
    }

    /**
     * Gets the always-on counters of the given triggers.
     *
     * @param {{triggerId: string, name: string}[]} triggers The triggers.
     */
    counters( triggers ) {
        const result = {};
        triggers.forEach( trigger => {
            const s = this.#stats[ trigger.triggerId ];
            result[ trigger.triggerId ] = { name: trigger.name, checked: s?.checked ?? 0, fired: s?.fired ?? 0 };
        } );
        return result;
    }
}

module.exports = { TriggerMetrics, timedPerLine, measureDurationMs };

// Per-trigger counters and on-demand timing for the log watcher.
//
// Every trigger has a { checked, fired } pair that is always counted (two
// integer increments).  Timing only runs during a measurement, on one log line
// in fifty, and is scaled up like the perf taps (see perf-taps.js).

const sampleEvery = 50;

/** How long a measurement runs before it ends by itself. */
const measureDurationMs = 10 * 60 * 1000;

class TriggerMetrics {

    /** @type {Record<string, {checked: number, fired: number, totalMs: number, maxMs: number}>} */
    #stats = {};

    /** @type {Record<string, [number, number]>} The counters when the measurement started. */
    #base = {};

    #measuring = false;
    #startedAt = 0;
    #lines = 0;

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
        return this.#stats[ id ] ??= { checked: 0, fired: 0, totalMs: 0, maxMs: 0 };
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
            s.totalMs = 0;
            s.maxMs = 0;
        }
        this.#lines = 0;
        this.#startedAt = now;
        this.#measuring = true;
    }

    /**
     * Counts a log line while measuring.
     *
     * @returns {boolean} True when the triggers should be timed on this line.
     */
    sampleLine() {
        return this.#measuring && ++this.#lines % sampleEvery === 0;
    }

    /**
     * Adds a timed call to a trigger's counters, scaled up for the sampling.
     *
     * @param {{totalMs: number, maxMs: number}} stats The trigger's counters.
     * @param {number} ms The time the trigger took.
     */
    record( stats, ms ) {
        stats.totalMs += ms * sampleEvery;
        if ( ms > stats.maxMs ) {
            stats.maxMs = ms;
        }
    }

    /**
     * Ends the measurement.
     *
     * @param {{triggerId: string}[]} triggers The triggers to report; those never checked are included with zeros.
     * @param {number} now The end time, in ms since the epoch.
     * @returns {{startedAt: number, endedAt: number, lineCount: number, triggers: Record<string, {checked: number, fired: number, totalMs: number, maxMs: number}>}}
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

module.exports = { TriggerMetrics, sampleEvery, measureDurationMs };

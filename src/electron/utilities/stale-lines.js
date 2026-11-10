const staleLineMs = 15000;
const hourMs = 3600000;
/** A stale lag that holds within this many milliseconds, for steadyWindowMs and steadyMinLines, is a constant clock offset. */
const steadyToleranceMs = 3000;
const steadyWindowMs = 30000;
const steadyMinLines = 5;

/**
 * Decides whether lines read from the live log file are stale (Nag is still catching up on a backlog), measuring each
 * line's lag against the wall clock without a constant clock offset such as a time zone or DST mismatch.
 */
class StaleLineTracker {

    /** True when the last line passed to update() is stale. */
    stale = false;

    /** The lag of the last line, in milliseconds, with the clock offset removed. */
    lagMs = 0;

    #clockOffsetMs = 0;
    #steadyLagMs = null;
    #steadySinceMs = 0;
    #steadyLineCount = 0;
    #catchingUp = false;
    #onCatchingUp;
    #onCaughtUp;

    /**
     * @param {{onCatchingUp?: () => void, onCaughtUp?: () => void}} options Called when catching up starts and ends.
     */
    constructor( options ) {
        this.#onCatchingUp = options?.onCatchingUp;
        this.#onCaughtUp = options?.onCaughtUp;
    }

    /**
     * Returns true if a line with the given timestamp is stale, without changing what the tracker has learned.
     *
     * @param {Date} timestamp The log timestamp of the line.
     */
    isStale( timestamp ) {
        let lag = Date.now() - timestamp.getTime() - this.#clockOffsetMs;

        if ( Number.isNaN( lag ) ) {
            return false;
        }

        const hours = Math.round( lag / hourMs ) * hourMs;
        if ( Math.abs( lag ) > staleLineMs && hours !== 0 && Math.abs( lag - hours ) <= staleLineMs ) {
            lag -= hours;
        }

        return lag > staleLineMs;
    }

    /** Forgets the learned clock offset and the catching-up state. */
    reset() {
        this.stale = false;
        this.lagMs = 0;
        this.#clockOffsetMs = 0;
        this.#steadyLagMs = null;
        this.#catchingUp = false;
    }

    /**
     * Updates the stale state with the next live line.
     *
     * @param {Date} timestamp The log timestamp of the line.
     */
    update( timestamp ) {
        let lag = Date.now() - timestamp.getTime() - this.#clockOffsetMs;

        if ( Number.isNaN( lag ) ) {
            this.stale = false;
            this.lagMs = 0;
            return;
        }

        if ( Math.abs( lag ) > staleLineMs ) {
            // A lag that is a whole number of hours (to within the stale limit) is a clock offset such as a time zone
            // or DST mismatch, not a backlog, so it is learned instead of muting alerts.
            const hours = Math.round( lag / hourMs ) * hourMs;
            if ( hours !== 0 && Math.abs( lag - hours ) <= staleLineMs ) {
                this.#clockOffsetMs += hours;
                lag -= hours;
            }
        }

        if ( Math.abs( lag ) > staleLineMs ) {
            // A backlog's lag shrinks as Nag catches up.  A lag that stays constant while lines keep arriving is a
            // clock offset (for example a half-hour time zone), so it is learned instead of muting every alert.
            const now = Date.now();
            if ( this.#steadyLagMs === null || Math.abs( lag - this.#steadyLagMs ) > steadyToleranceMs ) {
                this.#steadyLagMs = lag;
                this.#steadySinceMs = now;
                this.#steadyLineCount = 1;
            } else {
                this.#steadyLineCount++;
                if ( now - this.#steadySinceMs >= steadyWindowMs && this.#steadyLineCount >= steadyMinLines ) {
                    this.#clockOffsetMs += lag;
                    lag = 0;
                    this.#steadyLagMs = null;
                }
            }
        } else {
            this.#steadyLagMs = null;
        }

        this.lagMs = lag;
        this.stale = lag > staleLineMs;

        if ( this.stale && !this.#catchingUp ) {
            this.#catchingUp = true;
            this.#onCatchingUp?.();
        } else if ( !this.stale && this.#catchingUp ) {
            this.#catchingUp = false;
            this.#onCaughtUp?.();
        }
    }

}

module.exports = {
    StaleLineTracker,
    staleLineMs,
};

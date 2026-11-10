const windowMs = 10 * 60 * 1000;

/**
 * Follows the zone-in and /who messages of one log to find which name /who reports for a zone-in name.
 */
class ZoneTracker {

    /** @type {string | null} */
    #enteredZone = null;
    #enteredAt = 0;

    /**
     * Call when the loading screen message is seen. A /who after it needs a new zone-in message to pair with.
     */
    loading() {
        this.#enteredZone = null;
    }

    /**
     * Call when a zone-in message is seen.
     *
     * @param {string} zone The zone name from the message.
     * @param {number} now The current time in milliseconds.
     * @returns {{ zone: string }} The message to send to the zone knowledge store.
     */
    entered( zone, now ) {
        this.#enteredZone = this.#clean( zone );
        this.#enteredAt = now;
        return { zone: this.#enteredZone };
    }

    /**
     * Call when your own /who line is seen.
     *
     * @param {string} zone The zone name from the line.
     * @param {number} now The current time in milliseconds.
     * @returns {{ zone: string, from?: string, to?: string }} The message to send to the zone knowledge store.
     */
    who( zone, now ) {
        const name = this.#clean( zone );

        if ( this.#enteredZone && now - this.#enteredAt < windowMs && this.#enteredZone.toLowerCase() !== name.toLowerCase() ) {
            return { zone: name, from: this.#enteredZone, to: name };
        }

        return { zone: name };
    }

    /**
     * Removes a trailing instance number, which /who adds to the zone name.
     */
    #clean( zone ) {
        return String( zone ).trim().replace( /\s+\d+$/, '' );
    }

}

ZoneTracker.windowMs = windowMs;

module.exports = ZoneTracker;

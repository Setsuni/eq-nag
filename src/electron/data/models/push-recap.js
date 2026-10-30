class PushRecapPreferences {
    /** @type {string} */
    triggerId;
    /** @type {boolean} */
    enabled = false;
    /** @type {number} */
    quietGapSeconds = 30;
    /** @type {boolean} */
    showTab = false;
    /** @type {boolean} */
    saveRecaps = true;
}

module.exports = { PushRecapPreferences };

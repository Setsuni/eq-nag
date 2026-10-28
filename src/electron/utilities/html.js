const createDOMPurify = require( 'dompurify' );
const perf = require( './perf' );
const { sanitizeConfig, checkAttribute } = require( './sanitize-rules' );

/** @type {import('dompurify').DOMPurify} */
let purifier = null;

/** @type {import('dompurify').DOMPurify} */
let scrapePurifier = null;

// The scraped pages are never shown, so they only lose what can run code.
const scrapeConfig = {
    FORBID_TAGS: [ 'style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'dialog' ],
};










/**
 * Removes everything but simple formatting from the given HTML.  Use it for
 * every piece of trigger, package or log text that is assigned to innerHTML.
 * Do not use it on the app's own markup; sanitize the text that goes into the
 * app's templates instead.
 *
 * @param {string} html The html to sanitize.
 * @returns {string}
 */
function sanitizeHtml( html ) {
    if ( html === null || html === undefined || html === '' ) {
        return '';
    }
    const perfStart = perf.enabled ? perf.now() : 0;
    if ( purifier === null ) {
        purifier = createDOMPurify( window );
        purifier.addHook( 'uponSanitizeAttribute', checkAttribute );
    }
    const clean = purifier.sanitize( String( html ), sanitizeConfig );
    perf.enabled && perf.record( 'renderer: sanitize html', perfStart );
    return clean;
}










/**
 * Removes anything that can run code from a scraped web page.  Unlike
 * sanitizeHtml, image sources are kept, because the scrapers read them and the
 * page is never shown as trigger text.
 *
 * @param {string} html The html to sanitize.
 * @returns {string}
 */
function sanitizeScrapedHtml( html ) {
    if ( html === null || html === undefined || html === '' ) {
        return '';
    }
    scrapePurifier = scrapePurifier ?? createDOMPurify( window );
    return scrapePurifier.sanitize( String( html ), scrapeConfig );
}










module.exports = { sanitizeHtml, sanitizeScrapedHtml };

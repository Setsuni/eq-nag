const path = require( 'path' );
const fs = require( 'fs' );
const { hintTexts } = require( '../utilities/trigger-perf-analysis' );

const fileName = 'trigger-perf.json';

/**
 * Keeps the last trigger measurement report of each character in the user data folder.
 * Holds trigger ids, names and numbers only.
 */
class TriggerPerfStore {

    #file;

    /** @type {Record<string, any>|null} */
    #reports = null;

    /**
     * @param {string} userDataPath The user data folder.
     */
    constructor( userDataPath ) {
        this.#file = path.join( userDataPath, fileName );
    }

    #load() {
        if ( this.#reports ) {
            return this.#reports;
        }
        try {
            this.#reports = JSON.parse( fs.readFileSync( this.#file, 'utf8' ) );
        } catch {
            this.#reports = {};
        }
        return this.#reports;
    }

    /**
     * Gets the last report of a character.
     *
     * @param {string} characterId The character id.
     * @returns {any|null}
     */
    get( characterId ) {
        const report = this.#load()[ characterId ];
        if ( !report?.rows ) {
            return null;
        }
        return { ...report, rows: report.rows.map( row => ( { ...row, hints: row.hints.map( code => ( { code: code, text: hintTexts[ code ] } ) ).filter( h => h.text ) } ) ) };
    }

    /**
     * Stores the report of a character and writes the file.
     *
     * @param {string} characterId The character id.
     * @param {any} report The report.
     */
    set( characterId, report ) {
        const reports = this.#load();
        reports[ characterId ] = { ...report, rows: report.rows.map( row => ( { ...row, hints: row.hints.map( h => h.code ) } ) ) };
        try {
            const temp = `${this.#file}.tmp`;
            fs.writeFileSync( temp, JSON.stringify( reports ) );
            fs.renameSync( temp, this.#file );
        } catch {
            // The report stays available for this session.
        }
    }
}

module.exports = TriggerPerfStore;

const path = require( 'path' );
const fs = require( 'fs' );
const { hintTexts } = require( '../utilities/trigger-perf-analysis' );

const fileName = 'trigger-perf.json';
const maxRows = 50000;
const maxTextLength = 300;
const reportNumbers = [ 'startedAt', 'endedAt', 'lineCount', 'totalMs' ];
const rowNumbers = [ 'checked', 'fired', 'totalMs', 'maxMs', 'sharePercent', 'avgMsPerCheck' ];

/**
 * Checks a report that came from a log watcher or from disk and returns a clean copy of it.
 *
 * @param {any} report The report.
 * @returns {any|null} The report, or null when it is not a report.
 */
function sanitizeReport( report ) {
    if ( !report || typeof report !== 'object' || !Array.isArray( report.rows ) || reportNumbers.some( key => !Number.isFinite( report[ key ] ) ) ) {
        return null;
    }

    const rows = [];
    for ( const row of report.rows.slice( 0, maxRows ) ) {
        if ( !row || typeof row.triggerId !== 'string' || typeof row.name !== 'string' || rowNumbers.some( key => !Number.isFinite( row[ key ] ) ) ) {
            continue;
        }
        const codes = Array.isArray( row.hints ) ? row.hints.map( h => typeof h === 'string' ? h : h?.code ).filter( code => typeof code === 'string' && Object.hasOwn( hintTexts, code ) ) : [];
        rows.push( {
            triggerId: row.triggerId.slice( 0, maxTextLength ),
            name: row.name.slice( 0, maxTextLength ),
            checked: row.checked,
            fired: row.fired,
            totalMs: row.totalMs,
            maxMs: row.maxMs,
            samples: Number.isFinite( row.samples ) ? row.samples : 0,
            sharePercent: row.sharePercent,
            avgMsPerCheck: row.avgMsPerCheck,
            skipped: row.skipped === true,
            hints: codes.map( code => ( { code: code, text: hintTexts[ code ] } ) ),
        } );
    }

    return { startedAt: report.startedAt, endedAt: report.endedAt, lineCount: report.lineCount, totalMs: report.totalMs, rows: rows };
}

/**
 * Checks the counters a log watcher sent and returns a clean copy of them.
 *
 * @param {any} counters The counters by trigger id.
 * @returns {Record<string, {name: string, fired: number}>|null}
 */
function sanitizeCounters( counters ) {
    if ( !counters || typeof counters !== 'object' || Array.isArray( counters ) ) {
        return null;
    }
    const result = Object.create( null );
    for ( const id of Object.keys( counters ).slice( 0, maxRows ) ) {
        const c = counters[ id ];
        if ( c && typeof c.name === 'string' && Number.isFinite( c.fired ) ) {
            result[ id.slice( 0, maxTextLength ) ] = { name: c.name.slice( 0, maxTextLength ), fired: c.fired };
        }
    }
    return result;
}

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
        this.#reports = Object.create( null );
        try {
            const data = JSON.parse( fs.readFileSync( this.#file, 'utf8' ) );
            if ( data && typeof data === 'object' && !Array.isArray( data ) ) {
                for ( const characterId of Object.keys( data ) ) {
                    const report = sanitizeReport( data[ characterId ] );
                    if ( report ) {
                        this.#reports[ characterId ] = report;
                    }
                }
            }
        } catch {
            // No file yet, or one that cannot be read.
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
        return this.#load()[ characterId ] ?? null;
    }

    /**
     * The ids of the characters that have a stored report.
     *
     * @returns {string[]}
     */
    characterIds() {
        return Object.keys( this.#load() );
    }

    /**
     * The character whose report ended last, or null without reports.
     *
     * @returns {string|null}
     */
    latestCharacterId() {
        const reports = this.#load();
        return Object.keys( reports ).sort( ( a, b ) => reports[ b ].endedAt - reports[ a ].endedAt )[ 0 ] ?? null;
    }

    /**
     * Stores the report of a character and writes the file.
     *
     * @param {string} characterId The character id.
     * @param {any} report The report, already checked with sanitizeReport.
     */
    set( characterId, report ) {
        const reports = this.#load();
        reports[ characterId ] = report;
        try {
            const saved = {};
            for ( const id of Object.keys( reports ) ) {
                saved[ id ] = { ...reports[ id ], rows: reports[ id ].rows.map( row => ( { ...row, hints: row.hints.map( h => h.code ) } ) ) };
            }
            const temp = `${this.#file}.tmp`;
            fs.writeFileSync( temp, JSON.stringify( saved ) );
            fs.renameSync( temp, this.#file );
        } catch {
            // The report stays available for this session.
        }
    }
}

module.exports = TriggerPerfStore;
module.exports.sanitizeReport = sanitizeReport;
module.exports.sanitizeCounters = sanitizeCounters;

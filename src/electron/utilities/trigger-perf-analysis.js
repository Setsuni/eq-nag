// Turns a measurement from trigger-metrics.js into the rows and plain-words
// hints shown on the trigger performance page.

const MAX_ALTERNATIVES = 50;
const MIN_LITERAL_RUN = 3;
const manyPhrases = 20;
const firesOftenRatio = 0.02;
const firesOftenMin = 100;

const hintTexts = {
    'leading-wildcard': 'The phrase starts with a wildcard, so it cannot be skipped quickly. Start it with the fixed words.',
    'no-literal': 'The phrase has no run of 3 or more fixed characters, so it has to be tried on every line.',
    'many-alternatives': 'The phrase lists more than 50 alternatives. Split it into several triggers or shorten the list.',
    'nested-quantifier': 'The phrase repeats a group that already repeats something, which can get very slow.',
    'many-phrases': 'The trigger has 20 or more phrases, and every one is tried on each line.',
    'fires-often': 'The trigger fires on a large share of all lines. Its phrase may be too broad.',
};

/**
 * Describes a regular expression pattern for the slow-phrase rules.
 *
 * @param {string} source The pattern text.
 * @returns {{ longestLiteralRun: number, maxAlternatives: number, leadingWildcard: boolean, nestedQuantifier: boolean }}
 */
function analyzePattern( source ) {
    let run = 0;
    let longestLiteralRun = 0;
    let maxAlternatives = 0;
    const alternatives = [ 0 ];
    const endRun = () => {
        longestLiteralRun = Math.max( longestLiteralRun, run );
        run = 0;
    };

    for ( let i = 0; i < source.length; i++ ) {
        const c = source[ i ];

        if ( c === '\\' ) {
            const next = source[ i + 1 ] ?? '';
            i++;
            if ( /[dDwWsSbBnrtfv0-9kpPuxc]/.test( next ) ) {
                endRun();
            } else {
                run++;
            }
        } else if ( c === '[' ) {
            i++;
            while ( i < source.length && source[ i ] !== ']' ) {
                i += source[ i ] === '\\' ? 2 : 1;
            }
            endRun();
        } else if ( c === '(' ) {
            if ( source[ i + 1 ] === '?' ) {
                const prefix = /^\(\?(?:<[A-Za-z_][^>]*>|<=|<!|:|=|!)/.exec( source.substring( i ) );
                i += ( prefix ? prefix[ 0 ].length : 2 ) - 1;
            }
            alternatives.push( 0 );
            endRun();
        } else if ( c === ')' ) {
            if ( alternatives.length > 1 ) {
                maxAlternatives = Math.max( maxAlternatives, alternatives.pop() + 1 );
            }
            endRun();
        } else if ( c === '|' ) {
            alternatives[ alternatives.length - 1 ]++;
            endRun();
        } else if ( c === '*' || c === '?' ) {
            run = Math.max( 0, run - 1 );
            endRun();
        } else if ( c === '+' || c === '.' || c === '^' ) {
            endRun();
        } else if ( c === '{' || ( c === '$' && source[ i + 1 ] === '{' ) ) {
            const start = c === '$' ? i + 1 : i;
            const quantifier = /^\{(\d+)(?:,\d*)?\}/.exec( source.substring( start ) );
            if ( c === '{' && quantifier ) {
                if ( +quantifier[ 1 ] === 0 ) {
                    run = Math.max( 0, run - 1 );
                }
                i += quantifier[ 0 ].length - 1;
            } else {
                const end = source.indexOf( '}', start );
                i = end < 0 ? source.length : end;
            }
            endRun();
        } else if ( c === '$' ) {
            endRun();
        } else {
            run++;
        }
    }

    endRun();
    maxAlternatives = Math.max( maxAlternatives, alternatives[ 0 ] + 1 );

    return {
        longestLiteralRun,
        maxAlternatives,
        leadingWildcard: /^\^?(?:\(\?:)*\.[*+]/.test( source ),
        nestedQuantifier: /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test( source ),
    };
}

/**
 * Looks at a regular expression phrase for patterns that make matching slow.  Plain text phrases are not judged.
 *
 * @param {{phrase: string, useRegEx?: boolean}} capturePhrase The phrase.
 * @returns {string[]} The hint codes.
 */
function phraseHints( capturePhrase ) {
    const phrase = capturePhrase?.phrase;
    if ( !capturePhrase?.useRegEx || typeof phrase !== 'string' || phrase.length === 0 ) {
        return [];
    }

    const pattern = analyzePattern( phrase );
    const hints = [];
    if ( pattern.leadingWildcard ) {
        hints.push( 'leading-wildcard' );
    }
    if ( pattern.longestLiteralRun < MIN_LITERAL_RUN ) {
        hints.push( 'no-literal' );
    }
    if ( pattern.maxAlternatives > MAX_ALTERNATIVES ) {
        hints.push( 'many-alternatives' );
    }
    if ( pattern.nestedQuantifier ) {
        hints.push( 'nested-quantifier' );
    }
    return hints;
}

/**
 * Builds the rows of a measurement, sorted by share of the total trigger time.
 *
 * @param {{startedAt: number, endedAt: number, lineCount: number, triggers: Record<string, {checked: number, fired: number, totalMs: number, maxMs: number}>}} measurement The measurement.
 * @param {{triggerId: string, name: string, capturePhrases?: {phrase: string, useRegEx?: boolean}[]}[]} triggers The triggers that were measured.
 */
function buildReport( measurement, triggers ) {
    // Triggers that were never checked have no time and stay out of the share base.
    let totalMs = 0;
    for ( const id in measurement.triggers ) {
        if ( measurement.triggers[ id ].checked > 0 ) {
            totalMs += measurement.triggers[ id ].totalMs;
        }
    }

    const rows = triggers.filter( t => measurement.triggers[ t.triggerId ] ).map( trigger => {
        const m = measurement.triggers[ trigger.triggerId ];
        const codes = new Set();
        trigger.capturePhrases?.forEach( p => phraseHints( p ).forEach( code => codes.add( code ) ) );
        if ( trigger.capturePhrases?.length >= manyPhrases ) {
            codes.add( 'many-phrases' );
        }
        if ( m.fired >= firesOftenMin && measurement.lineCount > 0 && m.fired / measurement.lineCount >= firesOftenRatio ) {
            codes.add( 'fires-often' );
        }

        return {
            triggerId: trigger.triggerId,
            name: trigger.name,
            checked: m.checked,
            fired: m.fired,
            totalMs: m.totalMs,
            maxMs: m.maxMs,
            samples: m.samples ?? 0,
            sharePercent: totalMs > 0 && m.checked > 0 ? m.totalMs / totalMs * 100 : 0,
            avgMsPerCheck: m.checked > 0 ? m.totalMs / m.checked : 0,
            skipped: m.checked === 0,
            hints: [ ...codes ].map( code => ( { code: code, text: hintTexts[ code ] } ) ),
        };
    } );
    rows.sort( ( a, b ) => ( a.skipped ? 1 : 0 ) - ( b.skipped ? 1 : 0 ) || b.totalMs - a.totalMs || b.checked - a.checked );

    return {
        startedAt: measurement.startedAt,
        endedAt: measurement.endedAt,
        lineCount: measurement.lineCount,
        totalMs: totalMs,
        rows: rows,
    };
}

module.exports = { buildReport, phraseHints, analyzePattern, hintTexts, MIN_LITERAL_RUN, MAX_ALTERNATIVES };

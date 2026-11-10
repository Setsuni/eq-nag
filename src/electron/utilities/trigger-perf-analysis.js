// Turns a measurement from trigger-metrics.js into the rows and plain-words
// hints shown on the trigger performance page.

const manyAlternatives = 50;
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
 * Finds the longest run of fixed characters in a regular expression.
 *
 * @param {string} pattern The regular expression source.
 * @returns {number} The length of the run.
 */
function longestRegexLiteral( pattern ) {
    let best = 0;
    let run = 0;
    const end = () => {
        best = Math.max( best, run );
        run = 0;
    };

    for ( let i = 0; i < pattern.length; i++ ) {
        const c = pattern[ i ];
        if ( c === '\\' ) {
            const n = pattern[ ++i ];
            if ( n != null && 'dDwWsSbBnrtfvk0123456789'.includes( n ) ) {
                end();
            } else {
                run++;
            }
        } else if ( c === '[' ) {
            end();
            while ( i < pattern.length && pattern[ i ] !== ']' ) {
                i += pattern[ i ] === '\\' ? 2 : 1;
            }
        } else if ( c === '{' ) {
            // A counted repeat makes the character before it optional or repeated.
            run = Math.max( 0, run - 1 );
            end();
            while ( i < pattern.length && pattern[ i ] !== '}' ) {
                i++;
            }
        } else if ( c === '*' || c === '?' ) {
            // Makes the character before it optional.
            run = Math.max( 0, run - 1 );
            end();
        } else if ( '()|.+^$'.includes( c ) ) {
            end();
        } else {
            run++;
        }
    }
    end();
    return best;
}

/**
 * Finds the longest run of fixed characters in a plain phrase, where {S}-style codes are not fixed.
 *
 * @param {string} phrase The phrase.
 */
function longestPlainLiteral( phrase ) {
    return phrase.split( /{[^}]*}/ ).reduce( ( max, part ) => Math.max( max, part.length ), 0 );
}

/**
 * Looks at a phrase for patterns that make matching slow.
 *
 * @param {{phrase: string, useRegEx?: boolean}} capturePhrase The phrase.
 * @returns {string[]} The hint codes.
 */
function phraseHints( capturePhrase ) {
    const phrase = capturePhrase?.phrase;
    if ( typeof phrase !== 'string' || phrase.length === 0 ) {
        return [];
    }

    const hints = [];
    if ( capturePhrase.useRegEx ) {
        const body = phrase.replace( /^\^/, '' ).replace( /^(\((\?:|\?<[A-Za-z0-9_]+>)?)+/, '' );
        if ( body.startsWith( '.*' ) || body.startsWith( '.+' ) ) {
            hints.push( 'leading-wildcard' );
        }
        if ( longestRegexLiteral( phrase ) < 3 ) {
            hints.push( 'no-literal' );
        }
        if ( phrase.replace( /\\./g, '' ).split( '|' ).length > manyAlternatives ) {
            hints.push( 'many-alternatives' );
        }
        if ( /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test( phrase ) ) {
            hints.push( 'nested-quantifier' );
        }
    } else {
        if ( /^{[^}]*}/.test( phrase ) ) {
            hints.push( 'leading-wildcard' );
        }
        if ( longestPlainLiteral( phrase ) < 3 ) {
            hints.push( 'no-literal' );
        }
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
    let totalMs = 0;
    for ( const id in measurement.triggers ) {
        totalMs += measurement.triggers[ id ].totalMs;
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
            sharePercent: totalMs > 0 ? m.totalMs / totalMs * 100 : 0,
            avgMsPerCheck: m.checked > 0 ? m.totalMs / m.checked : 0,
            skipped: m.checked === 0,
            hints: [ ...codes ].map( code => ( { code: code, text: hintTexts[ code ] } ) ),
        };
    } );
    rows.sort( ( a, b ) => b.totalMs - a.totalMs );

    return {
        startedAt: measurement.startedAt,
        endedAt: measurement.endedAt,
        lineCount: measurement.lineCount,
        totalMs: totalMs,
        rows: rows,
    };
}

module.exports = { buildReport, phraseHints, longestRegexLiteral, hintTexts };

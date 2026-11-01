// Trigger prefilter: answers only "this trigger can't match this log line".
//
// Every phrase gives one required literal (or a few, one per top-level
// alternative of a regex).  A phrase whose literal isn't in the line can't
// match it, so its trigger doesn't need to run.  Anything that can't be
// reduced to a literal for sure is never filtered out: a candidate list may
// have extra triggers but must never miss one.
//
// Literals are compared in lower case and cut to maxLiteralLength characters
// (a prefix of a required literal is also required).

const minRegexLiteralLength = 3;
const maxLiteralLength = 16;
const braceQuantifier = /\{(\d+)(?:,\d*)?\}/y;

/**
 * Returns the literal a plain phrase needs in the log line, in lower case, or
 * null if the phrase can't be filtered (empty, or uses stored variables).
 *
 * @param {string} phrase The phrase.
 * @returns {string|null}
 */
function extractPlainLiteral( phrase ) {
    if ( typeof phrase !== 'string' || phrase.length === 0 || phrase.includes( '${' ) ) {
        return null;
    }

    return phrase.toLowerCase().slice( 0, maxLiteralLength );
}

/**
 * Returns the index after the group that starts at the given index, or -1 if
 * it isn't closed.
 *
 * @param {string} source The regex source.
 * @param {number} start The index of the opening parenthesis.
 */
function skipGroup( source, start ) {
    let depth = 0;
    let i = start;

    while ( i < source.length ) {
        const c = source[ i ];

        if ( c === '\\' ) {
            i += 2;
        } else if ( c === '[' ) {
            i = skipClass( source, i );
            if ( i < 0 ) {
                return -1;
            }
        } else if ( c === '{' ) {
            const close = source.indexOf( '}', i );
            i = close < 0 ? i + 1 : close + 1;
        } else if ( c === '(' ) {
            depth++;
            i++;
        } else if ( c === ')' ) {
            depth--;
            i++;
            if ( depth === 0 ) {
                return i;
            }
        } else {
            i++;
        }
    }

    return -1;
}

/**
 * Returns the index after the character class that starts at the given index,
 * or -1 if it isn't closed.
 *
 * @param {string} source The regex source.
 * @param {number} start The index of the opening bracket.
 */
function skipClass( source, start ) {
    let i = start + 1;

    if ( source[ i ] === '^' ) {
        i++;
    }

    while ( i < source.length ) {
        if ( source[ i ] === '\\' ) {
            i += 2;
        } else if ( source[ i ] === ']' ) {
            return i + 1;
        } else {
            i++;
        }
    }

    return -1;
}

/**
 * Returns one required literal per top-level alternative of a regex phrase, in
 * lower case, or null if any alternative has none (or the source can't be
 * scanned), in which case the phrase can't be filtered.  Only literal text
 * that every match must contain is used: shortcodes, groups, classes, anchors,
 * optional characters and non-ASCII characters all end a literal.
 *
 * @param {string} source The phrase, as the user wrote it.
 * @returns {string[]|null}
 */
function extractRegexLiterals( source ) {
    if ( typeof source !== 'string' || source.length === 0 ) {
        return null;
    }

    /** @type {string[]} */
    const literals = [];
    let best = '';
    let run = '';
    let atBranchStart = true;
    let i = 0;

    const endRun = () => {
        if ( run.length > best.length ) {
            best = run;
        }
        run = '';
    };

    while ( i < source.length ) {
        const c = source[ i ];

        if ( c === '|' ) {
            endRun();
            if ( best.length < minRegexLiteralLength ) {
                return null;
            }
            literals.push( best.slice( 0, maxLiteralLength ).toLowerCase() );
            best = '';
            atBranchStart = true;
            i++;
            continue;
        }

        if ( c === '{' ) {
            // Shortcodes and quantifiers: skip to the closing brace.
            const close = source.indexOf( '}', i );
            endRun();
            atBranchStart = false;
            i = close < 0 ? i + 1 : close + 1;
            continue;
        }

        if ( c === '*' || c === '+' || c === '?' ) {
            if ( atBranchStart ) {
                return null;
            }
            endRun();
            i++;
            continue;
        }

        if ( c === ')' ) {
            return null;
        }

        /** @type {string|null} */
        let literal = null;
        let next = i + 1;

        if ( c === '\\' ) {
            if ( i + 1 >= source.length ) {
                return null;
            }
            const escaped = source[ i + 1 ];
            next = i + 2;
            if ( escaped.charCodeAt( 0 ) < 128 && !/[A-Za-z0-9]/.test( escaped ) ) {
                literal = escaped;
            }
        } else if ( c === '(' ) {
            next = skipGroup( source, i );
            if ( next < 0 ) {
                return null;
            }
        } else if ( c === '[' ) {
            next = skipClass( source, i );
            if ( next < 0 ) {
                return null;
            }
        } else if ( c.charCodeAt( 0 ) < 128 && !'^$.]}'.includes( c ) ) {
            literal = c;
        }

        atBranchStart = false;

        // Take the quantifier that follows the atom, if any.
        let quantifier = null;
        const q = source[ next ];
        if ( q === '*' || q === '+' || q === '?' ) {
            quantifier = q;
            next++;
            if ( source[ next ] === '?' ) {
                next++;
            }
            if ( source[ next ] === '*' || source[ next ] === '+' || source[ next ] === '?' ) {
                return null;
            }
        } else if ( q === '{' ) {
            // A numeric quantifier; other braces are shortcodes, which the main loop skips.
            braceQuantifier.lastIndex = next;
            const match = braceQuantifier.exec( source );
            if ( match ) {
                quantifier = +match[ 1 ] === 0 ? '*' : '+';
                next += match[ 0 ].length;
                if ( source[ next ] === '?' ) {
                    next++;
                }
            }
        }

        if ( literal === null ) {
            endRun();
        } else if ( quantifier === '*' || quantifier === '?' ) {
            endRun();
        } else if ( quantifier === '+' ) {
            run += literal;
            endRun();
        } else {
            run += literal;
        }

        i = next;
    }

    endRun();
    if ( best.length < minRegexLiteralLength ) {
        return null;
    }
    literals.push( best.slice( 0, maxLiteralLength ).toLowerCase() );

    return literals;
}

/**
 * Builds an Aho-Corasick automaton over the given literals.
 *
 * @param {{literal: string, key: number}[]} entries The literals, each with the key to mark when it's found.
 */
function build( entries ) {
    // Plain trie first.
    /** @type {Map<number, number>[]} */
    const children = [ new Map() ];
    /** @type {(number[]|undefined)[]} */
    const keysAt = [ undefined ];

    entries.forEach( entry => {
        if ( !entry.literal ) {
            return;
        }

        let node = 0;
        for ( let i = 0; i < entry.literal.length; i++ ) {
            const code = entry.literal.charCodeAt( i );
            let child = children[ node ].get( code );
            if ( child === undefined ) {
                child = children.length;
                children.push( new Map() );
                keysAt.push( undefined );
                children[ node ].set( code, child );
            }
            node = child;
        }

        ( keysAt[ node ] ??= [] ).push( entry.key );
    } );

    const count = children.length;
    const fail = new Int32Array( count );
    const dict = new Int32Array( count );

    // Single-child nodes keep one char code and one target; only branching
    // nodes get a Map.  singleChar: -1 no children, -2 branching, else the code.
    const singleChar = new Int32Array( count ).fill( -1 );
    const singleNext = new Int32Array( count );
    /** @type {(Map<number, number>|undefined)[]} */
    const branches = new Array( count );

    for ( let n = 0; n < count; n++ ) {
        const kids = children[ n ];
        if ( kids.size === 1 ) {
            const [ code, next ] = kids.entries().next().value;
            singleChar[ n ] = code;
            singleNext[ n ] = next;
        } else if ( kids.size > 1 ) {
            singleChar[ n ] = -2;
            branches[ n ] = kids;
        }
    }

    const step = ( node, code ) => {
        const sc = singleChar[ node ];
        if ( sc === code ) {
            return singleNext[ node ];
        }
        if ( sc === -2 ) {
            const next = branches[ node ].get( code );
            if ( next !== undefined ) {
                return next;
            }
        }
        return -1;
    };

    // Failure links, breadth first.
    const queue = [];
    children[ 0 ].forEach( child => queue.push( child ) );

    for ( let q = 0; q < queue.length; q++ ) {
        const node = queue[ q ];

        children[ node ].forEach( ( child, code ) => {
            let f = fail[ node ];
            let target = step( f, code );
            while ( target < 0 && f !== 0 ) {
                f = fail[ f ];
                target = step( f, code );
            }
            fail[ child ] = target < 0 ? 0 : target;
            dict[ child ] = keysAt[ fail[ child ] ] ? fail[ child ] : dict[ fail[ child ] ];
            queue.push( child );
        } );
    }

    children.length = 0;

    return {
        nodeCount: count,

        /**
         * Sets marks[ key ] = stamp for every literal found in the line.
         *
         * @param {string} lowerLine The log line, in lower case.
         * @param {{[key: number]: number}} marks The marks, indexed by key.
         * @param {number} stamp The value to mark with.
         */
        candidates( lowerLine, marks, stamp ) {
            let state = 0;

            for ( let i = 0; i < lowerLine.length; i++ ) {
                const code = lowerLine.charCodeAt( i );
                let next = step( state, code );
                while ( next < 0 && state !== 0 ) {
                    state = fail[ state ];
                    next = step( state, code );
                }
                state = next < 0 ? 0 : next;

                let out = keysAt[ state ] ? state : dict[ state ];
                while ( out > 0 ) {
                    const keys = keysAt[ out ];
                    for ( let k = 0; k < keys.length; k++ ) {
                        marks[ keys[ k ] ] = stamp;
                    }
                    out = dict[ out ];
                }
            }
        },
    };
}

module.exports = { extractPlainLiteral, extractRegexLiterals, build, minRegexLiteralLength, maxLiteralLength };

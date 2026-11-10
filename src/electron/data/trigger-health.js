const StringUtilities = require( '../utilities/string' );
const { analyzePattern, phraseHints, MIN_LITERAL_RUN, MAX_ALTERNATIVES } = require( '../utilities/trigger-perf-analysis' );

// Numeric values mirror OperatorTypes, TriggerConditionTypes and ActionTypes in core.model.ts.
const OP_IS_NULL = 0;
const OP_EQUALS = 1;
const OP_CONTAINS = 16;
const CONDITION_VARIABLE = 1;
const ACTION_STORE_VARIABLE = 5;
const ACTION_LIST = 15;

const ZONE_VARIABLE = 'CurrentZone';
const SEVERITY_ORDER = { never: 0, may: 1, cost: 2, info: 3 };
const MAX_ZONE_SUGGEST_DISTANCE = 2;
const MIN_ZONE_SUGGEST_LENGTH = 5;
const REGEX_LOOKING_TEXT = /^\^|\$$|\\\.|\(\?<|\\d/;

/** The checks, in the order they are numbered in the design. */
const CHECKS = {
    zoneEquals: { number: 1, severity: 'info', level: 'advanced' },
    zoneAlias: { number: 2, severity: 'may', level: 'default' },
    zoneUnknown: { number: 3, severity: 'may', level: 'default' },
    phraseInvalid: { number: 4, severity: 'never', level: 'default' },
    noPhrase: { number: 5, severity: 'never', level: 'default' },
    actionUnlinked: { number: 6, severity: 'never', level: 'default' },
    emptyCondition: { number: 7, severity: 'never', level: 'default' },
    storeUsedContains: { number: 8, severity: 'may', level: 'advanced' },
    plainLooksRegex: { number: 9, severity: 'may', level: 'default' },
    plainListCode: { number: 10, severity: 'never', level: 'advanced' },
    devOnly: { number: 11, severity: 'info', level: 'advanced' },
    classUnused: { number: 12, severity: 'info', level: 'advanced' },
    slowPhrase: { number: 13, severity: 'cost', level: 'advanced' },
};

/**
 * The action type names of getActionLabel in models/trigger. That module is not required here because it and the
 * string utilities require each other, which prints a circular dependency warning.
 */
const ACTION_LABELS = [
    'Display Text', 'Play Audio', 'Speak', 'Timer', 'Countdown', 'Store Variable', 'Dot Timer', 'Clear Variable',
    'Counter', 'Clipboard', 'Beneficial Timer', 'Display Death Recap', 'Screen Glow', 'Clear All', 'Stopwatch', 'List',
];

/**
 * Returns the name of an action type.
 *
 * @param {number} actionType The action type.
 * @returns {string}
 */
function actionLabel( actionType ) {
    return ACTION_LABELS[ actionType ] ?? 'Unknown';
}

/**
 * Removes a trailing instance number, the way /who adds one to a zone name.
 *
 * @param {string} name The zone name.
 * @returns {string}
 */
function stripInstance( name ) {
    return String( name ).replace( /\s+\d+$/, '' );
}

/**
 * Returns the edit distance between two strings, or max + 1 when it is larger than max.
 *
 * @param {string} a The first string.
 * @param {string} b The second string.
 * @param {number} max The largest distance of interest.
 * @returns {number}
 */
function editDistanceWithin( a, b, max ) {
    if ( Math.abs( a.length - b.length ) > max ) {
        return max + 1;
    }

    let previous = [];
    for ( let j = 0; j <= b.length; j++ ) {
        previous[ j ] = j;
    }

    for ( let i = 1; i <= a.length; i++ ) {
        const current = [ i ];
        let rowMin = i;
        for ( let j = 1; j <= b.length; j++ ) {
            const cost = a[ i - 1 ] === b[ j - 1 ] ? 0 : 1;
            current[ j ] = Math.min( previous[ j ] + 1, current[ j - 1 ] + 1, previous[ j - 1 ] + cost );
            rowMin = Math.min( rowMin, current[ j ] );
        }

        if ( rowMin > max ) {
            return max + 1;
        }
        previous = current;
    }

    return previous[ b.length ];
}

/**
 * Shortens the given text for display.
 *
 * @param {string} text The text to shorten.
 * @param {number} length The longest result allowed.
 * @returns {string}
 */
function shorten( text, length = 60 ) {
    text = String( text ?? '' ).replace( /\s+/g, ' ' );
    return text.length > length ? text.substring( 0, length - 1 ) + '…' : text;
}

/**
 * Renders a regular expression phrase the way the log watcher does and compiles it.
 *
 * @param {object} trigger The trigger the phrase belongs to.
 * @param {object} phrase The capture phrase.
 * @returns {{ source: string, error: string | null }}
 */
function compilePhrase( trigger, phrase ) {
    let source = phrase.phrase;

    try {
        const nConditional = StringUtilities.parseNConditionalCodesToRegex( source, 'Soandso' );
        source = nConditional?.value ?? source;
        source = StringUtilities.parseShortCodesToRegex( source, 'Soandso' );

        const variableConditional = StringUtilities.parseStoredVariablesToRegexConditional( source, {} );
        if ( variableConditional?.operations.length > 0 ) {
            source = variableConditional.value;
        }

        if ( trigger.actions?.some( a => a?.actionType === ACTION_LIST ) ) {
            const listConditional = StringUtilities.parseListCodesToRegexConditionals( source );
            if ( listConditional?.operations.length > 0 ) {
                source = listConditional.value;
            }
        }

        if ( trigger.captureMethod === 'Sequential' ) {
            const sequentialConditional = StringUtilities.parseSequentialGroupsToRegexConditionals( source );
            if ( sequentialConditional?.operations.length > 0 ) {
                source = sequentialConditional.value;
            }
        }

        new RegExp( source, phrase.ignoreCase ? 'i' : undefined );
        return { source, error: null };
    } catch ( error ) {
        return { source, error: String( error?.message ?? error ) };
    }
}

/**
 * Builds the lookup structures for zone names.
 *
 * @param {string[]} zones The built-in zone names.
 * @param {{ zones?: string[], pairs?: { from: string, to: string }[] }} knowledge The zone knowledge.
 */
function buildZoneIndex( zones, knowledge ) {
    const names = new Map();
    const add = name => {
        const trimmed = String( name ?? '' ).trim();
        if ( trimmed.length > 0 && !names.has( trimmed.toLowerCase() ) ) {
            names.set( trimmed.toLowerCase(), trimmed );
        }
    };

    zones?.forEach( add );
    knowledge?.zones?.forEach( add );

    /** @type {Map<string, { to: string, seed: boolean }[]>} */
    const aliases = new Map();
    knowledge?.pairs?.forEach( pair => {
        add( pair.from );
        add( pair.to );
        const key = String( pair.from ).trim().toLowerCase();
        const targets = aliases.get( key ) ?? [];
        if ( !targets.some( t => t.to.toLowerCase() === String( pair.to ).trim().toLowerCase() ) ) {
            targets.push( { to: String( pair.to ).trim(), seed: pair.seed === true } );
        }
        aliases.set( key, targets );
    } );

    const containing = new Map();
    const suggestions = new Map();

    return {
        names,
        aliases,

        /** Returns true if the name, or the name without an instance number, is a known zone. */
        isKnown( name ) {
            const lower = name.toLowerCase();
            return names.has( lower ) || names.has( stripInstance( lower ) );
        },

        /** Returns true if the name is part of at least one known zone name. */
        isPartOfKnown( name ) {
            const lower = name.toLowerCase();
            for ( const known of names.keys() ) {
                if ( known.includes( lower ) ) {
                    return true;
                }
            }
            return false;
        },

        /** Returns the other known zone names that contain the given name, leaving out event and difficulty variants such as "Zone: Event" or "Zone - Hard", which /who reports as the plain zone. */
        otherZonesContaining( name ) {
            const lower = name.toLowerCase();
            if ( !containing.has( lower ) ) {
                const found = [];
                for ( const [ known, original ] of names ) {
                    if ( known !== lower && known.includes( lower ) && !known.includes( ': ' ) && !known.startsWith( `${lower} - ` ) ) {
                        found.push( original );
                    }
                }
                containing.set( lower, found );
            }
            return containing.get( lower );
        },

        /** Returns the one known zone within a couple of edits, or null. */
        suggest( name ) {
            const lower = name.toLowerCase();
            if ( !suggestions.has( lower ) ) {
                let result = null;
                if ( lower.length >= MIN_ZONE_SUGGEST_LENGTH ) {
                    const close = [];
                    for ( const [ known, original ] of names ) {
                        if ( editDistanceWithin( lower, known, MAX_ZONE_SUGGEST_DISTANCE ) <= MAX_ZONE_SUGGEST_DISTANCE ) {
                            close.push( original );
                        }
                    }
                    result = close.length === 1 ? close[ 0 ] : null;
                }
                suggestions.set( lower, result );
            }
            return suggestions.get( lower );
        },
    };
}

/**
 * Splits the given condition value into its alternatives, the way the log watcher does.
 *
 * @param {string} value The condition value.
 * @returns {string[]}
 */
function splitValue( value ) {
    return String( value ).split( '|' );
}

/**
 * Returns true if an alternative of the condition value already covers the target zone name.
 *
 * @param {number} operator The condition operator.
 * @param {string[]} alternatives The trimmed alternatives of the condition.
 * @param {string} target The zone name.
 */
function covers( operator, alternatives, target ) {
    const lower = target.toLowerCase();
    return alternatives.some( alt => operator === OP_EQUALS ? alt === target : alt.length > 0 && lower.includes( alt.toLowerCase() ) );
}

/**
 * Runs the health checks over the given triggers and folders.
 *
 * @param {{
 *   triggers: any[],
 *   folders: any[],
 *   zones?: string[],
 *   zoneKnowledge?: { zones?: string[], pairs?: { from: string, to: string }[] },
 *   packages?: { packageId: string, name?: string, author?: string, authorDiscord?: string }[],
 *   characterClasses?: string[],
 * }} input The data to check.
 * @returns {{ summary: object, findings: object[] }}
 */
function checkTriggerHealth( input ) {
    const triggers = ( input.triggers ?? [] ).filter( t => t != null );
    const folders = input.folders ?? [];
    const zoneIndex = buildZoneIndex( input.zones ?? [], input.zoneKnowledge );
    const packageMap = new Map( ( input.packages ?? [] ).map( p => [ p.packageId, p ] ) );
    const characterClasses = new Set( ( input.characterClasses ?? [] ).filter( c => c?.trim() ) );
    const hasClasslessCharacter = ( input.characterClasses ?? [] ).some( c => !c?.trim() );

    /** @type {Map<string, { folder: any, path: string, parentId: string | null }>} */
    const folderInfo = new Map();
    const indexFolders = ( list, parentPath, parentId ) => {
        list?.forEach( folder => {
            const path = parentPath ? `${parentPath} / ${folder.name}` : folder.name;
            folderInfo.set( folder.folderId, { folder, path, parentId } );
            indexFolders( folder.children, path, folder.folderId );
        } );
    };
    indexFolders( folders, '', null );

    /** @type {Map<string, string[]>} Trigger ids by folder id, including all sub-folders. */
    const triggerIdsByFolder = new Map();
    triggers.forEach( trigger => {
        let id = trigger.folderId;
        const seen = new Set();
        while ( id != null && folderInfo.has( id ) && !seen.has( id ) ) {
            seen.add( id );
            if ( !triggerIdsByFolder.has( id ) ) {
                triggerIdsByFolder.set( id, [] );
            }
            triggerIdsByFolder.get( id ).push( trigger.triggerId );
            id = folderInfo.get( id ).parentId;
        }
    } );

    /** @type {Map<string, any[]>} Value conditions by variable name, from triggers and folders. */
    const conditionsByVariable = new Map();
    const collectConditions = conditions => {
        conditions?.forEach( condition => {
            if ( condition?.conditionType === CONDITION_VARIABLE && condition.variableName && !StringUtilities.isNullOrWhitespace( condition.variableValue ) ) {
                if ( !conditionsByVariable.has( condition.variableName ) ) {
                    conditionsByVariable.set( condition.variableName, [] );
                }
                conditionsByVariable.get( condition.variableName ).push( condition );
            }
        } );
    };
    triggers.forEach( trigger => Array.isArray( trigger.conditions ) && collectConditions( trigger.conditions ) );
    folderInfo.forEach( info => collectConditions( info.folder.folderConditions ) );

    /** @type {any[]} */
    const findings = [];

    const packageOf = triggerIds => {
        const hits = [];
        triggerIds.forEach( id => {
            const trigger = triggerById.get( id );
            const pkg = trigger?.packageId ? packageMap.get( trigger.packageId ) : undefined;
            if ( pkg && !hits.includes( pkg ) ) {
                hits.push( pkg );
            }
        } );
        return hits.length > 0
            ? { packageId: hits[ 0 ].packageId, name: hits[ 0 ].name ?? '', author: hits[ 0 ].author ?? '', authorDiscord: hits[ 0 ].authorDiscord ?? '' }
            : null;
    };
    const triggerById = new Map( triggers.map( t => [ t.triggerId, t ] ) );

    /**
     * Adds a finding for a trigger or a folder.
     */
    const add = ( check, subject, key, reason, extra = {} ) => {
        const meta = CHECKS[ check ];
        const triggerIds = subject.kind === 'folder' ? ( triggerIdsByFolder.get( subject.id ) ?? [] ) : [ subject.id ];
        const finding = {
            id: `${check}:${subject.kind}:${subject.id}:${key}`,
            check,
            checkNumber: meta.number,
            severity: extra.severity ?? meta.severity,
            level: extra.level ?? meta.level,
            subject: {
                kind: subject.kind,
                id: subject.id,
                name: subject.name,
                folderId: subject.folderId ?? null,
                folderPath: folderInfo.get( subject.folderId )?.path ?? '(no folder)',
                disabled: subject.disabled === true,
            },
            affectedTriggerIds: triggerIds,
            reason,
            detail: extra.detail ?? null,
            needsLook: extra.needsLook === true,
            fix: extra.fix ?? null,
            package: packageOf( triggerIds ),
        };

        if ( finding.fix ) {
            finding.fix.bulk = finding.fix.safe === true && !finding.needsLook && finding.package == null && finding.level === 'default';
        }

        findings.push( finding );
    };

    const triggerSubject = trigger => ( {
        kind: 'trigger',
        id: trigger.triggerId,
        name: trigger.name ?? '',
        folderId: trigger.folderId,
        disabled: !trigger.enabled,
    } );

    /**
     * Checks one condition of a trigger or folder.
     */
    const checkCondition = ( condition, index, subject, patchTarget ) => {
        if ( condition?.conditionType !== CONDITION_VARIABLE ) {
            return;
        }

        const conditionRef = { ...patchTarget, conditionId: condition.conditionId ?? null, conditionIndex: index };
        const key = condition.conditionId ?? `#${index}`;
        const operator = condition.operatorType;
        const value = condition.variableValue;
        const label = condition.variableName === ZONE_VARIABLE ? 'zone condition' : `condition on ${condition.variableName}`;

        if ( !value && operator === OP_EQUALS ) {
            add( 'emptyCondition', subject, key,
                `The ${label} requires an empty value to be equal to something, so it can never pass. It probably should say "is empty".`,
                {
                    fix: {
                        label: 'Switch to "Is empty"',
                        safe: true,
                        patches: [ { ...conditionRef, field: 'operatorType', from: OP_EQUALS, to: OP_IS_NULL } ],
                    },
                } );
            return;
        }

        if ( !value && operator === OP_CONTAINS ) {
            add( 'emptyCondition', subject, key, `The ${label} looks for nothing, so it can never pass.` );
            return;
        }

        if ( condition.variableName !== ZONE_VARIABLE || !value || ( operator !== OP_EQUALS && operator !== OP_CONTAINS ) ) {
            return;
        }

        const operatorName = operator === OP_EQUALS ? 'Equals' : 'Contains';
        const raw = splitValue( value );
        const alternatives = raw.map( v => v.trim() ).filter( v => v.length > 0 );

        // 2: /who reports a different name than the zone-in message.
        const missingTargets = [];
        const aliasNotes = [];
        let learnedAlias = false;
        alternatives.forEach( alt => {
            const targets = [ ...( zoneIndex.aliases.get( alt.toLowerCase() ) ?? [] ) ];
            const eventPrefix = /^(.+?):\s+\S.*$/.exec( alt );
            if ( eventPrefix && zoneIndex.names.has( eventPrefix[ 1 ].toLowerCase() ) && !targets.some( t => t.to.toLowerCase() === eventPrefix[ 1 ].toLowerCase() ) ) {
                targets.push( { to: zoneIndex.names.get( eventPrefix[ 1 ].toLowerCase() ), seed: true } );
            }

            targets.forEach( ( { to: target, seed } ) => {
                if ( !covers( operator, alternatives, target ) && !missingTargets.some( m => m.toLowerCase() === target.toLowerCase() ) ) {
                    missingTargets.push( target );
                    learnedAlias = learnedAlias || !seed;
                    aliasNotes.push( `${alt}" as "${target}` );
                }
            } );
        } );

        if ( missingTargets.length > 0 ) {
            add( 'zoneAlias', subject, key,
                `The ${label} says "${alternatives.join( '|' )}", but /who reports ${aliasNotes.map( n => `"${n}"` ).join( ' and ' )}. After a /who this stops firing until you zone again.${learnedAlias ? ' This name was learned from your own /who lines, so check it first.' : ''}`,
                {
                    needsLook: learnedAlias,
                    detail: `Operator ${operatorName}, value "${value}". The name is not a substring of the other name, so ${operatorName} cannot match it.`,
                    fix: {
                        label: `Add "${missingTargets.join( '|' )}"`,
                        safe: true,
                        patches: [ { ...conditionRef, field: 'variableValue', from: value, to: `${value}|${missingTargets.join( '|' )}` } ],
                    },
                } );
        }

        // 3: not a zone Nag knows.
        const unknown = alternatives.filter( alt => operator === OP_EQUALS ? !zoneIndex.isKnown( alt ) : !zoneIndex.isPartOfKnown( alt ) && !zoneIndex.isKnown( alt ) );
        unknown.forEach( alt => {
            const suggestion = zoneIndex.suggest( stripInstance( alt ) );
            let fix = null;

            if ( suggestion ) {
                const patched = raw.map( part => part.trim() === alt ? part.replace( alt, suggestion ) : part ).join( '|' );
                fix = {
                    label: `Rename to "${suggestion}"`,
                    safe: false,
                    patches: [ { ...conditionRef, field: 'variableValue', from: value, to: patched } ],
                };
            }

            add( 'zoneUnknown', subject, `${key}:${alt}`,
                `The ${label} says "${alt}", which is not a zone Nag knows.${suggestion ? ` Did you mean "${suggestion}"?` : ' It may be a newer zone than the built-in list.'}`,
                suggestion ? { fix } : { severity: 'info', level: 'advanced' } );
        } );

        // 1: Equals misses instance numbers.
        if ( operator === OP_EQUALS ) {
            const others = [];
            alternatives.forEach( alt => zoneIndex.otherZonesContaining( alt ).forEach( z => !others.includes( z ) && others.push( z ) ) );

            let reason = `The ${label} needs the zone name to be exactly "${alternatives.join( '|' )}". Contains is more forgiving: it also matches event and difficulty variants and ignores case.`;
            if ( others.length > 0 ) {
                reason += ` Switching to Contains would also match ${others.length} other zone${others.length === 1 ? '' : 's'}, such as ${others.slice( 0, 3 ).map( o => `"${o}"` ).join( ', ' )}.`;
            }

            add( 'zoneEquals', subject, key, reason, {
                needsLook: others.length > 0,
                detail: `Operator Equals, value "${value}". Equals is an exact, case-sensitive match against the stored zone name.`,
                fix: {
                    label: 'Switch to Contains',
                    safe: true,
                    patches: [ { ...conditionRef, field: 'operatorType', from: OP_EQUALS, to: OP_CONTAINS } ],
                },
            } );
        }
    };

    // Folder conditions.
    folderInfo.forEach( ( info, folderId ) => {
        const folder = info.folder;
        const subject = { kind: 'folder', id: folderId, name: folder.name ?? '', folderId };
        folder.folderConditions?.forEach( ( condition, index ) => {
            const before = findings.length;
            checkCondition( condition, index, subject, { target: 'folderCondition', folderId } );
            const count = triggerIdsByFolder.get( folderId )?.length ?? 0;
            for ( let i = before; i < findings.length; i++ ) {
                findings[ i ].reason = `${findings[ i ].reason} Affects ${count} trigger${count === 1 ? '' : 's'} in this folder.`;
            }
        } );
    } );

    triggers.forEach( trigger => {
        const subject = triggerSubject( trigger );
        const conditionPatchTarget = { target: 'triggerCondition', triggerId: trigger.triggerId };
        const phrases = Array.isArray( trigger.capturePhrases ) ? trigger.capturePhrases.filter( p => p != null ) : [];
        const actions = Array.isArray( trigger.actions ) ? trigger.actions.filter( a => a != null ) : [];
        const usablePhrases = phrases.filter( p => typeof p.phrase === 'string' && p.phrase.length > 0 );

        // 11: dev-only triggers never run in a normal build, so nothing else about them matters.
        if ( trigger.onlyExecuteInDev ) {
            add( 'devOnly', subject, 'trigger', 'Marked "only run in dev". It never fires in a normal Nag.' );
            return;
        }

        if ( !Array.isArray( trigger.conditions ) ) {
            add( 'noPhrase', subject, 'conditions', 'This trigger will never fire: it has no conditions list, which Nag needs to read it.' );
        } else {
            trigger.conditions.forEach( ( condition, index ) => checkCondition( condition, index, subject, conditionPatchTarget ) );
        }

        // 5: nothing to look for. Triggers with no actions, or with hotkeys, have nothing to start from a phrase.
        const captureMethod = trigger.captureMethod;
        const runsFromPhrases = actions.some( a => a.actionType != null ) && !( trigger.hotkeys?.length > 0 );
        if ( runsFromPhrases ) {
            if ( phrases.length === 0 ) {
                add( 'noPhrase', subject, 'phrases', 'This trigger will never fire: it has no phrase to look for.' );
            } else if ( usablePhrases.length === 0 ) {
                add( 'noPhrase', subject, 'phrases', `This trigger will never fire: ${phrases.length === 1 ? 'its only phrase is' : 'all of its phrases are'} empty.` );
            } else if ( captureMethod !== 'Any match' && captureMethod !== 'Sequential' ) {
                add( 'noPhrase', subject, 'method', captureMethod ? `This trigger will never fire: its capture method is "${captureMethod}", which Nag does not run.` : 'This trigger will never fire: it has no capture method.' );
            }
        }

        // 4, 9, 10, 13: phrases.
        let slowFinding = null;
        usablePhrases.forEach( ( phrase, index ) => {
            const phraseKey = phrase.phraseId ?? `#${index}`;

            if ( phrase.useRegEx ) {
                const compiled = compilePhrase( trigger, phrase );
                if ( compiled.error ) {
                    add( 'phraseInvalid', subject, phraseKey, `This trigger will never fire: the phrase "${shorten( phrase.phrase )}" can't be read as a pattern.`, { detail: `Pattern error: ${compiled.error}` } );
                    return;
                }

                const pattern = analyzePattern( phrase.phrase );
                const hints = phraseHints( phrase );
                const reasons = [];
                const tips = [];
                if ( hints.includes( 'leading-wildcard' ) ) {
                    reasons.push( 'it starts with .* or .+' );
                    tips.push( 'start with the fixed words instead' );
                }
                if ( hints.includes( 'no-literal' ) ) {
                    reasons.push( `it has no run of ${MIN_LITERAL_RUN} fixed characters, so Nag cannot skip it quickly` );
                    tips.push( 'add a run of fixed words' );
                }
                if ( hints.includes( 'nested-quantifier' ) ) {
                    reasons.push( 'it repeats a group that already repeats' );
                    tips.push( 'simplify the repeated group' );
                }
                if ( hints.includes( 'many-alternatives' ) ) {
                    reasons.push( `it has ${pattern.maxAlternatives} alternatives in one group` );
                    tips.push( 'split it into a few triggers or use a list' );
                }

                if ( reasons.length > 0 && slowFinding == null ) {
                    slowFinding = {
                        key: phraseKey,
                        reason: `The phrase "${shorten( phrase.phrase )}" costs time on every line: ${reasons.join( ', ' )}. Tip: ${tips.join( '; ' )}.`,
                        detail: `Longest fixed run ${pattern.longestLiteralRun}, alternatives in one group ${pattern.maxAlternatives}.`,
                    };
                }
            } else {
                const text = phrase.phrase;

                if ( /{L([0-9]*?)}/i.test( text ) ) {
                    add( 'plainListCode', subject, phraseKey, `The phrase "${shorten( text )}" uses a list code, which only works when "Use regex" is on.` );
                } else if ( REGEX_LOOKING_TEXT.test( text ) ) {
                    add( 'plainLooksRegex', subject, phraseKey, `The phrase "${shorten( text )}" looks like a pattern, but "Use regex" is off, so it is matched as plain text and probably never matches.`, {
                        fix: {
                            label: 'Turn on "Use regex"',
                            safe: false,
                            patches: [ { target: 'phrase', triggerId: trigger.triggerId, phraseId: phrase.phraseId ?? null, phraseIndex: phrases.indexOf( phrase ), field: 'useRegEx', from: phrase.useRegEx ?? null, to: true } ],
                        },
                    } );
                }
            }
        } );

        if ( slowFinding ) {
            add( 'slowPhrase', subject, slowFinding.key, slowFinding.reason, { detail: slowFinding.detail } );
        }

        // 6: actions that no phrase can start.
        if ( usablePhrases.length > 0 && ( captureMethod === 'Any match' || captureMethod === 'Sequential' ) ) {
            const usableIds = new Set( usablePhrases.map( p => p.phraseId ).filter( id => id != null ) );
            const subActionIds = new Set();
            actions.forEach( action => {
                action.endingSoonSubActions?.forEach( s => s?.actionId != null && subActionIds.add( s.actionId ) );
                action.endedSubActions?.forEach( s => s?.actionId != null && subActionIds.add( s.actionId ) );
            } );

            actions.forEach( ( action, index ) => {
                if ( action.actionType == null || action.onlyExecuteInDev || action.actionType === ACTION_LIST || subActionIds.has( action.actionId ) ) {
                    return;
                }

                if ( !Array.isArray( action.phrases ) || !action.phrases.some( id => usableIds.has( id ) ) ) {
                    const sameType = actions.filter( a => a.actionType === action.actionType );
                    const actionName = action.name || `${actionLabel( action.actionType )} action${sameType.length > 1 ? ` ${sameType.indexOf( action ) + 1}` : ''}`;
                    const onlyOnePhrase = phrases.length === 1 && usablePhrases.length === 1 && usablePhrases[ 0 ].phraseId != null;
                    add( 'actionUnlinked', subject, action.actionId ?? `#${index}`,
                        `This trigger will never fire: the action "${shorten( actionName, 40 )}" is not linked to any phrase of the trigger.`,
                        {
                            fix: onlyOnePhrase ? {
                                label: 'Link to the phrase',
                                safe: true,
                                patches: [ { target: 'action', triggerId: trigger.triggerId, actionId: action.actionId ?? null, actionIndex: index, field: 'phrases', from: action.phrases ?? null, to: [ usablePhrases[ 0 ].phraseId ] } ],
                            } : null,
                        } );
                }
            } );
        }

        // 8: variables that only store values a condition names exactly.
        actions.forEach( ( action, index ) => {
            if ( action.actionType !== ACTION_STORE_VARIABLE || !action.onlyStoreUsedValues || !action.variableName || action.onlyExecuteInDev || action.variableStorageType === 'persistentDictionary' ) {
                return;
            }

            const conditions = conditionsByVariable.get( action.variableName );
            if ( conditions?.length > 0 && conditions.every( c => c.operatorType === OP_CONTAINS ) ) {
                add( 'storeUsedContains', subject, action.actionId ?? `#${index}`,
                    `The ${action.variableName} variable only stores values that a condition names exactly, but every condition on it uses Contains, so longer values are never stored and those conditions have nothing to look at.`,
                    {
                        fix: {
                            label: 'Store all values',
                            safe: false,
                            patches: [ { target: 'action', triggerId: trigger.triggerId, actionId: action.actionId ?? null, actionIndex: index, field: 'onlyStoreUsedValues', from: true, to: false } ],
                        },
                    } );
            }
        } );

        // 11: dev-only actions.
        const devActions = actions.filter( a => a.onlyExecuteInDev ).length;
        if ( devActions > 0 ) {
            add( 'devOnly', subject, 'actions', `${devActions === 1 ? 'An action is' : `${devActions} actions are`} marked "only run in dev" and never fire${devActions === 1 ? 's' : ''} in a normal Nag.` );
        }

        // 12: class restrictions nobody matches.
        const classes = ( trigger.classLevels ?? [] ).map( c => c?.class?.trim() ).filter( c => c );
        if ( classes.length > 0 && characterClasses.size > 0 && !hasClasslessCharacter && !classes.some( c => characterClasses.has( c ) ) ) {
            add( 'classUnused', subject, 'classes', `Limited to ${classes.join( ', ' )}; none of your characters is that class, so it is skipped.` );
        }
    } );

    findings.sort( ( a, b ) =>
        a.subject.folderPath.localeCompare( b.subject.folderPath ) ||
        SEVERITY_ORDER[ a.severity ] - SEVERITY_ORDER[ b.severity ] ||
        a.subject.name.localeCompare( b.subject.name ) ||
        a.checkNumber - b.checkNumber );

    return { summary: summarize( findings, triggers.length, folderInfo.size ), findings };
}

/**
 * Counts the findings.
 *
 * @param {any[]} findings The findings.
 * @param {number} triggerCount The number of triggers checked.
 * @param {number} folderCount The number of folders checked.
 */
function summarize( findings, triggerCount, folderCount ) {
    const counts = { never: 0, may: 0, cost: 0, info: 0 };
    const shown = { never: 0, may: 0 };
    let bulkFixes = 0;

    findings.forEach( f => {
        counts[ f.severity ]++;
        if ( f.level === 'default' ) {
            shown[ f.severity ] = ( shown[ f.severity ] ?? 0 ) + 1;
            if ( f.fix?.bulk ) {
                bulkFixes++;
            }
        }
    } );

    return {
        checkedAt: new Date().toISOString(),
        triggers: triggerCount,
        folders: folderCount,
        counts,
        defaultCount: findings.filter( f => f.level === 'default' ).length,
        defaultCounts: shown,
        bulkFixes,
    };
}

/**
 * Finds a trigger's condition, action or phrase for a patch.
 *
 * @returns {object | undefined}
 */
function resolvePatchTarget( patch, triggersById, foldersById ) {
    const pick = ( list, idField, id, index ) => {
        if ( !Array.isArray( list ) ) {
            return undefined;
        }
        return id != null ? list.find( x => x?.[ idField ] === id ) : list[ index ];
    };

    if ( patch.target === 'folderCondition' ) {
        return pick( foldersById.get( patch.folderId )?.folderConditions, 'conditionId', patch.conditionId, patch.conditionIndex );
    }

    const trigger = triggersById.get( patch.triggerId );
    if ( !trigger ) {
        return undefined;
    }

    if ( patch.target === 'triggerCondition' ) {
        return pick( trigger.conditions, 'conditionId', patch.conditionId, patch.conditionIndex );
    } else if ( patch.target === 'action' ) {
        return pick( trigger.actions, 'actionId', patch.actionId, patch.actionIndex );
    } else if ( patch.target === 'phrase' ) {
        return pick( trigger.capturePhrases, 'phraseId', patch.phraseId, patch.phraseIndex );
    }

    return undefined;
}

/**
 * Applies the patches in order, skipping any whose current value is no longer the expected one.
 *
 * @param {any[]} triggers The triggers, changed in place.
 * @param {any[]} folders The folder hierarchy, changed in place.
 * @param {any[]} patches The patches to apply.
 * @param {boolean} [revert] If true, the patches are reverted instead.
 * @returns {{ applied: any[], skipped: any[], triggerIds: string[], folderIds: string[] }}
 */
function applyPatches( triggers, folders, patches, revert = false ) {
    const triggersById = new Map( triggers.filter( t => t ).map( t => [ t.triggerId, t ] ) );
    const foldersById = new Map();
    const index = list => list?.forEach( f => {
        foldersById.set( f.folderId, f );
        index( f.children );
    } );
    index( folders );

    const result = { applied: [], skipped: [], triggerIds: [], folderIds: [] };
    const ordered = revert ? [ ...patches ].reverse() : patches;

    ordered.forEach( patch => {
        const holder = resolvePatchTarget( patch, triggersById, foldersById );
        const expected = revert ? patch.to : patch.from;
        const replacement = revert ? patch.from : patch.to;

        if ( !holder || JSON.stringify( holder[ patch.field ] ?? null ) !== JSON.stringify( expected ?? null ) ) {
            result.skipped.push( patch );
            return;
        }

        holder[ patch.field ] = JSON.parse( JSON.stringify( replacement ?? null ) );
        result.applied.push( patch );

        const list = patch.target === 'folderCondition' ? result.folderIds : result.triggerIds;
        const id = patch.target === 'folderCondition' ? patch.folderId : patch.triggerId;
        if ( !list.includes( id ) ) {
            list.push( id );
        }
    } );

    return result;
}

/**
 * Builds a plain text report for sharing. It lists trigger names and reasons only.
 *
 * @param {{ summary: any, findings: any[] }} report The check result.
 * @param {{ advanced?: boolean }} [options] Report options.
 * @returns {string}
 */
function formatReportText( report, options = {} ) {
    const wanted = report.findings.filter( f => options.advanced || f.level === 'default' );
    const labels = { never: 'Will never fire', may: 'May stop firing', cost: 'Costs time', info: 'Info' };
    const lines = [
        `Trigger health check: ${report.summary.triggers} triggers, ${wanted.length} finding${wanted.length === 1 ? '' : 's'}`,
    ];

    let folderPath = null;
    wanted.forEach( f => {
        if ( f.subject.folderPath !== folderPath ) {
            folderPath = f.subject.folderPath;
            lines.push( '', folderPath );
        }
        const who = f.subject.kind === 'folder' ? `Folder: ${f.subject.name}` : f.subject.name;
        lines.push( `- [${labels[ f.severity ]}] ${who}: ${f.reason}${options.advanced && f.detail ? ` (${f.detail})` : ''}` );
    } );

    return lines.join( '\n' ) + '\n';
}

module.exports = {
    CHECKS,
    checkTriggerHealth,
    applyPatches,
    formatReportText,
    analyzePattern,
    stripInstance,
};

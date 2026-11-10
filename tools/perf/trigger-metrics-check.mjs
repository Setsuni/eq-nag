// Checks the trigger counters and measurement (src/electron/utilities/trigger-metrics.js and trigger-perf-analysis.js,
// used by the log watcher).
//
//   node tools/perf/trigger-metrics-check.mjs
//       Unit cases against the real log watcher, with its Electron parts stubbed.
//
//   node tools/perf/trigger-metrics-check.mjs --triggers <trigger-database.json copy> --log <log copy> [--baseline <log-watcher.js without the counters>] [--repeat <n>]
//       Also replays the log through the watcher with and without a measurement running, fails if the matches
//       differ, and prints the cost per line (with --baseline, also the cost without the counters).
//       Use copies; only counts are printed, never trigger names, phrases or log lines.

import { createRequire } from 'module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';
import Module from 'module';

const require = createRequire( import.meta.url );
const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..', '..' );
const { ActionTypes, TriggerConditionTypes, OperatorTypes } = require( path.join( root, 'src/electron/data/models/trigger.js' ) );

let failures = 0;
let checks = 0;

function check( condition, label ) {
    checks++;
    if ( !condition ) {
        failures++;
        console.log( `FAIL: ${label}` );
    }
}

function same( a, b ) {
    return JSON.stringify( a ) === JSON.stringify( b );
}

// ---- A log watcher with the Electron parts stubbed ----

let fakeNow = Date.now();
const RealDate = Date;
globalThis.Date = class extends RealDate {
    constructor( ...args ) {
        args.length === 0 ? super( fakeNow ) : super( ...args );
    }
    static now() {
        return fakeNow;
    }
};

/** The watcher that currently receives the IPC traffic. */
let current = null;
const ipcRenderer = {
    invoke: async () => ( {} ),
    on: ( channel, fn ) => { current.handlers[ channel ] = fn; },
    once: ( channel, fn ) => { current.once[ channel ] = fn; },
    send: ( channel, ...args ) => {
        if ( channel === 'cache:retrieve' ) {
            const key = `cache:retrieve:${args[ 0 ]}`;
            const fn = current.once[ key ];
            delete current.once[ key ];
            fn?.( {}, null );
        } else if ( channel === 'trigger-perf:result' ) {
            current.results.push( args[ 0 ] );
        } else if ( channel === 'trigger-perf:counters-response' ) {
            current.counterReplies.push( args[ 0 ] );
        } else if ( channel === 'console:message' ) {
            current.console.push( args[ 0 ]?.message ?? args[ 0 ] );
        }
    },
};
globalThis.window = { onerror: null, setTimeout: setTimeout, clearTimeout: clearTimeout };
globalThis.speechSynthesis = { getVoices: () => [], onvoiceschanged: null, speak() { }, cancel() { } };
globalThis.SpeechSynthesisUtterance = function () { };
globalThis.document = { createElement: () => ( {} ) };

const originalLoad = Module._load;
Module._load = function ( request ) {
    if ( request === 'electron' ) {
        return { ipcRenderer: ipcRenderer, remote: {}, app: {}, shell: {} };
    }
    return originalLoad.apply( this, arguments );
};
process.emitWarning = () => { };

const watcherPath = path.join( root, 'src/electron/threads/log-watcher.js' );
const exportsSuffix = `
module.exports.__test = {
    parseLogEntries, backfind, saveVariable,
    get activeTriggers() { return activeTriggers; },
    get storedVariables() { return storedVariables; },
    get counters() { return counters; },
    get triggerMetrics() { return triggerMetrics; },
};
`;
const watcherSource = readFileSync( watcherPath, 'utf8' ) + exportsSuffix;

const timestamp = () => {
    const d = new RealDate( fakeNow );
    const p = n => `${n}`.padStart( 2, '0' );
    return `[${[ 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat' ][ d.getDay() ]} ${[ 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec' ][ d.getMonth() ]} ${p( d.getDate() )} ${p( d.getHours() )}:${p( d.getMinutes() )}:${p( d.getSeconds() )} ${d.getFullYear()}]`;
};

/**
 * Loads a fresh copy of the log watcher.
 *
 * @param {{triggers: any[], folders?: any[], characterClass?: string, disabled?: string[], env?: Record<string, string>, logFile?: string}} options
 */
function createWatcher( options ) {
    const savedEnv = {};
    Object.keys( options.env ?? {} ).forEach( key => {
        savedEnv[ key ] = process.env[ key ];
        process.env[ key ] = options.env[ key ];
    } );

    const watcher = { handlers: {}, once: {}, console: [], matches: [], runs: 0, line: 0, results: [], counterReplies: [] };
    current = watcher;

    const filename = watcherPath;
    const m = new Module( filename, null );
    m.filename = filename;
    m.paths = Module._nodeModulePaths( path.dirname( filename ) );
    m._compile( options.source ?? watcherSource, filename );

    Object.keys( options.env ?? {} ).forEach( key => {
        if ( savedEnv[ key ] === undefined ) {
            delete process.env[ key ];
        } else {
            process.env[ key ] = savedEnv[ key ];
        }
    } );

    const character = { name: 'Soandso', characterId: 'char1', class: options.characterClass ?? '', logFile: options.logFile ?? 'none.txt', disabledTriggers: [] };
    m.exports( character, 0 );
    watcher.internals = m.exports.__test;
    watcher.character = character;

    watcher.tick = ( record = true ) => {
        current = watcher;
        watcher.handlers.tick( {}, {
            triggers: JSON.parse( JSON.stringify( options.triggers ) ),
            folders: options.folders ?? [],
            overlays: [], enableFct: false, isDev: false, phoneticTransforms: [],
            characterModel: character,
            characterDisabledTriggers: [ { characterId: 'char1', disabledTriggers: options.disabled ?? [] } ],
            quickShareAuthorsList: [],
        } );

        // Count the runs and record the matches.
        record && watcher.internals.activeTriggers.forEach( trigger => {
            const original = trigger._parse;
            if ( typeof original === 'function' && !original.wrapped ) {
                const wrapped = ( value, onMatch ) => {
                    watcher.runs++;
                    return original( value, ( res, delta ) => {
                        watcher.matches.push( `${watcher.line}|${trigger.name}|${res.phraseId}` );
                        onMatch( res, delta );
                    } );
                };
                wrapped.wrapped = true;
                trigger._parse = wrapped;
            }
        } );
    };

    /** Feeds a log line without flushing the gate, like a line in the middle of a batch. */
    watcher.feed = text => {
        current = watcher;
        watcher.line++;
        watcher.internals.parseLogEntries( `${timestamp()} ${text}` );
    };

    /** Feeds the lines as one batch. */
    watcher.batch = lines => {
        lines.forEach( watcher.feed );
        watcher.internals.flushTriggerGate?.();
    };

    watcher.matched = name => watcher.matches.filter( x => x.split( '|' )[ 1 ] === name ).length;

    return watcher;
}

let idCounter = 0;
const nextId = () => `id${++idCounter}`;

function phrase( text, useRegEx = true ) {
    return { phraseId: nextId(), phrase: text, useRegEx: useRegEx, ignoreCase: false, requirePreviousPhrase: false, duration: null };
}

function makeTrigger( name, phrases, options = {} ) {
    const capturePhrases = phrases.map( p => typeof p === 'string' ? phrase( p ) : p );
    return {
        triggerId: nextId(), name: name, enabled: true, captureMethod: options.captureMethod ?? 'Any match',
        capturePhrases: capturePhrases,
        actions: ( options.actions ?? [] ).map( a => ( { actionId: nextId(), phrases: capturePhrases.map( p => p.phraseId ), onlyExecuteInDev: false, ...a } ) ),
        conditions: options.conditions ?? [], classLevels: options.classLevels ?? [],
        onlyExecuteInDev: false, folderId: options.folderId ?? null, cooldownDuration: 0, useCooldown: false,
        sequentialRestartBehavior: 0,
    };
}

const variableIs = ( variableName, variableValue, operatorType = OperatorTypes.Equals ) =>
    ( { conditionType: TriggerConditionTypes.VariableValue, operatorType: operatorType, variableName: variableName, variableValue: variableValue } );
const counterIs = ( variableName, variableValue, operatorType ) =>
    ( { conditionType: TriggerConditionTypes.CounterValue, operatorType: operatorType, variableName: variableName, variableValue: variableValue } );
const storeAction = variableName => ( { actionType: ActionTypes.StoreVariable, variableName: variableName } );
const clearAction = variableName => ( { actionType: ActionTypes.ClearVariable, variableName: variableName } );
const counterAction = ( name, resetSeconds, resetPhrases ) => ( { actionType: ActionTypes.Counter, displayText: name, duration: resetSeconds, resetCounterPhrases: resetPhrases ?? [] } );


function argument( name ) {
    const index = process.argv.indexOf( name );
    return index > -1 ? process.argv[ index + 1 ] : null;
}

const { TriggerMetrics, timedPerLine } = require( path.join( root, 'src/electron/utilities/trigger-metrics.js' ) );
const Analysis = require( path.join( root, 'src/electron/utilities/trigger-perf-analysis.js' ) );

// ---- Unit cases ----

const counterReply = w => {
    w.handlers[ 'trigger-perf:counters-request' ]( {}, 'request1' );
    const reply = w.counterReplies[ w.counterReplies.length - 1 ];
    check( reply.requestId === 'request1' && reply.characterId === 'char1', 'counters reply carries the request and character ids' );
    return reply.counters;
};

// Counters count the phrases actually tried and the matches, and nothing else.
{
    const hit = makeTrigger( 'Hit', [ phrase( 'alpha beta gamma', false ) ] );
    const never = makeTrigger( 'Never', [ phrase( 'something else entirely', false ) ] );
    const blocked = makeTrigger( 'Blocked', [ phrase( 'alpha beta gamma', false ) ], { conditions: [ variableIs( 'NoSuchVariable', 'x' ) ] } );
    const w = createWatcher( { triggers: [ hit, never, blocked ] } );
    w.tick();
    [ 'alpha beta gamma', 'delta', 'alpha beta gamma', 'epsilon', 'zeta' ].forEach( w.feed );

    const counters = counterReply( w );
    check( counters[ hit.triggerId ].checked === 5 && counters[ hit.triggerId ].fired === 2, 'counters: checked on every line, fired on matches' );
    check( counters[ never.triggerId ].checked === 5 && counters[ never.triggerId ].fired === 0, 'counters: a trigger that never matches is still checked' );
    check( counters[ blocked.triggerId ].checked === 0 && counters[ blocked.triggerId ].fired === 0, 'counters: a trigger whose conditions fail is not checked' );
    check( counters[ hit.triggerId ].name === 'Hit', 'counters: carry the trigger name' );
    check( w.internals.triggerMetrics.measuring === false, 'counters: no measurement runs by default' );
    check( Object.values( w.internals.triggerMetrics.counters( w.internals.activeTriggers ) ).every( c => c.totalMs === undefined ), 'counters: no timing without a measurement' );
}

// Counters survive a tick that rebuilds the triggers.
{
    const hit = makeTrigger( 'Hit', [ phrase( 'alpha beta gamma', false ) ] );
    const w = createWatcher( { triggers: [ hit ] } );
    w.tick();
    w.feed( 'alpha beta gamma' );
    w.tick();
    w.feed( 'alpha beta gamma' );
    check( counterReply( w )[ hit.triggerId ].fired === 2, 'counters: keep counting across a trigger rebuild' );
}

// A measurement covers only its own window, and sends one report.
{
    const hit = makeTrigger( 'Hit', [ phrase( 'alpha beta gamma', false ) ] );
    const quiet = makeTrigger( 'Quiet', [ phrase( 'something else entirely', false ) ] );
    const w = createWatcher( { triggers: [ hit, quiet ] } );
    w.tick();
    for ( let i = 0; i < 30; i++ ) {
        w.feed( 'alpha beta gamma' );
    }

    w.handlers[ 'trigger-perf:start' ]( {} );
    w.handlers[ 'trigger-perf:start' ]( {} );
    check( w.internals.triggerMetrics.measuring, 'measurement: starts' );
    for ( let i = 0; i < 200; i++ ) {
        w.feed( i % 2 === 0 ? 'alpha beta gamma' : 'delta' );
    }
    w.handlers[ 'trigger-perf:stop' ]( {} );
    w.handlers[ 'trigger-perf:stop' ]( {} );

    check( w.results.length === 1, 'measurement: one report, even when started and stopped twice' );
    const report = w.results[ 0 ]?.report;
    check( w.results[ 0 ]?.characterId === 'char1', 'measurement: report names the character' );
    check( report?.lineCount === 200, 'measurement: counts the lines in the window' );
    check( report?.endedAt >= report?.startedAt, 'measurement: has a time window' );
    const row = report?.rows.find( r => r.triggerId === hit.triggerId );
    check( row?.checked === 200 && row?.fired === 100, 'measurement: checked and fired cover the window only' );
    check( row?.samples === 200, 'measurement: with fewer triggers than the timed batch, every trigger is timed on every line' );
    check( row?.totalMs > 0 && row?.maxMs > 0 && row?.maxMs <= row?.totalMs, 'measurement: times the sampled lines' );
    check( report?.rows.length === 2, 'measurement: lists every active trigger' );
    check( Math.abs( report?.rows.reduce( ( sum, r ) => sum + r.sharePercent, 0 ) - 100 ) < 1e-6, 'measurement: shares add up to 100' );
    check( report?.rows[ 0 ].totalMs >= report?.rows[ 1 ].totalMs, 'measurement: sorted by time' );

    // A second window starts from zero again.
    w.handlers[ 'trigger-perf:start' ]( {} );
    w.feed( 'alpha beta gamma' );
    w.handlers[ 'trigger-perf:stop' ]( {} );
    const second = w.results[ 1 ]?.report.rows.find( r => r.triggerId === hit.triggerId );
    check( second?.checked === 1 && second?.fired === 1, 'measurement: a new window starts from zero' );
    check( counterReply( w )[ hit.triggerId ].fired === 30 + 100 + 1, 'counters: the always-on total is not reset by a measurement' );
}

// A measurement changes nothing about what matches.
{
    const triggers = [
        makeTrigger( 'One', [ phrase( 'alpha (\\w+) gamma' ) ] ),
        makeTrigger( 'Two', [ phrase( 'delta', false ), phrase( 'epsilon', false ) ] ),
        makeTrigger( 'Seq', [ phrase( 'first step', false ), phrase( 'second step', false ) ], { captureMethod: 'Sequential' } ),
    ];
    const lines = [];
    for ( let i = 0; i < 300; i++ ) {
        lines.push( [ 'alpha beta gamma', 'delta', 'first step', 'nothing', 'second step', 'epsilon' ][ i % 6 ] );
    }
    const matchesOf = measure => {
        const w = createWatcher( { triggers: triggers } );
        w.tick();
        measure && w.handlers[ 'trigger-perf:start' ]( {} );
        lines.forEach( w.feed );
        measure && w.handlers[ 'trigger-perf:stop' ]( {} );
        return w.matches;
    };
    const off = matchesOf( false );
    check( off.length > 200 && same( off, matchesOf( true ) ), 'measurement: the matches are identical with and without it' );
}

// Hints.
{
    const hints = ( phraseText, useRegEx = true ) => Analysis.phraseHints( { phrase: phraseText, useRegEx: useRegEx } );
    check( hints( '.*foo bar' ).includes( 'leading-wildcard' ), 'hints: leading .*' );
    check( hints( '^(?:.+)foo bar' ).includes( 'leading-wildcard' ), 'hints: leading .+ inside a group' );
    check( !hints( 'foo bar.*' ).includes( 'leading-wildcard' ), 'hints: trailing .* is fine' );
    check( hints( 'a.b\\d+' ).includes( 'no-literal' ), 'hints: no run of three fixed characters' );
    check( hints( 'ab?c?d' ).includes( 'no-literal' ), 'hints: optional characters do not count as fixed' );
    check( !hints( 'You hit (\\w+) for (\\d+)' ).includes( 'no-literal' ), 'hints: a normal phrase has a literal' );
    check( hints( new Array( 60 ).fill( 'word' ).join( '|' ) ).includes( 'many-alternatives' ), 'hints: more than 50 alternatives' );
    check( !hints( new Array( 10 ).fill( 'word' ).join( '|' ) ).includes( 'many-alternatives' ), 'hints: few alternatives are fine' );
    check( hints( '(a+)+b' ).includes( 'nested-quantifier' ), 'hints: nested quantifier' );
    check( !hints( '(abc)+' ).includes( 'nested-quantifier' ), 'hints: a repeated plain group is fine' );
    check( hints( '{S}', false ).length === 0 && hints( 'You have been slain', false ).length === 0, 'hints: plain phrases are not judged' );
    check( hints( '' ).length === 0, 'hints: empty phrase' );
}

// Report rows.
{
    const triggers = [
        { triggerId: 'a', name: 'Slow', capturePhrases: [ { phrase: '.*x', useRegEx: true } ] },
        { triggerId: 'b', name: 'Busy', capturePhrases: [ { phrase: 'steady chatter', useRegEx: false } ] },
        { triggerId: 'c', name: 'Skipped', capturePhrases: new Array( 25 ).fill( { phrase: 'fixed words', useRegEx: false } ) },
    ];
    const report = Analysis.buildReport( {
        startedAt: 1, endedAt: 2, lineCount: 1000,
        triggers: { a: { checked: 1000, fired: 0, totalMs: 300, maxMs: 2 }, b: { checked: 1000, fired: 500, totalMs: 100, maxMs: 1 }, c: { checked: 0, fired: 0, totalMs: 0, maxMs: 0 } },
    }, triggers );
    check( report.rows.map( r => r.triggerId ).join() === 'a,b,c', 'report: sorted by time' );
    check( report.rows[ 0 ].sharePercent === 75 && report.rows[ 1 ].sharePercent === 25, 'report: shares of the total' );
    check( report.rows[ 0 ].avgMsPerCheck === 0.3, 'report: average per check' );
    check( report.rows[ 0 ].hints.some( h => h.code === 'leading-wildcard' && h.text.length > 0 ), 'report: wildcard hint with text' );
    check( report.rows[ 1 ].hints.some( h => h.code === 'fires-often' ), 'report: fires often' );
    check( report.rows[ 2 ].skipped && report.rows[ 2 ].hints.some( h => h.code === 'many-phrases' ), 'report: skipped trigger with many phrases' );
    check( report.totalMs === 400 && report.lineCount === 1000, 'report: totals' );
}

// Round-robin sampling times every trigger equally often, scales the time up and counts every line.
{
    const metrics = new TriggerMetrics();
    check( metrics.sampleWindow( 10 ) === -1, 'metrics: nothing is timed while idle' );
    metrics.begin( 0 );
    const lines = 5 * 10;
    const timesTimed = new Array( 10 ).fill( 0 );
    for ( let line = 0; line < lines; line++ ) {
        const start = metrics.sampleWindow( 10 );
        for ( let i = 0; i < 10; i++ ) {
            metrics.isTimed( start, i ) && timesTimed[ i ]++;
        }
    }
    check( timesTimed.every( n => n === lines * timedPerLine / 10 ) && metrics.lines === lines, 'metrics: every trigger is timed equally often' );
    check( metrics.sampleWindow( 0 ) === -1, 'metrics: no triggers, nothing to time' );
    metrics.sampleWindow( 10 );
    const stats = metrics.statsFor( 't' );
    metrics.record( stats, 2000000n );
    check( stats.totalMs === 2 * 10 / timedPerLine && stats.maxMs === 2 && stats.samples === 1, 'metrics: a sample stands for the triggers that were not timed' );
    metrics.sampleWindow( 2 );
    const small = metrics.statsFor( 'u' );
    metrics.record( small, 1000000n );
    check( small.totalMs === 1, 'metrics: with fewer triggers than the batch the sample is not scaled' );
}

// The store and the checks on what a log watcher sends.
{
    const store = require( path.join( root, 'src/electron/data/trigger-perf-store.js' ) );
    const good = { startedAt: 1, endedAt: 2, lineCount: 3, totalMs: 1, rows: [ { triggerId: 'a', name: 'Slow', checked: 1, fired: 0, totalMs: 1, maxMs: 1, sharePercent: 100, avgMsPerCheck: 1, skipped: false, hints: [ { code: 'no-literal' }, 'bogus' ] } ] };
    check( store.sanitizeReport( good )?.rows[ 0 ].hints.length === 1, 'sanitize: keeps known hints only' );
    check( store.sanitizeReport( { ...good, rows: [ { ...good.rows[ 0 ], hints: undefined } ] } )?.rows[ 0 ].hints.length === 0, 'sanitize: a row without hints gets none' );
    check( [ null, 5, 'x', [], {}, { ...good, lineCount: 'x' }, { ...good, rows: 'x' } ].every( r => store.sanitizeReport( r ) === null ), 'sanitize: junk is not a report' );
    check( store.sanitizeReport( { ...good, rows: [ null, { triggerId: 1 }, { ...good.rows[ 0 ], checked: NaN }, good.rows[ 0 ] ] } ).rows.length === 1, 'sanitize: bad rows are dropped' );
    check( store.sanitizeCounters( { a: { name: 'x', checked: 1, fired: 2 }, b: { name: 5 }, c: null } ).a.fired === 2 && Object.keys( store.sanitizeCounters( { b: { name: 5 } } ) ).length === 0 && store.sanitizeCounters( 'x' ) === null, 'sanitize: counters' );

    const folder = mkdtempSync( path.join( process.env.NAG_TEST_TMP ?? tmpdir(), 'nag-perf-junk-' ) );
    writeFileSync( path.join( folder, 'trigger-perf.json' ), 'null' );
    const fromNull = new store( folder );
    check( fromNull.get( 'c' ) === null && fromNull.characterIds().length === 0, 'store: a file holding null is empty' );
    fromNull.set( 'c', store.sanitizeReport( good ) );
    check( new store( folder ).get( 'c' )?.lineCount === 3, 'store: saves over a bad file' );
    writeFileSync( path.join( folder, 'trigger-perf.json' ), JSON.stringify( { a: { ...good, rows: [ { ...good.rows[ 0 ], hints: undefined }, 5 ] }, b: 7, c: { rows: 1 } } ) );
    const mixed = new store( folder );
    check( mixed.characterIds().join() === 'a' && mixed.get( 'a' ).rows.length === 1, 'store: bad entries and rows without hints are skipped on load' );
    const later = store.sanitizeReport( { ...good, endedAt: 99 } );
    mixed.set( 'b', later );
    check( mixed.latestCharacterId() === 'b', 'store: latest character is the one whose report ended last' );
    rmSync( folder, { recursive: true, force: true } );
}

// The last report is kept per character in a file.
{
    const TriggerPerfStore = require( path.join( root, 'src/electron/data/trigger-perf-store.js' ) );
    const folder = mkdtempSync( path.join( process.env.NAG_TEST_TMP ?? tmpdir(), 'nag-perf-' ) );
    const report = { startedAt: 1, endedAt: 2, lineCount: 5, totalMs: 3, rows: [ { triggerId: 'a', name: 'Slow', checked: 1, fired: 0, totalMs: 3, maxMs: 1, sharePercent: 100, avgMsPerCheck: 3, skipped: false, hints: [ { code: 'no-literal', text: 'x' } ] } ] };
    const store = new TriggerPerfStore( folder );
    check( store.get( 'char1' ) === null, 'store: nothing before the first measurement' );
    store.set( 'char1', report );
    const again = new TriggerPerfStore( folder ).get( 'char1' );
    check( again?.lineCount === 5 && again.rows[ 0 ].name === 'Slow' && again.rows[ 0 ].hints[ 0 ].code === 'no-literal' && again.rows[ 0 ].hints[ 0 ].text.length > 1, 'store: the report survives a restart, with fresh hint text' );
    check( new TriggerPerfStore( folder ).get( 'char2' ) === null, 'store: reports are per character' );
    check( !existsSync( path.join( folder, 'trigger-perf.json.tmp' ) ), 'store: no temp file left behind' );
    rmSync( folder, { recursive: true, force: true } );
}

console.log( `${checks - failures} of ${checks} checks passed.` );

// ---- Library mode ----

const triggersFile = argument( '--triggers' );
const logFile = argument( '--log' );

if ( triggersFile && logFile && failures === 0 ) {
    const db = JSON.parse( readFileSync( triggersFile, 'utf8' ) );
    const baselineFile = argument( '--baseline' );
    const baselineSource = baselineFile ? readFileSync( baselineFile, 'utf8' ) + exportsSuffix : null;
    const repeat = Number( argument( '--repeat' ) ?? 3 );

    const lines = readFileSync( logFile, 'latin1' ).split( /\r?\n/ ).filter( l => l.length > 0 );
    const timestampRegex = /^\[(\w{3} \w{3} \d{2} \d{2}:\d{2}:\d{2} \d{4})\]/;
    const batchSize = 25;

    const run = ( source, measure, record ) => {
        const w = createWatcher( { triggers: db.triggers, folders: db.folders, source: source } );
        w.tick( record );
        measure && w.handlers[ 'trigger-perf:start' ]( {} );
        const started = process.hrtime.bigint();
        let inBatch = 0;
        lines.forEach( raw => {
            const ts = timestampRegex.exec( raw );
            if ( ts ) {
                fakeNow = RealDate.parse( ts[ 1 ] );
            }
            w.line++;
            w.internals.parseLogEntries( raw );
            if ( ++inBatch >= batchSize ) {
                inBatch = 0;
                w.internals.flushTriggerGate?.();
            }
        } );
        const ms = Number( process.hrtime.bigint() - started ) / 1e6;
        measure && w.handlers[ 'trigger-perf:stop' ]( {} );
        return { ms: ms, matches: w.matches, runs: w.runs, report: w.results[ 0 ]?.report, active: w.internals.activeTriggers.length };
    };

    console.log( `Library: ${db.triggers.length} triggers, ${lines.length} lines.` );

    // Matches: the same with the counters and with a measurement running (and with the old watcher, if given).
    const counters = run( null, false, true );
    const measured = run( null, true, true );
    const sortedMatches = r => [ ...r.matches ].sort();
    check( same( sortedMatches( counters ), sortedMatches( measured ) ), 'library: matches differ while measuring' );
    if ( baselineSource ) {
        check( same( sortedMatches( run( baselineSource, false, true ) ), sortedMatches( counters ) ), 'library: matches differ from the watcher without counters' );
    }
    check( measured.report?.lineCount === lines.length, 'library: the measurement counted every line' );
    const firedTotal = measured.report?.rows.reduce( ( sum, r ) => sum + r.fired, 0 );
    check( firedTotal === measured.matches.length, 'library: fired counts equal the matches' );
    const checkedTotal = measured.report?.rows.reduce( ( sum, r ) => sum + r.checked, 0 );
    const sampleCounts = measured.report?.rows.filter( r => !r.skipped ).map( r => r.samples ).sort( ( a, b ) => a - b ) ?? [];
    const perLineSamples = n => ( sampleCounts[ Math.floor( ( sampleCounts.length - 1 ) * n ) ] ?? 0 ) / lines.length;
    console.log( `Samples per checked trigger over ${lines.length} lines: min ${sampleCounts[ 0 ]}, median ${sampleCounts[ Math.floor( sampleCounts.length / 2 ) ]}, max ${sampleCounts[ sampleCounts.length - 1 ]} (median is ${( perLineSamples( 0.5 ) * 1e6 ).toFixed( 0 )} per million lines).` );
    console.log( `Library: ${counters.matches.length} matches, ${measured.active} enabled, ${( counters.runs / lines.length ).toFixed( 1 )} runs per line, ${( checkedTotal / lines.length ).toFixed( 1 )} checked per line, ${measured.report?.rows.filter( r => r.skipped ).length} never checked.` );

    // Cost per line; rounds are interleaved so a slow moment hits every variant.
    const times = { baseline: [], counters: [], measuring: [] };
    for ( let i = 0; i < repeat; i++ ) {
        baselineSource && times.baseline.push( run( baselineSource, false, false ).ms );
        times.counters.push( run( null, false, false ).ms );
        times.measuring.push( run( null, true, false ).ms );
    }
    const median = list => [ ...list ].sort( ( a, b ) => a - b )[ Math.floor( list.length / 2 ) ];
    const perLine = list => median( list ) / lines.length;
    const base = baselineSource ? perLine( times.baseline ) : null;
    if ( base != null ) {
        console.log( `without counters: ${base.toFixed( 5 )} ms per line` );
    }
    const counted = perLine( times.counters );
    console.log( `counters:         ${counted.toFixed( 5 )} ms per line${base != null ? ` (${( ( counted / base - 1 ) * 100 ).toFixed( 2 )}% vs without)` : ''}` );
    const timed = perLine( times.measuring );
    console.log( `measuring:        ${timed.toFixed( 5 )} ms per line (${( ( timed / counted - 1 ) * 100 ).toFixed( 2 )}% vs counters only)` );
    console.log( `rounds (ms): ${Object.entries( times ).filter( e => e[ 1 ].length > 0 ).map( e => `${e[ 0 ]} ${e[ 1 ].map( x => x.toFixed( 0 ) ).join( '/' )}` ).join( ', ' )}` );
}

if ( failures > 0 ) {
    console.log( `${failures} failure(s).` );
    process.exit( 1 );
}

process.exit( 0 );

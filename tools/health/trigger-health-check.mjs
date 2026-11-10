// Unit checks for the trigger health engine and the zone knowledge store.
// Run with: node tools/health/trigger-health-check.mjs
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire( import.meta.url );
const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..', '..' );
const health = require( path.join( root, 'src/electron/data/trigger-health.js' ) );
const eqZones = require( path.join( root, 'src/electron/data/models/everquest-zones.js' ) );

let passed = 0;
let queue = Promise.resolve();
function test( name, fn ) {
    queue = queue.then( async () => {
        try {
            await fn();
            passed++;
        } catch ( error ) {
            console.error( `FAIL ${name}` );
            throw error;
        }
    } );
}

let counter = 0;
const id = prefix => `${prefix}${++counter}`;

function phrase( text, options = {} ) {
    return { phraseId: id( 'p' ), phrase: text, useRegEx: false, ignoreCase: true, ...options };
}

function condition( operatorType, variableValue, variableName = 'CurrentZone', conditionType = 1 ) {
    return { conditionId: id( 'c' ), conditionType, operatorType, variableName, variableValue };
}

function trigger( name, options = {} ) {
    const phrases = options.capturePhrases ?? [ phrase( 'Soandso shouts' ) ];
    return {
        triggerId: id( 't' ),
        folderId: 'f1',
        packageId: null,
        name,
        enabled: true,
        captureMethod: 'Any match',
        capturePhrases: phrases,
        conditions: [],
        classLevels: [],
        actions: [ { actionId: id( 'a' ), actionType: 0, phrases: [ phrases[ 0 ]?.phraseId ] } ],
        ...options,
    };
}

const baseFolders = () => [ { folderId: 'f1', name: 'Raids', children: [ { folderId: 'f2', name: 'Old World', children: [], folderConditions: [] } ], folderConditions: [] } ];

function run( triggers, extra = {} ) {
    return health.checkTriggerHealth( { triggers, folders: baseFolders(), zones: eqZones, ...extra } );
}

const checksOf = report => report.findings.map( f => f.check );
const only = ( report, check ) => report.findings.filter( f => f.check === check );

test( 'clean trigger has no findings', () => {
    const report = run( [ trigger( 'Soandso Emote' ) ] );
    assert.equal( report.findings.length, 0 );
    assert.equal( report.summary.triggers, 1 );
} );

// Check 1.
test( 'zone Equals is flagged and switches to Contains', () => {
    const t = trigger( 'Soandso Zone', { conditions: [ condition( 1, 'Chardok' ) ] } );
    const report = run( [ t ] );
    const [ finding ] = only( report, 'zoneEquals' );
    assert.ok( finding );
    assert.equal( finding.severity, 'may' );
    assert.equal( finding.fix.bulk, true );
    assert.equal( finding.needsLook, false );

    const applied = health.applyPatches( [ t ], baseFolders(), finding.fix.patches );
    assert.equal( applied.applied.length, 1 );
    assert.equal( t.conditions[ 0 ].operatorType, 16 );
    assert.equal( only( run( [ t ] ), 'zoneEquals' ).length, 0 );
} );

test( 'zone Equals that is part of another zone needs a look and is not bulk', () => {
    const t = trigger( 'Soandso Guk', { conditions: [ condition( 1, 'Freeport' ) ] } );
    const [ finding ] = only( run( [ t ] ), 'zoneEquals' );
    assert.equal( finding.needsLook, true );
    assert.equal( finding.fix.bulk, false );
    assert.match( finding.reason, /other zone/ );
} );

test( 'Equals with an instance number is known and still flagged', () => {
    const t = trigger( 'Soandso Instance', { conditions: [ condition( 1, 'Chardok 19' ) ] } );
    const report = run( [ t ] );
    assert.equal( only( report, 'zoneUnknown' ).length, 0 );
    assert.equal( only( report, 'zoneEquals' ).length, 1 );
} );

test( 'only CurrentZone Equals is flagged', () => {
    const t = trigger( 'Soandso Var', { conditions: [ condition( 1, 'Stage1', 'SomeVariable' ) ] } );
    assert.equal( run( [ t ] ).findings.length, 0 );
} );

// Check 2.
const seed = { zones: [], pairs: [ { from: 'Tower of Discord', to: 'Citadel of the Worldslayer' }, { from: 'The Demiplane of Blood', to: 'Dreadspire Keep' } ] };

test( 'alias is added and bulk-fixable', () => {
    const t = trigger( 'Soandso Alias', { conditions: [ condition( 16, 'Tower of Discord' ) ] } );
    const report = run( [ t ], { zoneKnowledge: seed } );
    const [ finding ] = only( report, 'zoneAlias' );
    assert.ok( finding );
    assert.equal( finding.fix.bulk, true );
    health.applyPatches( [ t ], baseFolders(), finding.fix.patches );
    assert.equal( t.conditions[ 0 ].variableValue, 'Tower of Discord|Citadel of the Worldslayer' );
    assert.equal( only( run( [ t ], { zoneKnowledge: seed } ), 'zoneAlias' ).length, 0 );
} );

test( 'alias is not flagged when both names are present', () => {
    const t = trigger( 'Soandso Both', { conditions: [ condition( 16, 'The Demiplane of Blood|Dreadspire Keep' ) ] } );
    assert.equal( only( run( [ t ], { zoneKnowledge: seed } ), 'zoneAlias' ).length, 0 );
} );

test( 'a Contains that already covers the target is not flagged', () => {
    const t = trigger( 'Soandso Covered', { conditions: [ condition( 16, 'Tower of Discord|Worldslayer' ) ] } );
    assert.equal( only( run( [ t ], { zoneKnowledge: seed } ), 'zoneAlias' ).length, 0 );
} );

test( 'the X: Event rule suggests the plain zone name', () => {
    const t = trigger( 'Soandso Event', { conditions: [ condition( 16, 'Mines of Gloomingdeep: Jail Break!' ) ] } );
    const [ finding ] = only( run( [ t ] ), 'zoneAlias' );
    assert.ok( finding );
    assert.match( finding.fix.label, /Mines of Gloomingdeep/ );
} );

test( 'two aliases of one condition share one patch without duplicates', () => {
    const t = trigger( 'Soandso Two', { conditions: [ condition( 16, 'Tower of Discord|Tower of Discord - Hard' ) ] } );
    const knowledge = { zones: [], pairs: [ ...seed.pairs, { from: 'Tower of Discord - Hard', to: 'Citadel of the Worldslayer' } ] };
    const findings = only( run( [ t ], { zoneKnowledge: knowledge } ), 'zoneAlias' );
    assert.equal( findings.length, 1 );
    assert.equal( findings[ 0 ].fix.patches[ 0 ].to, 'Tower of Discord|Tower of Discord - Hard|Citadel of the Worldslayer' );
} );

// Check 3.
test( 'a typo with one close zone gets a rename, never bulk', () => {
    const t = trigger( 'Soandso Typo', { conditions: [ condition( 16, 'Permafrsot Keep' ) ] } );
    const [ finding ] = only( run( [ t ], { zoneKnowledge: seed } ), 'zoneUnknown' );
    assert.ok( finding );
    assert.equal( finding.fix.safe, false );
    assert.equal( finding.fix.bulk, false );
    assert.match( finding.fix.label, /Permafrost Keep/ );
    health.applyPatches( [ t ], baseFolders(), finding.fix.patches );
    assert.equal( t.conditions[ 0 ].variableValue, 'Permafrost Keep' );
} );

test( 'an unknown zone with no close match has no fix', () => {
    const t = trigger( 'Soandso Nowhere', { conditions: [ condition( 1, 'Qqqqqqq Zzzzzzz' ) ] } );
    const [ finding ] = only( run( [ t ] ), 'zoneUnknown' );
    assert.equal( finding.fix, null );
} );

test( 'a Contains fragment of a known zone is known', () => {
    const t = trigger( 'Soandso Fragment', { conditions: [ condition( 16, 'Kael' ) ] } );
    assert.equal( only( run( [ t ] ), 'zoneUnknown' ).length, 0 );
} );

test( 'learned zones count as known', () => {
    const t = trigger( 'Soandso Learned', { conditions: [ condition( 1, 'Brand New Zone' ) ] } );
    assert.equal( only( run( [ t ] ), 'zoneUnknown' ).length, 1 );
    assert.equal( only( run( [ t ], { zoneKnowledge: { zones: [ 'Brand New Zone' ], pairs: [] } } ), 'zoneUnknown' ).length, 0 );
} );

// Check 4.
test( 'an unreadable pattern is flagged with the error text', () => {
    const t = trigger( 'Soandso Broken', { capturePhrases: [ phrase( '^(Soandso shouts, \'Adds.', { useRegEx: true } ) ] } );
    const [ finding ] = only( run( [ t ] ), 'phraseInvalid' );
    assert.ok( finding );
    assert.equal( finding.severity, 'never' );
    assert.match( finding.detail, /Pattern error/ );
} );

test( 'shortcodes and variables render before compiling', () => {
    const t = trigger( 'Soandso Codes', { capturePhrases: [ phrase( '^{S} hits ${Thing} for {N>5} damage {TS}', { useRegEx: true } ) ] } );
    assert.equal( only( run( [ t ] ), 'phraseInvalid' ).length, 0 );
} );

// Check 5.
test( 'no phrases, empty phrases and an unsupported capture method are flagged', () => {
    const none = trigger( 'Soandso None', { capturePhrases: [], actions: [ { actionId: 'a-none', actionType: 0, phrases: [] } ] } );
    const empty = trigger( 'Soandso Empty', { capturePhrases: [ phrase( '' ) ] } );
    const concurrent = trigger( 'Soandso Concurrent', { captureMethod: 'Concurrent' } );
    const report = run( [ none, empty, concurrent ] );
    assert.equal( only( report, 'noPhrase' ).length, 3 );
    assert.match( only( report, 'noPhrase' ).find( f => f.subject.name === 'Soandso Empty' ).reason, /empty/ );
} );

test( 'placeholders without actions and hotkey triggers are not flagged for missing phrases', () => {
    const placeholder = trigger( 'Soandso Placeholder', { capturePhrases: [], actions: [] } );
    const hotkey = trigger( 'Soandso Hotkey', { capturePhrases: [], hotkeys: [ { hotkeyId: 'h1' } ] } );
    hotkey.actions = [ { actionId: 'a-hot', actionType: 0, phrases: [] } ];
    const report = run( [ placeholder, hotkey ] );
    assert.equal( only( report, 'noPhrase' ).length, 0 );
    assert.equal( only( report, 'actionUnlinked' ).length, 0 );
} );

test( 'an action without a type is not reported as unlinked', () => {
    const t = trigger( 'Soandso Blank' );
    t.actions.push( { actionId: 'blank1', phrases: [] } );
    assert.equal( only( run( [ t ] ), 'actionUnlinked' ).length, 0 );
} );

test( 'an unknown zone with no close match is informational and advanced', () => {
    const t = trigger( 'Soandso Newer', { conditions: [ condition( 16, 'Timorous Falls Annex' ) ] } );
    const [ finding ] = only( run( [ t ] ), 'zoneUnknown' );
    assert.equal( finding.severity, 'info' );
    assert.equal( finding.level, 'advanced' );
} );

test( 'a trigger without a conditions list is flagged', () => {
    const t = trigger( 'Soandso NoConditions' );
    delete t.conditions;
    assert.equal( only( run( [ t ] ), 'noPhrase' ).length, 1 );
} );

// Check 6.
test( 'an unlinked action with one phrase can be linked', () => {
    const t = trigger( 'Soandso Unlinked' );
    t.actions[ 0 ].phrases = [ 'gone' ];
    const [ finding ] = only( run( [ t ] ), 'actionUnlinked' );
    assert.ok( finding );
    assert.equal( finding.fix.bulk, true );
    health.applyPatches( [ t ], baseFolders(), finding.fix.patches );
    assert.deepEqual( t.actions[ 0 ].phrases, [ t.capturePhrases[ 0 ].phraseId ] );
    assert.equal( only( run( [ t ] ), 'actionUnlinked' ).length, 0 );
} );

test( 'an unlinked action with several phrases has no fix', () => {
    const t = trigger( 'Soandso Many', { capturePhrases: [ phrase( 'one' ), phrase( 'two' ) ] } );
    t.actions[ 0 ].phrases = [];
    const [ finding ] = only( run( [ t ] ), 'actionUnlinked' );
    assert.equal( finding.fix, null );
} );

test( 'sub-action targets, list actions and dev-only actions are not unlinked', () => {
    const t = trigger( 'Soandso Sub' );
    const sub = { actionId: 'sub1', actionType: 0, phrases: [] };
    t.actions[ 0 ].endedSubActions = [ { actionId: 'sub1' } ];
    t.actions.push( sub, { actionId: 'list1', actionType: 15, phrases: [] }, { actionId: 'dev1', actionType: 0, phrases: [], onlyExecuteInDev: true } );
    assert.equal( only( run( [ t ] ), 'actionUnlinked' ).length, 0 );
} );

// Check 7.
test( 'Equals with an empty value switches to Is empty', () => {
    const t = trigger( 'Soandso Empty Equals', { conditions: [ condition( 1, '' ) ] } );
    const [ finding ] = only( run( [ t ] ), 'emptyCondition' );
    assert.equal( finding.severity, 'never' );
    assert.equal( finding.fix.bulk, true );
    health.applyPatches( [ t ], baseFolders(), finding.fix.patches );
    assert.equal( t.conditions[ 0 ].operatorType, 0 );
} );

test( 'Contains with an empty value is flagged without a fix', () => {
    const t = trigger( 'Soandso Empty Contains', { conditions: [ condition( 16, '' ) ] } );
    const [ finding ] = only( run( [ t ] ), 'emptyCondition' );
    assert.equal( finding.fix, null );
} );

// Check 8.
test( 'only-store-used-values with only Contains conditions is flagged', () => {
    const storer = trigger( 'Soandso Storer' );
    storer.actions.push( { actionId: 'store1', actionType: 5, variableName: 'Thing', onlyStoreUsedValues: true, phrases: [ storer.capturePhrases[ 0 ].phraseId ] } );
    const user = trigger( 'Soandso User', { conditions: [ condition( 16, 'Ab', 'Thing' ) ] } );
    const [ finding ] = only( run( [ storer, user ] ), 'storeUsedContains' );
    assert.ok( finding );
    assert.equal( finding.level, 'advanced' );
    health.applyPatches( [ storer, user ], baseFolders(), finding.fix.patches );
    assert.equal( storer.actions[ 1 ].onlyStoreUsedValues, false );

    storer.actions[ 1 ].onlyStoreUsedValues = true;
    user.conditions.push( condition( 1, 'Cd', 'Thing' ) );
    assert.equal( only( run( [ storer, user ] ), 'storeUsedContains' ).length, 0 );
} );

// Check 9.
test( 'plain text that looks like a pattern can turn on Use regex', () => {
    const t = trigger( 'Soandso Plain', { capturePhrases: [ phrase( '^Soandso shouts' ) ] } );
    const [ finding ] = only( run( [ t ] ), 'plainLooksRegex' );
    assert.ok( finding );
    assert.equal( finding.fix.bulk, false );
    health.applyPatches( [ t ], baseFolders(), finding.fix.patches );
    assert.equal( t.capturePhrases[ 0 ].useRegEx, true );
    assert.equal( only( run( [ t ] ), 'plainLooksRegex' ).length, 0 );
} );

test( 'plain text with a decimal point is not flagged', () => {
    const t = trigger( 'Soandso Ok', { capturePhrases: [ phrase( 'You hit for 3.5 damage' ) ] } );
    assert.equal( only( run( [ t ] ), 'plainLooksRegex' ).length, 0 );
} );

// Check 10.
test( 'a list code in a plain phrase is flagged', () => {
    const t = trigger( 'Soandso List', { capturePhrases: [ phrase( 'Soandso says {L} now' ) ] } );
    assert.equal( only( run( [ t ] ), 'plainListCode' ).length, 1 );
} );

// Check 11.
test( 'dev-only triggers and actions are informational', () => {
    const dev = trigger( 'Soandso Dev', { onlyExecuteInDev: true, capturePhrases: [] } );
    const partly = trigger( 'Soandso Partly' );
    partly.actions.push( { actionId: 'dev2', actionType: 0, phrases: [], onlyExecuteInDev: true } );
    const report = run( [ dev, partly ] );
    assert.equal( only( report, 'devOnly' ).length, 2 );
    assert.equal( only( report, 'noPhrase' ).length, 0 );
    assert.ok( report.findings.every( f => f.severity === 'info' ) );
} );

// Check 12.
test( 'a class restriction no character has is informational', () => {
    const t = trigger( 'Soandso Class', { classLevels: [ { class: 'WAR', level: 1 } ] } );
    assert.equal( only( run( [ t ], { characterClasses: [ 'MAG' ] } ), 'classUnused' ).length, 1 );
    assert.equal( only( run( [ t ], { characterClasses: [ 'WAR' ] } ), 'classUnused' ).length, 0 );
    assert.equal( only( run( [ t ], { characterClasses: [] } ), 'classUnused' ).length, 0 );
} );

// Check 13.
test( 'slow phrases are flagged for each rule', () => {
    const wildcard = trigger( 'Soandso Wildcard', { capturePhrases: [ phrase( '.*says.*(incoming|adds).*', { useRegEx: true } ) ] } );
    const noLiteral = trigger( 'Soandso NoLiteral', { capturePhrases: [ phrase( '\\d+ \\w+ a', { useRegEx: true } ) ] } );
    const nested = trigger( 'Soandso Nested', { capturePhrases: [ phrase( 'Soandso (a+)+ shouts', { useRegEx: true } ) ] } );
    const names = Array.from( { length: 60 }, ( _, i ) => `Name${i}` ).join( '|' );
    const wide = trigger( 'Soandso Wide', { capturePhrases: [ phrase( `^You see (${names}) here`, { useRegEx: true } ) ] } );
    const fine = trigger( 'Soandso Fine', { capturePhrases: [ phrase( '^Soandso shouts, \'Adds (?<mob>.+) incoming', { useRegEx: true } ) ] } );
    const report = run( [ wildcard, noLiteral, nested, wide, fine ] );
    const slow = only( report, 'slowPhrase' ).map( f => f.subject.name );
    assert.deepEqual( slow.sort(), [ 'Soandso NoLiteral', 'Soandso Nested', 'Soandso Wide', 'Soandso Wildcard' ].sort() );
    assert.ok( only( report, 'slowPhrase' ).every( f => f.severity === 'cost' && f.level === 'advanced' ) );
} );

test( 'analyzePattern counts the longest fixed run', () => {
    assert.equal( health.analyzePattern( '^You have slain (?<mob>.+)!$' ).longestLiteralRun, 15 );
    assert.equal( health.analyzePattern( 'ab?c' ).longestLiteralRun, 1 );
    assert.equal( health.analyzePattern( '\\d{3}x' ).longestLiteralRun, 1 );
    assert.equal( health.analyzePattern( '${Var}hit' ).longestLiteralRun, 3 );
} );

// Folders.
test( 'a folder condition is one finding that counts affected triggers', () => {
    const folders = baseFolders();
    folders[ 0 ].children[ 0 ].folderConditions = [ condition( 1, 'Chardok' ) ];
    const a = trigger( 'Soandso A', { folderId: 'f2' } );
    const b = trigger( 'Soandso B', { folderId: 'f2' } );
    const report = health.checkTriggerHealth( { triggers: [ a, b ], folders, zones: eqZones } );
    const [ finding ] = only( report, 'zoneEquals' );
    assert.equal( finding.subject.kind, 'folder' );
    assert.equal( finding.affectedTriggerIds.length, 2 );
    assert.match( finding.reason, /^Folder condition:/ );
    assert.match( finding.reason, /Affects 2 triggers/ );
    assert.equal( finding.subject.folderPath, 'Raids / Old World' );

    health.applyPatches( [ a, b ], folders, finding.fix.patches );
    assert.equal( folders[ 0 ].children[ 0 ].folderConditions[ 0 ].operatorType, 16 );
} );

// Package triggers.
test( 'package triggers are flagged but excluded from bulk', () => {
    const t = trigger( 'Pack: Vindi', { packageId: 'pkg1', conditions: [ condition( 1, 'Chardok' ) ] } );
    const report = run( [ t ], { packages: [ { packageId: 'pkg1', name: 'Soandso Raid Pack', authorDiscord: 'soandso' } ] } );
    const [ finding ] = only( report, 'zoneEquals' );
    assert.equal( finding.package.name, 'Soandso Raid Pack' );
    assert.equal( finding.fix.bulk, false );
    assert.equal( report.summary.bulkFixes, 0 );

    const quickShare = trigger( 'Imported', { packageId: 'qs1', conditions: [ condition( 1, 'Chardok' ) ] } );
    const second = run( [ quickShare ], { packages: [ { packageId: 'pkg1' } ] } );
    assert.equal( only( second, 'zoneEquals' )[ 0 ].package, null );
    assert.equal( second.summary.bulkFixes, 1 );
} );

// Patches.
test( 'patches skip values that changed and undo reverts them', () => {
    const t = trigger( 'Soandso Patch', { conditions: [ condition( 1, 'Chardok' ) ] } );
    const [ finding ] = only( run( [ t ] ), 'zoneEquals' );

    t.conditions[ 0 ].operatorType = 2;
    const skipped = health.applyPatches( [ t ], baseFolders(), finding.fix.patches );
    assert.equal( skipped.applied.length, 0 );
    assert.equal( skipped.skipped.length, 1 );

    t.conditions[ 0 ].operatorType = 1;
    const applied = health.applyPatches( [ t ], baseFolders(), finding.fix.patches );
    assert.deepEqual( applied.triggerIds, [ t.triggerId ] );
    const undone = health.applyPatches( [ t ], baseFolders(), applied.applied, true );
    assert.equal( undone.applied.length, 1 );
    assert.equal( t.conditions[ 0 ].operatorType, 1 );
} );

test( 'patches find conditions by index when ids are missing', () => {
    const t = trigger( 'Soandso Old', { conditions: [ condition( 1, 'Chardok' ) ] } );
    delete t.conditions[ 0 ].conditionId;
    const [ finding ] = only( run( [ t ] ), 'zoneEquals' );
    const result = health.applyPatches( [ t ], baseFolders(), finding.fix.patches );
    assert.equal( result.applied.length, 1 );
    assert.equal( t.conditions[ 0 ].operatorType, 16 );
} );

test( 'bulk fixing every safe item leaves no safe items', () => {
    const triggers = [
        trigger( 'Soandso One', { conditions: [ condition( 1, 'Chardok' ) ] } ),
        trigger( 'Soandso Two', { conditions: [ condition( 16, 'Tower of Discord' ) ] } ),
        trigger( 'Soandso Three', { conditions: [ condition( 1, '' ) ] } ),
        trigger( 'Soandso Four', { conditions: [ condition( 1, 'Freeport' ) ] } ),
    ];
    triggers[ 3 ].actions[ 0 ].phrases = [ 'gone' ];
    const options = { zoneKnowledge: seed };
    const report = run( triggers, options );
    assert.equal( report.summary.bulkFixes, 4 );
    const patches = report.findings.filter( f => f.fix?.bulk ).flatMap( f => f.fix.patches );
    health.applyPatches( triggers, baseFolders(), patches );
    const after = run( triggers, options );
    assert.equal( after.summary.bulkFixes, 0 );
    assert.ok( after.findings.every( f => !f.fix?.bulk ) );
    assert.equal( only( after, 'zoneEquals' ).length, 1 );
} );

test( 'report text lists names and reasons, and the advanced items only when asked', () => {
    const report = run( [
        trigger( 'Soandso Report', { conditions: [ condition( 1, 'Chardok' ) ] } ),
        trigger( 'Soandso Dev', { onlyExecuteInDev: true } ),
    ] );
    const plain = health.formatReportText( report );
    assert.match( plain, /Soandso Report/ );
    assert.doesNotMatch( plain, /Soandso Dev/ );
    assert.match( health.formatReportText( report, { advanced: true } ), /Soandso Dev/ );
    assert.ok( plain.endsWith( '\n' ) );
} );

test( 'summary counts findings by verb', () => {
    const report = run( [
        trigger( 'Soandso Broken', { capturePhrases: [ phrase( '(', { useRegEx: true } ) ] } ),
        trigger( 'Soandso Zone', { conditions: [ condition( 1, 'Chardok' ) ] } ),
        trigger( 'Soandso Dev', { onlyExecuteInDev: true } ),
    ] );
    assert.equal( report.summary.defaultCounts.never, 1 );
    assert.equal( report.summary.defaultCounts.may, 1 );
    assert.equal( report.summary.counts.info, 1 );
    assert.equal( report.summary.defaultCount, 2 );
} );

// Zone knowledge store, with electron replaced by a temporary data folder.
const dataDir = fs.mkdtempSync( path.join( os.tmpdir(), 'nag-zone-knowledge-' ) );
const originalLoad = Module._load;
const ipcHandlers = {};
Module._load = function ( request, ...rest ) {
    if ( request === 'electron' ) {
        return { app: { getPath: () => dataDir }, ipcMain: { on: ( channel, fn ) => { ipcHandlers[ channel ] = fn; } } };
    }
    return originalLoad.call( this, request, ...rest );
};

try {
    const ZoneKnowledgeStore = require( path.join( root, 'src/electron/data/zone-knowledge.js' ) );

    test( 'zone knowledge starts with the seeded pairs', () => {
        const store = new ZoneKnowledgeStore();
        const { pairs, zones } = store.getKnowledge();
        assert.equal( pairs.length, 6 );
        assert.equal( zones.length, 0 );
        assert.ok( pairs.some( p => p.from === 'The Demiplane of Blood' && p.to === 'Dreadspire Keep' ) );
    } );

    test( 'zone knowledge learns pairs once and ignores known or silly ones', () => {
        const store = new ZoneKnowledgeStore();
        assert.equal( store.recordPair( 'Some Old Name', 'Some New Name 12' ), true );
        assert.equal( store.recordPair( 'some old name', 'Some New Name' ), false );
        assert.equal( store.recordPair( 'Tower of Discord', 'Citadel of the Worldslayer' ), false );
        assert.equal( store.recordPair( 'Same Name', 'same name' ), false );
        assert.equal( store.recordPair( 'x'.repeat( 200 ), 'Short' ), false );
        assert.equal( store.recordZone( 'Chardok' ), false );
        assert.equal( store.recordZone( 'A New Zone 7' ), true );
        const { pairs, zones } = store.getKnowledge();
        assert.equal( pairs.length, 7 );
        assert.ok( zones.includes( 'A New Zone' ) );
        assert.ok( zones.includes( 'Some New Name' ) );
    } );

    test( 'zone knowledge persists and is capped', () => {
        const reloaded = new ZoneKnowledgeStore();
        assert.ok( reloaded.getKnowledge().pairs.some( p => p.from === 'Some Old Name' ) );
        for ( let i = 0; i < 400; i++ ) {
            reloaded.recordZone( `Made Up Zone ${String.fromCharCode( 65 + ( i % 26 ) )}${i}x` );
        }
        assert.ok( reloaded.getKnowledge().zones.length <= 300 );
        const file = JSON.parse( fs.readFileSync( path.join( dataDir, 'zone-knowledge.json' ), 'utf8' ) );
        assert.ok( file.zones.length <= 300 );
    } );
    // The service, with a fake trigger database.
    const TriggerHealthService = require( path.join( root, 'src/electron/data/trigger-health-service.js' ) );
    const waitFor = fn => new Promise( resolve => { const poll = () => ( fn() ? resolve() : setTimeout( poll, 5 ) ); poll(); } );

    const serviceTriggers = [
        trigger( 'Soandso Svc One', { conditions: [ condition( 1, 'Chardok' ) ] } ),
        trigger( 'Soandso Svc Pack', { packageId: 'pkgS', conditions: [ condition( 1, 'Chardok' ) ] } ),
    ];
    let saves = 0;
    let backups = 0;
    let ticks = 0;
    const sent = [];
    const fakeDatabase = {
        getAll: () => serviceTriggers,
        getFolders: () => baseFolders(),
        getInstalledPackages: () => [ { packageId: 'pkgS', name: 'Soandso Pack' } ],
        backupDatafile: done => { backups++; done(); },
        save: () => { saves++; },
        onTriggersImported: fn => { fakeDatabase.imported = fn; },
    };
    const mainWindow = { reference: { webContents: { send: ( channel, data ) => sent.push( [ channel, data ] ) } } };
    const service = new TriggerHealthService( fakeDatabase, { getKnowledge: () => ( { zones: [], pairs: [] } ) }, { getAll: () => [] } );
    service.attachIpcEvents( mainWindow, () => { ticks++; } );
    const reply = channel => { const replies = []; return { sender: { send: ( c, data ) => c === channel && replies.push( data ) }, replies }; };

    test( 'service check reports to the client without patches and broadcasts the summary', () => {
        const event = reply( 'health:check' );
        ipcHandlers[ 'health:check' ]( event, { startup: true } );
        assert.equal( event.replies[ 0 ].findings.length, 2 );
        assert.ok( event.replies[ 0 ].findings.every( f => f.fix && f.fix.patches === undefined ) );
        assert.ok( sent.some( ( [ c ] ) => c === 'health:summary' ) );
    } );

    test( 'service fix-safe skips package triggers, backs up once and undo restores', async () => {
        const event = reply( 'health:fix-safe' );
        ipcHandlers[ 'health:fix-safe' ]( event );
        await waitFor( () => event.replies.length > 0 );
        assert.equal( event.replies[ 0 ].changed, 1 );
        assert.equal( serviceTriggers[ 0 ].conditions[ 0 ].operatorType, 16 );
        assert.equal( serviceTriggers[ 1 ].conditions[ 0 ].operatorType, 1 );
        assert.equal( backups, 1 );
        assert.equal( saves, 1 );
        assert.equal( ticks, 1 );
        assert.ok( sent.some( ( [ c ] ) => c === 'health:changed' ) );

        const packageEvent = reply( 'health:apply' );
        const packageFinding = event.replies[ 0 ].report.findings.find( f => f.package );
        ipcHandlers[ 'health:apply' ]( packageEvent, { ids: [ packageFinding.id ], includePackages: false } );
        await waitFor( () => packageEvent.replies.length > 0 );
        assert.equal( packageEvent.replies[ 0 ].changed, 0 );

        const forced = reply( 'health:apply' );
        ipcHandlers[ 'health:apply' ]( forced, { ids: [ packageFinding.id ], includePackages: true } );
        await waitFor( () => forced.replies.length > 0 );
        assert.equal( forced.replies[ 0 ].changed, 1 );
        assert.equal( backups, 1 );
        assert.equal( serviceTriggers[ 1 ].conditions[ 0 ].operatorType, 16 );

        const undo = reply( 'health:undo' );
        ipcHandlers[ 'health:undo' ]( undo, { undoId: forced.replies[ 0 ].undoId } );
        assert.equal( serviceTriggers[ 1 ].conditions[ 0 ].operatorType, 1 );
        assert.equal( serviceTriggers[ 0 ].conditions[ 0 ].operatorType, 16 );

        const undoAll = reply( 'health:undo' );
        ipcHandlers[ 'health:undo' ]( undoAll, {} );
        assert.equal( serviceTriggers[ 0 ].conditions[ 0 ].operatorType, 1 );
        assert.equal( undoAll.replies[ 0 ].report.summary.undoCount, 0 );

        const unknown = reply( 'health:undo' );
        ipcHandlers[ 'health:undo' ]( unknown, { undoId: 'undo-999' } );
        assert.equal( unknown.replies[ 0 ].changed, 0 );
    } );

    test( 'service tells the main window how many imported triggers need a look', async () => {
        sent.length = 0;
        fakeDatabase.imported( [ serviceTriggers[ 0 ].triggerId ] );
        await waitFor( () => sent.some( ( [ c ] ) => c === 'health:imported' ) );
        assert.deepEqual( sent.find( ( [ c ] ) => c === 'health:imported' )[ 1 ], { count: 1, imported: 1 } );
    } );

    await queue;
} finally {
    Module._load = originalLoad;
    fs.rmSync( dataDir, { recursive: true, force: true } );
}

console.log( `${passed} checks passed` );

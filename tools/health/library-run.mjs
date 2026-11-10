// Runs the trigger health check over trigger database files and prints counts per check, never names.
// Run with: node tools/health/library-run.mjs <trigger-database.json> [more files]
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire( import.meta.url );
const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..', '..' );
const health = require( path.join( root, 'src/electron/data/trigger-health.js' ) );
const eqZones = require( path.join( root, 'src/electron/data/models/everquest-zones.js' ) );

const originalLoad = Module._load;
Module._load = function ( request, ...rest ) {
    if ( request === 'electron' ) {
        return { app: { getPath: () => process.cwd() }, ipcMain: { on() { } } };
    }
    return originalLoad.call( this, request, ...rest );
};
const seedPairs = require( path.join( root, 'src/electron/data/zone-knowledge.js' ) ).seedPairs;
Module._load = originalLoad;

const files = process.argv.slice( 2 );
if ( files.length === 0 ) {
    console.error( 'Usage: node tools/health/library-run.mjs <trigger-database.json> [more files]' );
    process.exit( 1 );
}

files.forEach( ( file, i ) => {
    const data = JSON.parse( fs.readFileSync( file, 'utf8' ) );
    const input = {
        triggers: data.triggers ?? [],
        folders: data.folders ?? [],
        zones: eqZones,
        zoneKnowledge: { zones: [], pairs: seedPairs },
        packages: data.installedPackages ?? [],
        characterClasses: [],
    };

    const started = performance.now();
    const report = health.checkTriggerHealth( input );
    const elapsed = performance.now() - started;

    const byCheck = {};
    const needsLook = {};
    const inAdvanced = {};
    report.findings.forEach( f => {
        byCheck[ f.check ] = ( byCheck[ f.check ] ?? 0 ) + 1;
        if ( f.level === 'advanced' ) {
            inAdvanced[ f.check ] = ( inAdvanced[ f.check ] ?? 0 ) + 1;
        }
        if ( f.needsLook ) {
            needsLook[ f.check ] = ( needsLook[ f.check ] ?? 0 ) + 1;
        }
    } );

    console.log( `Library ${i + 1}: ${report.summary.triggers} triggers, ${report.summary.folders} folders, ${report.findings.length} findings in ${elapsed.toFixed( 0 )} ms` );
    Object.keys( health.CHECKS ).forEach( check => {
        const meta = health.CHECKS[ check ];
        console.log( `  ${String( meta.number ).padStart( 2 )} ${check.padEnd( 18 )} ${meta.severity.padEnd( 5 )} ${meta.level.padEnd( 8 )} ${String( byCheck[ check ] ?? 0 ).padStart( 5 )}${inAdvanced[ check ] ? ` (${inAdvanced[ check ]} in advanced)` : ''}${needsLook[ check ] ? ` (${needsLook[ check ]} need a look)` : ''}` );
    } );
    console.log( `  default view: ${report.summary.defaultCount}, safe one-click fixes: ${report.summary.bulkFixes}` );

    const patches = report.findings.filter( f => f.fix?.bulk ).flatMap( f => f.fix.patches );
    const applied = health.applyPatches( input.triggers, input.folders, patches );
    const after = health.checkTriggerHealth( input );
    console.log( `  bulk fix: ${applied.applied.length} patches applied, ${applied.skipped.length} skipped, safe fixes left after: ${after.summary.bulkFixes}, default findings left: ${after.summary.defaultCount}` );

    const undone = health.applyPatches( input.triggers, input.folders, applied.applied, true );
    const restored = health.checkTriggerHealth( input );
    console.log( `  undo: ${undone.applied.length} reverted, findings after undo: ${restored.findings.length} (before: ${report.findings.length})` );
} );

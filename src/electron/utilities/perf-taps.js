// The timing side of perf.js.  Release and Pre-release builds delete this
// file; it's only loaded when Nag is started with --perf.
//
// Every process keeps running totals per tap name and sends them to the main
// process every 5 seconds.  The main process writes perf-report.json to the
// user data folder every 10 seconds, with those totals and each process's CPU
// time.  Totals are cumulative, so compare two reports to see a rate.
//
// The report also says how long the session ran, which build and machine it
// was, any notes the code left about its settings, and a once-a-minute timeline
// of CPU time and tap counts to show bursts against idle.

const { performance } = require( 'perf_hooks' );

/** @type {Record<string, {count: number, totalMs: number, maxMs: number}>} */
const stats = {};

/** @type {Record<string, any>} */
const notes = {};

const startedAt = new Date();
const timelineIntervalMs = 60000;
const timelineMax = 1440;

function now() {
    return performance.now();
}

/**
 * Adds the time since start to the named tap.
 * 
 * @param {string} name The tap name.
 * @param {number} start The perf.now() value when the work started.
 * @param {number} [sampling] For taps only recorded on 1 call in N: scales the count and time by N.
 */
function record( name, start, sampling = 1 ) {
    const ms = performance.now() - start;
    const s = stats[ name ] ?? ( stats[ name ] = { count: 0, totalMs: 0, maxMs: 0 } );
    s.count += sampling;
    s.totalMs += ms * sampling;
    if ( ms > s.maxMs ) {
        s.maxMs = ms;
    }
}

/**
 * Keeps a setting worth knowing when reading the report.
 *
 * @param {string} key The note's name.
 * @param {any} value The note's value.
 */
function note( key, value ) {
    notes[ key ] = value;
}

function wrap( name, fn ) {
    return function ( ...args ) {
        const t = performance.now();
        try {
            return fn.apply( this, args );
        } finally {
            record( name, t );
        }
    };
}









/**
 * Names a window by its page, e.g. "log-watcher (Maxxer)" or "main window".
 *
 * @param {string} url The window's url.
 */
function labelOf( url ) {
    try {
        const u = new URL( url );
        if ( u.hash.startsWith( '#/' ) ) {
            return `main window ${u.hash}`;
        }
        const page = u.pathname.split( '/' ).pop().replace( /\.html$/, '' );
        const character = u.searchParams.get( 'character' );
        const name = character ? JSON.parse( character )?.name : null;
        return name ? `${page} (${name})` : page;
    } catch {
        return url;
    }
}









function startCollector() {
    const { app, ipcMain, webContents, screen } = require( 'electron' );
    const fs = require( 'fs' );
    const os = require( 'os' );
    const path = require( 'path' );

    /** @type {Record<number, {label: string, pid: number, stats: object, notes: object, closedAt?: string}>} */
    const reports = {};

    /** @type {Array<{t: number, cpu: Record<string, number>, taps: Record<string, Record<string, number>>, notes?: Record<string, object>}>} */
    const timeline = [];

    let build = null;
    try {
        const info = require( './perf-always-on.json' );
        if ( typeof info?.commit === 'string' && typeof info?.ref === 'string' ) {
            build = { commit: info.commit, ref: info.ref };
        }
    } catch {
        // Not a perf build.
    }

    ipcMain.on( 'perf:report', ( event, data ) => {
        try {
            const id = event.sender.id;
            const closedAt = reports[ id ]?.closedAt;
            if ( !reports[ id ] ) {
                event.sender.once( 'destroyed', () => {
                    if ( reports[ id ] && !reports[ id ].closedAt ) {
                        reports[ id ].closedAt = new Date().toISOString();
                    }
                } );
            }
            reports[ id ] = { label: labelOf( event.sender.getURL() ), pid: event.sender.getOSProcessId(), stats: data.stats, notes: data.notes ?? {} };
            if ( closedAt ) {
                reports[ id ].closedAt = closedAt;
            }
        } catch {
            // The window went away.
        }
    } );

    const uptime = () => Math.round( ( Date.now() - startedAt.getTime() ) / 100 ) / 10;

    const labelsByPid = () => {
        const labels = {};
        webContents.getAllWebContents().forEach( wc => {
            labels[ wc.getOSProcessId() ] = labelOf( wc.getURL() );
        } );
        return labels;
    };

    const labelOfProcess = ( m, labels ) => m.type === 'Browser' ? 'main process' : labels[ m.pid ] ?? m.type;

    const tapEntries = () => [ { label: 'main process', pid: process.pid, stats, notes }, ...Object.values( reports ) ];

    const cpus = os.cpus();
    const cpuModel = cpus[ 0 ]?.model;
    const cpuCores = cpus.length;

    const machine = () => {
        let displays = [];
        try {
            displays = screen.getAllDisplays().map( d => ( { width: d.size.width, height: d.size.height, scaleFactor: d.scaleFactor } ) );
        } catch {
            // No screen to ask.
        }
        return { cpuModel, cpuCores, displays };
    };

    const sample = () => {
        try {
            const labels = labelsByPid();
            const cpu = {};
            app.getAppMetrics().forEach( m => {
                const label = labelOfProcess( m, labels );
                cpu[ label ] = Math.round( ( ( cpu[ label ] ?? 0 ) + m.cpu.cumulativeCPUUsage ) * 100 ) / 100;
            } );

            const taps = {};
            tapEntries().forEach( entry => {
                const counts = taps[ entry.label ] ?? ( taps[ entry.label ] = {} );
                Object.entries( entry.stats ).forEach( ( [ name, s ] ) => {
                    if ( !name.startsWith( 'trigger: ' ) ) {
                        counts[ name ] = ( counts[ name ] ?? 0 ) + s.count;
                    }
                } );
            } );

            const sampleNotes = {};
            tapEntries().forEach( entry => {
                if ( entry.notes && Object.keys( entry.notes ).length > 0 ) {
                    sampleNotes[ entry.label ] = { ...sampleNotes[ entry.label ], ...entry.notes };
                }
            } );

            const point = { t: uptime(), cpu, taps };
            if ( Object.keys( sampleNotes ).length > 0 ) {
                point.notes = sampleNotes;
            }
            timeline.push( point );
            if ( timeline.length > timelineMax ) {
                timeline.shift();
            }
        } catch {
            // Skip this sample.
        }
    };

    const write = () => {
        try {
            const labels = labelsByPid();
            const report = {
                generatedAt: new Date().toISOString(),
                startedAt: startedAt.toISOString(),
                uptimeSeconds: uptime(),
                version: app.getVersion(),
                build,
                machine: machine(),
                processes: app.getAppMetrics().map( m => {
                    const entry = {
                        pid: m.pid,
                        type: m.type,
                        label: labelOfProcess( m, labels ),
                        cpuSeconds: m.cpu.cumulativeCPUUsage,
                    };
                    if ( Number.isFinite( m.creationTime ) && m.creationTime > 0 ) {
                        entry.startedAt = new Date( m.creationTime ).toISOString();
                    }
                    return entry;
                } ),
                taps: tapEntries(),
                timeline,
            };

            fs.writeFile( path.join( app.getPath( 'userData' ), 'perf-report.json' ), JSON.stringify( report ), () => { } );
        } catch {
            // Try again at the next write.
        }
    };

    app.whenReady().then( () => {
        setInterval( write, 10000 );
        setInterval( sample, timelineIntervalMs );
    } );
}









function startReporter() {
    const { ipcRenderer } = require( 'electron' );
    setInterval( () => {
        try {
            ipcRenderer.send( 'perf:report', { stats, notes } );
        } catch {
            // Skip this report.
        }
    }, 5000 );
}

if ( process.type === 'browser' ) {
    startCollector();
} else {
    startReporter();
}

module.exports = { enabled: true, now, record, note, wrap };

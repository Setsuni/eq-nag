const { app, BrowserWindow, ipcMain, screen } = require( "electron" );
const fs = require('fs');
const fsp = fs.promises;
const path = require( 'path' );
const CharacterDatabaseStore = require( './data/character-database' );
const { CharacterModel } = require( './data/models/character' );
const _ = require( 'lodash' );
const UserPreferencesStore = require( "./data/user-preferences" );
const FsUtilities = require( "./utilities/file-system" );
const log = require( 'electron-log' );
const ForwardRef = require( './forward-ref' );
const { LogMaintenancePlanTypes, LogMaintenanceRules, ArchiveFilePrefix, SimulationProgress } = require( "./data/models/common" );
const { nagLog } = require( "./utilities/nag-console" );
const CombatDatabase = require( "./data/combat-database" );
const TriggerPerfStore = require( "./data/trigger-perf-store" );
const { sanitizeReport, sanitizeCounters } = TriggerPerfStore;
const { measureDurationMs: triggerPerfDuration } = require( "./utilities/trigger-metrics" );
const customAlphabet = require( 'nanoid' ).customAlphabet;
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const nanoid = customAlphabet( alphabet, 16 );

class LogWatcherMeta {
    /** @type {BrowserWindow|null} */
    window;

    /** @type {string} */
    logFile;

    /** @type {number} */
    logSize;

    /** @type {number} */
    nullAttemptCount;

    /** @type {CharacterModel} */
    model;

    /** @type {() => void} */
    interrupt;

    /** @type {() => void} */
    start;

    /** @type {number} */
    intervalId;
}

class CombatWatcherMeta {
    /** @type {BrowserWindow|null} */
    window;

    /** @type {string} */
    characterId;

    /** @type {CharacterModel | undefined | null} */
    character;
}

/** @type {Record<string, LogWatcherMeta>} Dictionary of log watcher windows. */
var logWatchers = {};

/** @type {boolean} */
var userSelectedCombatWatcher = false;

/** @type {CombatWatcherMeta} */
var combatWatcher = {
    window: null,
    characterId: null,
    character: null,
    server: null,
};

/** @type {Record<string, {startedAt: number, endsAt: number}>} Trigger measurements in progress, by character id. */
var triggerPerfActive = {};

/** @type {TriggerPerfStore|null} The last finished trigger measurement report of each character. */
var triggerPerfStore = null;

/** @type {Record<string, {characterId: string, done: (counters: any) => void}>} Pending requests for a log watcher's trigger counters. */
var triggerCounterRequests = {};

let cwReady = false;
/** @type {(() => void) | undefined} */
let cwOnDomReady;

/** @type {ForwardRef<BrowserWindow>} */
let mainWinRef = undefined;

/** @type {number} The duration to wait between checking for activity on a log file. */
const checkInterval = 5 * 1000;
const maxBackupRetryInterval = 5 * 60 * 1000;

/**
 * Returns true if the given file name is a rotated copy of the given log file name, in the current or the legacy naming.
 * 
 * @param {string} fileName The file name to test.
 * @param {string} logFileName The watched log file name.
 */
const isRotatedLogName = ( fileName, logFileName ) => {
    const match = /^archive_(?:\d+_)?(.+)$/.exec( fileName );
    return match != null && match[ 1 ] === logFileName;
};

/**
 * Returns a unique path for the rotated copy of the given log file, so a rotation never overwrites an archive file that is still waiting to be zipped.
 * 
 * @param {string} logFile The log file path.
 */
const getArchiveFilePath = logFile => FsUtilities.Path.prependFilename( logFile, `${ArchiveFilePrefix}${Date.now()}_` );

/** @type {number} The duration to wait for no log file updates before closing the log file watcher. */
const killTime = 5 * 60 * 1000;

/** @type {number} If the log file has no updates in the given number of checks, then kill the log watcher window. */
const killAfterNAttempts = killTime / checkInterval;

class LogBootstrapper {

    /** @type {UserPreferencesStore} */
    #userPreferences;

    // /** @type {{logFile: string, callback: () => void}[]} */
    /** @type {{logFile: string, size: number}[]} */
    #filesForArchive = [];

    /** @type {BrowserWindow} */
    #logBackupWindow = null;

    /** @type {Set<string>} The files being archived by the open backup window. */
    #archiveInFlight = new Set();

    /** @type {boolean} */
    #isDev = false;

    /** @type {number} */
    #backupWaitId = null;

    /** @type {boolean]} */
    get isBackupProcessing() {
        return this.#logBackupWindow != null;
    }

    /** @type {(character: string) => void} */
    onLogWatcherWindowClosed = undefined;










    /**
     * Finds the log watcher window of a character.
     *
     * @param {string|undefined} characterId The character id; the first running log watcher if omitted.
     * @returns {{characterId: string, window: BrowserWindow}|null}
     */
    #findLogWatcher( characterId ) {
        const id = characterId ?? Object.keys( logWatchers ).find( key => logWatchers[ key ].window != null );
        const window = logWatchers[ id ]?.window;
        return window ? { characterId: id, window: window } : null;
    }

    /**
     * Finds the character a log watcher window belongs to.
     *
     * @param {Electron.WebContents} sender The sender of an IPC message.
     * @returns {string|null} The character id, or null when the sender is not a log watcher.
     */
    #watcherCharacterId( sender ) {
        return Object.keys( logWatchers ).find( key => {
            const window = logWatchers[ key ].window;
            return window != null && !window.isDestroyed() && window.webContents === sender;
        } ) ?? null;
    }

    /**
     * Lists the characters that have a log watcher or a stored trigger report, watched ones first.
     *
     * @param {(characterId: string) => string|undefined} nameOf Finds a character's name.
     * @returns {{characterId: string, name: string, watching: boolean, hasReport: boolean}[]}
     */
    getTriggerPerfCharacters( nameOf ) {
        const watching = Object.keys( logWatchers ).filter( key => logWatchers[ key ].window != null );
        const stored = triggerPerfStore?.characterIds() ?? [];
        return [ ...new Set( [ ...watching, ...stored ] ) ].map( id => ( {
            characterId: id,
            name: nameOf( id ) ?? id,
            watching: watching.includes( id ),
            hasReport: stored.includes( id ),
        } ) );
    }

    /**
     * Lists the characters Nag reads logs for, with whether each is being read now and when its log file last changed.
     *
     * @param {CharacterDatabaseStore} characterDatabase The character database.
     * @returns {Promise<{characterId: string, name: string, class: string|null, watching: boolean, lastLineAt: number|null}[]>}
     */
    async getWatchStatus( characterDatabase ) {
        return Promise.all( Object.keys( logWatchers ).map( async id => {
            const character = characterDatabase.find( id );
            const stats = await FsUtilities.statOrNull( logWatchers[ id ].logFile );
            return {
                characterId: id,
                name: character?.name ?? id,
                class: character?.class ?? null,
                watching: logWatchers[ id ].window != null,
                lastLineAt: stats?.mtimeMs ?? null,
            };
        } ) );
    }

    /**
     * Starts a ten minute trigger measurement.
     *
     * @param {string|undefined} characterId The character id; the first running log watcher if omitted.
     * @returns {{started: boolean, characterId?: string}}
     */
    startTriggerPerf( characterId ) {
        const watcher = this.#findLogWatcher( characterId );
        if ( !watcher ) {
            return { started: false };
        }
        const now = Date.now();
        triggerPerfActive[ watcher.characterId ] = { startedAt: now, endsAt: now + triggerPerfDuration };
        watcher.window.webContents.send( 'trigger-perf:start' );
        return { started: true, characterId: watcher.characterId };
    }

    /**
     * Ends a trigger measurement early; the report arrives through the trigger-perf:finished event.
     *
     * @param {string|undefined} characterId The character id; the first running log watcher if omitted.
     * @returns {{stopped: boolean}}
     */
    stopTriggerPerf( characterId ) {
        const watcher = this.#findLogWatcher( characterId );
        watcher?.window.webContents.send( 'trigger-perf:stop' );
        return { stopped: watcher != null };
    }

    /**
     * Gets the state of the trigger measurement and the last finished report.
     *
     * @param {string|undefined} characterId The character id; the first running log watcher if omitted.
     * @returns {{characterId?: string, measuring: boolean, startedAt?: number, endsAt?: number, last: any}}
     */
    getTriggerPerf( characterId ) {
        const id = characterId ?? this.#findLogWatcher( undefined )?.characterId ?? triggerPerfStore?.latestCharacterId() ?? undefined;
        const active = triggerPerfActive[ id ];
        // A watcher that closed mid-measurement never reports; stop showing it as running shortly after it should have ended.
        const measuring = active != null && Date.now() < active.endsAt + 30 * 1000;
        return { characterId: id, measuring: measuring, startedAt: active?.startedAt, endsAt: active?.endsAt, last: triggerPerfStore?.get( id ) ?? null };
    }

    /**
     * Asks a log watcher for its always-on trigger counters.
     *
     * @param {string|undefined} characterId The character id; the first running log watcher if omitted.
     * @returns {Promise<Record<string, {name: string, fired: number}>|null>} How often each trigger fired since the watcher started.
     */
    getTriggerCounters( characterId ) {
        const watcher = this.#findLogWatcher( characterId );
        if ( !watcher ) {
            return Promise.resolve( null );
        }
        return new Promise( resolve => {
            const requestId = nanoid();
            const done = counters => {
                clearTimeout( timeoutId );
                delete triggerCounterRequests[ requestId ];
                resolve( counters );
            };
            const timeoutId = setTimeout( () => done( null ), 5000 );
            triggerCounterRequests[ requestId ] = { characterId: watcher.characterId, done: done };
            watcher.window.webContents.send( 'trigger-perf:counters-request', requestId );
        } );
    }

    /**
     * Begins the process of checking and running log file watchers.
     * 
     * @param {ForwardRef<BrowserWindow>} mainWindowRef The main window of the application.
     * @param {boolean} isDev Sets up the log watcher window for development environment if true.
     * @param {CharacterDatabaseStore} characterDatabase The character database.
     * @param {() => void} sendTick The send tick method.
     * @param {UserPreferencesStore} userPreferences The user preferences store.
     * @param {(error: Error) => void} appLogException The application log exception method.
     * @param {CombatDatabase} combatDb The combat database store.
     */
    boostrapLogWatchers( mainWindowRef, isDev, characterDatabase, sendTick, userPreferences, appLogException, combatDb ) {

        mainWinRef = mainWindowRef;
        this.#userPreferences = userPreferences;
        this.#isDev = isDev;
        const $this = this;

        ipcMain.on( 'app:clear-log-history', ( event ) => {
            for ( let key in logWatchers ) {
                if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                    logWatchers[ key ].window.webContents.send( 'app:clear-log-history', undefined );
                }
            }
        } );
        
        ipcMain.on( 'tick', ( event, tickData ) => {
            for ( let key in logWatchers ) {
                if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                    logWatchers[ key ].model = characterDatabase.find( key );
                    tickData.characterModel = logWatchers[ key ].model;
                    logWatchers[ key ].window.webContents.send( 'tick', tickData );
                }
            }
            combatWatcher.window?.webContents.send( 'tick', tickData );
        } );

        triggerPerfStore = new TriggerPerfStore( app.getPath( 'userData' ) );

        // Trigger performance: the main window starts a ten minute measurement per character and reads the last report.
        const idArg = value => typeof value === 'string' ? value : undefined;
        ipcMain.handle( 'trigger-perf:start', ( event, characterId ) => $this.startTriggerPerf( idArg( characterId ) ) );
        ipcMain.handle( 'trigger-perf:stop', ( event, characterId ) => $this.stopTriggerPerf( idArg( characterId ) ) );
        ipcMain.handle( 'trigger-perf:get', ( event, characterId ) => $this.getTriggerPerf( idArg( characterId ) ) );
        ipcMain.handle( 'trigger-perf:counters', ( event, characterId ) => $this.getTriggerCounters( idArg( characterId ) ) );
        ipcMain.handle( 'trigger-perf:characters', () => $this.getTriggerPerfCharacters( id => characterDatabase.find( id )?.name ) );

        ipcMain.handle( 'app:status:watching', () => $this.getWatchStatus( characterDatabase ) );

        // Only a log watcher window may report; the character is the one that watcher belongs to.
        ipcMain.on( 'trigger-perf:result', ( event, data ) => {
            const characterId = $this.#watcherCharacterId( event.sender );
            if ( characterId == null ) {
                return;
            }
            delete triggerPerfActive[ characterId ];
            const report = sanitizeReport( data?.report );
            // A window without log lines says nothing, so the previous report stays.
            const saved = report != null && report.lineCount > 0;
            if ( saved ) {
                triggerPerfStore.set( characterId, report );
            }
            mainWinRef?.reference?.webContents.send( 'trigger-perf:finished', { characterId: characterId, saved: saved } );
        } );

        ipcMain.on( 'trigger-perf:counters-response', ( event, data ) => {
            const characterId = $this.#watcherCharacterId( event.sender );
            const pending = typeof data?.requestId === 'string' ? triggerCounterRequests[ data.requestId ] : null;
            if ( characterId != null && pending?.characterId === characterId ) {
                pending.done( sanitizeCounters( data.counters ) );
            }
        } );

        ipcMain.on( 'log:send:raw', function ( event, data ) {
            for ( let key in logWatchers ) {
                if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                    logWatchers[ key ].window.webContents.send( 'log:parse:raw', data );
                    break;
                }
            }
            combatWatcher.window?.webContents.send( 'log:parse:raw', data );
        } );

        ipcMain.on( 'log:simulate:file', function ( event, data ) {
            for ( let key in logWatchers ) {
                if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                    logWatchers[ key ].window.webContents.send( 'log:simulate:file', data );
                    break;
                }
            }
            combatWatcher.window?.webContents.send( 'log:simulate:file', data );
        } );

        // Trigger editor "Test with a log line": the log watcher evaluates the unsaved trigger against one line.
        const triggerTestReplies = {};
        ipcMain.on( 'trigger:test:run',
            /**
             * Sends a trigger and a log line to a log watcher, starting one for the first character if none is running.
             *
             * @param {Electron.IpcMainEvent} event Electron event args.
             * @param {{ requestId: string, trigger: any, line: string, fire: boolean }} data The test request.
             */
            function ( event, data ) {
                const requestId = typeof data?.requestId === 'string' && data.requestId.length <= 64 ? data.requestId : null;
                const pending = { watcher: null, done: false };
                const reply = result => {
                    if ( pending.done ) {
                        return;
                    }
                    pending.done = true;
                    delete triggerTestReplies[ requestId ];
                    if ( !event.sender.isDestroyed() ) {
                        event.sender.send( 'trigger:test:result', Object.assign( { requestId: requestId }, result ) );
                    }
                };

                const valid = requestId !== null
                    && data.trigger != null && typeof data.trigger === 'object' && !Array.isArray( data.trigger )
                    && typeof data.line === 'string' && data.line.length <= 2000
                    && typeof data.fire === 'boolean';
                if ( !valid ) {
                    reply( { ok: false, error: 'failed' } );
                    return;
                }

                triggerTestReplies[ requestId ] = Object.assign( pending, { reply: reply } );
                setTimeout( () => reply( { ok: false, error: 'timeout' } ), 15000 );

                // A watcher that is still loading has no listener yet, so wait for it.
                const send = watcherWindow => {
                    pending.watcher = watcherWindow.webContents;
                    if ( watcherWindow.webContents.isLoading() ) {
                        watcherWindow.webContents.once( 'dom-ready', () => !watcherWindow.isDestroyed() && watcherWindow.webContents.send( 'trigger:test:run', data ) );
                    } else {
                        watcherWindow.webContents.send( 'trigger:test:run', data );
                    }
                };

                const watcherKey = Object.keys( logWatchers ).find( key => logWatchers[ key ].window != null );
                if ( watcherKey ) {
                    send( logWatchers[ watcherKey ].window );
                    return;
                }

                const _chr = characterDatabase.getAll()[ 0 ];
                if ( !_chr || !logWatchers[ _chr.characterId ] ) {
                    reply( { ok: false, error: 'noCharacter' } );
                    return;
                }

                let _stats = FsUtilities.statOrNullSync( _chr.logFile );
                logWatchers[ _chr.characterId ].window = startLogWatcherWindow( _chr.logFile, isDev, sendTick, _chr, logWatchers[ _chr.characterId ].logSize > ( _stats?.size ?? 0 ) ? 0 : logWatchers[ _chr.characterId ].logSize );
                mainWindowRef.reference.webContents.send( 'log:character:activated', _chr.characterId );
                send( logWatchers[ _chr.characterId ].window );
            } );

        ipcMain.on( 'trigger:test:result', function ( event, result ) {
            const pending = triggerTestReplies[ result?.requestId ];
            if ( pending && pending.watcher === event.sender ) {
                pending.reply( result );
            }
        } );

        ipcMain.on( 'log:store:variable', function ( event, data ) {
            for ( let key in logWatchers ) {
                if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                    logWatchers[ key ].window.webContents.send( 'log:store:variable', data );
                }
            }
        } );

        ipcMain.on( 'log:store:scalar-variable', function ( event, data ) {
            for ( let key in logWatchers ) {
                if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                    logWatchers[ key ].window.webContents.send( 'log:store:scalar-variable', data );
                }
            }
        } );

        // TODO: Extend simulation to the combat watcher as well.
        ipcMain.on( 'log:simulate:begin',
            /**
             * Runs the simulation.
             * 
             * @param {Electron.IpcMainEvent} event Electron event args.
             * @param {{ lines: string[], characterId: string, lineIndex: number|null }} data The data to simulate.
             */
            function ( event, data ) {
                
                let powerSaveBlockerId = null;
                const powerSaveBlocker = require( 'electron' ).powerSaveBlocker;

                // Prevent the system from suspending while simulating.
                powerSaveBlockerId = powerSaveBlocker.start( 'prevent-app-suspension' );

                let simulationId = nanoid();
                let simData = {
                    lines: data.lines,
                    lineIndex: data.lineIndex,
                    simulationId: simulationId,
                };

                // Create a clean up function that unregisters the sim events.
                const cleanUp = function () {
                    ipcMain.removeAllListeners( `log:simulation:${simulationId}:progress` );
                    ipcMain.removeAllListeners( `log:simulation:${simulationId}:pause` );
                    ipcMain.removeAllListeners( `log:simulation:${simulationId}:resume` );
                    ipcMain.removeAllListeners( `log:simulation:${simulationId}:stop` );
                    ipcMain.removeAllListeners( `log:simulation:${simulationId}:lines` );

                    combatWatcher.window?.webContents.send( 'log:simulate:end', {} );
                    event.sender?.send( `simulation:${simulationId}:progress`, { isComplete: true, completePercent: 100, label: 'Simulation complete' } );
                    
                    logWatchers[ data.characterId ].window.setAlwaysOnTop( false );
                    
                    if ( powerSaveBlocker.isStarted( powerSaveBlockerId ) ) {
                        powerSaveBlocker.stop( powerSaveBlockerId );
                    }
                };

                ipcMain.on( `log:simulation:${simulationId}:lines`,
                    /**
                     * @param {Electron.IpcMainEvent} childEvent Electron event args.
                     * @param {{lines: string[], padTime: number}} lines 
                     */
                    function ( childEvent, lines ) {
                        combatWatcher.window?.webContents.send( 'log:simulate:lines', lines );
                    } );
                    
                // Setup sim events that handle progress and control.

                ipcMain.on( `log:simulation:${simulationId}:progress`,
                    /**
                     * Handles passing progress data to the user window.
                     * 
                     * @param {Electron.IpcMainEvent} childEvent Electron event args.
                     * @param {SimulationProgress} data The sim progress data.
                     */
                    function ( childEvent, data ) {
                        // Executed when log watcher window sends progress.
                        event.sender?.send( `simulation:${simulationId}:progress`, data );

                        if ( data.isComplete ) {
                            cleanUp();
                        }
                    } );

                ipcMain.on( `log:simulation:${simulationId}:pause`,
                    /**
                     * Passes pause event to the log watcher window.
                     * 
                     * @param {Electron.IpcMainEvent} childEvent Electron event args.
                     */
                    function ( childEvent ) {
                        // Executed when user pauses sim.
                        logWatchers[ data.characterId ].window.webContents.send( `log:simulation:${simulationId}:pause` );
                    } );

                ipcMain.on( `log:simulation:${simulationId}:resume`,
                    /**
                     * Passes resume event to the log watcher window.
                     * 
                     * @param {Electron.IpcMainEvent} childEvent Electron event args.
                     * @param {number|null} lineNumber The line number to resume from.
                     */
                    function ( childEvent, lineNumber ) {
                        // Executed when user resumes sim.
                        logWatchers[ data.characterId ].window.webContents.send( `log:simulation:${simulationId}:resume`, lineNumber );
                    } );

                ipcMain.on( `log:simulation:${simulationId}:stop`,
                    /**
                     * Passes stop event to the log watcher window.
                     * 
                     * @param {Electron.IpcMainEvent} childEvent Electron event args.
                     */
                    function ( childEvent ) {
                        // Executed when user stops sim.
                        logWatchers[ data.characterId ].window.webContents.send( `log:simulation:${simulationId}:stop` );
                    } );
                
                ipcMain.on( `log:simulation:${simulationId}:stopped`,
                    /**
                     * Passes stop event to the user window.
                     * 
                     * @param {Electron.IpcMainEvent} childEvent Electron event args.
                     */
                    ( childEvent ) => {
                        cleanUp();
                    } );

                let _chr = characterDatabase.find( data.characterId );

                if ( _chr && logWatchers[ _chr.characterId ].window == null ) {
                    let _stats = FsUtilities.statOrNullSync( _chr.logFile );

                    // If the window has not been engaged, then open it. // TODO: Start up a log watcher when simulating. Even allow a charcter to be selected from a list.
                    logWatchers[ _chr.characterId ].window = startLogWatcherWindow( _chr.logFile, isDev, sendTick, _chr, logWatchers[ _chr.characterId ].logSize > ( _stats?.size ?? 0 ) ? 0 : logWatchers[ _chr.characterId ].logSize );
            
                    // Notify the main window.
                    mainWindowRef.reference.webContents.send( 'log:character:activated', _chr.characterId );
                
                    logWatchers[ _chr.characterId ].window.webContents.once( 'dom-ready', () => {
                        logWatchers[ _chr.characterId ].window.webContents.send( 'log:simulate:begin', simData );
                        logWatchers[ _chr.characterId ].window.setAlwaysOnTop( true );
                        logWatchers[ _chr.characterId ].simulating = true;
                    } );

                } else {
                    logWatchers[ _chr.characterId ].window.webContents.send( 'log:simulate:begin', simData );
                    logWatchers[ _chr.characterId ].window.setAlwaysOnTop( true );
                    logWatchers[ _chr.characterId ].simulating = true;
                }

                combatWatcher.window?.webContents.send( 'log:simulate:begin', {} );
                event.sender?.send( 'log:simulate:begin', simData.simulationId );
            } ); // ipcMain 'log:simulate:begin'

        // TODO: I think this is unused.
        ipcMain.on( 'log:simulate:lines', function ( event, data ) {
            for ( let key in logWatchers ) {
                if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                    logWatchers[ key ].window.webContents.send( 'log:simulate:lines', data );
                    logWatchers[ key ].simulating = true;
                    break;
                }
            }

            
            if ( !_.some( logWatchers, f => f.simulating ) ) {
                let characters = characterDatabase.getAll();
                let _chr = characters[ 0 ];
                if ( logWatchers[ _chr.characterId ].window == null ) {
                    let _stats = FsUtilities.statOrNullSync( _chr.logFile );

                    // If the window has not been engaged, then open it. // TODO: Start up a log watcher when simulating. Even allow a charcter to be selected from a list.
                    logWatchers[ _chr.characterId ].window = startLogWatcherWindow( _chr.logFile, isDev, sendTick, _chr, logWatchers[ _chr.characterId ].logSize > ( _stats?.size ?? 0 ) ? 0 : logWatchers[ _chr.characterId ].logSize );
                
                    // Notify the main window.
                    mainWindowRef.reference.webContents.send( 'log:character:activated', _chr.characterId );
                    
                    logWatchers[ _chr.characterId ].window.webContents.once( 'dom-ready', () => {
                        logWatchers[ _chr.characterId ].window.webContents.send( 'log:simulate:lines', data );
                        logWatchers[ _chr.characterId ].simulating = true;
                    } );

                } else {
                    // logWatchers[ _chr.characterId ].window.webContents.once( 'dom-ready', () => {
                    logWatchers[ _chr.characterId ].window.webContents.send( 'log:simulate:lines', data );
                    logWatchers[ _chr.characterId ].simulating = true;
                    // } );
                }

            }
        } );

        ipcMain.on( 'log:simulate:done', function ( event, characterId ) {
            if ( logWatchers.hasOwnProperty( characterId ) ) {
                logWatchers[ characterId ].simulating = false;
            }
        } );

        ipcMain.on( 'log:destroy:component', function ( event, instanceId ) {
            for ( let key in logWatchers ) {
                if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                    logWatchers[ key ].window.webContents.send( 'component:destroy', instanceId );
                }
            }
        } );

        ipcMain.on( 'log:speak:phrase', function ( event, data ) {
            for ( let key in logWatchers ) {
                if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                    logWatchers[ key ].window.webContents.send( 'log:speak:phrase', data );
                    // We only need to send this to one log watcher window. It's not hacky!
                    break;
                }
            }
        } );

        ipcMain.on( 'log:action:execute-sub-action', function ( event, data ) {
            for ( let key in logWatchers ) {
                if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                    logWatchers[ key ].window.webContents.send( 'log:action:execute-sub-action', data );
                }
            }
        } );
        
        let characters = characterDatabase.getAll();
        characters.forEach( chr => {
            this.startWatcher( mainWindowRef, chr, isDev, characterDatabase, sendTick ).then( () => { } );
        } );

        characterDatabase.onCharacterCreated( chr => {
            this.startWatcher( mainWindowRef, chr, isDev, characterDatabase, sendTick ).then( () => { } );
        } );

        characterDatabase.onCharacterRemoved( chr => {
            if ( logWatchers.hasOwnProperty( chr.characterId ) ) {
                if ( logWatchers[ chr.characterId ].window != null ) {
                    logWatchers[ chr.characterId ].window.close();
                    logWatchers[ chr.characterId ].window = null;

                    if ( this.onLogWatcherWindowClosed ) {
                        this.onLogWatcherWindowClosed( chr.characterId );
                    }
                }

                clearInterval( logWatchers[ chr.characterId ].intervalId );

                delete logWatchers[ chr.characterId ];
            }
        } );

        ipcMain.on( 'log:pulse',
            /**
             * Closes the log watcher window that replied that it is no longer alive.
             *
             * @param {Electron.IpcMainEvent} event The event args.
             * @param {boolean} alive True if the log watcher is still alive.
             */
            ( event, alive ) => {
                if ( alive ) {
                    return;
                }

                // Find the character whose window sent the reply.
                const characterId = Object.keys( logWatchers ).find( key => {
                    const win = logWatchers[ key ].window;
                    return win != null && !win.isDestroyed() && win.webContents.id === event.sender.id;
                } );

                if ( characterId === undefined ) {
                    return;
                }

                // Notify the main window.
                mainWindowRef.reference.webContents.send( 'log:character:deactivated', characterId );

                logWatchers[ characterId ].window.close();
                logWatchers[ characterId ].window = null;

                if ( this.onLogWatcherWindowClosed ) {
                    this.onLogWatcherWindowClosed( characterId );
                }
            } );

        ipcMain.on( 'log:clear-all:done', function ( event, instanceId ) {
            for ( let key in logWatchers ) {
                if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                    logWatchers[ key ].window.webContents.send( 'log:clear-all:done', null );
                }
            }
        } );

        ipcMain.on( 'combat:character:change',
            /**
             * @param {Electron.IpcMainEvent} event The event args.
             * @param {string} characterId The character id.
             */
            async ( event, characterId ) => {
                const character = characterDatabase.find( characterId );
                if ( character ) {
                    let _stats = await FsUtilities.statOrNull( character.logFile );
                    if ( _stats == null ) {
                        appLogException( new Error( `Log file not found: ${character.logFile}` ), true );
                        return;
                    }
                    userSelectedCombatWatcher = true;
                    changeCombatCharacter( character, _stats.size, sendTick );
                }
            } );
        
        ipcMain.on( 'combat-database:add:pet',
            /**
             * Handles the add-pet event.
             * 
             * @param {Electron.IpcMainEvent} event The event args.
             * @param {{petName: string, ownerName: string, serverName: string, forcePet: boolean}} data The data.
             */
            ( event, data ) => {
                if ( combatWatcher.window && combatWatcher.character?.server === data.serverName ) {
                    // If the active combat watcher is for the same server, then we must send this to the combat watcher.
                    combatWatcher.window.webContents.send( 'combat-database:add:pet', data );
                    event.sender.send( 'combat-database:add:pet', true );

                } else {
                    // Otherwise, we need to add the pet to the combat database ourselves.
                    console.log( `CombatBootstrap > Adding pet: ${data.petName} owned by ${data.ownerName} on server ${data.serverName}` );
                    const serverModel = combatDb.getOrInitServer( data.serverName );

                    if ( !serverModel ) {
                        appLogException( new Error( `Failed to get server model for server: ${data.serverName}` ), true );
                        return;
                    }

                    const petName = data.petName.trim();
                    const ownerName = data.ownerName.trim();

                    // If the pet leader is not in the players list, add them.
                    if ( serverModel.verifiedPlayers.indexOf( ownerName ) === -1 ) {
                        serverModel.verifiedPlayers.push( ownerName );
                    }

                    // Determine if this is an NPC pet (charm).
                    const isNpc = !data.forcePet && petName.indexOf( ' ' ) > -1;
                    if ( isNpc && serverModel.verifiedNpcs.indexOf( petName ) === -1 ) {
                        serverModel.verifiedNpcs.push( petName );
                    }

                    const petIdx = serverModel.verifiedPets.indexOf( petName );
                    if ( petIdx === -1 && !isNpc ) {
                        // Add this pet to the pets list, if it's not an NPC pet.
                        serverModel.verifiedPets.push( petName );
                        
                    } else if ( isNpc && petIdx > -1 ) {
                        // If it's already in the pet list as an NPC, then remove it from the pet list.
                        serverModel.verifiedPets.splice( petIdx, 1 );
                        
                    }
                
                    if ( serverModel.petOwners[ petName ] !== ownerName ) {
                        serverModel.petOwners[ petName ] = ownerName;
                    }
                    
                    // Save the server model.
                    combatDb.putServer( serverModel ).then( () => {
                        log.info( `CombatBootstrap > Added pet: ${petName} owned by ${ownerName} on server ${data.serverName}` );
                        event.sender.send( 'combat-database:add:pet', true );

                    } ).catch( error => {
                        log.error( `CombatBootstrap > Failed to add pet: ${petName} owned by ${ownerName} on server ${data.serverName}`, error );
                        appLogException( error, true );
                        event.sender.send( 'combat-database:add:pet', false );

                    } );
                }
            } );

        startCombatWatcherWindow( isDev );
    }










    /**
     * Returns true if the given file is waiting for, or being processed by, an archive.
     *
     * @param {string} logFile The full path to the log file.
     */
    #isQueuedForArchive( logFile ) {
        return this.#archiveInFlight.has( logFile ) || this.#filesForArchive.some( f => f.logFile === logFile );
    }

    /**
     * Queues rotated log files that a previous run left behind before they were archived.
     * Only files named exactly like a rotation of this character's log file are touched.
     * 
     * @param {CharacterModel} chr The character to check.
     */
    async #queueLeftoverRotatedLogs( chr ) {
        try {
            const rules = this.#userPreferences.logMaintenanceRules;
            if ( rules?.enableLogFileMaintenance !== true || !( this.#userPreferences.everquestInstallFolder?.length > 0 ) || !chr?.logFile ) {
                return;
            }

            const dir = path.dirname( chr.logFile );
            const logFileName = path.basename( chr.logFile );
            const names = await fsp.readdir( dir );
            for ( const name of names ) {
                const fullPath = path.join( dir, name );
                if ( isRotatedLogName( name, logFileName ) && !this.#isQueuedForArchive( fullPath ) ) {
                    const stats = await FsUtilities.statOrNull( fullPath );

                    // Check again right before adding, another watcher may have queued it while waiting for the stats.
                    if ( stats?.isFile() && !this.#isQueuedForArchive( fullPath ) ) {
                        log.info( `LogBootstrap > Queueing leftover rotated log for archive: ${fullPath}` );
                        this.#addToArchive( fullPath, stats.size );
                    }
                }
            }
        } catch ( error ) {
            log.error( 'LogBootstrap > Could not check for leftover rotated logs.', error );
        }
    }

    /**
     * Adds the given log file to the backup list and checks if backups can start.
     * 
     * @param {string} logFile The full path to the log file.
     * @param {number} fileSize The current file size.
     */
    #addToArchive( logFile, fileSize ) {

        this.#filesForArchive.push( { logFile: logFile, size: fileSize } );

        if ( this.#backupWaitId > 0 ) {
            clearTimeout( this.#backupWaitId );
        }

        this.#backupWaitId = setTimeout( () => {
            this.#waitForArchive();
        }, checkInterval + 1000 );

    }










    /**
     * Checks for an active archive process to complete before beginning a new 
     * one.
     */
    #waitForArchive() {

        if ( this.#logBackupWindow == null ) {

            const archiveFiles = this.#filesForArchive.map( f => f.logFile );
            this.#logBackupWindow = startLogBackup( archiveFiles, this.#userPreferences.everquestInstallFolder, this.#isDev, null, this.#userPreferences.logMaintenanceHistory?.length ?? 0 );
            archiveFiles.forEach( f => this.#archiveInFlight.add( f ) );

            // Reset the archive files.
            this.#filesForArchive = [];
            
            this.#logBackupWindow.on( 'closed', () => {
                this.#userPreferences.addLogMaintenanceHistory( new Date(), 'Backup by Size', true );
                this.#logBackupWindow = null;
                archiveFiles.forEach( f => this.#archiveInFlight.delete( f ) );
            } );

        } else if ( this.#filesForArchive?.length > 0 ) {
            this.#backupWaitId = setTimeout( () => this.#waitForArchive(), checkInterval + 1000 );
        } else {
            
        }

    }










    /**
     * Starts the backup process for all tracked log files.
     * @param {LogMaintenanceRules} logMaintenanceRules The log maintenance rules.
     * @param {number} backupIndex The index of this backup event in the history.
     */
    backupLogFiles( logMaintenanceRules, backupIndex ) {

        let p = new Promise( async ( resolve, reject ) => {
            
            try {
                
                /** @type {string[]} */
                let logFiles = [];
                
                // Stop all running watchers and add to the archive queue
                for ( let characterId in logWatchers ) {
                    if ( logWatchers.hasOwnProperty( characterId ) ) {
                        logWatchers[ characterId ].interrupt();
                
                        // Lets only operate on existing files. This operation is
                        // executed outside the check loop, we need to ensure that the 
                        // file actually exists.
                        if ( await FsUtilities.existsAsync( logWatchers[ characterId ].logFile ) ) {
                    
                            logWatchers[ characterId ].window?.webContents.send( 'log:backup-started' );
                            // First, let's rename the log file with the archive prefix.
                            const logFilePath = getArchiveFilePath( logWatchers[ characterId ].logFile );
                            await fsp.rename( logWatchers[ characterId ].logFile, logFilePath );
                            await fsp.writeFile( logWatchers[ characterId ].logFile, '' );
                
                            // Next, let's reset the current log file size.
                            log.info( `LogBootstrap > Log file renamed to: ${logFilePath}` );
                            logWatchers[ characterId ].logSize = 0;

                            // Finally, add it to the list of files to archive.
                            logFiles.push( logFilePath );

                        }
                    }
                }

                if ( logFiles.length === 0 ) {
                    log.info( 'LogBootstrap > No log files to backup, exiting.' );
                    nagLog( 'No log files to backup.' );
                    resolve();
                    return;
                }

                ipcMain.on( 'log:backup:critical-failure', ( event, error ) => {
                    if ( this.#logBackupWindow ) {
                        this.#logBackupWindow.close();
                        this.#logBackupWindow = null;
                    }
    
                    reject( error );
                } );

                this.#logBackupWindow = startLogBackup( logFiles, this.#userPreferences.everquestInstallFolder, this.#isDev, logMaintenanceRules.logSchedule.dayOfWeek, backupIndex ?? 0 );

                // Reset the archive files.
                this.#filesForArchive = [];
                logFiles.forEach( f => this.#archiveInFlight.add( f ) );
        
                this.#logBackupWindow.on( 'closed', () => {
                    ipcMain.removeAllListeners( 'log:backup:critical-failure' );
                    this.#logBackupWindow = null;
                    logFiles.forEach( f => this.#archiveInFlight.delete( f ) );
                    resolve();
                } );
        
                // Once the files have been renamed and the backup process has started,
                // let's restart the watchers.
                for ( let characterId in logWatchers ) {
                    if ( logWatchers.hasOwnProperty( characterId ) ) {
                        logWatchers[ characterId ].start();
                    }
                }
                
            } catch ( error ) {
                
                if ( this.#logBackupWindow ) {
                    this.#logBackupWindow.close();
                    this.#logBackupWindow = null;
                }

                reject( error );
            }

        } );

        return p;
    }










    /**
     *  Starts watching for changes in the given character data.
     * 
     * @param {ForwardRef} mainWindowRef The main window of the application.
     * @param {CharacterModel} chr The character to watch.
     * @param {boolean} isDev Sets up the log watcher window for development environment if true.
     * @param {CharacterDatabaseStore} characterDatabase The character database.
     * @param {function} sendTick The send tick method.
     */
    async startWatcher( mainWindowRef, chr, isDev, characterDatabase, sendTick ) {
        let characterId = chr.characterId;
        await this.#queueLeftoverRotatedLogs( chr );
        let startingStats = await FsUtilities.existsAsync( chr.logFile ) ? await fsp.stat( chr.logFile ) : null;
        logWatchers[ characterId ] = {
            /** @type {BrowserWindow} */
            window: null,
            logFile: chr.logFile,
            logSize: startingStats == null ? 0 : startingStats.size,
            nullAttemptCount: 0,
            model: chr,
            interrupt: () => {
                clearInterval( logWatchers[ characterId ].intervalId );
            },
            start: () => {
                waitForLogFile().then( () => { } );
            }
        };

        let backupFailures = 0;

        const waitForLogFile = async () => {
            const current = characterDatabase.find( characterId );
            if ( !current ) {
                // The character was removed while waiting.
                return;
            }

            if ( await FsUtilities.existsAsync( current.logFile ) ) {
                // Log file's back, let's start watching again.
                logWatchers[ characterId ].intervalId = setInterval( () => checkFn().then( () => { } ), checkInterval );
                
            } else {
                setTimeout( () => waitForLogFile().then( () => { } ), checkInterval );
            }
        }

        /**
         * Starts the backup for the current character file.
         * 
         * @param {number} fileSize The file size.
         */
        const backupFn = async ( fileSize ) => {
            const current = characterDatabase.find( characterId );
            if ( !current ) {
                return;
            }

            log.info( `LogBootstrap > Initializing backup for: ${current.logFile} by size.` );

            if ( logWatchers[ characterId ].window ) {
                logWatchers[ characterId ].window.webContents.send( 'log:backup-started' );
            }
            // First, let's rename the log file with a timestamp.
            const logFilePath = getArchiveFilePath( current.logFile );
            let renamed = false;
            try {
                await fsp.rename( current.logFile, logFilePath );
                renamed = true;
                log.info( `LogBootstrap > Log file renamed to: ${logFilePath}` );

                // Queue the archive as soon as the rename succeeded, whatever happens next.
                this.#addToArchive( logFilePath, fileSize );

                await fsp.writeFile( current.logFile, '' );
            } catch ( error ) {
                // Log the first failure only, and retry less often while it keeps failing.
                if ( backupFailures === 0 ) {
                    log.error( `LogBootstrap > Log file backup failed for: ${current.logFile}`, error );
                }
                const delay = Math.min( checkInterval * Math.pow( 2, backupFailures ), maxBackupRetryInterval );
                backupFailures++;
                if ( renamed ) {
                    logWatchers[ characterId ].logSize = 0;
                }
                setTimeout( () => waitForLogFile().then( () => { } ), delay );
                return;
            }

            backupFailures = 0;
            logWatchers[ characterId ].logSize = 0;
            
            waitForLogFile().then( () => { } );
        }

        const checkFn = async () => {

            // Ensure we have the latest information.
            let _chr = characterDatabase.find( characterId );
            if ( !_chr ) {
                // The character was removed, there is nothing left to watch.
                clearInterval( logWatchers[ characterId ]?.intervalId );
                return;
            }

            let _stats = await FsUtilities.statOrNull( _chr.logFile );
            
            if ( _chr.logFile !== logWatchers[ characterId ].logFile ) {

                // The log file changed by the user, update the statistics.
                logWatchers[ characterId ].logFile = _chr.logFile;
                logWatchers[ characterId ].logSize = _stats == null ? 0 : _stats.size;

                // Reset the null attempt count.
                logWatchers[ characterId ].nullAttemptCount = 0;

                if ( logWatchers[ characterId ].window != null ) {
                    // Update the window if it exists.
                    logWatchers[ characterId ].window.send( 'log:changed', _chr.logFile );
                }

            }

            let enableLogFileMaintenance = this.#userPreferences.logMaintenanceRules?.enableLogFileMaintenance === true;
            let enableLogFileMaintenanceBySize = enableLogFileMaintenance && this.#userPreferences.logMaintenanceRules.maintenancePlan === LogMaintenancePlanTypes.BySize && +( this.#userPreferences.logMaintenanceRules?.maxLogFileSizeMb ?? 0 ) > 0;

            if ( _stats != null && _stats.size !== logWatchers[ characterId ].logSize ) {

                // Reset the null attempt count.
                logWatchers[ characterId ].nullAttemptCount = 0;

                if ( logWatchers[ characterId ].window == null ) {

                    // If the window has not been engaged, then open it. // TODO: Start up a log watcher when simulating. Even allow a charcter to be selected from a list.
                    logWatchers[ characterId ].window = startLogWatcherWindow( _chr.logFile, isDev, sendTick, _chr, logWatchers[ characterId ].logSize > _stats.size ? 0 : logWatchers[ characterId ].logSize );
                    
                    // Notify the main window.
                    mainWindowRef.reference.webContents.send( 'log:character:activated', characterId );

                }
                
            } else if ( logWatchers[ characterId ].window != null ) {

                // Increment the null attempt count.
                logWatchers[ characterId ].nullAttemptCount += 1;

                // Keep the combat watcher alive, even after null checks, if
                // the user has manually selected a combat watcher.  We'll still 
                // keep counting the null checks, if the user changes the combat 
                // watcher we can immediately kill this log watcher.
                const block = userSelectedCombatWatcher && characterId === combatWatcher?.characterId;

                // If after # of attempts without seeing any changes in the log
                // file, then kill the process.
                if (  !block && !logWatchers[ characterId ].simulating && logWatchers[ characterId ].nullAttemptCount >= killAfterNAttempts ) {
                    
                    logWatchers[ characterId ].window.send( 'log:check:pulse', null );

                }
            }

            // 2e-2 => 20KB
            // this.#userPreferences.logMaintenanceRules?.maxLogFileSizeMb
            if ( enableLogFileMaintenanceBySize && _stats != null && this.#userPreferences.everquestInstallFolder?.length > 0 && _stats.size / ( 1024 * 1024 ) > this.#userPreferences.logMaintenanceRules?.maxLogFileSizeMb ) {
                
                // Clear the watch interval.
                clearInterval( logWatchers[ characterId ].intervalId );

                // Execute the backup function.
                backupFn( _stats.size );

            } else {
                backupFailures = 0;
            }
            
            logWatchers[ characterId ].model = _chr;
            logWatchers[ characterId ].logSize = _stats == null ? 0 : _stats.size;

        }

        logWatchers[ characterId ].intervalId = setInterval( () => checkFn().then( () => { } ), checkInterval );

    }










    /**
     * Unloads all running processes and closes log watcher windows.
     */
    async unload() {

        if ( combatWatcher ) {
            // We need to close the combat watcher window on our terms at this point.
            combatWatcher.characterId = null;
            combatWatcher.character = null;
        }

        for ( let key in logWatchers ) {
            if ( logWatchers.hasOwnProperty( key ) ) {
                if ( logWatchers[ key ].window != null && !logWatchers[ key ].window.isDestroyed() ) {
                    logWatchers[ key ].window.close();
                    logWatchers[ key ].window = null;

                    if ( this.onLogWatcherWindowClosed ) {
                        this.onLogWatcherWindowClosed( key );
                    }
                }

                clearInterval( logWatchers[ key ].intervalId );
            }
        }

        await this.closeCombatWatcher();
        
    }









    
    /**
     * Closes the combat watcher window.
     * 
     * @returns {Promise<void>} A promise that resolves when the combat watcher window is closed.
     */
    closeCombatWatcher() {
        return new Promise( ( resolve, reject ) => {
            if ( !combatWatcher?.window || combatWatcher.window.isDestroyed() ) {
                resolve();
                return;

            } else {

                combatWatcher?.window.webContents.send( 'log:combat:unload', null );
                
                ipcMain.once( 'log:combat:unloaded', () => {
                    combatWatcher.window?.close();
                    resolve();
                } );

                return;
            }
        } );
    }










    /**
     * Sends a tick to all log watcher windows.
     * 
     * @param {any} tickData The data for the tick
     * @param {CharacterDatabaseStore} characterDatabase The character database.
     */
    tick( tickData, characterDatabase ) {
        for ( let key in logWatchers ) {
            if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                logWatchers[ key ].model = characterDatabase.find( key );
                tickData.characterModel = logWatchers[ key ].model;
                logWatchers[ key ].window.webContents.send( 'tick', tickData );
            }
        }
        combatWatcher.window?.webContents.send( 'tick', tickData );
    }










    /**
     * Sends the event to each log watcher window.
     * 
     * @param {string} channel The comms channel.
     * @param {string} value The event value.
     */
    sendToEach( channel, value ) {
        for ( let key in logWatchers ) {
            if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                logWatchers[ key ].window.webContents.send( channel, value );
            }
        }
    }










    /**
     * Sends the event to each log watcher window.
     * 
     * @param {string} channel The comms channel.
     * @param {string} value The event value.
     */
    sendToCombatWatcher( channel, value ) {
        combatWatcher.window?.webContents.send( channel, value );
    }

    /**
     * Speaks the given phrase using the first log watcher's voice settings.
     *
     * @param {string} phrase The phrase to speak.
     */
    speakPhrase( phrase ) {
        for ( let key in logWatchers ) {
            if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null ) {
                logWatchers[ key ].window.webContents.send( 'log:speak:phrase', { phrase: phrase, interruptSpeech: false } );
                break;
            }
        }
    }

}










/**
 * Starts a new log watcher window for the specified log file.
 * 
 * @param {string} logFile The full path to the log file.
 * @param {boolean} isDev Sets up the log watcher window for development environment if true.
 * @param {() => void} sendTick The send tick method.
 * @param {CharacterModel} character The character to watch.
 * @param {number} logPosition The position the log watcher should start processing log entries.
 */
function startLogWatcherWindow( logFile, isDev, sendTick, character, logPosition ) {
    let logWatcherWindow = new BrowserWindow( {
        //   width: 800,
        //   height: 600,
        show: isDev === true,
        // TODO: use preloaders.
        webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false, devTools: isDev === true },
    } );
    logWatcherWindow.webContents.openDevTools( { mode: 'undocked' } );
    logWatcherWindow.loadURL( `file://${__dirname}/threads/log-watcher.html?character=${encodeURI( JSON.stringify( character ) )}&logPosition=${logPosition}` );

    const closingWindow = logWatcherWindow;
    logWatcherWindow.on( 'closed', async () => {
        logWatcherWindow = null;

        if ( logWatchers[ character.characterId ]?.window === closingWindow ) {
            logWatchers[ character.characterId ].window = null;
        }
        
        if ( combatWatcher.characterId === character.characterId ) {
            // If there is still a character being watched, then start the combat watcher for that character.
            for ( let key in logWatchers ) {
                if ( logWatchers.hasOwnProperty( key ) && logWatchers[ key ].window != null && !logWatchers[ key ].window.isDestroyed() ) {
                    changeCombatCharacter( logWatchers[ key ].model, logWatchers[ key ].logSize, sendTick );
                    break;
                }
            }
        }
    } );

    logWatcherWindow.webContents.once( 'dom-ready', () => {
        logWatcherWindow.webContents.send( 'log:changed', logFile );
        sendTick();
    } );
    logWatcherWindow.setPosition( 100, 500 );

    if ( combatWatcher?.character == null ) {
        changeCombatCharacter( character, logPosition, sendTick );
    }

    return logWatcherWindow;
}










/**
 * Starts a new combat watcher window for the specified character.
 * 
 * @param {boolean} isDev The development environment flag.
 */
function startCombatWatcherWindow( isDev ) {
    
    if ( combatWatcher.window == null ) {

        combatWatcher.window = new BrowserWindow( {
            show: isDev === true,
            webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false, devTools: isDev === true },
            // alwaysOnTop: true,
        } );
        combatWatcher.window.webContents.openDevTools( { mode: 'undocked' } );
        combatWatcher.window.loadURL( `file://${__dirname}/threads/combat-watcher.html` );

        combatWatcher.window.webContents.once( 'dom-ready', () => {
            cwReady = true;
            if ( cwOnDomReady ) {
                cwOnDomReady();
                cwOnDomReady = undefined;
            }
        } );

        combatWatcher.window.setPosition( 100, 500 );
    }
}










/**
 * Starts/changes the combat watcher to watch the specified character.
 * 
 * @param {CharacterModel} character The character to watch.
 * @param {number | undefined} logPosition The position the log watcher should start processing log entries.
 * @param {() => void} sendTick The send tick method.
 * @returns 
 */
function changeCombatCharacter( character, logPosition, sendTick ) {
    if ( !cwReady ) {
        cwOnDomReady = () => changeCombatCharacter( character, logPosition, sendTick );
        return;
    }

    combatWatcher.characterId = character.characterId;
    combatWatcher.character = character;

    if ( !combatWatcher.window || combatWatcher.window.isDestroyed() ) {
        return;
    }

    combatWatcher.window.webContents.send( 'log:character:changed', { character: character, logPosition: logPosition } );
    sendTick();

    mainWinRef?.reference?.webContents.send( 'combat:character:changed', character.characterId );
}










/**
 * Spins up a new log backup window to backup the specified log files.
 * 
 * @param {string[]} logFiles 
 * @param {string} everquestInstallFolder
 * @param {boolean} isDev
 * @param {number[]|null} daysOfWeek
 * @param {number} backupIndex
 */
function startLogBackup( logFiles, everquestInstallFolder, isDev, daysOfWeek, backupIndex ) {
    
    let logBackupWindow = new BrowserWindow( {
        show: isDev === true,
        // TODO: use preloaders.
        webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false, devTools: isDev === true },
    } );

    if ( isDev ) {
        logBackupWindow.webContents.openDevTools( { mode: 'undocked' } );
    }
    // If the renderer crashes the window never closes by itself, which would block every later archive.
    logBackupWindow.webContents.on( 'render-process-gone', () => {
        if ( !logBackupWindow.isDestroyed() ) {
            logBackupWindow.destroy();
        }
    } );

    logBackupWindow.loadURL( `file://${__dirname}/threads/log-backup.html?logFiles=${encodeURI(JSON.stringify(logFiles))}&eqFolder=${encodeURI(everquestInstallFolder)}&daysOfWeek=${encodeURI(JSON.stringify(daysOfWeek ?? []))}&i=${backupIndex}` );

    return logBackupWindow;
}










module.exports = LogBootstrapper;

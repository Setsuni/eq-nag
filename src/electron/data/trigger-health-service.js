const { ipcMain } = require( 'electron' );
const eqZones = require( './models/everquest-zones' );
const { checkTriggerHealth, applyPatches, formatReportText } = require( './trigger-health' );

class TriggerHealthService {

    /** @type {import('./trigger-database')} */
    #triggerDatabase;
    /** @type {import('./zone-knowledge')} */
    #zoneKnowledge;
    /** @type {import('./character-database')} */
    #characterDatabase;
    /** @type {{ summary: any, findings: any[] } | null} */
    #lastReport = null;
    /** @type {{ undoId: string, patches: any[] }[]} */
    #undoStack = [];
    #undoCounter = 0;
    #backupMade = false;

    /**
     * @param {import('./trigger-database')} triggerDatabase The trigger database.
     * @param {import('./zone-knowledge')} zoneKnowledge The zone knowledge store.
     * @param {import('./character-database')} characterDatabase The character database.
     */
    constructor( triggerDatabase, zoneKnowledge, characterDatabase ) {
        this.#triggerDatabase = triggerDatabase;
        this.#zoneKnowledge = zoneKnowledge;
        this.#characterDatabase = characterDatabase;
    }

    /**
     * Runs the check over the current triggers and keeps the result for later fixes.
     *
     * @returns {{ summary: any, findings: any[] }}
     */
    check() {
        this.#lastReport = checkTriggerHealth( {
            triggers: this.#triggerDatabase.getAll(),
            folders: this.#triggerDatabase.getFolders(),
            zones: eqZones,
            zoneKnowledge: this.#zoneKnowledge.getKnowledge(),
            packages: [
                ...this.#triggerDatabase.getInstalledPackages(),
                ...( this.#triggerDatabase.getInstalledQuickShares() ?? [] ).map( q => ( { packageId: q.quickShareId, name: 'Quick Share', author: q.author, authorDiscord: q.authorDiscord } ) ),
            ],
            characterClasses: this.#characterDatabase.getAll().map( c => c.class ),
        } );

        return this.#lastReport;
    }

    /**
     * Returns the report without the patches, which stay in the main process.
     *
     * @param {{ summary: any, findings: any[] }} report The report.
     */
    #toClient( report ) {
        return {
            summary: { ...report.summary, undoCount: this.#undoStack.length },
            findings: report.findings.map( f => ( { ...f, fix: f.fix ? { label: f.fix.label, safe: f.fix.safe, bulk: f.fix.bulk } : null } ) ),
        };
    }

    /**
     * Writes a backup of the trigger data before the first change of a session.
     *
     * @returns {Promise<boolean>}
     */
    #ensureBackup() {
        if ( this.#backupMade ) {
            return Promise.resolve( true );
        }

        return new Promise( resolve => {
            try {
                this.#triggerDatabase.backupDatafile( () => {
                    this.#backupMade = true;
                    resolve( true );
                }, () => resolve( false ) );
            } catch ( error ) {
                resolve( false );
            }
        } );
    }

    /**
     * Applies the fixes of the given findings.
     *
     * @param {string[]} ids The finding ids.
     * @param {boolean} includePackages If true, fixes for package triggers are applied too.
     * @param {() => void} sendTick Tells the log watchers to reload the triggers.
     */
    async apply( ids, includePackages, sendTick ) {
        const report = this.#lastReport ?? this.check();
        const wanted = new Set( ids );
        const patches = [];

        report.findings.forEach( f => {
            if ( wanted.has( f.id ) && f.fix && ( includePackages || f.package == null ) ) {
                patches.push( ...f.fix.patches );
            }
        } );

        if ( patches.length === 0 ) {
            return { fixes: 0, changed: 0, undoId: null, report: this.#toClient( this.check() ) };
        }

        if ( !( await this.#ensureBackup() ) ) {
            return { fixes: 0, changed: 0, undoId: null, error: 'backup', report: this.#toClient( report ) };
        }

        const result = applyPatches( this.#triggerDatabase.getAll(), this.#triggerDatabase.getFolders(), patches );
        let undoId = null;

        if ( result.applied.length > 0 ) {
            undoId = `undo-${++this.#undoCounter}`;
            this.#undoStack.push( { undoId, patches: result.applied } );
            this.#triggerDatabase.save();
            sendTick();
        }

        return {
            fixes: result.applied.length,
            changed: result.triggerIds.length + result.folderIds.length,
            skipped: result.skipped.length,
            undoId,
            report: this.#toClient( this.check() ),
        };
    }

    /**
     * Applies every safe fix that is not for a package trigger.
     *
     * @param {() => void} sendTick Tells the log watchers to reload the triggers.
     */
    async fixSafe( sendTick ) {
        const report = this.check();
        return this.apply( report.findings.filter( f => f.fix?.bulk && f.level === 'default' ).map( f => f.id ), false, sendTick );
    }

    /**
     * Reverts one change, or every change of this session.
     *
     * @param {string | null} undoId The change to revert, or null for all.
     * @param {() => void} sendTick Tells the log watchers to reload the triggers.
     */
    undo( undoId, sendTick ) {
        const index = this.#undoStack.findIndex( e => e.undoId === undoId );
        const entries = undoId == null ? this.#undoStack.splice( 0 ).reverse() : ( index > -1 ? this.#undoStack.splice( index, 1 ) : [] );
        let changed = 0;
        let fixes = 0;

        entries.forEach( entry => {
            const result = applyPatches( this.#triggerDatabase.getAll(), this.#triggerDatabase.getFolders(), entry.patches, true );
            changed += result.triggerIds.length + result.folderIds.length;
            fixes += result.applied.length;
        } );

        if ( changed > 0 ) {
            this.#triggerDatabase.save();
            sendTick();
        }

        return { fixes, changed, report: this.#toClient( this.check() ) };
    }

    /**
     * Attaches the health check events to ipc main.
     *
     * @param {import('../forward-ref')} mainWindowRef The main window of the application.
     * @param {function} sendTick The send tick method.
     */
    attachIpcEvents( mainWindowRef, sendTick ) {

        const broadcast = ( report, changed = false ) => {
            mainWindowRef.reference?.webContents.send( 'health:summary', report.summary );
            if ( changed ) {
                mainWindowRef.reference?.webContents.send( 'health:changed' );
            }
        };

        ipcMain.on( 'health:check', ( event, options ) => {
            const report = this.#toClient( this.check() );
            event.sender.send( 'health:check', report );
            broadcast( report );

            if ( options?.startup && report.summary.defaultCount === 0 ) {
                mainWindowRef.reference?.webContents.send( 'console:success', {
                    label: 'Trigger Health',
                    activity: true,
                    message: `Trigger health check: all ${report.summary.triggers.toLocaleString( 'en-US' )} triggers look fine.`,
                    timestamp: new Date(),
                } );
            }
        } );

        ipcMain.on( 'health:get:summary', event => {
            event.sender.send( 'health:summary', ( this.#lastReport ?? this.check() ).summary );
        } );

        ipcMain.on( 'health:apply', async ( event, args ) => {
            const result = await this.apply( args?.ids ?? [], args?.includePackages === true, sendTick );
            event.sender.send( 'health:apply', result );
            broadcast( result.report, result.changed > 0 );
        } );

        ipcMain.on( 'health:fix-safe', async event => {
            const result = await this.fixSafe( sendTick );
            event.sender.send( 'health:fix-safe', result );
            broadcast( result.report, result.changed > 0 );
        } );

        ipcMain.on( 'health:undo', ( event, args ) => {
            const result = this.undo( args?.undoId ?? null, sendTick );
            event.sender.send( 'health:undo', result );
            broadcast( result.report, result.changed > 0 );
        } );

        ipcMain.on( 'health:report-text', ( event, options ) => {
            event.sender.send( 'health:report-text', formatReportText( this.#lastReport ?? this.check(), options ) );
        } );

        this.#triggerDatabase.onTriggersImported( triggerIds => {
            setTimeout( () => {
                const report = this.check();
                const imported = new Set( triggerIds );
                const needLook = new Set();

                report.findings.forEach( f => {
                    if ( f.level === 'default' && ( f.severity === 'never' || f.severity === 'may' ) ) {
                        f.affectedTriggerIds.forEach( id => imported.has( id ) && needLook.add( id ) );
                    }
                } );

                broadcast( report );
                if ( needLook.size > 0 ) {
                    mainWindowRef.reference?.webContents.send( 'health:imported', { count: needLook.size, imported: imported.size } );
                }
            }, 500 );
        } );

    }

}

module.exports = TriggerHealthService;

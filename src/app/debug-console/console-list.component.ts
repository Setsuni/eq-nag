import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, HostListener, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges } from '@angular/core';
import { ConsoleMessageModel, LogTypes, ProgressModel, TriggerParseHistoryModel } from '../core.model';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import * as _ from 'lodash-es';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { IpcService } from '../ipc.service';

@Component( {
    selector: 'console-list',
    templateUrl: 'console-list.component.html',
    styleUrls: [ 'console-list.component.scss' ],
    changeDetection: ChangeDetectionStrategy.OnPush,
} )
export class ConsoleListComponent implements OnInit, OnChanges, OnDestroy {

    private readonly _destroyed: Subject<void> = new Subject<void>();

    public showTriggerHistory: boolean = false;
    public parseType: 'successful' | 'failed' = 'successful';
    @Input() public searchText: string = null;
    @Input() public characterId: string = null;
    /** True shows the developer log; false shows only trigger matches and a few status messages. */
    @Input() public developer: boolean = false;
    @Output() public onListUpdated: EventEmitter<{ scrollBottom: boolean }> = new EventEmitter<{ scrollBottom: boolean }>();

    private histories: { successful: TriggerParseHistoryModel[], exceptions: TriggerParseHistoryModel[] } = { successful: [], exceptions: [] };
    private triggerHistories: { successful: TriggerParseHistoryModel[], failed: TriggerParseHistoryModel[] } = { successful: [], failed: [] };
    private consoleMessages: ConsoleMessageModel[] = [];
    private consoleProgress: ProgressModel[] = [];
    
    public logTypes: typeof LogTypes = LogTypes;
    public triggerId: string | null = null;
    public triggerName: string | null = null;

    /** Trigger errors and error messages since the last clear. */
    public get problemCount(): number {
        return this.histories.exceptions.length + this.consoleMessages.filter( x => x.logType === LogTypes.error ).length;
    }

    public history: ( ConsoleMessageModel | TriggerParseHistoryModel | ProgressModel )[] = [];

    constructor(
        private readonly ipcService: IpcService,
        private readonly sanitizer: DomSanitizer,
        private readonly changeDetector: ChangeDetectorRef,
    ) { }

    ngOnChanges( changes: SimpleChanges ) {
        if ( Object.values( changes ).every( change => change.firstChange ) ) {
            return;
        }

        this.renderHistory( false );
    }










    ngOnInit() {

        // This is called because the console list is destroyed when hidden.
        this.ipcService.getConsoleData().pipe( takeUntil( this._destroyed ) ).subscribe( history => {
            this.setHistories( history.successful, history.failed, history.consoleMessages, history.consoleProgress );
        } );
        
        this.ipcService.onBatchParseHistory().pipe( takeUntil( this._destroyed ) ).subscribe( history => {
            if ( history.exceptions?.length > 0 || history.successful?.length > 0 ) {
                this.appendHistories( history.successful, history.exceptions );
            }
        } );

        this.ipcService.onConsoleSuccess().pipe( takeUntil( this._destroyed ) ).subscribe( log => {
            this.pushConsoleMessage( log );
            this.renderHistory( false );
        } );

        this.ipcService.onConsoleError().pipe( takeUntil( this._destroyed ) ).subscribe( log => {
            this.pushConsoleMessage( log );
            this.renderHistory( false );
        } );

        this.ipcService.onConsoleProgress().pipe( takeUntil( this._destroyed ) ).subscribe( log => {
            if ( this.consoleProgress.findIndex( x => x.logId === log.logId ) === -1 ) {
                this.consoleProgress.push( log );
                this.renderHistory( false );
            } else {
                let index = this.consoleProgress.findIndex( x => x.logId === log.logId );
                this.consoleProgress[ index ].label = log.label;
                this.consoleProgress[ index ].message = log.message;
                this.consoleProgress[ index ].progress = log.progress;
                this.renderHistory( false );
            }
        } );

    }










    ngOnDestroy() {
        this._destroyed.next();
        this._destroyed.complete();
    }









    /**
     * Adds a console message, keeping the newest 500.
     *
     * @param message The console message.
     */
    private pushConsoleMessage( message: ConsoleMessageModel ): void {
        this.consoleMessages.push( message );
        this.consoleMessages = this.consoleMessages.slice( -500 );
    }









    /**
     * Returns true if the message is something a player wants in the Activity view:
     * trigger health, the zone trigger count and the catching-up notices.
     *
     * @param message The console message.
     */
    private static isActivityMessage( message: ConsoleMessageModel ): boolean {
        if ( message.logType === LogTypes.error ) {
            return false;
        }

        return message.activity === true ||
            message.label === 'Trigger Health' ||
            /^Triggers active in this zone: /.test( message.message ?? '' ) ||
            /^Nag (is catching up|has caught up)/.test( message.message ?? '' );
    }









    /**
     * Returns every entry of the developer log, ignoring the search, character and trigger filters.
     */
    private allItems(): ( ConsoleMessageModel | TriggerParseHistoryModel | ProgressModel )[] {
        return _.orderBy( Array.prototype.concat( this.histories.successful, this.histories.exceptions, this.consoleMessages, this.consoleProgress ), [ 'timestamp' ], [ 'asc' ] );
    }









    /**
     * Returns the number of entries in the whole developer log.
     */
    public getCopyCount(): number {
        return this.allItems().length;
    }









    /**
     * Returns the whole developer log as plain text, for pasting into a support request.
     */
    public getCopyText(): string {
        return this.allItems().map( item => {
            let line = `[${new Date( item.timestamp ).toISOString()}] `;
            if ( item instanceof TriggerParseHistoryModel ) {
                line += `${item.triggerName} ${item.logType === LogTypes.error ? item.errorDescription : ( Array.isArray( item.rawLogEntry ) ? item.rawLogEntry[ 0 ] : item.rawLogEntry )}`;
                if ( item.error !== null && item.error !== undefined ) {
                    line += ` ${ConsoleListComponent.payloadText( item.error )}`;
                }
            } else if ( item instanceof ProgressModel ) {
                line += `${item.label ?? ''} ${item.message ?? ''} (${item.progress}%)`;
            } else {
                let message = item as ConsoleMessageModel;
                line += `${message.label ?? ''} ${message.message ?? ''}`;
                if ( message.payload !== null && message.payload !== undefined ) {
                    line += ` ${ConsoleListComponent.payloadText( message.payload )}`;
                }
            }
            return line;
        } ).join( '\r\n' );
    }









    /**
     * Returns the payload as text, including the stack of an error.
     *
     * @param payload The message payload.
     */
    private static payloadText( payload: any ): string {
        if ( payload instanceof Error ) {
            return payload.stack ?? `${payload.name}: ${payload.message}`;
        }

        try {
            return typeof payload === 'string' ? payload : JSON.stringify( payload );
        } catch ( error ) {
            return String( payload );
        }
    }









    /**
     * Returns the given console message as a trigger parse history model.
     * 
     * @param log The log entry item.
     */
    public asTriggerParseHistoryModel( log: any ): TriggerParseHistoryModel {
        return log as TriggerParseHistoryModel;
    }









    
    /**
     * Returns true if the given log is a trigger event.
     * 
     * @param log The log to evaluate.
     */
    public getLogType( log: ConsoleMessageModel | TriggerParseHistoryModel | ProgressModel ): 'message' | 'trigger' | 'progress' {
        if ( log instanceof TriggerParseHistoryModel ) {
            return 'trigger';
        } else if ( log instanceof ConsoleMessageModel ) {
            return 'message';
        }  else if ( log instanceof ProgressModel ) {
            return 'progress';
        }
    }










    /**
     * Sets the parse type filter.
     * 
     * @param type The type of parse to render.
     */
    public setParseType( type: 'successful' | 'failed' ) {
        this.parseType = type;
        this.renderHistory( false );
    }










    /**
     * Adds the given parses to the lists.
     * 
     * @param successful The list of successful parses to append.
     * @param exceptions The list of failed parses to append.
     */
    public appendHistories( successful: TriggerParseHistoryModel[], exceptions: TriggerParseHistoryModel[] ) {
        this.histories.successful = Array.prototype.concat( this.histories.successful, successful );
        this.histories.exceptions = Array.prototype.concat( this.histories.exceptions, exceptions );
        this.trimHistories();
        this.renderHistory( true );
    }










    /**
     * Sets the history lists.
     * 
     * @param successful The list of successful parses.
     * @param exceptions The list of failed parses.
     */
    public setHistories( successful: TriggerParseHistoryModel[], exceptions: TriggerParseHistoryModel[], consoleMessages: ConsoleMessageModel[], consoleProgress: ProgressModel[] ) {
        this.histories.successful = successful;
        this.histories.exceptions = exceptions;
        this.consoleMessages = consoleMessages;
        this.consoleProgress = consoleProgress;
        this.trimHistories();
        this.renderHistory( true );
    }










    /**
     * Limits the size of the history list to 500 items per list.
     */
    private trimHistories() {
        this.histories.successful = this.histories.successful.slice( -500 );
        this.histories.exceptions = this.histories.exceptions.slice( -500 );
        this.consoleMessages = this.consoleMessages.slice( -500 );
    }










    /**
     * Updates and filters the history list.  Emits the onListUpdated event and 
     * calls for detectChanges.  This should be called whenever the history list 
     * is updated.
     */
    private renderHistory( scrollBottom: boolean ): void {

        if ( this.triggerId ) {
    
            this.history = this.parseType === 'successful' || !this.developer ? Array.prototype.concat( this.triggerHistories.successful ) : Array.prototype.concat( this.triggerHistories.failed );
            
        } else {

            this.history = this.developer ?
                Array.prototype.concat( this.histories.successful, this.histories.exceptions, this.consoleMessages, this.consoleProgress ) :
                Array.prototype.concat( this.histories.successful, this.consoleMessages.filter( x => ConsoleListComponent.isActivityMessage( x ) ) );
            this.history = _.orderBy( this.history, [ 'timestamp' ], [ 'asc' ] );

        }
    
        let search = this.searchText?.toLowerCase();
        this.history = this.history.filter( x => {
            if ( x instanceof TriggerParseHistoryModel ) {
                return ( !search || String( x.rawLogEntry ?? '' ).toLowerCase().indexOf( search ) > -1 || String( x.triggerName ?? '' ).toLowerCase().indexOf( search ) > -1 ) &&
                    ( !this.characterId || x.characterId === this.characterId );
            } else {
                return ( !search || String( x.message ?? '' ).toLowerCase().indexOf( search ) > -1 );
            }
        } );
        
        if ( !this.triggerId ) {
            for ( let i = 0; i < this.history.length; i++ ) {
                const item = this.history[ i ];
                if ( item instanceof TriggerParseHistoryModel ) {
                    item.duplicateCount = 0;
                }
            }

            for ( let i = this.history.length - 1; i >= 0; i-- ) {
                if ( i !== 0 ) {
                    const prev = this.history[ i - 1 ];
                    const curr = this.history[ i ];
                    if ( prev instanceof TriggerParseHistoryModel && curr instanceof TriggerParseHistoryModel && TriggerParseHistoryModel.sameError( prev, curr ) ) {
                        this.history.splice( i, 1 );
                        prev.duplicateCount += ( curr.duplicateCount ?? 0 ) + 1;
                    }
                }
            }
        }

        this.changeDetector.detectChanges();
        this.onListUpdated.emit( { scrollBottom: scrollBottom } );
    }










    /**
     * Returns the unique id for the given log.
     * 
     * @param index The index of the log in the list.
     * @param item The log item.
     */
    public trackByFn( index: number, item: ConsoleMessageModel | TriggerParseHistoryModel | ProgressModel ) {
        return item.logId;
    }









    
    /**
     * Clears all trigger history.
     */
    public clear() {
        this.histories = { successful: [], exceptions: [] };
        this.triggerHistories = { successful: [], failed: [] };
        this.consoleMessages = [];
        this.consoleProgress = [];
        this.triggerId = null;
        this.triggerName = null;
        this.hideTriggerHistory();
        this.ipcService.clearLogHistory();
    }









    
    /**
     * Hide the specific trigger history.
     */
    public hideTriggerHistory() {
        this.showTriggerHistory = false;
        this.parseType = 'successful';
        this.triggerId = null;
        this.triggerName = null;
        this.triggerHistories = { successful: [], failed: [] };

        this.renderHistory( false );
        
    }









    
    /**
     * Show the trigger history for the given trigger.
     * 
     * @param triggerId The id of the trigger to show history for.
     * @param triggerName The name of the trigger to show history for.
     */
    public showTriggerParseHistory( triggerId: string, triggerName: string ) {
        this.ipcService.getTriggerParseHistory( triggerId ).subscribe( history => {
            this.showTriggerHistory = true;
            this.triggerName = triggerName;
            this.triggerId = triggerId;
            this.triggerHistories = history;
            this.renderHistory( false );
        } );
    }









    
    /**
     * Shows the edit trigger dialog for the specified trigger.
     * 
     * @param triggerId The id of the desired trigger.
     */
    public showEditTriggerDialog( triggerId: string | null = null ): void {
        if ( triggerId || this.triggerId ) {
            this.ipcService.showEditTriggerDialog( triggerId ?? this.triggerId );
        }
    }

}

import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Observable, Observer, Subject } from 'rxjs';
import { tap } from 'rxjs/operators';

export type HealthSeverity = 'never' | 'may' | 'cost' | 'info';

export interface HealthFinding {
    id: string;
    check: string;
    checkNumber: number;
    severity: HealthSeverity;
    level: 'default' | 'advanced';
    subject: {
        kind: 'trigger' | 'folder';
        id: string;
        name: string;
        folderId: string | null;
        folderPath: string;
        disabled: boolean;
    };
    affectedTriggerIds: string[];
    reason: string;
    detail: string | null;
    needsLook: boolean;
    fix: { label: string; safe: boolean; bulk: boolean } | null;
    package: { packageId: string; name: string; author: string; authorDiscord: string } | null;
}

export interface HealthSummary {
    checkedAt: string;
    triggers: number;
    folders: number;
    counts: Record<HealthSeverity, number>;
    defaultCount: number;
    defaultCounts: { never: number; may: number };
    bulkFixes: number;
    undoCount?: number;
}

export interface HealthReport {
    summary: HealthSummary;
    findings: HealthFinding[];
}

export interface HealthChangeResult {
    /** The number of fixes applied. */
    fixes: number;
    /** The number of triggers and folders those fixes touched. */
    changed: number;
    skipped?: number;
    undoId?: string | null;
    error?: string;
    report: HealthReport;
}

@Injectable( { providedIn: 'root' } )
export class TriggerHealthService {

    /** The summary of the latest check, or null before the first one. */
    public readonly summary$ = new BehaviorSubject<HealthSummary | null>( null );
    /** The latest check result, or null before the first one. */
    public readonly report$ = new BehaviorSubject<HealthReport | null>( null );
    /** Emits when fixes or undo changed triggers or folders. */
    public readonly changed$ = new Subject<void>();
    /** Emits when imported triggers were checked and some need a look. */
    public readonly imported$ = new Subject<{ count: number; imported: number }>();
    /** Emits when something asks to show the Trigger Health section in Settings. */
    public readonly showSection$ = new Subject<void>();
    /** Emits the id of a folder whose conditions should be opened in the Triggers tab. */
    public readonly openFolder$ = new Subject<string>();

    constructor( private readonly ngZone: NgZone ) {
        if ( window.api ) {
            window.api.ipc.on( 'health:summary', ( e: any, summary: HealthSummary ) => this.ngZone.run( () => this.summary$.next( summary ) ) );
            window.api.ipc.on( 'health:changed', () => this.ngZone.run( () => this.changed$.next() ) );
            window.api.ipc.on( 'health:imported', ( e: any, data: { count: number; imported: number } ) => this.ngZone.run( () => this.imported$.next( data ) ) );
        }
    }

    private request<T>( channel: string, args?: any, replyChannel: string = channel ): Observable<T> {
        return new Observable<T>( ( observer: Observer<T> ) => {
            window.api.ipc.once( replyChannel, ( e: any, data: T ) => {
                this.ngZone.run( () => {
                    observer.next( data );
                    observer.complete();
                } );
            } );
            window.api.ipc.send( channel, args );
        } );
    }

    /**
     * Checks the triggers.
     *
     * @param startup True for the check at application start, which prints a console line when nothing is found.
     */
    public check( startup: boolean = false ): Observable<HealthReport> {
        return this.request<HealthReport>( 'health:check', { startup } ).pipe( tap( report => this.report$.next( report ) ) );
    }

    /** Applies every safe fix that is not for a package trigger. */
    public fixSafe(): Observable<HealthChangeResult> {
        return this.request<HealthChangeResult>( 'health:fix-safe' ).pipe( tap( result => this.report$.next( result.report ) ) );
    }

    /**
     * Applies the fixes of the given findings.
     *
     * @param ids The finding ids.
     * @param includePackages True to fix package triggers too.
     */
    public apply( ids: string[], includePackages: boolean = false ): Observable<HealthChangeResult> {
        return this.request<HealthChangeResult>( 'health:apply', { ids, includePackages } ).pipe( tap( result => this.report$.next( result.report ) ) );
    }

    /**
     * Reverts one change, or all changes of this session.
     *
     * @param undoId The change to revert; null reverts all.
     */
    public undo( undoId: string | null = null ): Observable<{ fixes: number; changed: number; report: HealthReport }> {
        return this.request<{ fixes: number; changed: number; report: HealthReport }>( 'health:undo', { undoId } ).pipe( tap( result => this.report$.next( result.report ) ) );
    }

    /**
     * Returns a plain text report of the last check.
     *
     * @param advanced True to include the advanced items.
     */
    public reportText( advanced: boolean ): Observable<string> {
        return this.request<string>( 'health:report-text', { advanced } );
    }

    /** Returns the version the start-up pop-up was last dismissed for. */
    public getSeenVersion(): Observable<string | undefined> {
        return this.request<string | undefined>( 'settings:get:healthCheckSeenVersion', null );
    }

    /** Stores the version the start-up pop-up was dismissed for. */
    public setSeenVersion( version: string ): void {
        window.api.ipc.send( 'settings:set:healthCheckSeenVersion', version );
    }

}

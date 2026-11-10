import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { IpcService } from '../ipc.service';
import { PerfReport, PerfRow, PerfState, TriggerPerfService } from './trigger-perf.service';
import { HealthChangeResult, HealthFinding, HealthReport, HealthSeverity, TriggerHealthService } from './trigger-health.service';

interface PlainWord {
    title: string;
    detail: string;
    triggerId: string | null;
    good: boolean;
}

interface HealthGroup {
    path: string;
    findings: HealthFinding[];
    installedPackage: boolean;
}

@Component( {
    selector: 'app-trigger-health',
    templateUrl: './trigger-health.component.html',
    styleUrls: [ './trigger-health.component.scss' ]
} )
export class TriggerHealthComponent implements OnInit, OnDestroy {

    public report: HealthReport | null = null;
    public busy: boolean = false;
    public advanced: boolean = false;
    public defaultGroups: HealthGroup[] = [];
    public advancedGroups: HealthGroup[] = [];

    public tab: 'findings' | 'perf' = 'findings';
    public perf: PerfState = { measuring: false, last: null };
    public perfPage: number = 0;
    public readonly pageSize: number = 25;
    public plainWords: PlainWord[] = [];
    public elapsedLabel: string = '0:00';
    public durationLabel: string = '10:00';
    public readonly skippedReason: string = 'Skipped the whole time: its zone or variable condition was false, or its fixed words never appeared in a line.';

    private perfTimer: ReturnType<typeof setInterval> | null = null;

    public readonly severityLabels: Record<HealthSeverity, string> = {
        never: 'Will never fire',
        may: 'May stop firing',
        cost: 'Costs time',
        info: 'Good to know',
    };

    /** Groups the user opened or closed; the default is open, except for installed packages. */
    private readonly toggled: Record<string, boolean> = {};

    constructor(
        private readonly healthService: TriggerHealthService,
        private readonly ipcService: IpcService,
        private readonly snackBar: MatSnackBar,
        private readonly perfService: TriggerPerfService,
        private readonly ngZone: NgZone,
    ) { }

    /** True when the Performance tab is showing; it only exists under Advanced. */
    public get showPerf(): boolean {
        return this.advanced && this.tab === 'perf';
    }

    public get pageCount(): number {
        return Math.max( 1, Math.ceil( ( this.perf.last?.rows.length ?? 0 ) / this.pageSize ) );
    }

    public get pageRows(): PerfRow[] {
        const start = Math.min( this.perfPage, this.pageCount - 1 ) * this.pageSize;
        return this.perf.last?.rows.slice( start, start + this.pageSize ) ?? [];
    }

    /** Trigger time per log line, as text. */
    public get msPerLine(): string {
        const last = this.perf.last;
        return last && last.lineCount > 0 ? this.formatMs( last.totalMs / last.lineCount ) : '–';
    }

    ngOnInit(): void {
        this.healthService.report$.subscribe( report => {
            if ( report ) {
                this.setReport( report );
            }
        } );

        this.perfService.finished$.subscribe( () => this.refreshPerf() );
        this.refreshPerf();
    }

    ngOnDestroy(): void {
        this.stopPerfTimer();
    }

    public showTab( tab: 'findings' | 'perf' ): void {
        this.tab = tab;
        if ( tab === 'perf' ) {
            this.refreshPerf();
        }
    }

    /**
     * Starts a ten minute trigger measurement.
     */
    public async startMeasuring(): Promise<void> {
        const result = await this.perfService.start();
        if ( result?.started ) {
            await this.refreshPerf();
        } else {
            this.snackBar.open( 'No character is being watched right now. Start EverQuest logging for a character first.', 'Close', { duration: 6000 } );
        }
    }

    /**
     * Ends the measurement early; the result arrives a moment later.
     */
    public stopMeasuring(): void {
        this.perfService.stop();
    }

    public openTrigger( triggerId: string ): void {
        this.ipcService.showEditTriggerDialog( triggerId );
    }

    public trackRow( index: number, row: PerfRow ): string {
        return row.triggerId;
    }

    public formatMs( ms: number ): string {
        if ( !ms ) {
            return '–';
        }
        return `${ms >= 10 ? ms.toFixed( 0 ) : ms >= 1 ? ms.toFixed( 1 ) : ms >= 0.01 ? ms.toFixed( 2 ) : ms.toFixed( 3 )} ms`;
    }

    public formatShare( percent: number ): string {
        return `${percent >= 10 ? percent.toFixed( 0 ) : percent >= 0.1 ? percent.toFixed( 1 ) : percent.toFixed( 2 )}%`;
    }

    /**
     * Reads the measurement state and the last report.
     */
    private async refreshPerf(): Promise<void> {
        const state = await this.perfService.get();
        this.ngZone.run( () => {
            this.perf = state ?? { measuring: false, last: null };
            this.setPerfReport( this.perf.last );
            if ( this.perf.measuring ) {
                this.startPerfTimer();
            } else {
                this.stopPerfTimer();
            }
        } );
    }

    private startPerfTimer(): void {
        this.updateElapsed();
        if ( this.perfTimer == null ) {
            this.perfTimer = setInterval( () => {
                this.ngZone.run( () => this.updateElapsed() );
                if ( this.perf.endsAt != null && Date.now() > this.perf.endsAt ) {
                    this.refreshPerf();
                }
            }, 1000 );
        }
    }

    private stopPerfTimer(): void {
        if ( this.perfTimer != null ) {
            clearInterval( this.perfTimer );
            this.perfTimer = null;
        }
    }

    private updateElapsed(): void {
        const clock = ( ms: number ) => `${Math.floor( ms / 60000 )}:${String( Math.floor( ms / 1000 ) % 60 ).padStart( 2, '0' )}`;
        const total = Math.max( ( this.perf.endsAt ?? 0 ) - ( this.perf.startedAt ?? 0 ), 0 );
        this.durationLabel = clock( total );
        this.elapsedLabel = clock( Math.min( Math.max( Date.now() - ( this.perf.startedAt ?? Date.now() ), 0 ), total ) );
    }

    /**
     * Writes the top three triggers and the rest in plain words.
     */
    private setPerfReport( report: PerfReport | null ): void {
        this.plainWords = [];
        this.perfPage = Math.min( this.perfPage, this.pageCount - 1 );
        if ( !report ) {
            return;
        }

        const ran = report.rows.filter( r => !r.skipped );
        const top = ran.filter( r => r.sharePercent >= 5 ).slice( 0, 3 );
        top.forEach( row => {
            const facts = `Checked ${row.checked.toLocaleString()} times, average ${this.formatMs( row.avgMsPerCheck )} each, worst ${this.formatMs( row.maxMs )}.`;
            const hints = row.hints.map( h => h.text ).join( ' ' );
            this.plainWords.push( {
                title: `${row.name} took ${this.formatShare( row.sharePercent )} of all trigger time`,
                detail: hints ? `${facts} ${hints}` : facts,
                triggerId: row.triggerId,
                good: false,
            } );
        } );

        const rest = ran.filter( r => !top.includes( r ) );
        const restShare = rest.reduce( ( sum, r ) => sum + r.sharePercent, 0 );
        const skipped = report.rows.length - ran.length;
        const skippedText = skipped > 0 ? ` ${skipped.toLocaleString()} ${skipped === 1 ? 'trigger was' : 'triggers were'} skipped the whole time because a zone or variable condition was false, or their fixed words never appeared.` : '';
        this.plainWords.push( {
            title: top.length === 0 ? `No single trigger stands out: ${rest.length.toLocaleString()} triggers share the time` : `Everything else: ${this.formatShare( restShare )}, spread over ${rest.length.toLocaleString()} triggers`,
            detail: ( top.length === 0 ? 'None is above 5% of the trigger time.' : 'No single one is above 5%.' ) + skippedText,
            triggerId: null,
            good: true,
        } );
    }

    /**
     * Checks the triggers.
     */
    public check(): void {
        this.busy = true;
        this.healthService.check().subscribe( () => this.busy = false );
    }

    /**
     * Applies every safe fix.
     */
    public fixSafe(): void {
        this.busy = true;
        this.healthService.fixSafe().subscribe( result => this.afterChange( result ) );
    }

    /**
     * Applies the fix of one finding.
     *
     * @param finding The finding to fix.
     */
    public fix( finding: HealthFinding ): void {
        this.busy = true;
        this.healthService.apply( [ finding.id ], finding.package != null ).subscribe( result => this.afterChange( result ) );
    }

    /**
     * Reverts every change made from this check.
     */
    public undoAll(): void {
        this.busy = true;
        this.healthService.undo( null ).subscribe( result => {
            this.busy = false;
            this.snackBar.open( `${this.countLabel( result.changed )} restored.`, 'Close', { duration: 4000 } );
        } );
    }

    /**
     * Opens the trigger or folder of a finding.
     *
     * @param finding The finding to open.
     */
    public open( finding: HealthFinding ): void {
        if ( finding.subject.kind === 'folder' ) {
            this.healthService.openFolder$.next( finding.subject.id );
        } else {
            this.ipcService.showEditTriggerDialog( finding.subject.id );
        }
    }

    /**
     * Copies a ready-made note for the author of an installed package.
     *
     * @param finding The finding in a package trigger.
     */
    public messageAuthor( finding: HealthFinding ): void {
        const pkg = finding.package;
        const note = [
            `Hi! Nag's trigger health check found a problem in your package "${pkg.name}".`,
            '',
            `${finding.subject.kind === 'folder' ? 'Folder' : 'Trigger'}: ${finding.subject.name}`,
            finding.reason,
            ...( finding.fix ? [ `Suggested change: ${finding.fix.label}.` ] : [] ),
        ].join( '\n' );

        this.ipcService.sendTextToClipboard( note );
        this.snackBar.open( pkg.authorDiscord ? `Note copied. Send it to ${pkg.authorDiscord} on Discord.` : 'Note copied for the package author.', 'Close', { duration: 6000 } );
    }

    /**
     * Copies a plain text report.
     */
    public copyReport(): void {
        this.healthService.reportText( this.advanced ).subscribe( text => {
            this.ipcService.sendTextToClipboard( text );
            this.snackBar.open( 'Report copied to the clipboard.', 'Close', { duration: 3000 } );
        } );
    }

    /**
     * Returns true if the group is shown open.
     */
    public isOpen( group: HealthGroup ): boolean {
        return this.toggled[ group.path ] ?? !group.installedPackage;
    }

    public toggle( group: HealthGroup ): void {
        this.toggled[ group.path ] = !this.isOpen( group );
    }

    public trackGroup( index: number, group: HealthGroup ): string {
        return group.path;
    }

    public trackFinding( index: number, finding: HealthFinding ): string {
        return finding.id;
    }

    /**
     * Shows the result of a fix and offers to undo it.
     */
    private afterChange( result: HealthChangeResult ): void {
        this.busy = false;

        if ( result.error === 'backup' ) {
            this.snackBar.open( 'Could not back up your triggers first, so nothing was changed.', 'Close', { duration: 8000 } );
        } else if ( result.changed === 0 ) {
            this.snackBar.open( 'Nothing was changed; the trigger was edited since the last check. Checked again.', 'Close', { duration: 6000 } );
        } else {
            const ref = this.snackBar.open( `${this.countLabel( result.changed )} changed.`, 'Undo', { duration: 10000 } );
            ref.onAction().subscribe( () => {
                this.busy = true;
                this.healthService.undo( result.undoId ).subscribe( () => this.busy = false );
            } );
        }
    }

    private countLabel( count: number ): string {
        return `${count} ${count === 1 ? 'trigger or folder' : 'triggers or folders'}`;
    }

    private setReport( report: HealthReport ): void {
        this.report = report;
        this.defaultGroups = this.group( report.findings.filter( f => f.level === 'default' ) );
        this.advancedGroups = this.group( report.findings.filter( f => f.level === 'advanced' ) );
    }

    private group( findings: HealthFinding[] ): HealthGroup[] {
        const groups: HealthGroup[] = [];
        findings.forEach( finding => {
            let group = groups.find( g => g.path === finding.subject.folderPath );
            if ( !group ) {
                group = { path: finding.subject.folderPath, findings: [], installedPackage: false };
                groups.push( group );
            }
            group.findings.push( finding );
        } );
        groups.forEach( g => g.installedPackage = g.findings.every( f => f.package != null ) );
        return groups;
    }

}

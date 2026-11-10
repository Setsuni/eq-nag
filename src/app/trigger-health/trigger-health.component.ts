import { Component, OnInit } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { IpcService } from '../ipc.service';
import { HealthChangeResult, HealthFinding, HealthReport, HealthSeverity, TriggerHealthService } from './trigger-health.service';

interface HealthRow {
    subject: HealthFinding['subject'];
    findings: HealthFinding[];
    package: HealthFinding['package'];
    severity: HealthSeverity;
}

interface HealthGroup {
    path: string;
    rows: HealthRow[];
    count: number;
    installedPackage: boolean;
}

@Component( {
    selector: 'app-trigger-health',
    templateUrl: './trigger-health.component.html',
    styleUrls: [ './trigger-health.component.scss' ]
} )
export class TriggerHealthComponent implements OnInit {

    public report: HealthReport | null = null;
    public busy: boolean = false;
    public advanced: boolean = false;
    public defaultGroups: HealthGroup[] = [];
    public advancedGroups: HealthGroup[] = [];

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
    ) { }

    ngOnInit(): void {
        this.healthService.report$.subscribe( report => {
            if ( report ) {
                this.setReport( report );
            }
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
            this.snackBar.open( `${this.fixLabel( result.fixes, result.changed )} undone.`, 'Close', { duration: 4000 } );
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
     * @param row The row of a package trigger.
     */
    public messageAuthor( row: HealthRow ): void {
        const pkg = row.package;
        const note = [
            `Hi! Nag's trigger health check found a problem in your package "${pkg.name}".`,
            '',
            `${row.subject.kind === 'folder' ? 'Folder' : 'Trigger'}: ${row.subject.name}`,
            ...row.findings.flatMap( f => [ f.reason, ...( f.fix ? [ `Suggested change: ${f.fix.label}.` ] : [] ) ] ),
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

    public trackRow( index: number, row: HealthRow ): string {
        return `${row.subject.kind}:${row.subject.id}`;
    }

    public trackFinding( index: number, finding: HealthFinding ): string {
        return finding.id;
    }

    /**
     * Returns the fixes of a row that the user may apply.
     */
    public fixable( row: HealthRow ): HealthFinding[] {
        return row.findings.filter( f => f.fix );
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
            const ref = this.snackBar.open( `${this.fixLabel( result.fixes, result.changed )} applied.`, 'Undo', { duration: 10000 } );
            ref.onAction().subscribe( () => {
                this.busy = true;
                this.healthService.undo( result.undoId ).subscribe( () => this.busy = false );
            } );
        }
    }

    private fixLabel( fixes: number, changed: number ): string {
        return `${fixes} ${fixes === 1 ? 'fix' : 'fixes'} (${changed} ${changed === 1 ? 'trigger or folder' : 'triggers or folders'})`;
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
                group = { path: finding.subject.folderPath, rows: [], count: 0, installedPackage: false };
                groups.push( group );
            }

            let row = group.rows.find( r => r.subject.kind === finding.subject.kind && r.subject.id === finding.subject.id );
            if ( !row ) {
                row = { subject: finding.subject, findings: [], package: finding.package, severity: finding.severity };
                group.rows.push( row );
            }

            row.findings.push( finding );
            group.count++;
        } );
        groups.forEach( g => g.installedPackage = g.rows.every( r => r.package != null ) );
        return groups;
    }

}

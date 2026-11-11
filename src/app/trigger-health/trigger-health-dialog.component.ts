import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { HealthSummary } from './trigger-health.service';

export interface TriggerHealthDialogData {
    version: string;
    summary: HealthSummary;
}

export interface TriggerHealthDialogResult {
    review: boolean;
    dontShowAgain: boolean;
}

@Component( {
    selector: 'app-trigger-health-dialog',
    template: `
        <h2 mat-dialog-title>Trigger health check</h2>

        <mat-dialog-content>
            <p class="lead">Nag {{data.version}} checked your triggers</p>
            <p>Most of your {{data.summary.triggers | number}} triggers look fine. Some will never fire, or may stop firing in instanced zones.</p>

            <div class="stats">
                <div class="stat never"><span class="number">{{data.summary.defaultCounts.never}}</span><span class="label">will never fire</span></div>
                <div class="stat may"><span class="number">{{data.summary.defaultCounts.may}}</span><span class="label">may stop firing</span></div>
                <div class="stat fix"><span class="number">{{data.summary.bulkFixes}}</span><span class="label">one-click fixes</span></div>
            </div>

            <p class="note">Nothing has been changed. The review shows each trigger, why it was flagged, and a fix you can accept or skip.</p>
        </mat-dialog-content>

        <mat-dialog-actions>
            <mat-checkbox [(ngModel)]="dontShowAgain" name="dontShowAgain">Don't show again for this version</mat-checkbox>
            <span class="spacer"></span>
            <button mat-stroked-button (click)="close( false )">Later</button>
            <button mat-flat-button color="primary" (click)="close( true )">Review</button>
        </mat-dialog-actions>
    `,
    styleUrls: [ '../dialogs/dialog.styles.scss' ],
    styles: [ `
        .lead { font-size: 18px; margin: 0 0 4px; }
        .stats { display: flex; gap: 12px; margin: 16px 0; }
        .stat { flex: 1; padding: 10px 12px; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 4px; display: flex; flex-direction: column; }
        .stat .number { font-size: 28px; font-weight: 500; }
        .stat .label { font-size: 12px; opacity: 0.85; }
        .stat.never .number { color: #f06969; }
        .stat.may .number { color: #f0c669; }
        .stat.fix .number { color: #69f0ae; }
        .note { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 20px; background: rgba(0, 0, 0, 0.18); border-radius: 4px; color: rgba(255, 255, 255, 0.7); }
        mat-dialog-actions { display: flex; align-items: center; gap: 8px; }
        mat-dialog-actions .spacer { flex: 1 1 auto; }
    ` ],
} )
export class TriggerHealthDialogComponent {

    public dontShowAgain: boolean = false;

    constructor(
        private readonly dialogRef: MatDialogRef<TriggerHealthDialogComponent, TriggerHealthDialogResult>,
        @Inject( MAT_DIALOG_DATA ) public data: TriggerHealthDialogData,
    ) { }

    public close( review: boolean ): void {
        this.dialogRef.close( { review, dontShowAgain: this.dontShowAgain } );
    }

}

import { Component, Input } from '@angular/core';
import { ActionTypes, OverlayWindowModel, Phrase, TimerRestartBehaviors, TriggerAction } from 'src/app/core.model';

/** True when the action uses a timer option that only shows under Advanced. */
export function usesAdvancedTimerOptions( action: TriggerAction ): boolean {
    return action.repeatTimer === true
        || action.hideTimer === true
        || action.useCustomColor === true
        || action.storageDuration?.length > 0
        || action.timerIcon != null
        || action.onlyUseAaBeneficialFocus === true
        || action.skipBenCastingTimeFocus === true
        || action.endingSoonShowTimer === true
        || action.endingClipboard === true
        || action.endingPlayAudio === true
        || action.endedClipboard === true
        || action.endedPlayAudio === true
        || action.endedChangeColor === true
        || action.remainUnlessEndedEarly === true
        || action.endingSoonSubActions?.length > 0
        || action.endedSubActions?.length > 0
        || action.endEarlyPhrases?.length > 0
        || action.excludeTargets?.length > 0
        || action.hideConditions?.length > 0;
}

/**
 * The few fields most timers need: name, duration, overlay, what to do when it
 * fires again, a warning before it ends and what happens when it ends.  They
 * edit the same properties as the Advanced tabs, so nothing is stored twice.
 */
@Component( {
    selector: 'app-timer-quick',
    templateUrl: 'timer-quick.component.html',
    styleUrls: [ 'timer-quick.component.scss', '../../core.scss', '../../modal.scss' ]
} )
export class TimerQuickComponent {

    @Input() public action: TriggerAction;
    @Input() public timerOverlays: OverlayWindowModel[] = [];
    @Input() public alertOverlays: OverlayWindowModel[] = [];
    @Input() public capturePhrases: Phrase[] = [];

    public Math: typeof Math = Math;
    public actionTypes: typeof ActionTypes = ActionTypes;
    public timerRestartBehaviors: typeof TimerRestartBehaviors = TimerRestartBehaviors;

    public get warnActive(): boolean {
        return this.action.ifEndingSoon === true && this.action.endingDuration > 0;
    }

    public onWarnChange( checked: boolean ): void {
        this.action.ifEndingSoon = checked;
        if ( checked && !( this.action.endingDuration > 0 ) ) {
            this.action.endingDuration = 10;
        }
    }

    public onWarnColorChange( checked: boolean ): void {
        this.action.endingSoonChangeColor = checked;
        if ( checked && !this.action.endingSoonColor ) {
            this.action.endingSoonColor = '#ff0000';
        }
    }

    public onWarnTextChange( checked: boolean ): void {
        this.action.endingSoonDisplayText = checked;
        if ( checked ) {
            this.action.endingSoonTextOverlayId = this.action.endingSoonTextOverlayId ?? this.defaultTextOverlay();
            this.action.endingSoonTextDuration = this.action.endingSoonTextDuration ?? 5;
        }
    }

    public get endedShowText(): boolean {
        return this.action.notifyWhenEnded === true && this.action.endedDisplayText === true;
    }

    public set endedShowText( value: boolean ) {
        this.action.endedDisplayText = value;
        if ( value ) {
            this.action.notifyWhenEnded = true;
            this.action.endedTextOverlayId = this.action.endedTextOverlayId ?? this.defaultTextOverlay();
            this.action.endedTextDuration = this.action.endedTextDuration ?? 5;
        }
    }

    public get endedSpeak(): boolean {
        return this.action.notifyWhenEnded === true && this.action.endedSpeak === true;
    }

    public set endedSpeak( value: boolean ) {
        this.action.endedSpeak = value;
        if ( value ) {
            this.action.notifyWhenEnded = true;
        }
    }

    public onKeepBarChange( checked: boolean ): void {
        this.action.remainAfterEnded = checked;
        if ( checked && !( this.action.remainDuration > 0 ) ) {
            this.action.remainDuration = 5;
        }
    }

    private defaultTextOverlay(): string | null {
        return this.alertOverlays?.[ 0 ]?.overlayId ?? null;
    }

}

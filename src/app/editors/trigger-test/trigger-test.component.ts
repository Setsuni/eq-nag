import { Component, Input } from '@angular/core';
import { ActionTypeLabels, ActionTypes, TriggerAction, TriggerModel, TriggerTestResult } from 'src/app/core.model';
import { IpcService } from 'src/app/ipc.service';
import { summarizeAction } from '../action-picker';

/**
 * Lets the player paste one log line and see whether the trigger, as it is in
 * the editor, would react to it, and optionally run its actions right away.
 */
@Component( {
    selector: 'app-trigger-test',
    templateUrl: 'trigger-test.component.html',
    styleUrls: [ 'trigger-test.component.scss', '../../core.scss', '../../modal.scss' ]
} )
export class TriggerTestComponent {

    @Input() public trigger: TriggerModel;

    public line: string = '';
    public running: boolean = false;
    public result: TriggerTestResult | null = null;
    public fired: boolean = false;

    constructor( private ipcService: IpcService ) { }

    public test( fire: boolean ): void {
        if ( this.running || !( this.line?.trim().length > 0 ) ) {
            return;
        }
        this.running = true;
        this.ipcService.testTrigger( this.trigger, this.line.trim(), fire ).subscribe( result => {
            this.result = result;
            this.fired = fire && result.fired;
            this.running = false;
        } );
    }

    /** The actions that would run for the phrases that matched. */
    public get actionLines(): string[] {
        const matched = this.result?.matches.map( m => m.phraseId ) ?? [];
        return ( this.trigger.actions ?? [] )
            .filter( ( action: TriggerAction ) => action.actionType != null && ( action.actionType === ActionTypes.List || action.phrases?.some( id => matched.includes( id ) ) ) )
            .map( action => [ ActionTypeLabels( action.actionType ), summarizeAction( action ) ].filter( f => f.length > 0 ).join( ' ' ) );
    }

    /** The number of the first phrase that matched, as the player sees it. */
    public get matchedNumber(): number {
        const id = this.result?.matches[ 0 ]?.phraseId;
        return this.trigger.capturePhrases.findIndex( p => p.phraseId === id ) + 1;
    }

    public get errorText(): string {
        return this.result?.error === 'noCharacter' ? 'Add a character first, so Nag has a log reader to test with.'
            : this.result?.error === 'timeout' ? 'Nag did not get an answer from the log reader. Try again in a moment.'
            : 'Something went wrong while testing this trigger.';
    }

}

import { Component, ElementRef, EventEmitter, Input, OnInit, Output, ViewChild } from '@angular/core';
import { ActionTypeIcons, ActionTypeLabels, ActionTypes, CapturePhrase, OverlayWindowModel, TriggerAction } from 'src/app/core.model';
import { DialogService } from 'src/app/dialogs/dialog.service';
import { IpcService } from 'src/app/ipc.service';
import { ActionPickerGroup, ActionPickerGroups, actionTypeDescription, isAdvancedActionType, summarizeAction } from '../action-picker';

@Component( {
    selector: 'app-trigger-actions',
    templateUrl: 'trigger-actions.component.html',
    styleUrls: ['trigger-actions.component.scss', '../../core.scss', '../../modal.scss']
} )
export class TriggerActionsComponent implements OnInit {

    @Input() public actions: TriggerAction[];
    @Output() public actionsChange: EventEmitter<TriggerAction[]> = new EventEmitter<TriggerAction[]>();

    @Input() public isDev: boolean = false;
    @Input() public predefined: boolean = false;
    @Input() public capturePhrases: CapturePhrase[] = [];
    @Input() public showAdvanced: boolean = false;

    /** The action types offered as one-click buttons next to the More menu. */
    public quickAddTypes: ActionTypes[] = [ ActionTypes.DisplayText, ActionTypes.Speak, ActionTypes.PlayAudio, ActionTypes.Timer ];

    private _open: Set<TriggerAction> = new Set<TriggerAction>();

    public actionTypes: typeof ActionTypes = ActionTypes;
    public actionTypeLabels = ActionTypeLabels;
    public actionTypeIcons = ActionTypeIcons;
    public overlays: OverlayWindowModel[] = [];
    
    public get alertOverlays(): OverlayWindowModel[] {
        return this.overlays.filter( f => f.overlayType === 'Alert' );
    }

    public get logOverlays(): OverlayWindowModel[] {
        return this.overlays.filter( f => f.overlayType === 'Log' );
    }

    public get timerOverlays(): OverlayWindowModel[] {
        return this.overlays.filter( f => f.overlayType === 'Timer' );
    }

    @ViewChild( 'content', { static: true } ) content: ElementRef<HTMLDivElement>;

    private _scrollTimeoutId: number | undefined = undefined;
    private _scrolling: boolean = false;
    public get scrolling(): boolean {
        return this._scrolling;
    }
    public set scrolling( value: boolean ) {
        this._scrolling = value;
        if ( value ) {
            if ( this._scrollTimeoutId ) {
                window.clearTimeout( this._scrollTimeoutId );
            }
            this._scrollTimeoutId = window.setTimeout( () => {
                this.scrolling = false;
                this.scrollIndex = -1;
            }, 3000 );
        }
    }
    public scrollIndex: number = -1;

    constructor( private dialogService: DialogService, private ipcService: IpcService ) { }

    ngOnInit() {
        
        this.ipcService.getOverlayWindows().subscribe( overlays => this.overlays = overlays );

    }










    /**
     * Returns true if there are no list actions in the actions array, or if 
     * the given action already is a list action.
     * 
     * @param action The action to check.
     */
    public canSelectList( action: TriggerAction | null ): boolean {
        return !this.actions.some( f => ( action == null || f.actionId !== action.actionId ) && f.actionType === ActionTypes.List );
    }









    
    /**
     * Returns true if the trigger has a single capture phrase and the given
     * action runs for it, so there is nothing to choose.
     * 
     * @param action The action to check.
     */
    public runsForAnyPhrase( action: TriggerAction ): boolean {
        return this.capturePhrases?.length === 1 && action.phrases?.includes( this.capturePhrases[ 0 ].phraseId ) === true;
    }

    /**
     * Adds a new action that runs for every current capture phrase and opens it for editing.
     * 
     * @param actionType The type of the new action, if known.
     */
    public addNewAction( actionType: ActionTypes = null ): void {
        const action = new TriggerAction();
        action.phrases = this.capturePhrases?.map( f => f.phraseId ) ?? [];
        if ( actionType != null ) {
            action.actionType = actionType;
        }
        this.actions.push( action );
        this._open.add( action );
        this.actionsChange.emit( this.actions );
        window.setTimeout( () => this.content?.nativeElement.querySelector( '.action-card:last-of-type' )?.scrollIntoView( { block: 'nearest' } ) );
    }

    /** Whether the action's full editor is showing.  Actions without a type always are. */
    public isOpen( action: TriggerAction ): boolean {
        return action.actionType == null || this._open.has( action );
    }

    public toggleOpen( action: TriggerAction ): void {
        if ( this._open.has( action ) ) {
            this._open.delete( action );
        } else {
            this._open.add( action );
        }
    }

    public summary( action: TriggerAction ): string {
        return summarizeAction( action );
    }

    public typeDescription( actionType: ActionTypes ): string {
        return actionTypeDescription( actionType );
    }

    public outlinedIcon( actionType: ActionTypes ): boolean {
        return actionType === ActionTypes.Timer || actionType === ActionTypes.ClearAll || actionType === ActionTypes.Stopwatch;
    }

    /**
     * Returns the picker groups to offer.  The advanced group shows when the player
     * turned advanced options on, or when the action being changed already uses one.
     * 
     * @param action The action whose type is being changed, or null when adding.
     */
    public pickerGroups( action: TriggerAction | null ): ActionPickerGroup[] {
        const showAdvanced = this.showAdvanced || ( action?.actionType != null && isAdvancedActionType( action.actionType ) );
        return ActionPickerGroups.filter( g => showAdvanced || !g.advanced );
    }









    
    /**
     * Deletes the specified action, after confirming with the user.
     * 
     * @param index The index of the action to remove.
     */
    public deleteAction( index: number ): void {
        this.dialogService
            .showConfirmationDialog(
                'Are you certain you want to delete this action?',
                'Click "Yes" to delete the action.',
                'Click "No" to cancel and close this dialog without deleting the action.' )
            .subscribe( confirmed => {
                if ( confirmed ) {
                    this.actions?.splice( index, 1 );
                    this.actionsChange.emit( this.actions );
                }
            } );
    }









    
    /**
     * Returns a list of trigger actions not matching the given id.
     * 
     * @param actionId The action id to exclude.
     */
    public getOtherActions( actionId: string ): TriggerAction[] {
        return this.actions.filter( f => f.actionId !== actionId );
    }









    
    /**
     * Moves the action at the given index up one position.
     * 
     * @param index The index of the action to move up.
     */
    public moveUp( index: number, ev: MouseEvent ): void {

        this.scrolling = true;

        if ( index > 0 ) {
            const action = this.actions[ index ];
            this.actions.splice( index, 1 );
            this.actions.splice( index - 1, 0, action );
            this.actionsChange.emit( this.actions );
            this.scrollIndex = index - 1;
        }
    }









    
    /**
     * Moves the action at the given index down one position.
     * 
     * @param index The index of the action to move down.
     */
    public moveDown( index: number, ev: MouseEvent ): void {

        this.scrolling = true;

        if ( index < this.actions.length - 1 ) {
            const action = this.actions[ index ];
            this.actions.splice( index, 1 );
            this.actions.splice( index + 1, 0, action );
            this.actionsChange.emit( this.actions );
            this.scrollIndex = index + 1;
        }
    }









    /**
     * Sets the type of an existing action, or adds a new action of that type.
     * 
     * @param action The action to change, or null to add a new action.
     * @param selectedType The action type that was picked.
     */
    public pickActionType( action: TriggerAction | null, selectedType: ActionTypes ): void {
        if ( action == null ) {
            this.addNewAction( selectedType );
            return;
        }
        action.actionType = selectedType;
        this._open.add( action );
        this.actionsChange.emit( this.actions ); // Let the parent component react immediately.
    }

}

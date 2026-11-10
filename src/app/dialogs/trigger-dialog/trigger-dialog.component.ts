import { Component, OnInit } from '@angular/core';
import { animate, state, style, transition, trigger } from '@angular/animations';
import { ActivatedRoute } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';

import { IpcService } from 'src/app/ipc.service';
import { DialogService } from '../dialog.service';
import { ColorUtility } from 'src/app/utilities';
import { TriggerModel, CapturePhrase, ActionTypes, TriggerAction, TriggerCondition, TriggerConditionTypes, OverlayWindowModel, OperatorTypes, ImportTypes, ExternalDataSources } from 'src/app/core.model';
import { Observable } from 'rxjs';
import { CooldownExplanation } from 'src/app/editors/capture-phrases/capture-phrases.component';
import { isAdvancedActionType } from 'src/app/editors/action-picker';

const advancedStorageKey = 'nagTriggerEditorAdvanced';
const zoneVariableName = 'CurrentZone';

@Component( {
    selector: 'app-trigger-dialog',
    templateUrl: 'trigger-dialog.component.html',
    styleUrls: [ 'trigger-dialog.component.scss', '../../core.scss', '../../modal.scss' ],
    animations: [
        trigger( 'detailExpand', [
            state( 'collapsed', style( { height: '0px', minHeight: '0' } ) ),
            state( 'expanded', style( { height: '*' } ) ),
            transition( 'expanded <=> collapsed', animate( '225ms cubic-bezier(0.4, 0.0, 0.2, 1)' ) ),
        ] ),
    ],
} )
export class TriggerDialogComponent implements OnInit {

    public model: TriggerModel;
    public triggerId: string = null;
    public folderId: string = null;
    public actionTypes: typeof ActionTypes = ActionTypes;
    public operatorTypes: typeof OperatorTypes = OperatorTypes;
    public isDev: boolean = false;
    public showAdvanced: boolean = false;
    public showOnlyWhen: boolean = false;
    public zones: string[] = [];
    private _baseline: string = null;
    private _docsUrl: string = 'https://guildantix.github.io/eq-nag/triggers/';

    /** The docs page for the section the player is working in. */
    public helpPage: string = 'capture-phrases/';
    public get helpUrl(): string {
        return this._docsUrl + this.helpPage;
    }

    /** Whether the trigger uses anything that only shows under Advanced. */
    public get usesAdvanced(): boolean {
        const m = this.model;
        return m.captureMethod === 'Sequential'
            || m.conditions?.some( c => !this.isSimpleZoneCondition( c ) || this.zoneMode === 'complex' )
            || m.classLevels?.some( c => c.class?.trim().length > 0 )
            || m.hotkeys?.length > 0
            || m.comments?.length > 0
            || m.actions?.some( a => isAdvancedActionType( a.actionType ) );
    }

    /** Whether the trigger uses anything that shows under Only when. */
    public get usesOnlyWhen(): boolean {
        return this.model.useCooldown === true || this.zoneConditions.length > 0;
    }

    private isSimpleZoneCondition( condition: TriggerCondition ): boolean {
        return condition.variableName === zoneVariableName && condition.operatorType === OperatorTypes.Contains && !( condition as any ).useRegEx;
    }

    private get zoneConditions(): TriggerCondition[] {
        return this.model.conditions?.filter( c => c.variableName === zoneVariableName ) ?? [];
    }

    /** The zone field edits a lone "contains" rule on the current zone; anything else is shown but edited in Advanced. */
    public get zoneMode(): 'simple' | 'complex' {
        const zoneConditions = this.zoneConditions;
        if ( zoneConditions.length === 0 ) {
            return 'simple';
        }
        return zoneConditions.length === 1 && this.model.conditions.length === 1 && this.isSimpleZoneCondition( zoneConditions[ 0 ] ) ? 'simple' : 'complex';
    }

    public get zoneValue(): string {
        return this.zoneConditions[ 0 ]?.variableValue ?? '';
    }

    /** Plain-English description of the zone rules the zone field cannot edit. */
    public get complexZoneText(): string {
        const words: Record<number, string> = {
            [ OperatorTypes.IsNull ]: 'is empty',
            [ OperatorTypes.Equals ]: 'is exactly',
            [ OperatorTypes.DoesNotEqual ]: 'is not',
            [ OperatorTypes.Contains ]: 'contains',
        };
        return this.zoneConditions.map( c => `${words[ c.operatorType ] ?? 'matches'} ${c.variableValue ?? ''}`.trim() ).join( ' and ' );
    }

    /** Creates, changes or removes the zone rule, the same rule the Conditions table makes. */
    public setZone( value: string ): void {
        const others = this.model.conditions ?? [];
        const existing = this.zoneConditions[ 0 ];
        if ( !( value?.length > 0 ) ) {
            this.model.conditions = others.filter( c => c !== existing );
        } else if ( existing ) {
            existing.variableValue = value;
            this.model.conditions = [ ...others ];
        } else {
            const condition = new TriggerCondition();
            condition.conditionType = TriggerConditionTypes.VariableValue;
            condition.operatorType = OperatorTypes.Contains;
            condition.variableName = zoneVariableName;
            condition.variableValue = value;
            this.model.conditions = [ ...others, condition ];
        }
    }
    private _fullName: string = '';
    public get fullName(): string {
        return this._fullName;
    }
    public set fullName( value: string ) {
        this._fullName = value;
    }
    public get fullNamePrefix(): string {
        // Return the first half of the full name, by size.
        if ( this.fullName.length > 0 ) {
            let half = Math.floor( this.fullName.length / 2 );
            // if the first part of the second half is a slash or space, move past it so it stays in the first half.
            while ( this.fullName[ half ] === '/' || this.fullName[ half ] === ' ' ) {
                half++;
            }
            return this.fullName.substring( 0, half );
        } else {
            return '';
        }
    }
    public get fullNameSuffix(): string {
        // Return the second half of the full name, by size.
        if ( this.fullName.length > 0 ) {
            let half = Math.floor( this.fullName.length / 2 );
            // if the first part of the second half is a slash or space, move past it so it stays in the first half.
            while ( this.fullName[ half ] === '/' || this.fullName[ half ] === ' ' ) {
                half++;
            }
            return this.fullName.substring( half );
        } else {
            return '';
        }
    }

    public get showReimportFromAlla(): boolean {
        if ( this.model.importType == ImportTypes.None || this.model.allakhazamUrl == null ) {
            return false;
        }
        if ( this.model.externalSource === ExternalDataSources.Allakhazam ) {
            // Allakhazam triggers move to EQ Spell Resources, which has no raid
            // ability generator.
            return this.model.importType !== ImportTypes.Ability;
        }
        return this.model.externalSource === ExternalDataSources.EqSpellResources;
    }

    /** Re-imports always come from EQ Spell Resources; Allakhazam is no longer used. */
    public get serviceName(): string {
        return this.model.importType != ImportTypes.None ? 'EQ Spell Resources' : 'None';
    }

    constructor( private ipcService: IpcService, private route: ActivatedRoute, public dialogService: DialogService, private snackBar: MatSnackBar ) { }

    ngOnInit() {
        this.model = new TriggerModel();

        this.route.params.subscribe( params => {
            
            this.triggerId = params[ 'id' ];
            this.folderId = params[ 'folderId' ];

            if ( this.triggerId != null ) {
                this.ipcService.getTrigger( this.triggerId ).subscribe( trigger => {
                    this.model = trigger;
                    this.initDisclosures();
                    this.captureBaseline();
                } );
                this.ipcService.getTriggerFullName( this.triggerId ).subscribe( fullName => this.fullName = fullName );
            } else {
                this.initDisclosures();
                this.captureBaseline();
            }

            // In a real app: dispatch action to load the details here.
        } );
        
        this.ipcService.getAppIsDev().subscribe( isDev => this.isDev = isDev );
    }

    public closeModal(): void {
        this.ipcService.closeThisChild();
    }

    /** Opens Advanced when the player left it open last time, or when this trigger needs it. */
    private initDisclosures(): void {
        this.showAdvanced = localStorage.getItem( advancedStorageKey ) === 'true' || this.usesAdvanced;
        this.showOnlyWhen = this.usesOnlyWhen || ( this.showAdvanced && ( this.model.conditions?.length > 0 || this.model.classLevels?.some( c => c.class?.trim().length > 0 ) ) );
        this.ipcService.getEverquestZones().subscribe( zones => this.zones = zones ?? [] );
    }

    /** Shows or hides the advanced options, and remembers the choice for the next trigger. */
    public setShowAdvanced( value: boolean ): void {
        this.showAdvanced = value;
        localStorage.setItem( advancedStorageKey, value.toString() );
    }

    public explainCooldowns(): void {
        this.dialogService.showInfoDialog( 'Capture Cooldowns', CooldownExplanation );
    }

    /** Records the model as it looks once the editor has finished rendering it. */
    private captureBaseline(): void {
        window.setTimeout( () => this._baseline = JSON.stringify( this.model ) );
    }

    public get hasUnsavedChanges(): boolean {
        return this._baseline != null && JSON.stringify( this.model ) !== this._baseline;
    }

    /** Closes the editor, asking first when there are unsaved changes. */
    public requestClose(): void {
        if ( !this.hasUnsavedChanges ) {
            this.closeModal();
            return;
        }
        this.dialogService
            .showConfirmationDialog(
                'Close without saving?',
                'Click "Discard" to close the editor and lose your changes.',
                'Click "Keep editing" to go back to the editor.',
                null, 'normal', null,
                { Yes: 'Discard', No: 'Keep editing' } )
            .subscribe( discard => {
                if ( discard ) {
                    this.closeModal();
                }
            } );
    }

    /** Actions that ran for every previous phrase also run for the new one. */
    public onCapturePhraseAdded( added: CapturePhrase ): void {
        const previousIds = this.model.capturePhrases.filter( f => f.phraseId !== added.phraseId ).map( f => f.phraseId );
        this.model.actions?.forEach( action => {
            const ranForEveryPhrase = previousIds.length === 0 ? !( action.phrases?.length > 0 ) : previousIds.every( id => action.phrases?.includes( id ) );
            if ( ranForEveryPhrase ) {
                action.phrases = action.phrases ?? [];
                action.phrases.push( added.phraseId );
            }
        } );
    }

    public save(): Observable<boolean> {

        return new Observable( observer => {

            let listActionCount = this.model.actions?.filter( x => x.actionType === ActionTypes.List ).length ?? 0;

            if ( listActionCount > 1 ) {
                this.dialogService.showErrorDialog( 'Error!', 'Only one list action is allowed per trigger.' );
                observer.next( false );
                observer.complete();
                return;
            }

            this.model.actions?.forEach( ( action: TriggerAction ) => {
    
                if ( action.actionType === ActionTypes.StoreVariable ) {
                    // No special processing operations are required for store variable actions.
                    
                } else {
    
                    if ( action.useCustomColor === true ) {
                        action.overrideTimerColor = action.overrideTimerColor;
                        action.timerBackgroundColor = ColorUtility.FromHex( action.overrideTimerColor ).darken( 0.93 ).toString( 0.75 );
                    } else {
                        action.overrideTimerColor = null;
                        action.timerBackgroundColor = null;
                    }
    
                    if ( action.ifEndingSoon === true && action.endingDuration > 0 ) {
                        if ( action.endingSoonChangeColor === true ) {
                            action.endingSoonBackgroundColor = ColorUtility.FromHex( action.endingSoonColor ).darken( 0.93 ).toString( 0.75 );
                        } else {
                            action.endingSoonBackgroundColor = null;
                        }
                    } else {
                        action.endingDuration = null;
                        action.endingSoonColor = null;
                    }
    
                    if ( action.actionType === ActionTypes.Stopwatch || ( action.remainAfterEnded === true && action.remainDuration > 0 ) ) {
                        if ( action.endedChangeColor === true ) {
                            action.endedBackgroundColor = ColorUtility.FromHex( action.endedColor ).darken( 0.93 ).toString( 0.75 );
                        } else {
                            action.endedBackgroundColor = null;
                        }
                    } else {
                        action.remainAfterEnded = false;
                        action.remainDuration = null;
                        action.endedColor = null;
                        action.endedBackgroundColor = null;
                    }
    
                }
    
            } );

            if ( this.triggerId == null ) {
                this.model.folderId = this.folderId?.length > 0 ? this.folderId : null;
                this.ipcService.createNewTrigger( this.model ).subscribe( triggerId => {
                    this.triggerId = triggerId;
                    this.model.triggerId = triggerId;
                    this._baseline = JSON.stringify( this.model );
                    observer.next( true );
                    observer.complete();
                } );
            } else {
                this.ipcService.updateTrigger( this.model ).subscribe( success => {
                    if ( success ) {
                        this._baseline = JSON.stringify( this.model );
                    }
                    observer.next( success );
                    observer.complete();
                } );
            }
        } );

    }

    public saveAndClose(): void {
        this.save().subscribe( success => {
            if ( success ) {
                this.closeModal();
            }
        } );
    }

    public applyChanges(): void {
        this.save().subscribe();
    }

    public copyJson(excludeNull = false, format = false): void {
        let replacer = null;
        let space = 0;

        // Set replacer if we need to exclude nulls
        if (excludeNull) {
            replacer = (key: string, value: any) => value === null ? undefined : value;
        }

        // Set indentation if we need to format
        if (format) {
            space = 4;
        }

        // Stringify and copy
        this.ipcService.sendTextToClipboard(JSON.stringify(this.model, replacer, space));
        this.snackBar.open('Trigger details copied!', 'Dismiss', { duration: 5000 });
    }

    public reimportFromAllakhazam(): void {
        if ( this.model.externalSource === ExternalDataSources.Allakhazam ) {
            this.dialogService.showEqsrUrlDialog().subscribe( url => {
                if ( url ) {
                    this.model.allakhazamUrl = url;
                    this.model.externalSource = ExternalDataSources.EqSpellResources;
                    this.reimportFromAllakhazam();
                }
            } );
            return;
        }

        if ( this.model.importType === ImportTypes.DotTimer ) {
            this.reimportDotTimerFromAllakhazam();
        } else if ( this.model.importType === ImportTypes.Ability ) {
            this.reimportAbilityFromAllakhazam();
        } else if ( this.model.importType === ImportTypes.Buff || this.model.importType === ImportTypes.OthersBuff ) {
            this.reimportBuffFromAllakhazam();
        }
    }

    private reimportDotTimerFromAllakhazam(): void {
        this.dialogService.showReimportDotTimerDialog( this.model, this.model.externalSource );
    }

    private reimportAbilityFromAllakhazam(): void {
        this.dialogService.showReimportRaidAbilityDialog( this.model, this.model.externalSource );
    }

    private reimportBuffFromAllakhazam(): void {
        this.dialogService.showReimportBuffDialog( this.model, this.model.externalSource );
    }

}

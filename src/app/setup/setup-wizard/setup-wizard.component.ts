import { Component, ElementRef, Inject, NgZone, OnInit, ViewChild } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActionTypes, CharacterModel, DpsMeterSettings, OverlayWindowModel, Rectangle, SettingsKeys, TriggerAction } from 'src/app/core.model';
import { IpcService } from 'src/app/ipc.service';
import { customAlphabet } from 'nanoid';
import { forkJoin, Observable, of } from 'rxjs';
import { serverLabel } from 'src/app/utilities/string.utilities';
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const nanoid = customAlphabet( alphabet, 16 );

const recentDays = 60;
const sampleSeconds = 8;

export interface SetupCharacterOption {
    name: string;
    server: string;
    logFile: string;
    thj: boolean;
    p99: boolean;
    takp: boolean;
    daybreak: boolean;
    added: boolean;
    checked: boolean;
    modified: number | null;
    lastPlayed: string;
}

@Component( {
    selector: 'app-setup-wizard',
    templateUrl: 'setup-wizard.component.html',
    styleUrls: [ 'setup-wizard.component.scss' ]
} )
export class SetupWizardComponent implements OnInit {

    public serverLabel( server: string ): string {
        return serverLabel( server );
    }

    public readonly stepLabels: string[] = [ 'Your characters', 'Place your overlays', 'Try it', 'Extras' ];
    private _step: number = 0;
    public get step(): number {
        return this._step;
    }
    public set step( value: number ) {
        this._step = value;
        // Keep keyboard and screen reader focus in the dialog when the step content is swapped.
        window.setTimeout( () => this.elementRef.nativeElement.querySelector( 'h3' )?.focus() );
    }
    public busy: boolean = false;

    public scanning: boolean = true;
    public scanFolder: string = null;
    public characterOptions: SetupCharacterOption[] = [];

    public previewOverlays: OverlayWindowModel[] = [];
    public groupedTimers: boolean = false;
    public canChooseGrouping: boolean = false;

    public readonly testSeconds: number = sampleSeconds;
    public testSent: boolean = false;

    public enableFct: boolean = false;
    public rollTrackerEnabled: boolean = false;
    private _enableDpsMeter: boolean = false;
    public get enableDpsMeter(): boolean {
        return this._enableDpsMeter;
    }
    public set enableDpsMeter( value: boolean ) {
        this._enableDpsMeter = value;
        this.ipcService.getSetting<DpsMeterSettings>( SettingsKeys.dpsMeterSettings, false ).subscribe( current => {
            const settings = Object.assign( new DpsMeterSettings(), current );
            settings.show = value;
            this.ipcService.updateSetting( SettingsKeys.dpsMeterSettings, settings, 0 );
        } );
    }

    private _displaySize: { width: number, height: number } = { width: 1920, height: 1080 };

    private _fctOutId: string;
    private _fctInId: string;
    private _detrimentalId: string;
    private _benficialId: string;
    private _alertId: string;
    private _createdDetrimental: boolean = false;
    private _movedIds: Set<string> = new Set<string>();

    @ViewChild( 'fileSelector' ) private fileSelector: ElementRef<HTMLInputElement>;

    constructor(
        public dialogRef: MatDialogRef<SetupWizardComponent>,
        @Inject( MAT_DIALOG_DATA ) public data: {},
        private ipcService: IpcService,
        private snackBar: MatSnackBar,
        private ngZone: NgZone,
        private elementRef: ElementRef<HTMLElement> ) {
        
    }

    ngOnInit() {

        this.ipcService.getPrimaryDisplay().subscribe( display => {
            this._displaySize = { width: display.size.width, height: display.size.height };
        } );

        this.ipcService.getDetrimentalOverlayId().subscribe( id => this._detrimentalId = id );
        this.ipcService.getBeneficialOverlayId().subscribe( id => this._benficialId = id );
        this.ipcService.getAlertOverlayId().subscribe( id => this._alertId = id );
        this.ipcService.getDamageDealtOverlayId().subscribe( id => this._fctOutId = id );
        this.ipcService.getDamageReceivedOverlayId().subscribe( id => this._fctInId = id );

        this.scanForCharacters( null );

        // Skipping, or closing the dialog any other way, counts as finishing setup.
        this.dialogRef.beforeClosed().subscribe( completed => {
            if ( completed !== true ) {
                this.ipcService.saveSetupCompleted( true );
                this.snackBar.open( 'Setup skipped. You can run setup again from Settings.', 'Dismiss', { duration: 5000 } );
            }
        } );

    }

    public get onLastStep(): boolean {
        return this.step === this.stepLabels.length - 1;
    }

    public get selectedNewCount(): number {
        return this.characterOptions.filter( c => c.checked && !c.added ).length;
    }

    /**
     * Looks for character log files in the EverQuest log folder, or in the given folder.
     *
     * @param logsPath The folder to scan, or null to use the EverQuest install folder.
     */
    scanForCharacters( logsPath: string | null ): void {
        this.scanning = true;

        const scan = ( folder: string ) => {
            this.scanFolder = folder;
            this.ipcService.getCharacterOptions( folder ).subscribe( options => {
                this.characterOptions = this.buildCharacterOptions( options );
                this.scanning = false;
            } );
        };

        if ( logsPath ) {
            scan( logsPath );
            return;
        }

        this.ipcService.getEqInstallFolder().subscribe( folder => {
            if ( folder ) {
                scan( folder + '\\Logs' );
            } else {
                this.scanFolder = null;
                this.characterOptions = [];
                this.scanning = false;
            }
        } );
    }

    showFileSelector(): void {
        this.fileSelector.nativeElement.click();
    }

    fileSelected(): void {
        const files = this.fileSelector.nativeElement.files;
        if ( files?.length > 0 ) {
            const filePath = window.api.getPathForFile( files[ 0 ] );
            const logsPath = filePath.substring( 0, Math.max( filePath.lastIndexOf( '\\' ), filePath.lastIndexOf( '/' ) ) );
            const logsIndex = logsPath.toLowerCase().lastIndexOf( '\\logs' );

            if ( logsIndex > 0 ) {
                this.ipcService.setEqInstallFolder( logsPath.substring( 0, logsIndex ) );
            }

            this.fileSelector.nativeElement.value = null;
            this.scanForCharacters( logsPath );
        }
    }

    /**
     * Adds the ticked characters, then moves on to the overlays.
     */
    saveCharacters(): void {
        const creates: Observable<any>[] = this.characterOptions.filter( c => c.checked && !c.added ).map( option => {
            const model = Object.assign( new CharacterModel(), {
                name: option.name,
                server: option.server,
                logFile: option.logFile,
                p99: option.p99,
                takp: option.takp,
                thj: option.thj,
                daybreak: option.daybreak,
            } );
            return this.ipcService.createCharacter( model );
        } );

        this.busy = true;
        forkJoin( creates.length > 0 ? creates : [ of( null ) ] ).subscribe( () => {
            this.busy = false;
            this.openOverlaysStep();
        } );
    }

    /**
     * Makes sure the default overlays exist, then shows them on the preview.
     */
    openOverlaysStep(): void {
        this.busy = true;

        const creates: Observable<any>[] = [];

        if ( !this._detrimentalId ) {
            const overlay = this.createTimerOverlay( 'Detrimental Timers', false );
            this._detrimentalId = overlay.overlayId;
            this._createdDetrimental = true;
            creates.push( this.ipcService.createNewOverlayWindow( overlay ) );
        }
        if ( !this._benficialId ) {
            const overlay = this.createTimerOverlay( 'Beneficial Timers', true );
            this._benficialId = overlay.overlayId;
            creates.push( this.ipcService.createNewOverlayWindow( overlay ) );
        }
        if ( !this._alertId ) {
            const overlay = this.createTextOverlay();
            this._alertId = overlay.overlayId;
            creates.push( this.ipcService.createNewOverlayWindow( overlay ) );
        }

        forkJoin( creates.length > 0 ? creates : [ of( null ) ] ).subscribe( () => {
            this.ipcService.saveDetrimentalOverlayId( this._detrimentalId );
            this.ipcService.saveBeneficialOverlayId( this._benficialId );
            this.ipcService.saveAlertOverlayId( this._alertId );

            this.canChooseGrouping = this._createdDetrimental;
            this.loadPreview( () => {
                this.busy = false;
                this.step = 1;
            } );
        } );
    }

    /**
     * Lets the player move the real overlays on screen, then refreshes the preview.
     */
    arrangeOnScreen(): void {
        this.persistPreview().subscribe( () => {
            this.ipcService.showArrangeOverlaysDialog().subscribe( () => this.loadPreview( () => { } ) );
        } );
    }

    /**
     * Saves the previewed positions and moves on to the test step.
     */
    overlaysLookGood(): void {
        this.busy = true;
        this.persistPreview().subscribe( () => {
            this.busy = false;
            this.testSent = false;
            this.step = 2;
        } );
    }

    onOverlayMoved( move: { overlayId: string, displayId: number, x: number, y: number } ): void {
        this._movedIds.add( move.overlayId );
    }

    /**
     * Sends a sample timer and a sample text to the default overlays.
     */
    sendTest(): void {
        const timerAction = Object.assign( new TriggerAction(), {
            actionId: nanoid(),
            actionType: ActionTypes.Timer,
            displayText: 'Sample timer',
            duration: sampleSeconds,
        } );
        const textAction = Object.assign( new TriggerAction(), {
            actionId: nanoid(),
            actionType: ActionTypes.DisplayText,
            displayText: 'Nag is working',
            duration: sampleSeconds,
        } );

        this.ipcService.sendOverlayComponent( { instanceId: nanoid(), action: timerAction, overlayId: this._detrimentalId, matches: [], timestamp: new Date() } );
        this.ipcService.sendOverlayComponent( { instanceId: nanoid(), action: textAction, overlayId: this._alertId, matches: [] } );
        this.testSent = true;
    }

    moveOverlaysAgain(): void {
        this.testSent = false;
        this.step = 1;
    }

    openExtrasStep(): void {
        this.step = 3;

        this.ipcService.getSetting<DpsMeterSettings>( SettingsKeys.dpsMeterSettings, false ).subscribe( settings => this._enableDpsMeter = settings?.show === true );
        this.ipcService.getSetting<boolean>( 'enableFct', false ).subscribe( enabled => this.enableFct = enabled === true );
        window.api.ipc.once( 'rolls:state', ( event: any, state: { settings: { enabled: boolean } } ) => {
            this.ngZone.run( () => this.rollTrackerEnabled = state?.settings?.enabled === true );
        } );
        window.api.ipc.send( 'rolls:get', null );
    }

    setRollTracker( enabled: boolean ): void {
        this.rollTrackerEnabled = enabled;
        window.api.ipc.send( 'rolls:settings:set', { enabled: enabled } );
    }

    /**
     * Turns floating combat text on, creating its overlays the first time.
     *
     * @param enabled Whether floating combat text is on.
     */
    setFct( enabled: boolean ): void {
        this.enableFct = enabled;

        if ( !enabled ) {
            this.ipcService.updateEnableFct( false );
            return;
        }

        const creates: Observable<any>[] = [];

        if ( !this._fctOutId ) {
            const overlay = this.createFctOverlay( 'FCT My Damage', '#ffffff', -1 );
            this._fctOutId = overlay.overlayId;
            creates.push( this.ipcService.createNewOverlayWindow( overlay ) );
        }
        if ( !this._fctInId ) {
            const overlay = this.createFctOverlay( 'FCT Damage to Me', '#b71c1c', 1 );
            this._fctInId = overlay.overlayId;
            creates.push( this.ipcService.createNewOverlayWindow( overlay ) );
        }

        forkJoin( creates.length > 0 ? creates : [ of( null ) ] ).subscribe( () => {
            this.ipcService.updateEnableFct( true );
            this.ipcService.saveDamageDealtOverlayId( this._fctOutId );
            this.ipcService.saveDamageReceivedOverlayId( this._fctInId );
            this.ipcService.initializeFctCombatGroups( { fctOutId: this._fctOutId, fctInId: this._fctInId } ).subscribe( () => { } );
        } );
    }

    previous(): void {
        if ( this.step === 1 ) {
            this.step = 0;
            this.scanForCharacters( null );
        } else {
            this.step = Math.max( 0, this.step - 1 );
        }
    }

    complete(): void {
        this.ipcService.saveSetupCompleted( true );
        this.dialogRef.close( true );
    }

    private buildCharacterOptions( options: Record<string, CharacterModel[]> ): SetupCharacterOption[] {
        const now = Date.now();
        const list: SetupCharacterOption[] = [];

        Object.keys( options ?? {} ).forEach( server => {
            options[ server ].forEach( option => {
                const modified: number | null = ( option as any ).modified ?? null;
                list.push( {
                    name: option.name,
                    server: option.server,
                    logFile: option.logFile,
                    thj: option.thj === true,
                    p99: ( option as any ).p99 === true,
                    takp: ( option as any ).takp === true,
                    daybreak: ( option as any ).daybreak === true,
                    added: option.characterId?.length > 0,
                    checked: option.characterId?.length > 0 || ( modified != null && now - modified < recentDays * 86400000 ),
                    modified: modified,
                    lastPlayed: this.describeLastPlayed( modified, now ),
                } );
            } );
        } );

        list.sort( ( a, b ) => ( b.modified ?? 0 ) - ( a.modified ?? 0 ) );

        // Keep one row per name and server: the newest log, or the one that is already added.
        const unique: SetupCharacterOption[] = [];
        list.forEach( option => {
            const key = `${option.name}|${option.server}`.toLowerCase();
            const index = unique.findIndex( u => `${u.name}|${u.server}`.toLowerCase() === key );
            if ( index < 0 ) {
                unique.push( option );
            } else if ( option.added && !unique[ index ].added ) {
                unique[ index ] = option;
            }
        } );
        list.splice( 0, list.length, ...unique );

        // With nothing recent, tick the newest log so the list does not start empty.
        if ( list.length > 0 && !list.some( c => c.checked ) ) {
            list[ 0 ].checked = true;
        }

        return list;
    }

    private describeLastPlayed( modified: number | null, now: number ): string {
        if ( modified == null ) {
            return '';
        }

        const days = Math.floor( ( now - modified ) / 86400000 );

        if ( days < 1 ) {
            return 'last played today';
        } else if ( days < 2 ) {
            return 'last played yesterday';
        } else if ( days <= recentDays ) {
            return `last played ${days} days ago`;
        }

        return `last played ${new Date( modified ).getFullYear()}`;
    }

    /**
     * Loads the default overlays shown on the map of all monitors.
     *
     * @param done Called once the overlays are ready.
     */
    private loadPreview( done: () => void ): void {
        this._movedIds.clear();

        this.ipcService.getOverlayWindows().subscribe( overlays => {
            const overlayIds = [ this._detrimentalId, this._benficialId, this._alertId ];

            this.previewOverlays = overlayIds.map( id => overlays?.find( o => o.overlayId === id ) )
                .filter( overlay => overlay != null );

            done();
        } );
    }

    /**
     * Saves the moved overlays and the timer grouping choice.
     */
    private persistPreview(): Observable<any> {
        const updates: Observable<any>[] = [];

        this.previewOverlays.forEach( overlay => {
            let changed = this._movedIds.has( overlay.overlayId );

            if ( this.canChooseGrouping && overlay.overlayId === this._detrimentalId && overlay.groupByTarget !== this.groupedTimers ) {
                overlay.groupByTarget = this.groupedTimers;
                changed = true;
            }

            if ( changed ) {
                updates.push( this.ipcService.updateOverlayWindow( overlay ) );
            }
        } );

        this._movedIds.clear();

        return forkJoin( updates.length > 0 ? updates : [ of( null ) ] );
    }

    private createTimerOverlay( name: string, beneficial: boolean ): OverlayWindowModel {
        // Close to the usual layout on a 1920x1080 screen; most people move them afterwards.
        const width = Math.round( this._displaySize.width / ( 1920 / 500 ) );
        const height = Math.round( this._displaySize.height / ( 1080 / 300 ) );
        const borderPadding = 20;
        const bounds = new Rectangle( beneficial ? this._displaySize.width - width - borderPadding : borderPadding, borderPadding, width, height );

        return this.createOverlay( bounds, {
            name: name,
            overlayType: 'Timer',
            fontSize: 12,
            lineHeight: 100,
            fontWeight: 500,
            timerSortType: 1,
            showTextBorder: false,
            showTextGlow: false,
            textGlowSize: 10,
            groupByTarget: false,
            groupHeaderSize: 14,
            groupHeaderWeight: 700,
            groupHeaderColor: beneficial ? '#ffffff' : '#f57f17',
            showTimeRemaining: true,
        } );
    }

    private createTextOverlay(): OverlayWindowModel {
        const width = Math.round( this._displaySize.width / ( 1920 / 800 ) );
        const height = Math.round( this._displaySize.height / ( 1080 / 300 ) );
        const bounds = new Rectangle( ( this._displaySize.width / 2 ) - ( width / 2 ), 20, width, height );

        return this.createOverlay( bounds, {
            name: 'Text Notifications',
            overlayType: 'Alert',
            fontSize: 18,
            lineHeight: 90,
            fontWeight: 700,
            timerSortType: 1,
            showTextBorder: true,
            showTextGlow: true,
            textGlowSize: 4,
            groupByTarget: false,
            groupHeaderSize: 40,
            groupHeaderWeight: 400,
            groupHeaderColor: '#ffffff',
            showTimeRemaining: false,
        } );
    }

    /**
     * Creates a floating combat text overlay beside the middle of the screen.
     *
     * @param name The overlay name.
     * @param fontColor The text color.
     * @param side -1 for left of center, 1 for right of center.
     */
    private createFctOverlay( name: string, fontColor: string, side: -1 | 1 ): OverlayWindowModel {
        const width = Math.round( this._displaySize.width / ( 1920 / 500 ) );
        const height = Math.round( this._displaySize.height / ( 1080 / 500 ) );
        const offset = this._displaySize.width * 0.1;
        const left = side < 0 ? ( this._displaySize.width / 2 ) - offset - width : ( this._displaySize.width / 2 ) + offset;
        const bounds = new Rectangle( left, Math.round( ( this._displaySize.height / 2 ) - ( height / 3 ) ), width, height );

        return this.createOverlay( bounds, {
            name: name,
            overlayType: 'FCT',
            fontSize: 32,
            lineHeight: 90,
            fontWeight: 700,
            fontColor: fontColor,
            timerSortType: 0,
            showTextBorder: false,
            showTextGlow: false,
            textGlowSize: 10,
            groupByTarget: false,
            groupHeaderSize: 40,
            groupHeaderWeight: 400,
            groupHeaderColor: '#ffffff',
            showTimeRemaining: false,
        } );
    }

    private createOverlay( bounds: Rectangle, overrides: Partial<OverlayWindowModel> ): OverlayWindowModel {
        return Object.assign( new OverlayWindowModel(), <OverlayWindowModel>{
            overlayId: nanoid(),
            windowHeight: bounds.height,
            windowWidth: bounds.width,
            x: bounds.x,
            y: bounds.y,
            fontFamily: 'Roboto',
            horizontalAlignment: 'center',
            verticalAlignment: 'bottom',
            fontColor: '#ffffff',
            fontTransparency: 1,
            backgroundColor: '#000000',
            backgroundTransparency: 0,
            borderColor: '#000000',
            borderTransparency: 0,
            timerColor: '#008000',
            textBorderColor: '#000000',
            textBorderIntensity: 1,
            textGlowColor: '#000000',
            textGlowIntensity: 1,
            groupMinWidth: 200,
            hideTargetLabel: false,
        }, overrides );
    }
}

import { Component, ElementRef, HostListener, Inject, NgZone, OnInit, ViewChild } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActionTypes, CharacterModel, DpsMeterSettings, OverlayWindowModel, Rectangle, SettingsKeys, TriggerAction } from 'src/app/core.model';
import { IpcService } from 'src/app/ipc.service';
import { customAlphabet } from 'nanoid';
import { forkJoin, Observable, of } from 'rxjs';
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const nanoid = customAlphabet( alphabet, 16 );

const recentDays = 60;
const previewMaxWidth = 820;
const previewMaxHeight = 300;
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

export interface SetupPreviewDisplay {
    id: number;
    name: string;
    left: number;
    top: number;
    width: number;
    height: number;
    bounds: Electron.Rectangle;
}

export interface SetupPreviewBox {
    overlay: OverlayWindowModel;
    display: SetupPreviewDisplay;
    kind: 'timer' | 'text';
    left: number;
    top: number;
    width: number;
    height: number;
}

@Component( {
    selector: 'app-setup-wizard',
    templateUrl: 'setup-wizard.component.html',
    styleUrls: [ 'setup-wizard.component.scss' ]
} )
export class SetupWizardComponent implements OnInit {

    public readonly stepLabels: string[] = [ 'Your characters', 'Place your overlays', 'Try it', 'Extras' ];
    public step: number = 0;
    public busy: boolean = false;

    public scanning: boolean = true;
    public scanFolder: string = null;
    public characterOptions: SetupCharacterOption[] = [];

    public previewBoxes: SetupPreviewBox[] = [];
    public previewDisplays: SetupPreviewDisplay[] = [];
    public previewHeight: number = 0;
    public previewWidth: number = 0;
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
    private _displayId: number = null;
    private _displayOrigin: { x: number, y: number } = { x: 0, y: 0 };
    private _previewOrigin: { x: number, y: number } = { x: 0, y: 0 };
    private _scale: number = 1;

    private _fctOutId: string;
    private _fctInId: string;
    private _detrimentalId: string;
    private _benficialId: string;
    private _alertId: string;
    private _createdDetrimental: boolean = false;
    private _movedIds: Set<string> = new Set<string>();
    private _drag: { box: SetupPreviewBox, startX: number, startY: number, originLeft: number, originTop: number } = null;

    @ViewChild( 'fileSelector' ) private fileSelector: ElementRef<HTMLInputElement>;

    constructor(
        public dialogRef: MatDialogRef<SetupWizardComponent>,
        @Inject( MAT_DIALOG_DATA ) public data: {},
        private ipcService: IpcService,
        private snackBar: MatSnackBar,
        private ngZone: NgZone ) {
        
    }

    ngOnInit() {

        this.ipcService.getPrimaryDisplay().subscribe( display => {
            this._displaySize = { width: display.size.width, height: display.size.height };
            this._displayId = display.id;
            this._displayOrigin = { x: display.bounds?.x ?? 0, y: display.bounds?.y ?? 0 };
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

    startDrag( event: MouseEvent, box: SetupPreviewBox ): void {
        event.preventDefault();
        this._drag = { box: box, startX: event.clientX, startY: event.clientY, originLeft: box.left, originTop: box.top };
    }

    nudge( event: Event, box: SetupPreviewBox, dx: number, dy: number ): void {
        event.preventDefault();
        box.left += dx * 4;
        box.top += dy * 4;
        this._movedIds.add( box.overlay.overlayId );
        this.settleBox( box );
    }

    @HostListener( 'document:mousemove', [ '$event' ] )
    onMouseMove( event: MouseEvent ): void {
        if ( this._drag ) {
            const box = this._drag.box;
            box.left = this.clamp( this._drag.originLeft + event.clientX - this._drag.startX, 0, this.previewWidth - box.width );
            box.top = this.clamp( this._drag.originTop + event.clientY - this._drag.startY, 0, this.previewHeight - box.height );
            this._movedIds.add( box.overlay.overlayId );
        }
    }

    @HostListener( 'document:mouseup' )
    onMouseUp(): void {
        if ( this._drag ) {
            this.settleBox( this._drag.box );
        }
        this._drag = null;
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

    private clamp( value: number, min: number, max: number ): number {
        return Math.round( Math.max( min, Math.min( max, value ) ) );
    }

    /**
     * Loads the default overlays and lays them out on a scaled map of all displays.
     *
     * @param done Called once the boxes are ready.
     */
    private loadPreview( done: () => void ): void {
        this._movedIds.clear();

        this.ipcService.getAllDisplays().subscribe( displays => {
            const hasDisplays = displays?.length > 0;
            const list: Electron.Rectangle[] = hasDisplays
                ? displays.map( d => d.bounds )
                : [ { x: this._displayOrigin.x, y: this._displayOrigin.y, width: this._displaySize.width, height: this._displaySize.height } ];
            const ids: number[] = hasDisplays ? displays.map( d => d.id ) : [ this._displayId ];

            const minX = Math.min( ...list.map( r => r.x ) );
            const minY = Math.min( ...list.map( r => r.y ) );
            const totalWidth = Math.max( ...list.map( r => r.x + r.width ) ) - minX;
            const totalHeight = Math.max( ...list.map( r => r.y + r.height ) ) - minY;

            this._scale = Math.min( previewMaxWidth / totalWidth, previewMaxHeight / totalHeight );
            this._previewOrigin = { x: minX, y: minY };
            this.previewWidth = Math.round( totalWidth * this._scale );
            this.previewHeight = Math.round( totalHeight * this._scale );
            this.previewDisplays = list.map( ( r, i ) => <SetupPreviewDisplay>{
                id: ids[ i ],
                name: ids.length > 1 ? `Display ${i + 1}${ids[ i ] === this._displayId ? ' (main)' : ''}` : 'Main display',
                left: Math.round( ( r.x - minX ) * this._scale ),
                top: Math.round( ( r.y - minY ) * this._scale ),
                width: Math.round( r.width * this._scale ),
                height: Math.round( r.height * this._scale ),
                bounds: r,
            } );

            this.ipcService.getOverlayWindows().subscribe( overlays => {
                const overlayIds = [ this._detrimentalId, this._benficialId, this._alertId ];

                this.previewBoxes = overlayIds.map( id => overlays?.find( o => o.overlayId === id ) )
                    .filter( overlay => overlay != null )
                    .map( overlay => <SetupPreviewBox>{
                        overlay: overlay,
                        display: null,
                        kind: overlay.overlayType === 'Alert' ? 'text' : 'timer',
                        left: this.clamp( ( overlay.x - minX ) * this._scale, 0, this.previewWidth ),
                        top: this.clamp( ( overlay.y - minY ) * this._scale, 0, this.previewHeight ),
                        width: Math.max( 40, Math.round( overlay.windowWidth * this._scale ) ),
                        height: Math.max( 24, Math.round( overlay.windowHeight * this._scale ) ),
                    } );

                this.previewBoxes.forEach( box => this.settleBox( box ) );

                done();
            } );
        } );
    }

    /**
     * Puts the box fully inside the display its center is on, or the closest one.
     *
     * @param box The box to settle.
     */
    private settleBox( box: SetupPreviewBox ): void {
        const centerX = box.left + box.width / 2;
        const centerY = box.top + box.height / 2;
        const distance = ( d: SetupPreviewDisplay ) => {
            const dx = Math.max( d.left - centerX, 0, centerX - ( d.left + d.width ) );
            const dy = Math.max( d.top - centerY, 0, centerY - ( d.top + d.height ) );
            return dx * dx + dy * dy;
        };
        const display = this.previewDisplays.reduce( ( best, d ) => distance( d ) < distance( best ) ? d : best, this.previewDisplays[ 0 ] );

        box.display = display;
        box.left = this.clamp( box.left, display.left, Math.max( display.left, display.left + display.width - box.width ) );
        box.top = this.clamp( box.top, display.top, Math.max( display.top, display.top + display.height - box.height ) );
    }

    /**
     * Saves the moved overlays and the timer grouping choice.
     */
    private persistPreview(): Observable<any> {
        const updates: Observable<any>[] = [];

        this.previewBoxes.forEach( box => {
            const overlay = box.overlay;
            let changed = false;

            if ( this._movedIds.has( overlay.overlayId ) ) {
                overlay.x = Math.round( box.left / this._scale ) + this._previewOrigin.x;
                overlay.y = Math.round( box.top / this._scale ) + this._previewOrigin.y;
                overlay.displayId = box.display.id;
                overlay.displayBounds = box.display.bounds;
                changed = true;
            }

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

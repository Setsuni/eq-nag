import { Component, OnInit, HostListener } from '@angular/core';
import { IpcService } from 'src/app/ipc.service';
import { OverlayWindowModel, TriggerAction, TimerSortTypes, StylePropertiesModel } from 'src/app/core.model';
import { ActivatedRoute } from '@angular/router';
import { ThemePalette } from '@angular/material/core';
import { AbstractControl, FormControl } from '@angular/forms';
import { ColorUtility, Color } from '../../utilities';
import { canSendOverlayTest, sendOverlayTest } from 'src/app/overlays/overlay-test';
import { MonitorSelectDialogComponent } from '../monitor-select-dialog/monitor-select-dialog.component';
import { MatDialog } from '@angular/material/dialog';
import { DialogService } from '../dialog.service';
// import { Color } from '@angular-material-components/color-picker';
// import { NgForm } from '@angular/forms';

const availableFonts = {
    'Roboto': [ 100, 300, 400, 500, 700, 900 ],
    'Red Rose': [ 300, 400, 700 ],
    'Oswald': [ 200, 300, 400, 500, 600, 700 ],
    'Roboto Mono': [ 100, 200, 300, 400, 500, 600, 700 ],
    'Open Sans Condensed': [ 300, 700 ],
    'Ranchers': [ 400 ],
    'Press Start 2P': [ 400 ],
};
// <!-- Roboto(i): 100, 300, 400, 500, 700, 900 -->
// <!-- Red Rose: 300, 400, 700 -->
// <!-- Oswald: 200, 300, 400, 500, 600, 700 -->
// <!-- Roboto Mono (i): 100, 200, 300, 400, 500, 600, 700 -->
// <!-- Open Sans Condensed: 300(i), 700 -->
// <!-- Ranchers: 400 -->
// <!-- Press Start 2P: 400 -->

@Component( {
    selector: 'app-overlay-editor-dialog',
    templateUrl: 'overlay-editor-dialog.component.html',
    styleUrls: [ 'overlay-editor-dialog.component.scss', '../../core.scss', '../../modal.scss' ],
} )
export class OverlayEditorDialogComponent implements OnInit {

    public model: OverlayWindowModel;
    public phraseTableColumns = [ 'number', 'phrase', 'regEx', 'delete' ];
    public overlayId: string = null;
    public fontWeightIndex: number = 0;
    public dotGroupHeaderWeightIndex: number = 0;
    public color: ThemePalette = 'primary';
    public fontColor: Color = new Color( 255, 255, 255, 1 );
    public fontTransparency: number = 100;
    public backgroundTransparency: number = 0;
    public borderTransparency: number = 0;
    public _noChangesModel: OverlayWindowModel;
    public timerSortTypes: typeof TimerSortTypes = TimerSortTypes;
    public textBorderIntensity: number = 100;
    public textBorderColor: string = '#000000';
    public textGlowIntensity: number = 100;
    public textGlowColor: string = '#000000';
    public enterDescription: boolean;
    public showColoredBackground: boolean = false;
    private _baseline: string = null;
    
    public get maxFontWeightIndex(): number {
        if ( this.model?.fontFamily != null ) {
            return availableFonts[ this.model.fontFamily ].length - 1;
        } else {
            return 1;
        }
    }

    public get fontWeight(): string {
        if ( this.fontWeightIndex >= 0 ) {
            return `${availableFonts[ this.model.fontFamily ][ this.fontWeightIndex ]}`;
        } else {
            return null;
        }
    }

    public get textShadow(): string {
        let shdw = null;
        if ( this.model.showTextBorder && this.textBorderColor ) {
            let textBorderColor = ColorUtility.FromHex( this.textBorderColor ).toHexString( this.model.textBorderIntensity );
            shdw = shdw ? shdw : '';
            shdw += `0px 0px 1px ${textBorderColor}, -1px -1px 0 ${textBorderColor}, 1px -1px 0 ${textBorderColor}, -1px 1px 0 ${textBorderColor}, 1px 1px 0 ${textBorderColor}`;
        }

        if ( this.model.showTextGlow && this.textGlowColor && this.textGlowIntensity ) {
            let textGlowColor = ColorUtility.FromHex( this.textGlowColor ).toHexString( this.model.textGlowIntensity );
            shdw = shdw ? shdw + ',' : '';
            shdw += `0px 0px ${this.model.textGlowSize}px ${textGlowColor}, -1px -1px ${this.model.textGlowSize}px ${textGlowColor}, 1px -1px ${this.model.textGlowSize}px ${textGlowColor}, -1px 1px ${this.model.textGlowSize}px ${textGlowColor}, 1px 1px ${this.model.textGlowSize}px ${textGlowColor}`;
        }
        
        return shdw;
    }

    public get backgroundColor(): string {
        if ( this.backgroundTransparency > 0 && this.model.backgroundColor ) {
            let backgroundColor = ColorUtility.FromHex( this.model.backgroundColor ).toHexString( this.backgroundTransparency / 100 );
            return backgroundColor;
        } else {
            return null;
        }
    }

    public get border(): string {
        if ( this.borderTransparency > 0 && this.model.borderColor ) {
            let borderColor = ColorUtility.FromHex( this.model.borderColor ).toHexString( this.borderTransparency / 100 );
            return `3px solid ${borderColor}`;
        } else {
            return null;
        }
    }

    public get lineHeight(): string {
        return `${( this.model.lineHeight > 10 ? this.model.lineHeight : 90 ) / 100}em`;
    }

    public get previewFontColor(): string {
        if ( this.fontTransparency > 0 ) {
            return ColorUtility.FromHex( this.model.fontColor ).toHexString( this.fontTransparency / 100 );
        } else {
            return this.model.fontColor;
        }
        
    }

    public readonly sampleTimers = [
        { name: 'Dot 01', percent: 85, time: '0:41' },
        { name: 'Dot 02', percent: 55, time: '0:16' },
        { name: 'Dot 03', percent: 25, time: '0:13' },
    ];

    public get previewVerticalAlign(): string {
        switch ( this.model.verticalAlignment ) {
            case 'top': return 'flex-start';
            case 'bottom': return 'flex-end';
            default: return 'center';
        }
    }

    public get previewTimerBackground(): string {
        return this.model.timerColor?.length > 0 ? ColorUtility.FromHex( this.model.timerColor ).darken( 0.93 ).toString( 0.75 ) : null;
    }

    public get previewGroupHeaderSize(): number {
        return Math.min( this.model.groupHeaderSize, 24 );
    }

    public get canSendTest(): boolean {
        return canSendOverlayTest( this.model.overlayType );
    }

    public get typeLabel(): string {
        switch ( this.model.overlayType ) {
            case 'Timer': return 'Timer overlay';
            case 'Alert': return 'Text overlay';
            case 'FCT': return 'Floating combat text overlay';
            case 'Log': return 'Debug log overlay';
            default: return 'Overlay';
        }
    }

    public get typeClass(): string {
        switch ( this.model.overlayType ) {
            case 'Timer': return 'type-timer';
            case 'Alert': return 'type-text';
            case 'FCT': return 'type-fct';
            default: return '';
        }
    }

    public get typeDescription(): string {
        switch ( this.model.overlayType ) {
            case 'Timer': return 'Shows countdown bars from Timer, Countdown and DoT actions. The type is chosen when the overlay is created and cannot be changed.';
            case 'Alert': return 'Shows the text from Display Text actions. The type is chosen when the overlay is created and cannot be changed.';
            case 'FCT': return 'Shows floating combat text, such as damage and healing numbers. The type is chosen when the overlay is created and cannot be changed.';
            default: return 'The type is chosen when the overlay is created and cannot be changed.';
        }
    }

    @HostListener( 'window:beforeunload' ) doSomething() {
        this.ipcService.disableOverlayEditMode( this.overlayId );
    }

    constructor( private ipcService: IpcService, private route: ActivatedRoute, private dialog: MatDialog, private dialogService: DialogService ) { }

    ngOnInit() {
        this.model = new OverlayWindowModel();

        this.route.params.subscribe( params => {
            
            this.overlayId = params[ 'id' ];

            if ( this.overlayId != null ) {
                this.ipcService.getOverlayWindow( this.overlayId ).subscribe( overlay => {
                    
                    this.ipcService.enableOverlayEditMode( this.overlayId );
                    this._noChangesModel = Object.assign( new OverlayWindowModel(), overlay );
                    this.model = overlay;
                    this.enterDescription = this.model.description?.length > 0;

                    this.model.fontFamily = this.model.fontFamily ? this.model.fontFamily : 'Roboto';
                    this.model.fontSize = this.model.fontSize > 0 ? this.model.fontSize : 14;
                    this.model.lineHeight = this.model.lineHeight > 0 ? this.model.lineHeight : 90;
                    this.model.fontWeight = this.model.fontWeight > 100 ? this.model.fontWeight : 400;
                    this.fontWeightIndex = availableFonts[ this.model.fontFamily ].indexOf( this.model.fontWeight );
                    this.fontTransparency = Math.round( this.model.fontTransparency * 100 );
                    this.backgroundTransparency = Math.round( this.model.backgroundTransparency * 100 );
                    this.borderTransparency = Math.round( this.model.borderTransparency * 100 );
                    this.textBorderColor = ColorUtility.FromHex( this.model.textBorderColor ).toHexString( 1 );
                    this.textGlowColor = ColorUtility.FromHex( this.model.textGlowColor ).toHexString( 1 );
                    this.textBorderIntensity = ColorUtility.FromHex( this.model.textBorderColor ).a * 100;
                    this.textGlowIntensity = ColorUtility.FromHex( this.model.textGlowColor ).a * 100;
                    this.dotGroupHeaderWeightIndex = availableFonts[ this.model.fontFamily ].indexOf( this.model.groupHeaderWeight );
                    window.setTimeout( () => this._baseline = JSON.stringify( this.model ) );
                } );

                this.ipcService.overlayBoundsChanged().subscribe( e => {
                    if ( e.overlayId === this.overlayId ) {
                        this.model.x = e.bounds.x;
                        this.model.y = e.bounds.y;
                        this.model.windowWidth = e.bounds.width;
                        this.model.windowHeight = e.bounds.height;
                        this.model.displayBounds = e.displayBounds;
                        this.model.displayId = e.displayId;
                    }
                } );
            }
     
        } );
        
    }









    
    /**
     * Sets the font family and broadcasts the model.
     */
    public onChangeFontFamily(): void {
        let fi: number = availableFonts[ this.model.fontFamily ].indexOf( this.model.fontWeight );
        this.fontWeightIndex = -1;
        this.dotGroupHeaderWeightIndex = -1;

        if ( fi > -1 ) {
            this.fontWeightIndex = fi;
            this.dotGroupHeaderWeightIndex = fi;
        } else {

            for ( let i = 100; i < 500; i += 100 ) {
                let lfi: number = availableFonts[ this.model.fontFamily ].indexOf( this.model.fontWeight - i );
                let ufi: number = availableFonts[ this.model.fontFamily ].indexOf( this.model.fontWeight + i );
                if ( lfi > -1 ) {
                    this.fontWeightIndex = lfi;
                    this.dotGroupHeaderWeightIndex = lfi;
                    break;
                } else if ( ufi > -1 ) {
                    this.fontWeightIndex = ufi;
                    this.dotGroupHeaderWeightIndex = ufi;
                    break;
                }
            }
            
        }

        this.fontWeightIndex = this.fontWeightIndex > -1 ? this.fontWeightIndex : 0;
        this.dotGroupHeaderWeightIndex = this.dotGroupHeaderWeightIndex > -1 ? this.dotGroupHeaderWeightIndex : 0;

        this.broadcastModel();
    }









    
    /**
     * Sets the font border intensity and broadcasts the model.
     */
    public onChangeTextBorderIntensity(): void {
        this.model.textBorderIntensity = this.textBorderIntensity / 100;
        this.broadcastModel();
    }









    
    /**
     * Sets the text glow intensity and broadcasts the model.
     */
    public onChangeTextGlowIntensity(): void {
        this.model.textGlowIntensity = this.textGlowIntensity / 100;
        this.broadcastModel();
    }









    
    /**
     * Sets the font transparency and broadcasts the model.
     */
    public onChangeFontTransparency(): void {
        this.model.fontTransparency = this.fontTransparency / 100;
        this.broadcastModel();
    }









    
    /**
     * Sets the background transparency and broadcasts the model.
     */
    public onChangeBackgroundTransparency(): void {
        this.model.backgroundTransparency = this.backgroundTransparency / 100;
        this.broadcastModel();
    }









    
    /**
     * Sets the border transparency and broadcasts the model.
     */
    public onChangeBorderTransparency(): void {
        this.model.borderTransparency = this.borderTransparency / 100;
        this.broadcastModel();
    }









    
    /**
     * Sets the font color and broadcasts the model.
     */
    public onChangeFontColor(): void {
        this.model.fontColor = this.fontColor.toHex();
        this.broadcastModel();
    }









    
    /**
     * Broadcasts the model to the overlay.
     */
    public broadcastModel(): void {
        this.model.fontWeight = availableFonts[ this.model.fontFamily ][ this.fontWeightIndex ];
        this.model.groupHeaderWeight = availableFonts[ this.model.fontFamily ][ this.dotGroupHeaderWeightIndex ];
        this.model.textBorderColor = ColorUtility.FromHex( this.textBorderColor ).toHexString( this.model.textBorderIntensity );
        this.model.textGlowColor = ColorUtility.FromHex( this.textGlowColor ).toHexString( this.model.textGlowIntensity );
        this.ipcService.broadcastOverlayModel( this.model );
    }
    








    
    /**
     * Broadcasts the model to the overlay.
     * 
     * @param style The style that changed.
     */
    public styleChange( style: StylePropertiesModel ) {
        // TODO: Wat?
        this.broadcastModel();
    }









    
    public get hasUnsavedChanges(): boolean {
        return this._baseline != null && JSON.stringify( this.model ) !== this._baseline;
    }

    /**
     * Cancels the overlay editor, asking first when there are unsaved changes.
     */
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
                    this.cancel();
                }
            } );
    }

    /**
     * Cancels the overlay editor, reverting any changes made.
     */
    public cancel(): void {
        this.ipcService.updateOverlayWindow( this._noChangesModel ).subscribe( success => { } );
        this.closeModal();
    }









    
    /**
     * Closes the modal.
     */
    public closeModal(): void {
        this.ipcService.closeThisChild();
    }









    
    /**
     * Saves the overlay.
     */
    public save(): void {
        if ( this.overlayId == null ) {
            this.closeModal();
        } else {
            if ( this.model.timerColor?.length > 0 ) {
                this.model.timerBackgroundColor = ColorUtility.FromHex( this.model.timerColor ).darken( 0.93 ).toString( 0.75 );
            }
            this.ipcService.updateOverlayWindow( this.model ).subscribe( success => { } );
            this.closeModal();
        }
    }









    
    /**
     * Sends the overlay to the origin of the user selected display.
     */
    sendToOrigin() {
        this.dialog.open<MonitorSelectDialogComponent, any, number|null>( MonitorSelectDialogComponent, {
            width: '750px',
            data: {
                message: [ 'Select which monitor to move this overlay to.' ],
                displayId: this.model.displayId ?? null,
            },
            panelClass: 'app-dialog',
        } ).afterClosed().subscribe( displayId => {
            if ( displayId !== null ) {
                window.api.logger.info( `[OverlayEditor:sendToOrigin] Sending overlay ${this.overlayId} to display ${displayId}` );
                this.ipcService.sendOverlayToOrigin( this.overlayId, displayId );
            }
        } );
    }
    








    
    /**
     * Sends a test display text to the overlay.
     */
    public sendDisplayTextTest(): void {
        sendOverlayTest( this.ipcService, this.model );
    }










}

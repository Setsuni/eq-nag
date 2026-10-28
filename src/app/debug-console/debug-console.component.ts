import { Component, DoCheck, ElementRef, HostListener, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { IpcService } from '../ipc.service';
import * as _ from 'lodash-es';
import { ConsoleListComponent } from './console-list.component';

@Component( {
    selector: 'app-debug-console',
    templateUrl: 'debug-console.component.html',
    styleUrls: [ 'debug-console.component.scss' ],
} )
export class DebugConsoleComponent implements OnInit, OnDestroy, DoCheck {

    private static readonly collapsedHeight: number = 24;
    private static readonly minHeight: number = 50;
    private static readonly maxHeightRatio: number = 0.8;

    private _show: boolean = DebugConsoleComponent.loadOpen();
    public get show(): boolean {
        return this._show;
    }
    public set show( value: boolean ) {
        this._show = value;
        DebugConsoleComponent.store( 'nagConsoleOpen', value ? 'true' : 'false' );
    }
    public showInput: boolean = true;
    public consoleCommand: string | undefined = undefined;
    public showTriggerHistory: boolean = false;
    public characterId: string = null;
    // public parseType: 'successful' | 'failed' = 'successful';
    public searchText: string = null;
    public characterOptions: { id: string, name: string, server: string }[] = [];
    private _atBottom: boolean = true;
    public get atBottom(): boolean {
        return this._atBottom;
    }
    public get showBottomTools(): boolean {
        return !this.atBottom;
    }

    @ViewChild( 'consoleList', { static: false } ) consoleList: ConsoleListComponent;
    private _container: ElementRef<HTMLDivElement>;
    private _resizeObserver: ResizeObserver;
    private _savedHeight: number | null = null;
    @ViewChild( 'container', { static: false } ) set container( value: ElementRef<HTMLDivElement> ) {
        this._resizeObserver?.disconnect();
        this._container = value;

        if ( value?.nativeElement ) {
            let savedHeight = DebugConsoleComponent.loadHeight();
            if ( savedHeight ) {
                value.nativeElement.style.height = `${savedHeight}px`;
            }

            this.publishHeight( value.nativeElement.offsetHeight );
            this.ngZone.runOutsideAngular( () => {
                this._resizeObserver = new ResizeObserver( () => this.publishHeight( value.nativeElement.offsetHeight ) );
                this._resizeObserver.observe( value.nativeElement );
            } );
        } else {
            this.publishHeight( DebugConsoleComponent.collapsedHeight );
        }
    }
    get container(): ElementRef<HTMLDivElement> {
        return this._container;
    }
    
    @HostListener( 'document:keyup', [ '$event' ] ) onKeydownHandler( event: KeyboardEvent ) {
        if ( event.key === 'F12' ) {
            this.show = !this.show;
        }
    }

    public scrolling: boolean = false;

    private readonly _mouseupListener = () => this.onMouseupHandler();

    private onMouseupHandler() {
        if ( this.container?.nativeElement ) {
            let height = this.container.nativeElement.offsetHeight;
            if ( height !== this._savedHeight ) {
                this._savedHeight = height;
                DebugConsoleComponent.store( 'nagConsoleHeight', `${height}` );
            }
        }
    }

    @HostListener( 'wheel', [ '$event' ] ) onScroll( event: Event ) {
        if ( !this.container?.nativeElement ) {
            return;
        }

        if ( this.container.nativeElement.scrollTop >= this.container.nativeElement.scrollHeight - this.container.nativeElement.offsetHeight ) {
            this.scrolling = false;
        } else {
            this.scrolling = true;
        }
        
    }

    constructor(
        private readonly ipcService: IpcService,
        private readonly ngZone: NgZone,
    ) { }

    ngOnInit() {
        this.ngZone.runOutsideAngular( () => document.addEventListener( 'mouseup', this._mouseupListener ) );

        this.ipcService.getCharacters().subscribe( options => {
            this.characterOptions = _.orderBy( options.map( x => ( { id: x.characterId, name: x.name, server: x.server } ) ), [ 'server', 'name' ] );
        } );

    }

    ngOnDestroy() {
        document.removeEventListener( 'mouseup', this._mouseupListener );
        this._resizeObserver?.disconnect();
        document.documentElement.style.removeProperty( '--nag-console-height' );
    }

    ngDoCheck(): void {
        if ( this.container?.nativeElement ) {
            this._atBottom = this.container.nativeElement.scrollTop >= this.container.nativeElement.scrollHeight - this.container.nativeElement.offsetHeight;
        }
    }










    /**
     * Publishes the height the console currently occupies at the bottom of the window.
     *
     * @param height The height in pixels.
     */
    private publishHeight( height: number ): void {
        document.documentElement.style.setProperty( '--nag-console-height', `${height}px` );
    }









    /**
     * Returns the persisted open state of the console.
     */
    private static loadOpen(): boolean {
        try {
            return localStorage.getItem( 'nagConsoleOpen' ) === 'true';
        } catch ( error ) {
            return false;
        }
    }









    /**
     * Returns the persisted console height clamped to the allowed range, or null when none is stored.
     */
    private static loadHeight(): number | null {
        try {
            let height = parseInt( localStorage.getItem( 'nagConsoleHeight' ), 10 );
            if ( isNaN( height ) ) {
                return null;
            }

            return Math.max( DebugConsoleComponent.minHeight, Math.min( height, window.innerHeight * DebugConsoleComponent.maxHeightRatio ) );
        } catch ( error ) {
            return null;
        }
    }









    /**
     * Stores a value in local storage, ignoring failures.
     *
     * @param key The storage key.
     * @param value The value to store.
     */
    private static store( key: string, value: string ): void {
        try {
            localStorage.setItem( key, value );
        } catch ( error ) {
        }
    }









    /**
     * Sends the entered console command to the server.
     */
    sendConsoleCommand(): void {
        if ( this.consoleCommand ) {
            this.ipcService.sendConsoleCommand( this.consoleCommand );
            this.consoleCommand = undefined;
        }
    }









    
    /**
     * Clears all trigger history.
     */
    public clear() {
        this.ipcService.clearTriggerHistory();
        this.consoleList.clear();
    }









    
    /**
     * Changes the view back to the full history.
     */
    public hideTriggerHistory() {
        this.consoleList.hideTriggerHistory();
    }









    
    /**
     * Opens the trigger editor dialog.
     */
    public showEditTriggerDialog() {
        this.consoleList.showEditTriggerDialog();
    }









    
    /**
     * Filters the console list by the given parse type.
     * 
     * @param parseType The type of parse to show.
     */
    public setParseType( parseType: 'successful' | 'failed' ) {
        this.consoleList.setParseType( parseType );
    }









    
    /**
     * Scrolls to the bottom of the console when the list is updated.
     */
    public onListUpdated( scrollBottom: boolean ): void {
        if ( scrollBottom ) {
            if ( !this.scrolling && this.container?.nativeElement ) {
                this.container.nativeElement.scrollTop = this.container.nativeElement.scrollHeight;
            }
        }
    }










    /**
     * Scrolls to the bottom of the console and sets the scrolling flag to false.
     */
    public scrollToBottom(): void {
        this.scrolling = false;
        this.container.nativeElement.scrollTop = this.container.nativeElement.scrollHeight;
    }









    
}

import { Component, ElementRef, EventEmitter, Input, OnInit, Output, ViewChild } from '@angular/core';
import { OverlayWindowModel } from '../../core.model';
import { IpcService } from '../../ipc.service';

interface MapDisplay {
    id: number;
    label: string;
    bounds: Electron.Rectangle;
    size: Electron.Size;
}

interface MapBox {
    overlay: OverlayWindowModel;
    display: MapDisplay;
    x: number;
    y: number;
    width: number;
    height: number;
}

const defaultOverlayWidth = 500;
const defaultOverlayHeight = 400;
const dragThreshold = 3;

@Component( {
    selector: 'app-overlay-map',
    templateUrl: 'overlay-map.component.html',
    styleUrls: [ 'overlay-map.component.scss' ],
} )
export class OverlayMapComponent implements OnInit {

    @ViewChild( 'mapArea' ) public mapArea: ElementRef<HTMLElement>;

    @Input() public selectedOverlayId: string = null;
    @Output() public overlaySelected: EventEmitter<string> = new EventEmitter<string>();
    @Output() public overlayMoved: EventEmitter<{ overlayId: string, displayId: number, x: number, y: number }> = new EventEmitter<{ overlayId: string, displayId: number, x: number, y: number }>();

    public displays: MapDisplay[] = [];
    public space: Electron.Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
    public boxes: MapBox[] = [];
    public dragId: string = null;

    private _overlays: OverlayWindowModel[] = [];
    private dragStart: { pointerX: number, pointerY: number, boxX: number, boxY: number, moved: boolean } = null;
    private dragOffset: { x: number, y: number } = { x: 0, y: 0 };

    @Input() public set overlays( value: OverlayWindowModel[] ) {
        this._overlays = value ?? [];
        this.buildBoxes();
    }

    public get ratio(): number {
        return this.space.width / this.space.height;
    }

    constructor( private readonly ipcService: IpcService ) { }

    ngOnInit() {
        this.ipcService.getAllDisplays().subscribe( displays => {
            const primary = displays.find( d => d.bounds.x === 0 && d.bounds.y === 0 );
            this.displays = displays.map( ( d, i ) => ( {
                id: d.id,
                label: `Monitor ${i + 1}${d === primary ? ' (main)' : ''}`,
                bounds: d.bounds,
                size: d.size,
            } ) );

            if ( this.displays.length > 0 ) {
                const left = Math.min( ...this.displays.map( d => d.bounds.x ) );
                const top = Math.min( ...this.displays.map( d => d.bounds.y ) );
                const right = Math.max( ...this.displays.map( d => d.bounds.x + d.bounds.width ) );
                const bottom = Math.max( ...this.displays.map( d => d.bounds.y + d.bounds.height ) );
                this.space = { x: left, y: top, width: right - left, height: bottom - top };
            }
            this.buildBoxes();
        } );
    }

    /**
     * The css class for the colour of an overlay type.
     *
     * @param overlayType The overlay type value.
     */
    public typeClass( overlayType: string ): string {
        switch ( overlayType ) {
            case 'Timer': return 'type-timer';
            case 'Alert': return 'type-text';
            case 'FCT': return 'type-fct';
            default: return 'type-other';
        }
    }

    /**
     * Position and size of a box, as a percentage of the map.
     *
     * @param box The box to measure.
     */
    public left( box: MapBox ): number {
        return ( box.display.bounds.x + box.x + this.dragOffsetFor( box ).x - this.space.x ) / this.space.width * 100;
    }

    public top( box: MapBox ): number {
        return ( box.display.bounds.y + box.y + this.dragOffsetFor( box ).y - this.space.y ) / this.space.height * 100;
    }

    public width( box: MapBox ): number {
        return box.width / this.space.width * 100;
    }

    public height( box: MapBox ): number {
        return box.height / this.space.height * 100;
    }

    public onPointerDown( event: PointerEvent, box: MapBox ): void {
        if ( event.button !== 0 ) {
            return;
        }
        ( event.currentTarget as HTMLElement ).setPointerCapture( event.pointerId );
        this.dragId = box.overlay.overlayId;
        this.dragOffset = { x: 0, y: 0 };
        this.dragStart = { pointerX: event.clientX, pointerY: event.clientY, boxX: box.display.bounds.x + box.x, boxY: box.display.bounds.y + box.y, moved: false };
        this.overlaySelected.emit( box.overlay.overlayId );
        event.preventDefault();
    }

    public onPointerMove( event: PointerEvent ): void {
        if ( this.dragStart == null ) {
            return;
        }
        const scale = this.scale();
        const dx = event.clientX - this.dragStart.pointerX;
        const dy = event.clientY - this.dragStart.pointerY;
        if ( !this.dragStart.moved && Math.abs( dx ) < dragThreshold && Math.abs( dy ) < dragThreshold ) {
            return;
        }
        this.dragStart.moved = true;
        this.dragOffset = { x: dx / scale, y: dy / scale };
    }

    public onPointerUp( event: PointerEvent, box: MapBox ): void {
        const start = this.dragStart;
        this.dragStart = null;
        this.dragId = null;
        const offset = this.dragOffset;
        this.dragOffset = { x: 0, y: 0 };

        if ( start == null || !start.moved ) {
            return;
        }

        const absX = start.boxX + offset.x;
        const absY = start.boxY + offset.y;
        const centerX = absX + box.width / 2;
        const centerY = absY + box.height / 2;
        const target = this.displays.find( d => centerX >= d.bounds.x && centerX < d.bounds.x + d.bounds.width && centerY >= d.bounds.y && centerY < d.bounds.y + d.bounds.height ) ?? box.display;

        const x = Math.min( Math.max( 0, absX - target.bounds.x ), Math.max( 0, target.size.width - box.width ) );
        const y = Math.min( Math.max( 0, absY - target.bounds.y ), Math.max( 0, target.size.height - box.height ) );

        // Show the box where it landed until the next update arrives.
        box.display = target;
        box.x = x;
        box.y = y;
        box.overlay.displayId = target.id;
        box.overlay.displayBounds = target.bounds;
        box.overlay.x = Math.round( x );
        box.overlay.y = Math.round( y );
        this.overlayMoved.emit( { overlayId: box.overlay.overlayId, displayId: target.id, x: x, y: y } );
    }

    public onPointerCancel(): void {
        this.dragStart = null;
        this.dragId = null;
        this.dragOffset = { x: 0, y: 0 };
    }

    /**
     * Whether another monitor sits right above this one, leaving no room for its label outside.
     * 
     * @param display The monitor to check.
     */
    public labelInside( display: MapDisplay ): boolean {
        const reach = this.space.width * 0.045;
        return this.displays.some( other => other !== display
            && other.bounds.x < display.bounds.x + display.bounds.width
            && other.bounds.x + other.bounds.width > display.bounds.x
            && other.bounds.y + other.bounds.height > display.bounds.y - reach
            && other.bounds.y < display.bounds.y );
    }

    private dragOffsetFor( box: MapBox ): { x: number, y: number } {
        return this.dragId === box.overlay.overlayId ? this.dragOffset : { x: 0, y: 0 };
    }

    /**
     * Rendered pixels per screen pixel.
     */
    private scale(): number {
        const width = this.mapArea?.nativeElement?.clientWidth;
        return width > 0 ? width / this.space.width : 1;
    }

    private buildBoxes(): void {
        if ( this.displays.length === 0 ) {
            this.boxes = [];
            return;
        }
        const primary = this.displays.find( d => d.bounds.x === 0 && d.bounds.y === 0 ) ?? this.displays[ 0 ];
        this.boxes = this._overlays.map( overlay => {
            const display = this.displays.find( d => d.id === overlay.displayId )
                ?? this.displays.find( d => overlay.displayBounds != null && d.bounds.x === overlay.displayBounds.x && d.bounds.y === overlay.displayBounds.y )
                ?? primary;
            return {
                overlay: overlay,
                display: display,
                x: overlay.x ?? 0,
                y: overlay.y ?? 0,
                width: overlay.windowWidth > 0 ? overlay.windowWidth : defaultOverlayWidth,
                height: overlay.windowHeight > 0 ? overlay.windowHeight : defaultOverlayHeight,
            };
        } );
    }

}

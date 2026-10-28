import { Directive, ElementRef, HostListener, Input, NgZone, OnDestroy, OnInit } from '@angular/core';

/**
 * Lets the user resize the pane to the left of the divider by dragging it, double-clicking it to reset
 * or using the left and right arrow keys. The width is kept as a percentage of the row and persisted.
 */
@Directive( { selector: '[nagPaneDivider]' } )
export class PaneDividerDirective implements OnInit, OnDestroy {

    /** The pane that is resized. */
    @Input() paneTarget: HTMLElement;
    /** The pane on the other side of the divider, it takes the remaining width. */
    @Input() paneSibling: HTMLElement;
    /** The smallest width of the resized pane in pixels. */
    @Input() paneMinPx: number = 160;
    /** The smallest width of the sibling pane in pixels. */
    @Input() siblingMinPx: number = 300;
    /** The pane width as a percentage of the row when the divider is reset. */
    @Input() defaultPercent: number = 32;
    /** The width in pixels the pane changes by per arrow key press. */
    @Input() stepPx: number = 16;
    /** The local storage key the pane width is persisted under. */
    @Input() storageKey: string = null;

    /** The target pane width as a percentage of the row. */
    private _percent: number = 32;
    /** The mouse x position where the current drag started. */
    private _dragStartX: number = 0;
    /** The pane width in pixels where the current drag started. */
    private _dragStartWidth: number = 0;

    /** Re-applies the width when the window is resized. */
    private readonly _onWindowResize = () => this.apply();
    /** Resizes the pane while the mouse moves during a drag. */
    private readonly _onDragMove = ( event: MouseEvent ) => this.setWidth( this._dragStartWidth + event.clientX - this._dragStartX );
    /** Finishes the drag when the mouse button is released. */
    private readonly _onDragEnd = () => this.endDrag();

    constructor(
        private readonly el: ElementRef<HTMLElement>,
        private readonly ngZone: NgZone,
    ) { }

    ngOnInit() {
        this._percent = this.load();
        this.apply();
        this.ngZone.runOutsideAngular( () => window.addEventListener( 'resize', this._onWindowResize ) );
    }

    ngOnDestroy() {
        window.removeEventListener( 'resize', this._onWindowResize );
        this.removeDragListeners();
    }

    @HostListener( 'mousedown', [ '$event' ] ) onMouseDown( event: MouseEvent ) {
        if ( event.button !== 0 || this.narrow ) {
            return;
        }

        event.preventDefault();
        this.el.nativeElement.focus();

        this._dragStartX = event.clientX;
        this._dragStartWidth = this.paneTarget.offsetWidth;
        this.el.nativeElement.classList.add( 'dragging' );

        this.ngZone.runOutsideAngular( () => {
            document.addEventListener( 'mousemove', this._onDragMove );
            document.addEventListener( 'mouseup', this._onDragEnd );
        } );
    }

    @HostListener( 'keydown', [ '$event' ] ) onKeydown( event: KeyboardEvent ) {
        if ( event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' ) {
            return;
        }

        event.preventDefault();

        if ( this.narrow ) {
            return;
        }

        let step = event.key === 'ArrowLeft' ? -this.stepPx : this.stepPx;
        this.setWidth( this.paneTarget.offsetWidth + step );
        this.save();
    }

    @HostListener( 'dblclick' ) onDoubleClick() {
        this._percent = this.defaultPercent;
        this.apply();
        this.save();
    }

    /**
     * Returns the stored width percentage, or the default when it is missing or invalid.
     */
    private load(): number {
        try {
            let value = parseFloat( localStorage.getItem( this.storageKey ) );

            if ( isFinite( value ) && value > 0 && value < 100 ) {
                return value;
            }
        } catch ( error ) {
            // Storage is unavailable, use the default.
        }

        return this.defaultPercent;
    }

    /**
     * Stores the width percentage in local storage.
     */
    private save() {
        try {
            localStorage.setItem( this.storageKey, this._percent.toString() );
        } catch ( error ) {
            // Storage is unavailable, the width just will not persist.
        }
    }

    /**
     * Returns the width of the row that holds the panes in pixels.
     */
    private get rowWidth(): number {
        return this.paneTarget.parentElement?.clientWidth ?? 0;
    }

    /**
     * Returns true when the row is too narrow for both minimum widths.
     */
    private get narrow(): boolean {
        let rowWidth = this.rowWidth;

        return rowWidth <= 0 || this.availableWidth( rowWidth ) < this.paneMinPx + this.siblingMinPx;
    }

    /**
     * Returns the width in pixels the panes share, without the divider and the pane margins.
     *
     * @param rowWidth The width of the row in pixels.
     */
    private availableWidth( rowWidth: number ): number {
        // The panes have 3px margins on both sides.
        return rowWidth - this.el.nativeElement.offsetWidth - 12;
    }

    /**
     * Applies the stored percentage to the panes. When the row is too narrow for both minimum widths the
     * panes share the available width proportionally and their minimum widths are dropped.
     */
    private apply() {
        let rowWidth = this.rowWidth;
        let pane = this.paneTarget;

        if ( rowWidth <= 0 ) {
            pane.style.width = `${this._percent}%`;
            return;
        }

        let available = this.availableWidth( rowWidth );
        let narrow = available < this.paneMinPx + this.siblingMinPx;
        let width = narrow ? Math.max( 0, available ) * this._percent / 100 : this.clamp( rowWidth * this._percent / 100, rowWidth );

        pane.style.minWidth = narrow ? '0' : `${this.paneMinPx}px`;
        pane.style.width = `${width}px`;

        if ( this.paneSibling ) {
            this.paneSibling.style.minWidth = narrow ? '0' : `${this.siblingMinPx}px`;
        }

        this.updateAria( width, rowWidth, narrow ? 0 : this.paneMinPx, narrow ? available : available - this.siblingMinPx );
    }

    /**
     * Clamps the pane width in pixels so both panes keep their minimum widths.
     *
     * @param width The desired pane width in pixels.
     * @param rowWidth The width of the row in pixels.
     */
    private clamp( width: number, rowWidth: number ): number {
        return Math.max( this.paneMinPx, Math.min( width, this.availableWidth( rowWidth ) - this.siblingMinPx ) );
    }

    /**
     * Updates the ARIA values with the pane width and its bounds as percentages of the row.
     *
     * @param width The pane width in pixels.
     * @param rowWidth The width of the row in pixels.
     * @param minWidth The smallest pane width in pixels.
     * @param maxWidth The largest pane width in pixels.
     */
    private updateAria( width: number, rowWidth: number, minWidth: number, maxWidth: number ) {
        let divider = this.el.nativeElement;

        divider.setAttribute( 'aria-valuenow', Math.round( width / rowWidth * 100 ).toString() );
        divider.setAttribute( 'aria-valuemin', Math.round( minWidth / rowWidth * 100 ).toString() );
        divider.setAttribute( 'aria-valuemax', Math.round( Math.max( minWidth, maxWidth ) / rowWidth * 100 ).toString() );
    }

    /**
     * Sets the pane width from a pixel value and keeps it as a percentage of the row.
     * Does nothing while the row is too narrow for both minimum widths.
     *
     * @param width The desired pane width in pixels.
     */
    private setWidth( width: number ) {
        let rowWidth = this.rowWidth;

        if ( rowWidth <= 0 || this.availableWidth( rowWidth ) < this.paneMinPx + this.siblingMinPx ) {
            return;
        }

        this._percent = this.clamp( width, rowWidth ) / rowWidth * 100;
        this.apply();
    }

    /**
     * Finishes dragging and stores the width.
     */
    private endDrag() {
        this.removeDragListeners();
        this.el.nativeElement.classList.remove( 'dragging' );
        this.save();
    }

    /**
     * Removes the document listeners used while dragging.
     */
    private removeDragListeners() {
        document.removeEventListener( 'mousemove', this._onDragMove );
        document.removeEventListener( 'mouseup', this._onDragEnd );
    }

}

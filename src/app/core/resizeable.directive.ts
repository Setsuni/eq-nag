import { DOCUMENT } from '@angular/common';
import { Directive, ElementRef, HostListener, Inject, Input, NgZone, OnDestroy, OnInit, Renderer2 } from '@angular/core';

@Directive( {
    selector: '[nagResizeable]',
} )
export class ResizeableDirective implements OnInit, OnDestroy {

    private _dragElement: HTMLDivElement;
    private _resizeObserver: ResizeObserver;
    private _userSelectValue: string | undefined = undefined;

    private _heightMax: number | undefined = undefined;
    private _widthMax: number | undefined = undefined;
    private _maxRatio: number | undefined = undefined;

    @Input('resizeMax') set max( value: number | string ) {

        if ( typeof value === 'string' ) {
            if ( value.indexOf( '%' ) > -1 ) {
                value = parseInt( value.replace( '%', '' ), 10 );
                value = value / 100;

                this._maxRatio = value;
                this.updateMax();

            } else if ( value.indexOf( 'px' ) > -1 ) {
                value = parseInt( value.replace( 'px', '' ), 10 );
                
                this._maxRatio = undefined;
                this._heightMax = value;
                this._widthMax = value;

            } else {
                value = parseInt( value, 10 );

                this._maxRatio = undefined;
                this._heightMax = value;
                this._widthMax = value;

            }
        }

    }

    private _location: 'top' | 'bottom' | 'left' | 'right' = 'top';
    @Input( 'resizeLocation' ) set location( value: 'top' | 'bottom' | 'left' | 'right' ) {
        if ( this._dragElement ) {
            this.renderer.removeChild( this.elementRef.nativeElement, this._dragElement );
        }
        
        this._location = value;

        this.createDragElement();
    }
    get location(): 'top' | 'bottom' | 'left' | 'right' {
        return this._location;
    }
    private _visibility: 'hidden' | 'visible' = 'hidden';
    @Input( 'resizeVisibility' ) set visibility( value: 'hidden' | 'visible' ) {
        
        if ( !this._dragElement ) {
            return;
        }

        this.renderer.setStyle( this._dragElement, 'opacity', value === 'hidden' ? 0 : 1 );

        this._visibility = value;
    }
    public get visibility(): 'hidden' | 'visible' {
        return this._visibility;
    }

    private _dragging: boolean = false;
    @HostListener( 'document:mousedown', [ '$event' ] ) onMousedownHandler( event: MouseEvent ) {
        if ( this._dragging ) {
            return;
        }
        
        if ( event.target === this._dragElement ) {
            this._userSelectValue = this.elementRef.nativeElement.style.userSelect;
            this.elementRef.nativeElement.style.userSelect = 'none';
            this._dragging = true;
            this.updateMax();

            this.ngZone.runOutsideAngular( () => {
                this.document.addEventListener( 'mousemove', this._mousemoveListener );
                this.document.addEventListener( 'mouseup', this._mouseupListener );
            } );
        }
    }

    private readonly _windowResizeListener = () => {
        this.updateMax();
        this.clampToMax();
        this.setPosition();
    };

    private readonly _mouseupListener = () => this.onMouseupHandler();
    private readonly _mousemoveListener = ( event: MouseEvent ) => this.onMousemoveHandler( event );

    private onMouseupHandler() {
        this.removeDragListeners();
        this.elementRef.nativeElement.style.userSelect = this._userSelectValue;
        this._dragging = false;
        this.setPosition();
    }

    private onMousemoveHandler( event: MouseEvent ) {
        if ( !this._dragging ) {
            return;
        }
        
        if ( this._location === 'top' ) {
            this.renderer.setStyle( this.elementRef.nativeElement, 'height', `${this.elementRef.nativeElement.offsetHeight - event.movementY}px` );

            if ( this.elementRef.nativeElement.offsetHeight < 0 ) {
                this.renderer.setStyle( this.elementRef.nativeElement, 'height', `50px` );
            } else if ( this._heightMax > 0 && this.elementRef.nativeElement.offsetHeight > this._heightMax ) {
                this.renderer.setStyle( this.elementRef.nativeElement, 'height', `${this._heightMax}px` );
            }

        } else if ( this._location === 'bottom' ) {
            this.renderer.setStyle( this.elementRef.nativeElement, 'height', `${this.elementRef.nativeElement.offsetHeight + event.movementY}px` );
        } else if ( this._location === 'left' ) {
            this.renderer.setStyle( this.elementRef.nativeElement, 'width', `${this.elementRef.nativeElement.offsetWidth - event.movementX}px` );

            if ( +this.elementRef.nativeElement.offsetWidth > this._widthMax ) {
                this.renderer.setStyle( this.elementRef.nativeElement, 'width', `${this._widthMax}px` );
            }

        } else if ( this._location === 'right' ) {
            this.renderer.setStyle( this.elementRef.nativeElement, 'width', `${this.elementRef.nativeElement.offsetWidth + event.movementX}px` );
        }

    }
    
    constructor(
        private elementRef: ElementRef<HTMLElement>,
        private renderer: Renderer2,
        @Inject( DOCUMENT ) private document: Document,
        private ngZone: NgZone
    ) { }

    ngOnInit() {
        let computedStyle = this.document.defaultView.getComputedStyle( this.elementRef.nativeElement );

        if ( !computedStyle.position || computedStyle.position === 'static' ) {
            this.renderer.setStyle( this.elementRef.nativeElement, 'position', 'relative' );
        }

        this.createDragElement();

        this.ngZone.runOutsideAngular( () => {
            window.addEventListener( 'resize', this._windowResizeListener );
            this._resizeObserver = new ResizeObserver( () => this.setPosition() );
            this._resizeObserver.observe( this.elementRef.nativeElement );
        } );
    }

    ngOnDestroy() {
        window.removeEventListener( 'resize', this._windowResizeListener );
        this.removeDragListeners();
        this._resizeObserver?.disconnect();

        if ( this._dragElement ) {
            this.renderer.removeChild( this.document.body, this._dragElement );
        }
    }

    private createDragElement() {
        // Create the drag element
        this._dragElement = this.renderer.createElement( 'div' );
        this._dragElement.style.userSelect = 'none';

        // Add the classes
        this.renderer.addClass( this._dragElement, 'resize-handle' );
        this.renderer.addClass( this._dragElement, `resize-${this._location}` );
        
        // Add the element to the parent
        this.renderer.appendChild( document.body, this._dragElement );

        this.setPosition();

        // Set the visibility
        this.renderer.setStyle( this._dragElement, 'opacity', this.visibility === 'hidden' ? 0 : 1 );

    }

    private removeDragListeners() {
        this.document.removeEventListener( 'mousemove', this._mousemoveListener );
        this.document.removeEventListener( 'mouseup', this._mouseupListener );
    }

    private clampToMax() {
        let element = this.elementRef.nativeElement;

        if ( this._location === 'top' && this._heightMax > 0 && element.offsetHeight > this._heightMax ) {
            this.renderer.setStyle( element, 'height', `${this._heightMax}px` );
        } else if ( this._location === 'left' && this._widthMax > 0 && element.offsetWidth > this._widthMax ) {
            this.renderer.setStyle( element, 'width', `${this._widthMax}px` );
        }
    }

    private updateMax() {
        if ( this._maxRatio !== undefined ) {
            this._heightMax = this.document.defaultView.innerHeight * this._maxRatio;
            this._widthMax = this.document.defaultView.innerWidth * this._maxRatio;
        }
    }

    private setPosition() {
        let ownerRect = this.elementRef.nativeElement.getBoundingClientRect();

        if ( ownerRect ) {
            if ( this._location === 'top' ) {
                this.renderer.setStyle( this._dragElement, 'top', `${ownerRect.top}px` );
                this.renderer.setStyle( this._dragElement, 'left', `${ownerRect.left}px` );
                this.renderer.setStyle( this._dragElement, 'width', `${ownerRect.width}px` );
                this.renderer.setStyle( this._dragElement, 'height', `5px` );
            } else if ( this._location === 'bottom' ) {
                this.renderer.setStyle( this._dragElement, 'top', `${ownerRect.bottom - 5}px` );
                this.renderer.setStyle( this._dragElement, 'left', `${ownerRect.left}px` );
                this.renderer.setStyle( this._dragElement, 'width', `${ownerRect.width}px` );
                this.renderer.setStyle( this._dragElement, 'height', `5px` );
            } else if ( this._location === 'left' ) {
                this.renderer.setStyle( this._dragElement, 'top', `${ownerRect.top}px` );
                this.renderer.setStyle( this._dragElement, 'left', `${ownerRect.left}px` );
                this.renderer.setStyle( this._dragElement, 'width', `5px` );
                this.renderer.setStyle( this._dragElement, 'height', `${ownerRect.height}px` );
            } else if ( this._location === 'right' ) {
                this.renderer.setStyle( this._dragElement, 'top', `${ownerRect.top}px` );
                this.renderer.setStyle( this._dragElement, 'left', `${ownerRect.right - 5}px` );
                this.renderer.setStyle( this._dragElement, 'width', `5px` );
                this.renderer.setStyle( this._dragElement, 'height', `${ownerRect.height}px` );
            }
        
        }
    }


}

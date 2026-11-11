import { Component, OnInit, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ColoredString } from '../dialog.model';

@Component( {
    selector: 'app-confirm-dialog',
    templateUrl: 'confirm-dialog.component.html',
    styleUrls: [ '../dialog.styles.scss', '../../core.scss' ]
} )
export class ConfirmDialogComponent implements OnInit {

    public title: string = 'Confirm';
    public messages: ( string | ColoredString )[] = [];
    public noText: string = 'Cancel';
    public yesText: string = 'Confirm';
    public cancelText: string = 'Cancel';
    public destructive: boolean = false;

    constructor(
        public dialogRef: MatDialogRef<ConfirmDialogComponent>,
        @Inject(MAT_DIALOG_DATA) public data: any ) { }

    ngOnInit(): void {
        if ( this.data.message instanceof Array ) {
            this.messages = [ ...this.data.message ];
        } else if ( this.data.message ) {
            this.messages.push( this.data.message );
        } else {
            this.messages.push( 'Are you sure?' );
        }

        let verb: string | null = null;

        if ( this.data.title ) {
            this.title = this.data.title;
        } else {
            // A message line that is a question becomes the title.
            let at = this.messages.findIndex( m => typeof m === 'string' && /\?\s*$/.test( m ) );

            if ( at >= 0 ) {
                let question = ( this.messages.splice( at, 1 )[ 0 ] as string ).trim();
                let match = /^Are you (?:sure|certain)(?: that)? you (?:want|would like) to (.+\?)$/i.exec( question );
                this.title = match ? match[ 1 ].charAt( 0 ).toUpperCase() + match[ 1 ].slice( 1 ) : question;
                verb = match ? match[ 1 ].split( ' ' )[ 0 ] : null;
            }
        }

        if ( verb == null ) {
            verb = ConfirmDialogComponent.verbFrom( this.data.yesMessage );
        }

        if ( verb ) {
            this.yesText = verb.charAt( 0 ).toUpperCase() + verb.slice( 1 ).toLowerCase();
        }

        if ( this.data.buttonTexts ) {
            let buttonTexts = this.data.buttonTexts as { 'Yes'?: string, 'No'?: string, 'Cancel'?: string };

            this.yesText = buttonTexts.Yes ?? this.yesText;
            this.noText = buttonTexts.No ?? this.noText;
            this.cancelText = buttonTexts.Cancel ?? this.cancelText;
        }

        this.destructive = this.data.destructive ?? /^(delete|remove|uninstall)$/i.test( this.yesText );

        if ( this.destructive && this.messages.length === 0 ) {
            this.messages.push( 'This can\'t be undone.' );
        }
    }

    /** Pulls the verb out of a caller's 'Click "Yes" to <verb> ...' description. */
    private static verbFrom( description: string | null ): string | null {
        return /^Click ['"][^'"]+['"] to (\w+)/i.exec( description ?? '' )?.[ 1 ] ?? null;
    }
    
}

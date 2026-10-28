import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { sanitizeHtml } from '../utilities/html.utilities';
import { ColoredString } from '../dialogs/dialog.model';

/** Stands in for the tab spacer while the message text is sanitized; it is replaced in text nodes only. */
const spacerMarker = '\uE000';

/**
 * Replaces the spacer marker in the text nodes of the given sanitized html
 * with a spacer element.  Markers inside attribute values are left alone.
 *
 * @param html The sanitized html.
 */
function insertSpacers( html: string ): string {
    let template = document.createElement( 'template' );
    template.innerHTML = html;

    let walker = document.createTreeWalker( template.content, NodeFilter.SHOW_TEXT );
    let textNodes: Text[] = [];
    while ( walker.nextNode() ) {
        if ( walker.currentNode.nodeValue.includes( spacerMarker ) ) {
            textNodes.push( walker.currentNode as Text );
        }
    }

    for ( let textNode of textNodes ) {
        let fragment = document.createDocumentFragment();
        textNode.nodeValue.split( spacerMarker ).forEach( ( part, i ) => {
            if ( i > 0 ) {
                let spacer = document.createElement( 'span' );
                spacer.style.display = 'inline-block';
                spacer.style.width = '20px';
                spacer.textContent = '\u00a0';
                fragment.appendChild( spacer );
            }
            fragment.appendChild( document.createTextNode( part ) );
        } );
        textNode.parentNode.replaceChild( fragment, textNode );
    }

    return template.innerHTML;
}

@Pipe( {
    name: 'coloredString',
} )
export class ColoredStringPipe implements PipeTransform {

    constructor(private sanitizer: DomSanitizer) { }

    transform( msg: string | ColoredString ): string | SafeHtml {
        if ( msg instanceof ColoredString ) {
            let value = msg.value.split( spacerMarker ).join( '' );
            value = value.replace( /\*\*(.*?)\*\*/gi, '<strong>$1</strong>' );
            value = value.replace( /\~\~(.*?)\~\~/gi, '<i>$1</i>' );
            value = value.replace( /\^\^(.*?)\^\^/gi, '<sup>$1</sup>' );
            value = value.replace( /\>\>(.*?)\<\</gi, '<center>$1</center>' );
            value = value.replace( /\*t/gi, spacerMarker );

            // Only the message text is sanitized; the wrapper and the spacers are the app's own markup.
            value = insertSpacers( sanitizeHtml( value ) );
            let color = /^[a-z0-9#(),.% ]+$/i.test( msg.color ?? '' ) ? msg.color : 'inherit';
            let content = `<span style="color: ${color}; font-weight: ${msg.bold ? 'bold' : 'unset'}">${value}</span>`;

            return this.sanitizer.bypassSecurityTrustHtml( content );
        } else {
            return msg;
        }
    }
}

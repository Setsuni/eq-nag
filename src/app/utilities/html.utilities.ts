import DOMPurify from 'dompurify';
import { sanitizeConfig, checkAttribute } from '../../electron/utilities/sanitize-rules';

let hookInstalled = false;

/**
 * Removes everything but simple formatting from the given HTML.  The rules are
 * shared with src/electron/utilities/html.js.  Do not use it on the app's own
 * markup; sanitize the text that goes into it instead.
 *
 * @param html The html to sanitize.
 */
export function sanitizeHtml( html: string ): string {
    if ( html === null || html === undefined || html === '' ) {
        return '';
    }
    if ( !hookInstalled ) {
        DOMPurify.addHook( 'uponSanitizeAttribute', checkAttribute as any );
        hookInstalled = true;
    }
    return DOMPurify.sanitize( String( html ), sanitizeConfig as any ) as unknown as string;
}

/**
 * Escapes the given text so it is shown as-is when inserted as HTML.
 * 
 * @param text The text to escape.
 */
export function escapeHtml( text: string ): string {
    return String( text ?? '' ).replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' ).replace( /"/g, '&quot;' ).replace( /'/g, '&#39;' );
}

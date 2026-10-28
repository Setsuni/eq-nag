// The rules that decide what trigger text, package text and log text may
// contain.  Shared by the electron utilities and the app, so both sanitize the
// same way.  Only simple formatting is allowed: a short list of tags and
// attributes, images that carry their own data, and a short list of text
// styles whose values match a fixed grammar and stay below fixed sizes.
// Everything else, including links, svg, forms, classes and every other kind
// of url, is removed.

const allowedTags = [
    'p', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'big', 'strike', 'del', 'ins', 'sub', 'sup', 'br', 'hr', 'mark', 'font', 'center', 'code', 'pre', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img',
];
const allowedAttributes = [ 'style', 'title', 'color', 'face', 'size', 'src', 'alt', 'width', 'height' ];
const sanitizeConfig = {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttributes,
    ALLOWED_URI_REGEXP: /^data:image\/(png|jpe?g|gif|webp);base64,/i,
    ADD_URI_SAFE_ATTR: [ 'color', 'face', 'size', 'width', 'height' ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
};

const lengthProperties = [
    'font-size', 'letter-spacing', 'text-shadow', 'line-height', 'vertical-align',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
];
const allowedStyleProperties = [
    'color', 'background-color', 'font-weight', 'font-style', 'font-family', 'text-decoration', 'text-align', 'white-space', 'opacity',
    ...lengthProperties,
];
const styleValuePattern = /^(?:[a-z0-9 #,.%'"-]|(?:rgba?|hsla?)\(\s*[0-9., %/]+\s*\))+$/i;
const imageSourcePattern = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]*$/i;
const maxPixels = 200;
const maxEms = 20;
const maxPercent = 300;
const maxPaddingPixels = 50;
const maxPaddingEms = 5;
const maxPaddingPercent = 100;
const maxLineHeight = 20;
const maxShadows = 4;
const maxImageSize = 1000;










/**
 * Returns true if every length in the given value is small enough.
 *
 * @param {string} property The css property.
 * @param {string} value The css value.
 * @returns {boolean} True if no length is over the limit.
 */
function withinSizeLimits( property, value ) {
    let rest = value.replace( /#[0-9a-f]+/gi, '' ).replace( /(?:rgba?|hsla?)\([^)]*\)/gi, '' );
    if ( property === 'text-shadow' && rest.split( ',' ).length > maxShadows ) {
        return false;
    }
    let padding = property.startsWith( 'padding' );
    for ( let match of rest.matchAll( /(-?\d*\.?\d+)([a-z%]*)/gi ) ) {
        let amount = Math.abs( parseFloat( match[ 1 ] ) );
        let unit = match[ 2 ].toLowerCase();
        if ( unit === '' ) {
            if ( property === 'line-height' && amount > maxLineHeight ) {
                return false;
            }
        } else if ( unit === 'px' || unit === 'pt' ) {
            if ( amount > ( padding ? maxPaddingPixels : maxPixels ) ) {
                return false;
            }
        } else if ( unit === 'em' || unit === 'rem' ) {
            if ( amount > ( padding ? maxPaddingEms : maxEms ) ) {
                return false;
            }
        } else if ( unit === '%' ) {
            if ( amount > ( padding ? maxPaddingPercent : maxPercent ) ) {
                return false;
            }
        } else {
            return false;
        }
    }
    return true;
}










/**
 * Returns true if every quote in the given value is closed, so a value can't
 * swallow the declarations after it.
 *
 * @param {string} value The css value.
 * @returns {boolean} True if the quotes are balanced.
 */
function hasBalancedQuotes( value ) {
    return ( value.match( /'/g ) ?? [] ).length % 2 === 0 && ( value.match( /"/g ) ?? [] ).length % 2 === 0;
}










/**
 * Returns the given style with only the allowed declarations, or null when no
 * declaration is allowed.  A !important flag is removed.
 *
 * @param {string} style The value of a style attribute.
 * @returns {string|null} The style, or null when it must be removed.
 */
function cleanStyle( style ) {
    let declarations = [];
    for ( let declaration of String( style ).split( ';' ) ) {
        let colon = declaration.indexOf( ':' );
        if ( colon < 1 ) {
            continue;
        }
        let property = declaration.slice( 0, colon ).trim().toLowerCase();
        let value = declaration.slice( colon + 1 ).replace( /\s*!\s*important\s*$/i, '' ).trim();
        if ( !allowedStyleProperties.includes( property ) || !styleValuePattern.test( value ) || !hasBalancedQuotes( value ) ) {
            continue;
        }
        if ( lengthProperties.includes( property ) && !withinSizeLimits( property, value ) ) {
            continue;
        }
        declarations.push( `${property}: ${value}` );
    }
    return declarations.length > 0 ? declarations.join( '; ' ) : null;
}










/**
 * Keeps only allowed styles, embedded raster images and small image sizes.
 *
 * @param {Element} node The node the attribute belongs to.
 * @param {{ attrName: string, attrValue: string, keepAttr: boolean }} data The attribute being sanitized.
 */
function checkAttribute( node, data ) {
    let value = data.attrValue ?? '';
    if ( data.attrName === 'style' ) {
        let style = cleanStyle( value );
        if ( style === null ) {
            data.keepAttr = false;
        } else {
            data.attrValue = style;
        }
    } else if ( data.attrName === 'src' ) {
        if ( !imageSourcePattern.test( value ) ) {
            data.keepAttr = false;
        }
    } else if ( data.attrName === 'width' || data.attrName === 'height' ) {
        if ( !/^\d{1,4}$/.test( value ) || +value > maxImageSize ) {
            data.keepAttr = false;
        }
    }
}










module.exports = { sanitizeConfig, checkAttribute, cleanStyle, imageSourcePattern, allowedTags, allowedAttributes, allowedStyleProperties, styleValuePattern };

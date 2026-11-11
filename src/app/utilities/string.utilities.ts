
export function replaceAt( value: string, char: string, index: number, length: number ): string {
    return value.substring( 0, index ) + char + value.substring( index + length );
}

/**
 * Returns a server name for display: a name in one case gets a capital first letter, a mixed-case name is kept.
 */
export function serverLabel( server: string ): string {
    if ( !server ) {
        return '';
    }

    const mixed = server !== server.toLowerCase() && server !== server.toUpperCase();
    return server.charAt( 0 ).toUpperCase() + ( mixed ? server.slice( 1 ) : server.slice( 1 ).toLowerCase() );
}

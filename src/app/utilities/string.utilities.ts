
export function replaceAt( value: string, char: string, index: number, length: number ): string {
    return value.substring( 0, index ) + char + value.substring( index + length );
}

const knownServerLabels: Record<string, string> = {
    'P1999GREEN': 'P1999Green',
    'P1999BLUE': 'P1999Blue',
    'P1999RED': 'P1999Red',
    'P1999PVP': 'P1999PVP',
    'PROJECT1999': 'Project1999',
    'PQ.PROJ': 'pq.proj',
    'THJ': 'THJ',
};

/**
 * Returns a server name for display: known servers get their usual spelling, a name in one case gets a capital first letter, and a mixed-case name is kept.
 */
export function serverLabel( server: string ): string {
    if ( !server ) {
        return '';
    }

    const known = knownServerLabels[ server.toUpperCase() ];
    if ( known ) {
        return known;
    }

    const mixed = server !== server.toLowerCase() && server !== server.toUpperCase();
    return server.charAt( 0 ).toUpperCase() + ( mixed ? server.slice( 1 ) : server.slice( 1 ).toLowerCase() );
}

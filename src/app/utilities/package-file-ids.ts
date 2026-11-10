const maxSoundBytes = 5 * 1024 * 1024;
const maxShareBytes = 25 * 1024 * 1024;

/** A sound of a share or package that was not installed, and why. */
export class SkippedSound {
    constructor( public fileId: string, public fileName: string, public reason: string ) { }
}

/**
 * Returns the decoded size of the given base64 contents.
 *
 * @param contents The contents in base64.
 */
function getDecodedSize( contents: string ): number {
    let length = contents?.length ?? 0;
    return Math.floor( length * 3 / 4 ) - ( contents?.endsWith( '==' ) ? 2 : contents?.endsWith( '=' ) ? 1 : 0 );
}

/**
 * Returns the problem with the total size of the sounds of a share or
 * package, if any.  Sounds over the size of one sound are not counted
 * separately here, because they are skipped when they are installed.
 *
 * @param files The sounds, with their contents in base64.
 */
export function findSoundTotalProblem( files: { contents?: string }[] ): string | null {
    let total = 0;
    for ( let file of files ?? [] ) {
        total += getDecodedSize( file?.contents );
    }
    return total > maxShareBytes ? `The sounds total ${( total / 1024 / 1024 ).toFixed( 1 )} MB, which is more than the ${maxShareBytes / 1024 / 1024} MB limit.` : null;
}

/**
 * Returns the problem with the sounds of a share or package that is about to
 * be created, if any: a sound over 5 MB, or sounds that together are over
 * 25 MB.
 *
 * @param files The sounds, with their contents in base64.
 */
export function findSoundSizeProblem( files: { fileName?: string, contents?: string }[] ): string | null {
    for ( let file of files ?? [] ) {
        if ( getDecodedSize( file?.contents ) > maxSoundBytes ) {
            return `The sound "${( file.fileName ?? '' ).slice( 0, 80 )}" is larger than ${maxSoundBytes / 1024 / 1024} MB.`;
        }
    }
    return findSoundTotalProblem( files );
}

/**
 * Returns the sound that was not installed, given why the import failed.
 *
 * @param file The package file.
 * @param error The error of the import.
 */
export function toSkippedSound( file: { fileId: string, fileName?: string }, error: any ): SkippedSound {
    return new SkippedSound( file.fileId, file.fileName ?? file.fileId, getErrorReason( error, 'It could not be saved.' ) );
}

/**
 * Returns the reason in an error from the main process, without the text
 * that Electron puts in front of it.
 *
 * @param error The error.
 * @param fallback The reason to use when the error has none.
 */
export function getErrorReason( error: any, fallback: string = 'Unknown error' ): string {
    return String( error?.message ?? error ?? fallback )
        .replace( /^Error invoking remote method '[^']*': /, '' )
        .replace( /^Error: /, '' );
}

/**
 * Returns the sounds that were not installed.
 *
 * @param results The result of each file import: the stored id, or a skipped sound.
 */
export function getSkippedSounds( results: any[] ): SkippedSound[] {
    return ( results ?? [] ).filter( f => f instanceof SkippedSound );
}

/**
 * Returns a sentence that names the given sounds and why they were skipped.
 *
 * @param skipped The skipped sounds.
 */
export function describeSkippedSounds( skipped: SkippedSound[] ): string {
    return `Skipped ${skipped.length === 1 ? 'a sound' : `${skipped.length} sounds`}: ${skipped.map( f => `"${f.fileName.slice( 0, 60 )}" (${f.reason})` ).join( ', ' )}`;
}

/**
 * Builds a map of package file ids to the ids the files were stored under,
 * keeping only the files whose id changed.  A file that was skipped maps to
 * null.
 *
 * @param files The imported package files.
 * @param storedIds The id each file was stored under, or a skipped sound, in the same order as the files.
 */
export function buildFileIdMap( files: { fileId: string }[], storedIds: ( string | SkippedSound )[] ): Record<string, string | null> {
    let idMap: Record<string, string | null> = Object.create( null );
    files?.forEach( ( file, i ) => {
        let storedId = storedIds?.[ i ];
        if ( storedId instanceof SkippedSound ) {
            idMap[ file.fileId ] = null;
        } else if ( storedId && storedId !== file.fileId ) {
            idMap[ file.fileId ] = storedId;
        }
    } );
    return idMap;
}

/**
 * Rewrites the audio file ids of the given triggers' actions to the ids the
 * files were stored under.  The ids of skipped files are cleared.
 *
 * @param triggers The triggers about to be installed.
 * @param idMap The map of package file ids to stored file ids.
 */
export function remapAudioFileIds( triggers: { actions?: { audioFileId?: string, endingPlayAudioFileId?: string, endedPlayAudioFileId?: string }[] }[], idMap: Record<string, string | null> ): void {
    if ( !idMap || Object.keys( idMap ).length === 0 ) {
        return;
    }
    const has = ( id: string ) => !!id && Object.prototype.hasOwnProperty.call( idMap, id );
    triggers?.forEach( trigger => {
        trigger.actions?.forEach( action => {
            if ( has( action.audioFileId ) ) {
                action.audioFileId = idMap[ action.audioFileId ];
            }
            if ( has( action.endingPlayAudioFileId ) ) {
                action.endingPlayAudioFileId = idMap[ action.endingPlayAudioFileId ];
            }
            if ( has( action.endedPlayAudioFileId ) ) {
                action.endedPlayAudioFileId = idMap[ action.endedPlayAudioFileId ];
            }
        } );
    } );
}

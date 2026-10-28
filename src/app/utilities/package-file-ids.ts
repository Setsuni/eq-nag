/**
 * Builds a map of package file ids to the ids the files were stored under,
 * keeping only the files whose id changed.
 *
 * @param files The imported package files.
 * @param storedIds The id each file was stored under, in the same order as the files.
 */
export function buildFileIdMap( files: { fileId: string }[], storedIds: string[] ): Record<string, string> {
    let idMap: Record<string, string> = Object.create( null );
    files?.forEach( ( file, i ) => {
        let storedId = storedIds?.[ i ];
        if ( storedId && storedId !== file.fileId ) {
            idMap[ file.fileId ] = storedId;
        }
    } );
    return idMap;
}

/**
 * Rewrites the audio file ids of the given triggers' actions to the ids the
 * files were stored under.
 *
 * @param triggers The triggers about to be installed.
 * @param idMap The map of package file ids to stored file ids.
 */
export function remapAudioFileIds( triggers: { actions?: { audioFileId?: string, endingPlayAudioFileId?: string, endedPlayAudioFileId?: string }[] }[], idMap: Record<string, string> ): void {
    if ( !idMap || Object.keys( idMap ).length === 0 ) {
        return;
    }
    const has = ( id: string ) => !!id && Object.prototype.hasOwnProperty.call( idMap, id ) && !!idMap[ id ];
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

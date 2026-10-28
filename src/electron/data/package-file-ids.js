const crypto = require( 'crypto' );

/**
 * @typedef {object} PackageFileResolution
 * @property {string} fileId The id the incoming file is stored under.
 * @property {boolean} install True if the incoming file must be written to disk.
 */

/**
 * @typedef {object} ExistingFileState
 * @property {'ok' | 'missing' | 'unreadable'} status Whether the local file could be read.
 * @property {string | null} hash The hash of the local file when status is ok.
 */










/**
 * Returns the hash of the given file data.
 *
 * @param {Buffer} buffer The file data.
 * @returns {string}
 */
function hashFileData( buffer ) {
    return crypto.createHash( 'sha256' ).update( buffer ).digest( 'hex' );
}










/**
 * Decides which id an incoming package file is stored under, so that a shared
 * file never replaces a different local file that has the same id.
 *
 * @param {string} incomingId The file id carried by the package.
 * @param {string} incomingHash The hash of the incoming file data.
 * @param {ExistingFileState | null} existing The state of the local file with the same id, or null when the id is not used locally.
 * @param {(string) => string | null} findIdByHash Returns the id of a local file with the given hash, if any.
 * @param {(string) => boolean} idExists Returns true if the given file id is already used locally.
 * @param {() => string} createId Creates a new file id.
 * @returns {PackageFileResolution}
 */
function resolvePackageFileId( incomingId, incomingHash, existing, findIdByHash, idExists, createId ) {
    if ( !existing ) {
        return { fileId: incomingId, install: true };
    }

    // The local record points at a file that is gone, so the incoming file can restore it.
    if ( existing.status === 'missing' ) {
        return { fileId: incomingId, install: true };
    }

    if ( existing.status === 'ok' && existing.hash === incomingHash ) {
        return { fileId: incomingId, install: false };
    }

    // A different file already uses this id.  Reuse a local copy of the incoming data when there is one.
    let sameContentId = findIdByHash( incomingHash );
    if ( sameContentId ) {
        return { fileId: sameContentId, install: false };
    }

    let newId = createId();
    while ( idExists( newId ) ) {
        newId = createId();
    }
    return { fileId: newId, install: true };
}










module.exports = { hashFileData, resolvePackageFileId };

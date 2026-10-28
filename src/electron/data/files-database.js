const electron = require( 'electron' );
const { app, BrowserWindow, ipcMain } = require( "electron" );
const path = require( 'path' );
const fs = require( 'fs' );
const Store = require( './store' );
const _ = require( 'lodash' );
const ForwardRef = require( '../forward-ref' );
const customAlphabet = require( 'nanoid' ).customAlphabet;
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const idLen = 16;
const nanoid = customAlphabet( alphabet, 16 );
const ArrayUtilities = require( '../utilities/arrays' );
const StringUtilities = require( "../utilities/string" );
const Fuse = require( 'fuse.js' );
const { MediaTypes, FileModel, PackageFileModel } = require( './models/trigger' );
const { hashFileData, resolvePackageFileId } = require( './package-file-ids' );
const log = require( 'electron-log' );

const eqSpellPages = 63;
const eqIconPageSize = 256;
const eqIconSize = 40;
const filesFolder = 'resource-files';

// Audio types that can be installed from a shared package.  WAV is accepted
// here so packages made from GINA imports still install; it can't be uploaded
// from Nag (see storeFile).
const packageFileExtensions = new Set( [ '.mp3', '.ogg', '.m4a', '.opus', '.webm', '.aac', '.wav' ] );
const fileIdRegex = /^[A-Za-z0-9_-]{1,64}$/;

class FilesDatabaseStore extends Store {

    /** 
     * The data store for this object.
     * @type {{files: FileModel[]}}
     * */
    #data;

    #filePath;

    constructor() {
        super( {
            configName: "files-database",
            defaults: { files: [] },
        } );
        
        this.#data = this.parseDataFile();

        let userDataPath = ( electron.app || electron.remote.app ).getPath( 'userData' );
        this.#filePath = path.join( userDataPath, filesFolder );

        if ( !fs.existsSync( this.#filePath ) ) {
            fs.mkdir( this.#filePath, () => { } );
        }
    }
    








    
    /**
     * Attaches store events to ipc main and dispatches react events to the main window.
     * 
     * @param {ForwardRef} mainWindowRef The main window of the application.
     */
    attachIpcEvents( mainWindowRef ) {

        ipcMain.on( 'audio-file:save',
            /**
             * Saves the posted file to the store and returns the id of the file.
             * 
             * @param {import('electron').IpcMainEvent} event 
             * @param {{name: string, arrayBuffer: ArrayBuffer}} file 
             */
            ( event, file ) => {
                var buffer = Buffer.from( file.arrayBuffer );
                let fileId = this.storeFile( buffer, file.name );
                event.sender.send( 'audio-file:save', fileId );
            } );

        ipcMain.on( 'audio-file:import', ( event, filename ) => {
            let fileId = this.storeFileByName( filename );
            event.sender.send( 'audio-file:import', fileId );
        } );

        ipcMain.on( 'audio-file:get:url', ( event, fileId ) => {
            let url = this.getAudioFileUrl( fileId );
            event.sender.send( 'audio-file:get:url', url );
        } );

        ipcMain.on( 'audio-file:get', ( event ) => {
            event.sender.send( 'audio-file:get', this.getAudioFiles() );
        } );

        ipcMain.on( 'audio-file:getData', ( event ) => {
            event.sender.send( 'audio-file:getData', this.getAudioFileData() );
        } );

        ipcMain.handle( 'file:importFromPackage', ( event, packageFile ) => {
            return this.importPackageFile( packageFile );
        } );

    }









    
    /**
     * Returns a file URL for the specified file.
     * 
     * @param {string} fileId The id of the desired file.
     */
    getAudioFileUrl( fileId ) {
        let file = _.find( this.#data.files, f => f.fileId === fileId );
        if ( file ) {
            return `file://${file.physicalName}`;
        }
    }









    
    /**
     * Saves the posted file to the store.
     * 
     * @returns {string|null} Returns the id of the file.
     * 
     * @param {Buffer} buffer The file data.
     * @param {string} name The name of the file.
     */
    storeFile( buffer, name ) {

        const allowedExtensions = new Set( [
            // Only formats that are mp3 or better (smaller size vs quality)
            '.mp3', '.ogg', '.m4a', '.opus', '.webm', '.aac'
        ] );

        const ext = path.extname( name ).toLowerCase();
        if ( !allowedExtensions.has( ext ) )
            return null;
        
        let id = nanoid();
        let model = new FileModel();
        
        model.fileId = id;
        model.mediaType = MediaTypes.Audio;
        model.fileName = name;
        model.physicalName = path.join( this.#filePath, `${id}${path.extname( name )}` );
        model.hash = hashFileData( buffer );
        model.size = buffer.length;

        fs.writeFile( model.physicalName, buffer, () => { } );

        this.#data.files.push( model );
        this.storeDataFile( this.#data );

        return id;
    }









    
    /**
     * Removes the specified file.
     * 
     * @param {string} fileId The id of the file to remove.
     */
    deleteFile( fileId ) {
        let file = _.remove( this.#data.files, f => f.fileId === fileId );

        if ( file?.length > 0 ) {
            if ( this.isInFilesFolder( file[ 0 ].physicalName ) ) {
                fs.unlink( file[ 0 ].physicalName, () => { } );
            }
            this.storeDataFile( this.#data );
        }
    }









    
    /**
     * Removes the specified file when a package no longer uses it, unless a
     * package import only reused it because it already existed.
     *
     * @param {string} fileId The id of the file to remove.
     * @param {boolean} [requireImported] True to remove the file only when a package import created it.
     */
    deletePackageFile( fileId, requireImported = false ) {
        let file = this.#data.files.find( f => f.fileId === fileId );
        if ( file && ( requireImported ? file.packageImport === true : file.packageImport !== false ) ) {
            this.deleteFile( fileId );
        }
    }










    /**
     * Returns true if the given path is a file directly inside the files folder.
     * 
     * @param {string} physicalName The full path of the file.
     */
    isInFilesFolder( physicalName ) {
        return typeof physicalName === 'string' && path.dirname( path.resolve( physicalName ) ) === path.resolve( this.#filePath );
    }









    
    /**
     * Imports the given package file into the data store.  A local file that
     * has the same id but different contents is never replaced; the package
     * file is stored under a new id instead.
     * 
     * @param {PackageFileModel} file The package file to import.
     * @returns {string|null} Returns the id the file is stored under, which differs from the package file id when that id was already used by a different local file.
     */
    importPackageFile( file ) {

        // The file id and name come from the package, so only an id made of
        // plain characters and a known audio extension may become a file name
        // in the files folder.
        const ext = path.extname( `${file?.fileName ?? ''}` ).toLowerCase();
        if ( !fileIdRegex.test( `${file?.fileId ?? ''}` ) || !packageFileExtensions.has( ext ) || typeof file.contents !== 'string' ) {
            log.warn( `[files-database:importPackageFile] Skipped package file with an invalid id or type: ${JSON.stringify( `${file?.fileName ?? ''}` )}` );
            return null;
        }

        let contents = Buffer.from( file.contents, 'base64' );

        let incomingHash = hashFileData( contents );
        let existing = this.#data.files.find( f => f.fileId === file.fileId );

        let resolution = resolvePackageFileId(
            file.fileId,
            incomingHash,
            existing ? this.#getFileState( existing ) : null,
            hash => this.#findIdByHash( hash ),
            id => this.#data.files.some( f => f.fileId === id ),
            nanoid );
        if ( !resolution.install ) {
            let reused = this.#data.files.find( f => f.fileId === resolution.fileId );
            if ( reused && ( reused.packageImport === null || reused.packageImport === undefined ) ) {
                // The same id means an earlier package import wrote this file.  A different id means the contents matched a file that was already there.
                reused.packageImport = resolution.fileId === file.fileId;
                this.storeDataFile( this.#data );
            }
            return resolution.fileId;
        }

        // Only a record whose file is missing from disk is replaced.
        if ( existing && resolution.fileId === file.fileId ) {
            this.#data.files.splice( this.#data.files.indexOf( existing ), 1 );
        }

        let model = new FileModel();

        model.fileId = resolution.fileId;
        model.mediaType = +file.mediaType;
        model.fileName = file.fileName;
        model.physicalName = path.join( this.#filePath, `${resolution.fileId}${ext}` );
        model.hash = incomingHash;
        model.size = contents.length;
        model.packageImport = true;

        this.#writeFile( model.physicalName, contents );

        this.#data.files.push( model );
        this.storeDataFile( this.#data );

        return resolution.fileId;
    }










    /**
     * Writes the file under a temporary name and renames it, so a partly
     * written file never has the final name.
     *
     * @param {string} target The full path of the file.
     * @param {Buffer} buffer The file data.
     */
    #writeFile( target, buffer ) {
        let temporary = `${target}.${nanoid()}.tmp`;
        try {
            fs.writeFileSync( temporary, buffer );
            fs.renameSync( temporary, target );
        } catch ( error ) {
            fs.rmSync( temporary, { force: true } );
            throw error;
        }
    }










    /**
     * Returns the state of the file behind the given record.  The stored hash
     * is used when the file on disk still has the size it had when the hash
     * was taken; otherwise the file is read and the hash is saved on the record.
     *
     * @param {FileModel} record The file record.
     * @param {() => void} [onHashed] Called instead of saving the data file when a hash was added to the record.
     * @returns {import('./package-file-ids').ExistingFileState}
     */
    #getFileState( record, onHashed ) {
        if ( !fs.existsSync( record.physicalName ) ) {
            return { status: 'missing', hash: null };
        }
        try {
            if ( record.hash && record.size === fs.statSync( record.physicalName ).size ) {
                return { status: 'ok', hash: record.hash };
            }
            let buffer = fs.readFileSync( record.physicalName );
            record.hash = hashFileData( buffer );
            record.size = buffer.length;
            if ( onHashed ) {
                onHashed();
            } else {
                this.storeDataFile( this.#data );
            }
            return { status: 'ok', hash: record.hash };
        } catch ( error ) {
            log.warn( `[files-database:getFileState] Could not read the existing file: ${error}` );
            return { status: 'unreadable', hash: null };
        }
    }










    /**
     * Returns the id of a local file that has the given hash, if any.
     *
     * @param {string} hash The file hash.
     * @returns {string|null}
     */
    #findIdByHash( hash ) {
        let backfilled = false;
        let match = this.#data.files.find( f => ( !f.hash || f.hash === hash ) && this.#getFileState( f, () => { backfilled = true; } ).hash === hash );
        if ( backfilled ) {
            this.storeDataFile( this.#data );
        }
        return match?.fileId ?? null;
    }









    
    /**
     * Stores the specified filename in the data store, copying the file that 
     * exists on the computer into the files path.
     * 
     * @param {string} filename The full path and name of the desired file.
     * @returns 
     */
    storeFileByName( filename ) {

        if ( filename ) {
            let name = path.basename( filename );
            let existing = _.find( this.#data.files, f => f.fileName === name );

            if ( existing ) {
                return existing.fileId;

            } else {
                let id = nanoid();
                let model = new FileModel();
            
                model.fileId = id;
                model.mediaType = MediaTypes.Audio;
                model.fileName = name;
                model.physicalName = path.join( this.#filePath, `${id}${path.extname( name )}` );
                try {
                    let buffer = fs.readFileSync( filename );
                    model.hash = hashFileData( buffer );
                    model.size = buffer.length;
                } catch ( error ) {
                    log.warn( `[files-database:storeFileByName] Could not hash the file: ${error}` );
                }
    
                fs.copyFile( filename, model.physicalName, () => { } );
    
                this.#data.files.push( model );
                this.storeDataFile( this.#data );
    
                return id;

            }
        } else {
            log.error( `[files-database:storeFileByName] Invalid filename: ${filename === undefined ? 'undefined' : filename === null ? 'null' : filename}` );
            return undefined;
        }
    }









    
    /**
     * Returns a list of all audio files int he store.
     */
    getAudioFiles() {
        return _.filter( this.#data.files, f => f.mediaType === MediaTypes.Audio );
    }










    /**
     * Returns all file with data, in base64 format, for all audio files.
     */
    getAudioFileData() {
        /** @type {PackageFileModel[]} */
        let files = _.filter( this.#data.files, f => f.mediaType === MediaTypes.Audio )
            .filter( f => fs.existsSync( f.physicalName ) )
            .map( f => {
                let m = new PackageFileModel();

                m.fileId = f.fileId;
                m.mediaType = f.mediaType;
                m.fileName = f.fileName;
                m.contents = fs.readFileSync( f.physicalName ).toString( 'base64' );

                return m;
            } );

        return files;
    }

}

module.exports = FilesDatabaseStore;

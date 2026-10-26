const electron = require( 'electron' );
const path = require( 'path' );
const fs = require( 'fs' );
const fsp = fs.promises;
const archiver = require( 'archiver' );
const FsUtilities = require( '../utilities/file-system' );

class Store {
    /** The stored file path and location for this object. */
    #path;
    /** The folder for the current user data store. */
    userDataPath;
    /** This object's default values. */
    #defaults;
    /** Virtual properties */
    #virtual = [];
    /** The config name of this object. */
    configName;

    constructor( opts ) {
        // Renderer process has to get `app` module via `remote`, whereas the main process can get it directly
        // app.getPath('userData') will return a string of the user's app data directory path.
        this.userDataPath = ( electron.app || electron.remote.app ).getPath( 'userData' );
        // We'll use the `configName` property to set the file name and path.join to bring it all together as a string
        this.#path = path.join( this.userDataPath, opts.configName + '.json' );
        this.#defaults = opts.defaults;
        this.configName = opts.configName;
        this.#virtual = opts.virtual || [];
        // this.data = parseDataFile( this.path, opts.defaults );
    }
    

    /**
     * Reads the data file, returning the defaults when it is missing and moving it aside when it is corrupt.
     *
     * @returns {any} Returns the parsed data, or the defaults if the file could not be read.
     */
    parseDataFile() {
        // We'll try/catch it in case the file doesn't exist yet, which will be the case on the first application run.
        // `fs.readFileSync` will return a JSON string which we then parse into a Javascript object
        try {
            return JSON.parse( fs.readFileSync( this.#path ) );
        } catch ( error ) {
            // A missing file is a normal first run.
            if ( error?.code === 'ENOENT' ) {
                return this.#defaults;
            }

            // The file exists but could not be read or parsed, so move it aside before the next save overwrites it.
            let corruptPath = `${this.#path}.corrupt-${FsUtilities.getFileTimestamp()}`;

            try {
                fs.renameSync( this.#path, corruptPath );
                console.error( 'Error parsing ' + this.configName + ', the file was moved to ' + corruptPath, error );
            } catch ( renameError ) {
                console.error( 'Error parsing ' + this.configName + ', the file could not be moved aside', error, renameError );
            }

            return this.#defaults;
        }
    }

    /**
     * Clones the given data and strips the virtual properties so it is ready to be written.
     *
     * @param {any} data The data to store.
     * @returns {any} Returns the data to write to the file.
     */
    #prepareStoreData( data ) {

        let storeData = JSON.parse( JSON.stringify( data ) );

        if ( !storeData ) {
            throw 'Attmept to store null data file!';
        }

        if ( this.#virtual.length > 0 ) {
            for ( let i = 0; i < this.#virtual.length; i++ ) {
                let virtual = this.#virtual[i];
                if ( storeData[virtual] ) {
                    delete storeData[virtual];
                }
            }
        }

        return storeData;
    }

    /**
     * Returns a unique temporary file path next to the data file.
     *
     * @returns {string} Returns the temporary file path.
     */
    #getTempPath() {
        return `${this.#path}.${process.pid}-${Date.now()}-${Math.random().toString( 36 ).slice( 2 )}.tmp`;
    }

    /**
     * Writes the data file by writing a temporary file and renaming it over the data file.
     *
     * @param {any} data The data to store.
     */
    storeDataFile( data ) {

        let storeData = this.#prepareStoreData( data );
        let tempPath = this.#getTempPath();

        try {
            fs.writeFileSync( tempPath, JSON.stringify( storeData, null, 2 ) );
            fs.renameSync( tempPath, this.#path );
        } catch ( error ) {
            console.error( 'Error storing ' + this.configName, error );

            try {
                fs.rmSync( tempPath, { force: true } );
            } catch ( removeError ) {
                // Nothing more can be done about the temporary file.
            }
        }
    }

    /**
     * Writes the data file asynchronously by writing a temporary file and renaming it over the data file.
     *
     * @param {any} data The data to store.
     * @returns {Promise<void>} Returns a promise that resolves when the write is finished, even if it failed.
     */
    async storeDataFileAsync( data ) {

        let storeData = this.#prepareStoreData( data );
        let tempPath = this.#getTempPath();

        try {
            await fsp.writeFile( tempPath, JSON.stringify( storeData, null, 2 ) );
            await fsp.rename( tempPath, this.#path );
        } catch ( error ) {
            console.error( 'Error storing ' + this.configName, error );

            try {
                await fsp.rm( tempPath, { force: true } );
            } catch ( removeError ) {
                // Nothing more can be done about the temporary file.
            }
        }
    }

    /**
     * Creates a backup of the database.
     * 
     * @param {(string) => void)} onComplete Callback function executed when the backup file is created that receives the backup file location.
     */
    backupDatafile( onComplete ) {
        let backupFile = path.join( this.userDataPath, `-${FsUtilities.getFileTimestamp()}-backup.zip` );
        let output = fs.createWriteStream( backupFile );
        let zip = archiver( 'zip' );

        output.on( 'close', () => {
            onComplete( backupFile );
        } );

        zip.pipe( output );
        zip.file( this.#path, { name: this.configName + '.json' } );
        zip.finalize();
    }

}

module.exports = Store;

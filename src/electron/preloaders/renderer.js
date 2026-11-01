const { contextBridge, ipcRenderer } = require( 'electron' );

const channelPrefixes = [
    'app',
    'overlay',
    'clipboard',
    'log',
    'audio-file',
    'cache',
    'combat-database', 
    'chat-room',
    'combat',
    'show-settings',
];

contextBridge.exposeInMainWorld( 'api', {
    // TODO: THis should be updated and methods using require should be methods on the preloader.
    getRenderer: () => require( '../threads/renderer' ),
    showSettings: ( name ) => {
        ipcRenderer.send( 'show-settings', name );
    },
    recordEncounters: ( record ) => {
        ipcRenderer.send( 'combat:record-encounters', { recordEncounters: record } );
    }
} );

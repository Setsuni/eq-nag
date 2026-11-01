const { contextBridge, ipcRenderer } = require( 'electron' );

contextBridge.exposeInMainWorld( 'api', {
    // TODO: Update death recap to use preloader methods instead of require.
    getDeathRecap: () => require( '../windows/death-recap' ),
} );

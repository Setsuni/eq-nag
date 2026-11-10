const Store = require( './store' );
const { ipcMain } = require( 'electron' );
const eqZones = require( './models/everquest-zones' );

const maxZones = 300;
const maxPairs = 300;
const maxPending = 100;
const confirmations = 2;
const maxNameLength = 80;

/** Zone-in names that /who reports under a different name. */
const seedPairs = [
    { from: 'Tower of Discord', to: 'Citadel of the Worldslayer' },
    { from: 'Tower of Discord - Hard', to: 'Citadel of the Worldslayer' },
    { from: 'An Audience with Brell Serilis', to: 'Brell\'s Temple' },
    { from: 'The Permafrost Caverns', to: 'Permafrost Keep' },
    { from: 'The Demiplane of Blood', to: 'Dreadspire Keep' },
    { from: 'Rathe Council Chamber: Rallos Returns', to: 'Rathe Council Chamber' },
];

const builtInZones = new Set( eqZones.map( z => z.toLowerCase() ) );

/**
 * Normalizes a zone name, returning null if it should not be stored.
 *
 * @param {any} name The zone name.
 * @returns {string | null}
 */
function cleanName( name ) {
    if ( typeof name !== 'string' ) {
        return null;
    }

    const trimmed = name.trim().replace( /\s+\d+$/, '' );
    return trimmed.length > 0 && trimmed.length <= maxNameLength ? trimmed : null;
}

class ZoneKnowledgeStore extends Store {

    /** @type {{ version: number, zones: string[], pairs: { from: string, to: string }[], pending: { from: string, to: string, count: number }[] }} */
    #data;

    constructor() {
        super( {
            configName: 'zone-knowledge',
            defaults: { version: 1, zones: [], pairs: [], pending: [] },
        } );

        this.#data = this.parseDataFile();
        this.#data.zones = Array.isArray( this.#data.zones ) ? this.#data.zones : [];
        this.#data.pairs = Array.isArray( this.#data.pairs ) ? this.#data.pairs : [];
        this.#data.pending = Array.isArray( this.#data.pending ) ? this.#data.pending : [];
    }

    /**
     * Attaches the zone knowledge events to ipc main.
     */
    attachIpcEvents() {
        ipcMain.on( 'zone-knowledge:record', ( event, entry ) => {
            if ( entry?.zone ) {
                this.recordZone( entry.zone );
            }
            if ( entry?.from && entry?.to ) {
                this.recordPair( entry.from, entry.to );
            }
        } );
    }

    /**
     * Returns the seeded and learned zone knowledge.
     *
     * @returns {{ zones: string[], pairs: { from: string, to: string, seed?: boolean }[] }}
     */
    getKnowledge() {
        return {
            zones: [ ...this.#data.zones ],
            pairs: [ ...seedPairs.map( p => ( { ...p, seed: true } ) ), ...this.#data.pairs ],
        };
    }

    /**
     * Remembers a zone name that is not in the built-in list.
     *
     * @param {string} name The zone name.
     * @returns {boolean} Returns true if it was added.
     */
    recordZone( name ) {
        const zone = cleanName( name );
        if ( !zone || builtInZones.has( zone.toLowerCase() ) || this.#data.zones.some( z => z.toLowerCase() === zone.toLowerCase() ) ) {
            return false;
        }

        this.#data.zones.push( zone );
        if ( this.#data.zones.length > maxZones ) {
            this.#data.zones.splice( 0, this.#data.zones.length - maxZones );
        }
        this.storeDataFile( this.#data );
        return true;
    }

    /**
     * Remembers that /who reports the zone-in name as another name. A pair is only learned once it was seen twice.
     *
     * @param {string} from The name in the zone-in message.
     * @param {string} to The name /who reports, without an instance number.
     * @returns {boolean} Returns true if it was learned.
     */
    recordPair( from, to ) {
        const a = cleanName( from );
        const b = cleanName( to );
        if ( !a || !b || a.toLowerCase() === b.toLowerCase() ) {
            return false;
        }

        const known = pair => pair.from.toLowerCase() === a.toLowerCase() && pair.to.toLowerCase() === b.toLowerCase();
        if ( seedPairs.some( known ) || this.#data.pairs.some( known ) ) {
            return false;
        }

        let pending = this.#data.pending.find( known );
        if ( !pending ) {
            pending = { from: a, to: b, count: 0 };
            this.#data.pending.push( pending );
            if ( this.#data.pending.length > maxPending ) {
                this.#data.pending.splice( 0, this.#data.pending.length - maxPending );
            }
        }

        pending.count++;
        if ( pending.count < confirmations ) {
            this.storeDataFile( this.#data );
            return false;
        }

        this.#data.pending.splice( this.#data.pending.indexOf( pending ), 1 );
        this.#data.pairs.push( { from: pending.from, to: pending.to } );
        if ( this.#data.pairs.length > maxPairs ) {
            this.#data.pairs.splice( 0, this.#data.pairs.length - maxPairs );
        }
        this.recordZone( a );
        this.recordZone( b );
        this.storeDataFile( this.#data );
        return true;
    }

}

ZoneKnowledgeStore.seedPairs = seedPairs;

module.exports = ZoneKnowledgeStore;

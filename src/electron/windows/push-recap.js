const { ipcRenderer } = require( 'electron' );
const { loadPushSpells } = require( '../data/push-spells' );
const { readSession, summarize, analyzeKill, buildLandingIndex } = require( '../utilities/push-recap-parser' );
const { buildSavedSummary, notNamedNpcRgx } = require( '../utilities/push-recap-summary' );










/**
 * Formats the given damage value, e.g. 1.84B.
 *
 * @returns {string} The formatted value.
 *
 * @param {number} value The value.
 */
function formatDamage( value ) {
    if ( value >= 1000000000 ) {
        return `${( value / 1000000000 ).toFixed( 2 )}B`;
    } else if ( value >= 1000000 ) {
        return `${( value / 1000000 ).toFixed( 1 )}M`;
    } else if ( value >= 1000 ) {
        return `${( value / 1000 ).toFixed( 1 )}K`;
    }
    return `${value}`;
}










/**
 * Formats the given duration, e.g. 6m 41s.
 *
 * @returns {string} The formatted duration.
 *
 * @param {number} seconds The duration in seconds.
 */
function formatDuration( seconds ) {
    return seconds >= 60 ? `${Math.floor( seconds / 60 )}m ${seconds % 60}s` : `${seconds}s`;
}










/**
 * Lists the spells of a player, most hits first.
 *
 * @returns {{ name: string, confirmed: number, assumed: number, push: number | undefined }[]} The spells.
 *
 * @param {any} player The saved player.
 */
function listSpells( player ) {
    return Object.keys( player.spells ?? {} ).map( name => {
        let s = player.spells[ name ];
        return { name: name, confirmed: Math.max( 0, s.events - s.assumed ), assumed: s.assumed, push: s.push };
    } ).sort( ( x, y ) => ( y.confirmed + y.assumed ) - ( x.confirmed + x.assumed ) );
}










/**
 * Describes the spells of a player, e.g. Color Flux XVIII (push 0.5) ×71, Docility XII (push 0.5) ~×25.
 *
 * @returns {string} The description.
 *
 * @param {any} player The saved player.
 * @param {number} max The maximum number of spells to list.
 */
function describeSources( player, max ) {
    return listSpells( player ).slice( 0, max ).map( s => {
        let counts = [];
        if ( s.confirmed > 0 ) {
            counts.push( `×${s.confirmed}` );
        }
        if ( s.assumed > 0 ) {
            counts.push( `~×${s.assumed}` );
        }
        return `${s.name}${s.push != null ? ` (push ${s.push})` : ''} ${counts.join( ' ' )}`;
    } ).join( ', ' );
}










/**
 * Formats the kill time of the given summary as HH:MM:SS.  The kill time holds the clock of the log as UTC.
 *
 * @returns {string} The clock.
 *
 * @param {any} summary The saved summary.
 */
function formatKillClock( summary ) {
    return new Date( summary.killTime ).toISOString().substring( 11, 19 );
}










/**
 * Formats the push of one hit of a proc, e.g. 5 or 3–5.
 *
 * @returns {string} The text.
 *
 * @param {any} proc The proc.
 */
function formatProcPush( proc ) {
    if ( proc.pushMin == null ) {
        return '—';
    }
    return proc.push != null ? `${proc.push}` : `${proc.pushMin}–${proc.pushMax}`;
}










/**
 * Formats the total push of a proc, e.g. 50 or ~30–50 when the spell is ambiguous.
 *
 * @returns {string} The text.
 *
 * @param {any} proc The proc.
 */
function formatProcTotal( proc ) {
    if ( proc.pushMin == null ) {
        return '—';
    }
    let round = value => Math.round( value * 100 ) / 100;
    return proc.push != null ? `${round( proc.count * proc.push )}` : `~${round( proc.count * proc.pushMin )}–${round( proc.count * proc.pushMax )}`;
}










/**
 * Formats the landing message of a proc, e.g. … is struck by the axe of Rallos.
 *
 * @returns {string} The text.
 *
 * @param {any} proc The proc.
 */
function formatMessage( proc ) {
    return typeof proc.text === 'string' && proc.text !== '' ? `…${proc.text}` : '—';
}





/**
 * Lists the spells with no push that use the same message as a possible proc, e.g. A, B, C +5 more.
 *
 * @returns {string} The text.
 *
 * @param {any} proc The possible proc.
 */
function formatAlso( proc ) {
    let names = proc.alsoNames ?? [];
    if ( names.length === 0 ) {
        return '—';
    }
    let more = ( proc.alsoCount ?? 0 ) - names.length;
    return `${names.join( ', ' )}${more > 0 ? ` +${more} more` : ''}`;
}





/**
 * Builds a short plain text summary of the recap.
 *
 * @returns {string} The summary.
 *
 * @param {any} summary The saved summary.
 */
function buildSummaryText( summary ) {
    let players = summary.players ?? [];
    let lines = [
        `Push Recap - ${summary.mob}, killed ${formatKillClock( summary )}, fight ${formatDuration( summary.fightSeconds )}`,
        `${summary.events} push hits, ${players.length} players pushing`,
    ];
    players.forEach( ( p, i ) => {
        let share = summary.events > 0 ? Math.round( p.events * 100 / summary.events ) : 0;
        lines.push( `${i + 1}. ${p.name} - ${p.events} (${share}%)${p.assumed > 0 ? ` ~${p.assumed} assumed` : ''}` );
    } );
    if ( summary.unattributed.events > 0 ) {
        let top = ( summary.unattributed.procs ?? [] ).slice( 0, 5 ).map( p => `${p.name} ${p.count}` ).join( ', ' );
        lines.push( `Procs with no player named: ${summary.unattributed.events}${top === '' ? '' : ` (${top})`}` );
    }
    if ( ( summary.unattributed?.possibleEvents ?? 0 ) > 0 ) {
        let top = ( summary.unattributed.possible ?? [] ).slice( 0, 5 ).map( p => `${p.name} ${p.count}` ).join( ', ' );
        lines.push( `Possible procs: ${summary.unattributed.possibleEvents}${top === '' ? '' : ` (${top})`}` );
    }
    return lines.join( '\n' );
}










/**
 * Creates an element with the given class and text.
 *
 * @returns {HTMLElement} The element.
 *
 * @param {string} tag The tag name.
 * @param {string | null} className The css class.
 * @param {string | null} text The text content.
 */
function el( tag, className, text ) {
    let node = document.createElement( tag );
    if ( className ) {
        node.className = className;
    }
    if ( text != null ) {
        node.textContent = text;
    }
    return node;
}










/**
 * Shows a message in place of the recap.
 *
 * @param {string} text The message.
 * @param {boolean} isError True when the message is an error.
 */
function showMessage( text, isError ) {
    let message = document.getElementById( 'message' );
    message.textContent = text;
    message.className = isError ? 'message error' : 'message';
    message.hidden = false;
    document.getElementById( 'recap' ).hidden = true;
}










/**
 * Fills a proc table.  The procs with a hidden message are left out and counted in the hint.
 *
 * @param {string} bodyId The id of the table body.
 * @param {string} hintId The id of the element that tells how many messages are hidden.
 * @param {any[]} procs The procs.
 * @param {Set<string>} hidden The landing messages that are hidden.
 * @param {boolean} possible True for the table of possible procs.
 */
function renderProcRows( bodyId, hintId, procs, hidden, possible ) {
    let body = document.getElementById( bodyId );
    body.textContent = '';
    let shown = procs.filter( p => !hidden.has( p.text ) );
    shown.forEach( p => {
        let tr = el( 'tr' );
        tr.appendChild( el( 'td', 'hit-message', formatMessage( p ) ) );
        let name = el( 'td', possible ? 'dimmed' : null, p.name );
        if ( p.names?.length > 1 ) {
            name.title = p.names.join( ', ' );
        }
        tr.appendChild( name );
        if ( possible ) {
            tr.appendChild( el( 'td', 'sources', formatAlso( p ) ) );
        }
        tr.appendChild( el( 'td', possible ? 'num dimmed' : 'num', formatProcPush( p ) ) );
        tr.appendChild( el( 'td', 'num', `${p.count}` ) );
        let total = formatProcTotal( p );
        tr.appendChild( el( 'td', possible ? 'num dimmed' : 'num', possible && !total.startsWith( '~' ) && p.pushMin != null ? `~${total}` : total ) );
        let action = el( 'td', 'num' );
        if ( typeof p.text === 'string' && p.text !== '' ) {
            let button = el( 'button', 'hide-message', '×' );
            button.type = 'button';
            button.title = 'Hide this message from the proc tables';
            button.addEventListener( 'click', () => ipcRenderer.send( 'push-recap:hidden:set', { text: p.text, hidden: true } ) );
            action.appendChild( button );
        }
        tr.appendChild( action );
        body.appendChild( tr );
    } );
    body.parentElement.hidden = shown.length === 0;
    let count = procs.length - shown.length;
    let hint = document.getElementById( hintId );
    hint.hidden = count === 0;
    hint.textContent = ` ${count} ${count === 1 ? 'message' : 'messages'} hidden (Settings › Push Recap).`;
}





/**
 * Renders the given saved summary.  The pop-up only ever draws a summary, so a recap saved
 * by an older version, which lacks some fields, draws without those sections.
 *
 * @param {any} summary The saved summary.
 * @param {Set<string>} hidden The landing messages that are hidden.
 */
function render( summary, hidden ) {
    document.getElementById( 'message' ).hidden = true;
    document.getElementById( 'recap' ).hidden = false;

    let players = summary.players ?? [];
    let procs = summary.unattributed?.procs;
    let procHits = summary.unattributed?.events ?? 0;
    let topPlayer = players.find( p => p.name === summary.topPusher );
    let topPercent = topPlayer != null && summary.events > 0 ? Math.round( topPlayer.events * 100 / summary.events ) : 0;

    document.getElementById( 'bossName' ).textContent = summary.mob;
    document.getElementById( 'bossMeta' ).textContent = `Killed ${formatKillClock( summary )} · fight ${formatDuration( summary.fightSeconds )} · ${formatDamage( summary.damageTaken )} damage taken (HP estimate)${summary.named ? ' · named' : ''}`;

    document.getElementById( 'tileEvents' ).textContent = `${summary.events}`;
    document.getElementById( 'tileTop' ).textContent = summary.topPusher ?? '-';
    document.getElementById( 'tileTopLabel' ).textContent = summary.topPusher ? `top pusher · ${topPercent}% of hits` : 'top pusher';
    document.getElementById( 'tilePlayers' ).textContent = `${players.length}`;
    document.getElementById( 'tileValue' ).textContent = `${summary.pushValue}`;

    let rows = document.getElementById( 'playerRows' );
    rows.textContent = '';
    players.forEach( p => {
        let share = summary.events > 0 ? p.events * 100 / summary.events : 0;
        let tr = el( 'tr' );
        tr.appendChild( el( 'td', 'player', p.name ) );

        let events = el( 'td', 'num', `${p.events}` );
        if ( p.assumed > 0 ) {
            events.appendChild( el( 'span', 'assumed', ` ~${p.assumed}` ) );
        }
        tr.appendChild( events );

        let bar = el( 'span' );
        bar.style.width = `${share}%`;
        let shareCell = el( 'td' );
        let shareBox = el( 'div', 'share' );
        let barBox = el( 'div', 'bar' );
        barBox.appendChild( bar );
        shareBox.appendChild( barBox );
        shareBox.appendChild( el( 'div', 'pct', `${Math.round( share )}%` ) );
        shareCell.appendChild( shareBox );
        tr.appendChild( shareCell );

        tr.appendChild( el( 'td', 'num', `${p.pushValue}` ) );
        tr.appendChild( el( 'td', 'sources', describeSources( p, 4 ) ) );
        rows.appendChild( tr );
    } );

    if ( players.length === 0 ) {
        let tr = el( 'tr' );
        let cell = el( 'td', null, 'No push events were found in this fight.' );
        cell.colSpan = 5;
        tr.appendChild( cell );
        rows.appendChild( tr );
    }

    let hasProcs = Array.isArray( procs ) && procs.length > 0;
    document.getElementById( 'procs' ).hidden = !hasProcs;
    renderProcRows( 'procRows', 'procsHidden', hasProcs ? procs : [], hidden, false );
    let possible = summary.unattributed?.possible;
    let hasPossible = Array.isArray( possible ) && possible.length > 0;
    document.getElementById( 'possible' ).hidden = !hasPossible;
    renderProcRows( 'possibleRows', 'possibleHidden', hasPossible ? possible : [], hidden, true );
    let procsFallback = document.getElementById( 'procsFallback' );
    procsFallback.hidden = hasProcs || procHits <= 0;
    procsFallback.textContent = `${procHits} more hits came from procs with no player named. Re-scan the log to see which procs they were.`;

    document.getElementById( 'othersHint' ).hidden = summary.othersSeen !== false;

    let cutOffHint = document.getElementById( 'cutOffHint' );
    cutOffHint.hidden = summary.startsAtLogEdge !== true;
    cutOffHint.textContent = summary.reachedStart ? 'The log starts during this fight, so earlier pushes are missing.' : 'This fight began before the part of the log that was read, so earlier pushes are not counted.';

    let hasNpc = Array.isArray( summary.npcAbilities );
    document.getElementById( 'npcToggleLabel' ).hidden = !hasNpc;
    document.getElementById( 'npcAbilities' ).hidden = !hasNpc || !document.getElementById( 'npcToggle' ).checked;
    let npcRows = document.getElementById( 'npcRows' );
    npcRows.textContent = '';
    if ( hasNpc ) {
        summary.npcAbilities.forEach( a => {
            let tr = el( 'tr' );
            tr.appendChild( el( 'td', null, a.actor ) );
            tr.appendChild( el( 'td', null, a.name ) );
            tr.appendChild( el( 'td', 'num', `${a.count}` ) );
            tr.appendChild( el( 'td', 'num', `${a.push}` ) );
            npcRows.appendChild( tr );
        } );
        if ( summary.npcAbilities.length === 0 ) {
            let tr = el( 'tr' );
            let cell = el( 'td', null, 'No NPC push abilities were found in this fight.' );
            cell.colSpan = 4;
            tr.appendChild( cell );
            npcRows.appendChild( tr );
        }
    }
}










/**
 * The push recap screen.  Shows a snapshot of one fight and never refreshes it.  The snapshot is
 * either handed over by the Push tab, or built from the end of the log once, when there is none.
 *
 * @param {{ logFilePath: string, characterName: string, eqFolder: string, userData: string, quietGapSeconds: number, saveRecaps: boolean, snapshot: boolean }} params The window parameters.
 */
async function PushRecap( params ) {

    document.getElementById( 'characterName' ).textContent = params.characterName;
    document.getElementById( 'closeButton' ).addEventListener( 'click', () => ipcRenderer.send( 'window:child:close' ) );
    document.getElementById( 'npcToggle' ).addEventListener( 'change', e => document.getElementById( 'npcAbilities' ).hidden = !e.target.checked );

    let quietGapSeconds = params.quietGapSeconds >= 5 && params.quietGapSeconds <= 300 ? params.quietGapSeconds : 30;
    let shown = null;

    document.getElementById( 'copyButton' ).addEventListener( 'click', () => {
        if ( shown != null ) {
            ipcRenderer.send( 'clipboard:writeText', buildSummaryText( shown ) );
            document.getElementById( 'copyButton' ).textContent = 'Copied';
        }
    } );

    let hidden = new Set();
    ipcRenderer.on( 'push-recap:hidden-changed', ( event, texts ) => {
        hidden = new Set( texts );
        if ( shown != null ) {
            render( shown, hidden );
        }
    } );

    let state = 'unsaved';
    let clicked = false;
    let saveButton = document.getElementById( 'saveButton' );
    let showSaveState = () => {
        saveButton.textContent = state === 'saved' ? 'Saved' : state === 'pending' ? 'Saving...' : state === 'failed' ? "Couldn't save - try again" : 'Save to Push tab';
        saveButton.disabled = state === 'saved' || state === 'pending';
        saveButton.hidden = shown == null || ( !clicked && ( state === 'saved' || state === 'pending' ) );
    };
    let save = () => {
        if ( shown != null && state !== 'saved' && state !== 'pending' ) {
            state = 'pending';
            ipcRenderer.send( 'push-recaps:save', Object.assign( {}, shown, { id: '', saveKey: 0 } ) );
            showSaveState();
        }
    };
    saveButton.addEventListener( 'click', () => {
        clicked = true;
        save();
    } );
    ipcRenderer.on( 'push-recaps:saved', ( event, reply ) => {
        state = reply.ok ? 'saved' : 'failed';
        showSaveState();
    } );

    let show = ( summary, saved ) => {
        shown = summary;
        state = saved ? 'saved' : 'unsaved';
        document.getElementById( 'copyButton' ).textContent = 'Copy summary';
        showSaveState();
        render( summary, hidden );
    };

    try {
        hidden = new Set( await ipcRenderer.invoke( 'push-recap:hidden:get' ).catch( () => [] ) );
        if ( params.snapshot ) {
            let snapshot = await ipcRenderer.invoke( 'push-recap:snapshot' );
            if ( snapshot?.recap == null || typeof snapshot.recap !== 'object' ) {
                showMessage( 'There is no fight to show. Pick one in the Push tab.', false );
                return;
            }
            show( snapshot.recap, snapshot.saved === true );
            return;
        }

        showMessage( 'Loading spell data...', false );
        let table = await loadPushSpells( params.eqFolder, params.userData );
        let landing = buildLandingIndex( table );

        showMessage( 'Reading the log...', false );
        let session = await readSession( params.logFilePath, params.characterName, landing );
        let summary = summarize( session );

        if ( summary.kills.length === 0 ) {
            showMessage( 'No kills were found in the 30 minutes of log before the hotkey.', false );
            return;
        }

        show( buildSavedSummary( analyzeKill( session, summary, table, landing, summary.kills[ summary.defaultKill ], quietGapSeconds ), params.characterName ), false );
        if ( params.saveRecaps ) {
            save();
        }

    } catch ( error ) {
        showMessage( error.code === 'no-folder' || error.code === 'no-file' ? error.message : `The push recap could not be built: ${error.message}`, true );
    }

}

module.exports = PushRecap;

import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';

export interface PerfHint {
    code: string;
    text: string;
}

export interface PerfRow {
    triggerId: string;
    name: string;
    checked: number;
    fired: number;
    totalMs: number;
    maxMs: number;
    sharePercent: number;
    avgMsPerCheck: number;
    skipped: boolean;
    hints: PerfHint[];
}

export interface PerfReport {
    startedAt: number;
    endedAt: number;
    lineCount: number;
    totalMs: number;
    rows: PerfRow[];
}

export interface PerfCharacter {
    characterId: string;
    name: string;
    watching: boolean;
    hasReport: boolean;
}

export interface PerfFinished {
    characterId: string;
    saved: boolean;
}

export interface PerfState {
    characterId?: string;
    measuring: boolean;
    startedAt?: number;
    endsAt?: number;
    last: PerfReport | null;
}

@Injectable( { providedIn: 'root' } )
export class TriggerPerfService {

    /** Emits when a measurement finished and its report was stored. */
    public readonly finished$ = new Subject<PerfFinished>();

    constructor( private readonly ngZone: NgZone ) {
        if ( window.api ) {
            window.api.ipc.on( 'trigger-perf:finished', ( e: any, data: PerfFinished ) => this.ngZone.run( () => this.finished$.next( data ) ) );
        }
    }

    /**
     * Starts a ten minute measurement; started is false when the character is not being watched.
     *
     * @param characterId The character; the first watched one if omitted.
     */
    public start( characterId?: string ): Promise<{ started: boolean }> {
        return window.api.ipc.invoke( 'trigger-perf:start', characterId );
    }

    /**
     * Ends the measurement early.
     *
     * @param characterId The character; the first watched one if omitted.
     */
    public stop( characterId?: string ): Promise<{ stopped: boolean }> {
        return window.api.ipc.invoke( 'trigger-perf:stop', characterId );
    }

    /**
     * Gets the state of the measurement and the last finished report, which is read from disk when no log watcher is running.
     *
     * @param characterId The character; the first watched one, else the last measured, if omitted.
     */
    public get( characterId?: string ): Promise<PerfState> {
        return window.api.ipc.invoke( 'trigger-perf:get', characterId );
    }

    /** Lists the characters that are being watched or have a stored report. */
    public characters(): Promise<PerfCharacter[]> {
        return window.api.ipc.invoke( 'trigger-perf:characters' );
    }

}

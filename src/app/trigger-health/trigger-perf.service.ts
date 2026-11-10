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
    public readonly finished$ = new Subject<void>();

    constructor( private readonly ngZone: NgZone ) {
        if ( window.api ) {
            window.api.ipc.on( 'trigger-perf:finished', () => this.ngZone.run( () => this.finished$.next() ) );
        }
    }

    /** Starts a ten minute measurement; started is false when no character is being watched. */
    public start(): Promise<{ started: boolean }> {
        return window.api.ipc.invoke( 'trigger-perf:start' );
    }

    /** Ends the measurement early. */
    public stop(): Promise<{ stopped: boolean }> {
        return window.api.ipc.invoke( 'trigger-perf:stop' );
    }

    /** Gets the state of the measurement and the last finished report. */
    public get(): Promise<PerfState> {
        return window.api.ipc.invoke( 'trigger-perf:get' );
    }

}

import { ActionTypes, TriggerAction } from 'src/app/core.model';

export interface ActionPickerOption {
    type: ActionTypes;
    description: string;
}

export interface ActionPickerGroup {
    name: string;
    advanced: boolean;
    options: ActionPickerOption[];
}

/** The groups of the action picker, in display order.  Advanced groups only show when the player asks for them. */
export const ActionPickerGroups: ActionPickerGroup[] = [
    {
        name: 'Alerts',
        advanced: false,
        options: [
            { type: ActionTypes.DisplayText, description: 'Show a message on screen.' },
            { type: ActionTypes.Speak, description: 'Say something out loud.' },
            { type: ActionTypes.PlayAudio, description: 'Play a saved sound.' },
            { type: ActionTypes.DisplayDeathRecap, description: 'Open the death recap window.' },
        ],
    },
    {
        name: 'Timers',
        advanced: false,
        options: [
            { type: ActionTypes.Timer, description: 'A bar that counts down from a set time.' },
            { type: ActionTypes.Countdown, description: 'A countdown shown on a timer overlay.' },
            { type: ActionTypes.BeneficialTimer, description: 'Counts down until a buff you cast wears off.' },
            { type: ActionTypes.DotTimer, description: 'Counts down until a damage-over-time spell wears off.' },
        ],
    },
    {
        name: 'Advanced',
        advanced: true,
        options: [
            { type: ActionTypes.Stopwatch, description: 'Counts up from zero until stopped.' },
            { type: ActionTypes.Counter, description: 'Counts how many times something happens.' },
            { type: ActionTypes.List, description: 'Build and show a list from the log.' },
            { type: ActionTypes.StoreVariable, description: 'Keep a word or number from the log for other triggers.' },
            { type: ActionTypes.ClearVariable, description: 'Empty a value kept earlier.' },
            { type: ActionTypes.Clipboard, description: 'Copy text so you can paste it in game.' },
            { type: ActionTypes.ScreenGlow, description: 'Flash a glow around the screen.' },
            { type: ActionTypes.ClearAll, description: 'Stop every timer, sound and stored value.' },
        ],
    },
];

const advancedTypes: ActionTypes[] = ActionPickerGroups.filter( g => g.advanced ).flatMap( g => g.options.map( o => o.type ) );

export function isAdvancedActionType( actionType: ActionTypes ): boolean {
    return advancedTypes.includes( actionType );
}

export function actionTypeDescription( actionType: ActionTypes ): string {
    for ( const group of ActionPickerGroups ) {
        const option = group.options.find( o => o.type === actionType );
        if ( option ) {
            return option.description;
        }
    }
    return '';
}

/** Formats a length in seconds the way players say it: 45 s, 2:00. */
export function formatSeconds( seconds: number ): string {
    if ( !( seconds > 0 ) ) {
        return '';
    }
    if ( seconds < 60 ) {
        return `${seconds} s`;
    }
    const minutes = Math.floor( seconds / 60 );
    const rest = Math.round( seconds % 60 );
    return `${minutes}:${rest < 10 ? '0' : ''}${rest}`;
}

/** A short plain-English summary of what the action does, for compact lists. */
export function summarizeAction( action: TriggerAction ): string {
    const quoted = ( text: string ) => text?.length > 0 ? `"${text}"` : '';
    const duration = formatSeconds( action.duration );
    const parts: string[] = [];
    switch ( action.actionType ) {
        case ActionTypes.DisplayText:
            parts.push( quoted( action.displayText ) || '(no text yet)' );
            duration && parts.push( duration );
            break;
        case ActionTypes.Speak:
            parts.push( quoted( action.displayText ) || '(nothing to say yet)' );
            break;
        case ActionTypes.PlayAudio:
            parts.push( action.audioFileId ? 'Saved sound' : '(no sound picked yet)' );
            break;
        case ActionTypes.Timer:
        case ActionTypes.Countdown:
        case ActionTypes.BeneficialTimer:
        case ActionTypes.Stopwatch:
            action.displayText?.length > 0 && parts.push( quoted( action.displayText ) );
            duration && parts.push( duration );
            break;
        case ActionTypes.DotTimer:
            duration && parts.push( duration );
            break;
        case ActionTypes.Counter:
        case ActionTypes.Clipboard:
            action.displayText?.length > 0 && parts.push( quoted( action.displayText ) );
            break;
        case ActionTypes.StoreVariable:
        case ActionTypes.ClearVariable:
            action.variableName?.length > 0 && parts.push( action.variableName );
            break;
        default:
            break;
    }
    return parts.join( ' · ' );
}

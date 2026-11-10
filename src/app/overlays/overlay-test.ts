import { ActionTypes, OverlayWindowModel, TimerRestartBehaviors } from '../core.model';
import { IpcService } from '../ipc.service';
import { ColorUtility } from '../utilities';
import { customAlphabet } from 'nanoid';
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const nanoid = customAlphabet( alphabet, 16 );

/**
 * Whether Nag has a sample to show for the given overlay type.
 * 
 * @param overlayType The overlay type value.
 */
export function canSendOverlayTest( overlayType: string ): boolean {
    return overlayType === 'Timer' || overlayType === 'Alert';
}

/**
 * Sends sample timers or sample text to the specified overlay.
 * 
 * @param ipcService The IPC service.
 * @param overlay The overlay to send the sample to.
 */
export function sendOverlayTest( ipcService: IpcService, overlay: Pick<OverlayWindowModel, 'overlayId' | 'overlayType'> ): void {
    if ( overlay.overlayType === 'Timer' ) {
        let timers: any[] = [
            { name: 'Dot 01', triggerName: 'Dot 01', duration: 48, target: 'Mob 01', matches: { 0: '', 1: 'Mob 01', groups: { target: 'Mob 01' } }, delay: 0 * 1000, overrideTimerColor: '#CC5500', timerBackgroundColor: ColorUtility.FromHex( '#CC5500' ).darken( 0.93 ).toString( 0.75 ) },
            { name: 'Dot 02', triggerName: 'Dot 02', duration: 30, target: 'Mob 01', matches: { 0: '', 1: 'Mob 01', groups: { target: 'Mob 01' } }, delay: 2 * 1000, ifEndingSoon: true, endingDuration: 24, endingSoonChangeColor: true, endingSoonColor: '#800000', endingSoonBackgroundColor: ColorUtility.FromHex( '#800000' ).darken( 0.93 ).toString( 0.75 ) },
            { name: 'Dot 03', triggerName: 'Dot 03', duration: 54, target: 'Mob 01', matches: { 0: '', 1: 'Mob 01', groups: { target: 'Mob 01' } }, delay: 4 * 1000, overrideTimerColor: null, timerBackgroundColor: null },
            { name: 'Dot 04', triggerName: 'Dot 04', duration: 60, target: 'Mob 02', matches: { 0: '', 1: 'Mob 02', groups: { target: 'Mob 02' } }, delay: 6 * 1000, overrideTimerColor: null, timerBackgroundColor: null },
            { name: 'Dot 05', triggerName: 'Dot 05', duration: 48, target: 'Mob 02', matches: { 0: '', 1: 'Mob 02', groups: { target: 'Mob 02' } }, delay: 8 * 1000, overrideTimerColor: null, timerBackgroundColor: null },
            { name: 'Dot 06', triggerName: 'Dot 06', duration: 42, target: 'Mob 03', matches: { 0: '', 1: 'Mob 03', groups: { target: 'Mob 03' } }, delay: 10 * 1000, overrideTimerColor: null, timerBackgroundColor: null },
            { name: 'Dot 07', triggerName: 'Dot 07', duration: 36, target: 'Mob 03', matches: { 0: '', 1: 'Mob 03', groups: { target: 'Mob 03' } }, delay: 12 * 1000, overrideTimerColor: null, timerBackgroundColor: null },
            { name: 'Dot 08', triggerName: 'Dot 08', duration: 30, target: 'Mob 03', matches: { 0: '', 1: 'Mob 03', groups: { target: 'Mob 03' } }, delay: 14 * 1000, overrideTimerColor: null, timerBackgroundColor: null },
        ];
        timers.forEach( f => {
            let comp = {
                instanceId: nanoid(),
                triggerName: f.triggerName,
                action: {
                    actionId: nanoid(),
                    displayText: `${f.name} --== {1} ==--`,
                    restartBehavior: TimerRestartBehaviors.RestartOnDuplicate,
                    duration: f.duration,
                    actionType: ActionTypes.DotTimer,
                    overrideTimerColor: f.overrideTimerColor,
                    timerBackgroundColor: f.timerBackgroundColor,
                    ifEndingSoon: f.ifEndingSoon,
                    endingDuration: f.endingDuration,
                    endingSoonChangeColor: f.endingSoonChangeColor,
                    endingSoonColor: f.endingSoonColor,
                    endingSoonBackgroundColor: f.endingSoonBackgroundColor,
                    timerIcon: 'data:image/png;base64,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',
                },
                overlayId: overlay.overlayId,
                matches: f.matches,
                timestamp: new Date(),
            };
            
            window.setTimeout( () => {
                comp.timestamp = new Date();
                ipcService.sendOverlayComponent( comp );
            }, f.delay );
        } );
    } else {
        let phrases: string[] = [
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
            'Vivamus viverra luctus nibh, porta consequat neque mattis a.',
            'Etiam mollis justo felis, non suscipit velit commodo sed.',
            'Maecenas lobortis mi sed felis scelerisque viverra.',
            'Phasellus nec nibh a nulla porttitor gravida.',
        ];
        phrases.forEach( phrase => {
            let comp: any = {
                overlayId: overlay.overlayId,
                action: {
                    actionType: ActionTypes.DisplayText,
                    duration: Math.floor(Math.random() * 5) + 10,
                    displayText: phrase,
                }
            }
            ipcService.sendOverlayComponent( comp );
        } );
    }
}

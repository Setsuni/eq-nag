import { ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnDestroy, OnInit, Output, ViewChild } from '@angular/core';
import { DialogService } from 'src/app/dialogs/dialog.service';
import { IpcService } from 'src/app/ipc.service';
import { MatTable } from '@angular/material/table';
import { customAlphabet } from 'nanoid';
import { ActionTypes, AuthorModel, CapturePhrase, DeathRecapPreferences, LogMaintenanceRules, LogMaintenancePlanTypes, OverlayWindowModel, QuickShareAuthorListTypes, TriggerAction, TriggerModel, ScheduledTask, Range, SettingsKeys, SharedTriggerPermissions, DpsMeterSettings, FileReadDelays } from 'src/app/core.model';
import { SettingsService } from '../settings-http.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SetupService } from 'src/app/setup/setup.service';
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const nanoid = customAlphabet( alphabet, 16 );
import * as _ from 'lodash-es';
import { CharactersListComponent } from 'src/app/characters-list/characters-list.component';
import { nagId } from 'src/app/core/nag-id.util';
import { DateUtilities } from 'src/app/utilities/date.utilities';
import { MathUtilities } from 'src/app/utilities/math.utilities';
import { RollTrackerSettings } from 'src/app/rolls/rolls.component';
import { TriggerHealthComponent } from 'src/app/trigger-health/trigger-health.component';
import { HealthSummary, TriggerHealthService } from 'src/app/trigger-health/trigger-health.service';

interface IPhoneticTransform {
    id: string;
    originalText?: string;
    phoneticText?: string;
}

interface IWatchStatus {
    characterId: string;
    name: string;
    class: string | null;
    watching: boolean;
    lastLineAt: number | null;
}

interface ISettingsSection {
    id: string;
    label: string;
}

const advancedStorageKey = 'nagSettingsAdvanced';

@Component( {
    selector: 'app-settings',
    templateUrl: 'settings.component.html', 
    styleUrls: [ 'settings.component.scss', '../../core.scss' ],
} )
export class SettingsComponent implements OnInit, OnDestroy {

    public readonly sections: ISettingsSection[] = [
        { id: 'status', label: 'Status' },
        { id: 'characters', label: 'Characters & log' },
        { id: 'overlays', label: 'Overlays' },
        { id: 'sound', label: 'Sound & voice' },
        { id: 'sharing', label: 'Sharing' },
        { id: 'rolls', label: 'Roll tracker' },
        { id: 'death', label: 'Death recap' },
        { id: 'combat', label: 'Combat' },
        { id: 'advanced', label: 'Advanced' },
        { id: 'diagnostics', label: 'Diagnostics' },
    ];
    public section: string = 'status';
    public advancedOpen: boolean = false;
    public watchStatus: IWatchStatus[] = [];
    public statusNow: number = Date.now();
    public triggerCount: number = 0;
    public activeTriggerCount: number = 0;
    public healthSummary: HealthSummary | null = null;
    private statusTimerId: any = null;
    private statusActive: boolean = false;

    public phoneticTransforms: IPhoneticTransform[] = [];
    public phoneticTransformsModified: boolean = false;
    public version: string;
    public guidesUrl: string = 'https://guildantix.github.io/eq-nag/';
    public masterVolume: number = 100;
    public speechVolume: number = 100;
    public audioVolume: number = 100;
    public voiceOptions: SpeechSynthesisVoice[] = [];
    public voiceIndex: number = null;
    public author: AuthorModel = new AuthorModel();
    public trustedAuthor: boolean = false;
    public detrimentalOverlayId: string = null;
    public beneficialOverlayId: string = null;
    public alertOverlayId: string = null;
    public enableQuickShareImports: boolean = false;
    public sharedTriggerPermissions: SharedTriggerPermissions = new SharedTriggerPermissions();
    public deathRecapPreferences: DeathRecapPreferences = new DeathRecapPreferences();
    public minimizeToTrayOnLoad: boolean = false;
    public glowOnStartup: boolean = true;
    public quickShareAuthorListTypes: typeof QuickShareAuthorListTypes = QuickShareAuthorListTypes;
    public quickShareAuthorListType: QuickShareAuthorListTypes;
    public quickShareAuthorList: string = '';
    public settingsKeys: typeof SettingsKeys = SettingsKeys;
    public logMaintenancePlanTypes: typeof LogMaintenancePlanTypes = LogMaintenancePlanTypes; 
    public logMaintenanceRules: LogMaintenanceRules = new LogMaintenanceRules();
    public logTime: string|null;
    public logDays: number[] = [];
    public allowPrerelease: boolean = false;
    public enableCheckWindowPosition: boolean = true;
    // public enableGpuAcceleration: boolean = false;
    public exampleSpeech: string = 'Hello, my name is nag.';
    public baseSpeakingRate: number = 1;
    public utter: SpeechSynthesisUtterance | undefined = undefined;
    public updatedSettings: string[] = [];
    public rollSettings: RollTrackerSettings | null = null;
    public rollDefaults: RollTrackerSettings | null = null;
    private fileReadDelays: FileReadDelays | null = null;
    private rollAdvancedChecked: boolean = false;

    public get timerOverlays(): OverlayWindowModel[] {
        return this.overlays?.filter( m => m.overlayType === 'Timer' );
    }

    public get alertOverlays(): OverlayWindowModel[] {
        return this.overlays?.filter( m => m.overlayType === 'Alert' );
    }

    private overlays: OverlayWindowModel[] = [];

    @Input() public characterList: CharactersListComponent;
    @Output() public openCombat = new EventEmitter<void>();
    @ViewChild( 'triggerHealthSection', { static: true } ) public triggerHealthSection: ElementRef<HTMLElement>;
    @ViewChild( 'triggerHealth', { static: true } ) public triggerHealth: TriggerHealthComponent;

    constructor(
        private readonly ipcService: IpcService,
        private readonly dialogService: DialogService,
        private readonly settingsService: SettingsService,
        private readonly snackBar: MatSnackBar,
        private readonly setupService: SetupService,
        private readonly ngZone: NgZone,
        private readonly healthService: TriggerHealthService,
    ) {
        speechSynthesis.onvoiceschanged = () => {
            this.voiceOptions = speechSynthesis.getVoices();
        };
    }

    ngOnInit() {

        let storedAdvanced: any = null;
        try {
            storedAdvanced = JSON.parse( localStorage.getItem( advancedStorageKey ) );
        } catch ( error ) { }
        this.advancedOpen = storedAdvanced != null && typeof storedAdvanced === 'object' ? Object.values( storedAdvanced ).some( open => open === true ) : storedAdvanced === true;

        this.healthService.summary$.subscribe( summary => this.healthSummary = summary );

        this.ipcService.getAppVersion().subscribe( version => this.version = version );
        
        this.ipcService.tickReceived().subscribe( data => {
            this.masterVolume = data.masterVolume;
            this.speechVolume = data.speechVolume;
            this.audioVolume = data.audioVolume;
            this.baseSpeakingRate = data.baseSpeakingRate;
            this.voiceIndex = data.voiceIndex;
            this.overlays = data.overlays;
            this.triggerCount = data.triggers?.length ?? 0;
            this.activeTriggerCount = data.triggers?.filter( t => t.enabled !== false ).length ?? 0;

            this.phoneticTransforms = [];
            if ( data.phoneticTransforms ) {
                for ( let key of Object.keys( data.phoneticTransforms ) ) {
                    this.phoneticTransforms.push( { id: nanoid(), originalText: key, phoneticText: data.phoneticTransforms[ key ] } );
                }
            }

        } );

        window.api.ipc.on( 'rolls:state', ( event: any, state: { settings: RollTrackerSettings, defaults: RollTrackerSettings } ) => {
            this.ngZone.run( () => {
                this.rollSettings = state.settings;
                this.rollDefaults = state.defaults;
                if ( !this.advancedOpen && !this.rollAdvancedChecked && state.settings?.advancedOpen ) {
                    this.advancedOpen = true;
                }
                this.rollAdvancedChecked = true;
            } );
        } );
        window.api.ipc.send( 'rolls:get', null );

        this.loadSettings();
    }

    /**
     * Saves changed roll tracker settings; a null value restores that setting's default.
     */
    updateRollSettings( changes: { [ K in keyof RollTrackerSettings ]?: RollTrackerSettings[ K ] | null } ): void {
        window.api.ipc.send( 'rolls:settings:set', changes );
    }

    /**
     * Saves a roll tracker text setting; a blank value restores the default, which is shown in the box again.
     */
    saveRollText( input: HTMLInputElement, key: 'pastePrefix' | 'pasteTemplate' | 'speakWinnerPhrase' | 'speakTiePhrase' ): void {
        if ( input.value.trim() === '' ) {
            input.value = this.rollDefaults?.[ key ] ?? '';
            this.updateRollSettings( { [ key ]: null } );
        } else {
            this.updateRollSettings( { [ key ]: key === 'pastePrefix' ? input.value.trim() : input.value } );
        }
    }

    /**
     * Saves a roll tracker number setting clamped to min and max; a blank value restores the default. The box shows the saved value.
     */
    saveRollNumber( input: HTMLInputElement, key: 'closeAfterSeconds' | 'topCount' | 'resultSeconds', min: number, max: number ): void {
        const value = this.toRollNumber( input.value, min, max );
        input.value = String( value ?? this.rollDefaults?.[ key ] ?? '' );
        this.updateRollSettings( { [ key ]: value } );
    }

    /**
     * Speaks the phrase with sample values, using the default phrase when it is blank.
     */
    previewRollPhrase( phrase: string, kind: 'winner' | 'tie' ): void {
        const fallback = ( kind === 'winner' ? this.rollDefaults?.speakWinnerPhrase : this.rollDefaults?.speakTiePhrase ) ?? '';
        const sample: Record<string, string> = { winner: 'Soandso', winners: 'Soandso, Brindle', roll: '692', min: '0', max: '1000', count: '3' };
        const text = phrase?.trim() ? phrase : fallback;
        try {
            const utterance = new SpeechSynthesisUtterance( text.replace( /\$\{(winner|winners|roll|min|max|count)\}/g, ( match, key ) => sample[ key ] ) );
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak( utterance );
        } catch ( error ) {
            console.error( 'Roll Tracker > Failed to speak the preview', error );
        }
    }

    /**
     * Returns the input value as a whole number between min and max, or null, which restores the default, when it is not a number.
     */
    toRollNumber( value: string, min: number, max: number ): number | null {
        const parsed = Math.round( +value );
        return value.trim() === '' || isNaN( parsed ) ? null : Math.min( max, Math.max( min, parsed ) );
    }









    
    /**
     * Shows the update notes window.
     */
    showUpdateNotes(): void {
        this.ipcService.getAppVersion().subscribe( currentVersion => {
            this.ipcService.showUpdateNotesWindow( `v${currentVersion}` );
        } );
    }










    /**
     * Loads the settings data.
     */
    public loadSettings() {
        
        this.ipcService.getPhoneticTransforms().subscribe( transforms => {
            this.phoneticTransforms = [];
            if ( transforms ) {
                for ( let key of Object.keys( transforms ) ) {
                    this.phoneticTransforms.push( { id: nanoid(), originalText: key, phoneticText: transforms[ key ] } );
                }
            }
        } );
        
        this.ipcService.getAuthor().subscribe( author => {
            if ( author != null ) {
                this.author = author;
                this.settingsService.isTrusted( author.authorId ).subscribe( trusted => this.trustedAuthor = trusted );
            }
        } );

        this.ipcService.getOverlayWindows().subscribe( overlays => this.overlays = overlays );
        this.ipcService.getDetrimentalOverlayId().subscribe( id => this.detrimentalOverlayId = id );
        this.ipcService.getBeneficialOverlayId().subscribe( id => this.beneficialOverlayId = id );
        this.ipcService.getAlertOverlayId().subscribe( id => this.alertOverlayId = id );
        this.ipcService.getEnableQuickShareImports().subscribe( enabled => this.enableQuickShareImports = enabled );
        this.ipcService.getMinimizeToTrayOnLoad().subscribe( enabled => this.minimizeToTrayOnLoad = enabled );
        this.ipcService.getDeathRecapPreferences().subscribe( recapPrefs => this.deathRecapPreferences = recapPrefs ?? new DeathRecapPreferences() );
        this.ipcService.getEnableGlowOnStartup().subscribe( f => this.glowOnStartup = f );
        this.ipcService.getQuickShareAuthorsListType().subscribe( f => this.quickShareAuthorListType = f );
        this.ipcService.getQuickShareAuthorsList().subscribe( f => {
            this.quickShareAuthorList = f == null ? '' : f.join( '\r\n' );
        } );

        this.ipcService.getSetting<FileReadDelays>( 'fileReadDelays', false ).subscribe( f => this.fileReadDelays = f );
        this.ipcService.getSetting<boolean>( SettingsKeys.allowPrerelease ).subscribe( f => this.allowPrerelease = f );
        this.ipcService.getSetting<boolean>( SettingsKeys.enableCheckWindowPosition ).subscribe( f => this.enableCheckWindowPosition = f );

        // this.ipcService.getSetting<boolean>( SettingsKeys.enableGpuAcceleration ).subscribe( f => this.enableGpuAcceleration = f );
        this.ipcService.getSetting<LogMaintenanceRules>( SettingsKeys.logMaintenanceRules ).subscribe( f => {

            this.logMaintenanceRules = f;
            this.logTime = `${f.logSchedule?.hour ?? 0}:${f.logSchedule?.minute ?? 0}`;

            if ( f.logSchedule?.dayOfWeek instanceof Array ) {
                this.logDays = f.logSchedule.dayOfWeek;
            } else if (f.logSchedule?.dayOfWeek instanceof Range || (f.logSchedule?.dayOfWeek.hasOwnProperty('start') && f.logSchedule.dayOfWeek.hasOwnProperty('end'))) {
                this.logDays = Range.toArray( f.logSchedule.dayOfWeek as Range );
            } else if ( f.logSchedule?.dayOfWeek > 0 ) {
                this.logDays.push( +f.logSchedule.dayOfWeek );
            }

        } );
        this.ipcService.getSetting<SharedTriggerPermissions>( SettingsKeys.sharedTriggerPermissions ).subscribe( f => this.sharedTriggerPermissions = f ?? new SharedTriggerPermissions() );

    }

    public saveLogMaintenance(): void {

        if ( this.logMaintenanceRules.maintenancePlan === LogMaintenancePlanTypes.BySize ) {

            if ( !this.logMaintenanceRules.maxLogFileSizeMb || +this.logMaintenanceRules.maxLogFileSizeMb < 1 ) {
                this.logMaintenanceRules.maxLogFileSizeMb = 50;
            }

        } else if ( this.logMaintenanceRules.maintenancePlan === LogMaintenancePlanTypes.BySchedule ) {
            
            if ( !this.logTime && this.logDays.length > 0 ) {
                // If the user selects a day without selecting a time, default time is midnight.
                this.logTime = '12:00 AM';
            }

            if ( this.logTime ) {
                let logMaintenanceTime = DateUtilities.parseTimeString( this.logTime );
                this.logMaintenanceRules.logSchedule = new ScheduledTask();
                this.logMaintenanceRules.logSchedule.second = logMaintenanceTime.seconds;
                this.logMaintenanceRules.logSchedule.minute = logMaintenanceTime.minute;
                this.logMaintenanceRules.logSchedule.hour = logMaintenanceTime.hour;
                this.logMaintenanceRules.logSchedule.dayOfWeek = this.logDays;
            }

        }
        
        this.updateSetting( this.settingsKeys.logMaintenanceRules, this.logMaintenanceRules, 5 * 1000 );
    }









    
    /**
     * Generic setting update function.
     * 
     * @param key The setting key.
     * @param value The setting value.
     * @param delay Wait the given milliseconds before submitting changes.  If another change for the same key comes, the timeout is restarted.
     */
    public updateSetting<T>( key: SettingsKeys, value: T, delay: number = null, onExecuted: () => void = null ) {
        this.ipcService.updateSetting( key, value, delay, onExecuted );
        this.updatedSettings.push( key );
    }









    
    /**
     * Saves changes to the user preference.
     */
    onQuickShareImportsChange(): void {
        if ( this.quickShareAuthorList ) {
            let list = this.quickShareAuthorList.split( /\r\n|\n|\r/g ).filter( f => f != '' );
            this.ipcService.updateQuickShareAuthorsList( list );
        } else {
            this.ipcService.updateQuickShareAuthorsList( [] );
        }
        this.ipcService.updateEnableQuickShareImports( this.enableQuickShareImports );
        this.ipcService.updateQuickShareAuthorsListType( this.quickShareAuthorListType ?? QuickShareAuthorListTypes.Disabled );
    }









    
    /**
     * Saves changes to the user preference.
     */
    onGlowOnStartupChanged(): void {
        this.ipcService.updateEnableGlowOnStartup( this.glowOnStartup );
    }










    /**
     * Saves changes to the user preference.
     */
    onMinimizeToTrayOnLoadChange(): void {
        this.ipcService.updateMinimizeToTrayOnLoad( this.minimizeToTrayOnLoad );
    }










    /**
     * Saves changes to the death recap preferences.
     */
    onDeathRecapPrefsChange(): void {
        
        let capturePhrase = new CapturePhrase();
        capturePhrase.phraseId = nagId();
        capturePhrase.requirePreviousPhrase = false;
        capturePhrase.useRegEx = true;
        capturePhrase.duration = null;

        if ( this.deathRecapPreferences.engageMode === 'hotkey' ) {
            this.deathRecapPreferences.hotkeyPhrase = '/hot "Death Recap" /em wonders how they died.';
            // Live servers prefix /emote messages with "~ "; emulators don't.
            capturePhrase.phrase = '^(?:~ )?${Character} wonders how they died\\.$';

        } else if ( this.deathRecapPreferences.engageMode === 'automatic' ) {
            capturePhrase.phrase = '^You have been slain by (?<slayer>[^!]*)!$';
            this.deathRecapPreferences.hotkeyPhrase = null;

        } else {
            return;
        }

        if ( this.deathRecapPreferences.triggerId != null ) {

            this.ipcService.getTrigger( this.deathRecapPreferences.triggerId ).subscribe( trigger => {
                
                // Rename the trigger.
                trigger.name = `Death Recap [${this.deathRecapPreferences.engageMode === 'hotkey' ? 'Hotkey' : 'Auto'}]`;
                
                // Assign the built capture phrase.
                trigger.capturePhrases = [ capturePhrase ];

                // Build the trigger action and assign to existing trigger.
                let action = new TriggerAction();
                action.phrases = [ capturePhrase.phraseId ];
                action.actionType = ActionTypes.DisplayDeathRecap;
                action.actionId = nagId();
                trigger.actions = [ action ];
                
                this.ipcService.updateTrigger( trigger ).subscribe( success => {
                    this.ipcService.updateDeathRecapPreferences( this.deathRecapPreferences );
                    this.snackBar.open( 'The death recap trigger has been updated!', 'Dismiss', { duration: 5000 } );
                } );
            } );
            
        } else {

            this.dialogService.showSelectTriggerFolderDialog( null, 'Choose a folder', 'Select the folder that will contain the generated trigger.' ).subscribe( folderId => {
                if ( folderId ) {
                    
                    // Initialize a new trigger model.
                    let trigger = new TriggerModel();
                    trigger.name = `Death Recap [${this.deathRecapPreferences.engageMode === 'hotkey' ? 'Hotkey' : 'Auto'}]`;
                    trigger.folderId = folderId;
            
                    // Assign the built capture phrase.
                    trigger.capturePhrases = [ capturePhrase ];

                    // Build the trigger action.
                    let action = new TriggerAction();
                    action.phrases = [ capturePhrase.phraseId ];
                    action.actionType = ActionTypes.DisplayDeathRecap;
                    action.actionId = nagId();
                    trigger.actions = [ action ];

                    this.ipcService.createNewTrigger( trigger ).subscribe( triggerId => {

                        // Save the death recap preferences.
                        this.deathRecapPreferences.triggerId = triggerId;

                        this.ipcService.updateDeathRecapPreferences( this.deathRecapPreferences );
                        this.snackBar.open( 'The death recap trigger has been created!', 'Dismiss', { duration: 5000 } );
                    } );
                }
            } );
        }

    }










    /**
     * Copies the death recap command to the user's clipboard.
     */
    onCopyDeathRecapHotkeyCommand(): void {
        this.ipcService.sendTextToClipboard( this.deathRecapPreferences.hotkeyPhrase );

        this.snackBar.open( 'The command has been copied to your clipboard!', 'Dismiss', { duration: 5000 } );
    }









    
    /**
     * Checks the triggers again, so the Trigger Health section is current.
     */
    refreshTriggerHealth(): void {
        this.triggerHealth.check();
    }










    /**
     * Opens the Diagnostics section and brings the Trigger Health card to the top of the view.
     */
    scrollToTriggerHealth(): void {
        this.selectSection( 'diagnostics' );
        setTimeout( () => this.triggerHealthSection.nativeElement.scrollIntoView( { block: 'start' } ) );
    }

    /**
     * Shows one section of the page.
     */
    selectSection( id: string ): void {
        this.section = id;
        this.updateStatusTimer();
    }

    /**
     * Shows or hides the Advanced part of every section; the choice is remembered.
     */
    toggleAdvanced(): void {
        this.advancedOpen = !this.advancedOpen;
        try {
            localStorage.setItem( advancedStorageKey, JSON.stringify( this.advancedOpen ) );
        } catch ( error ) { }
        if ( this.rollSettings ) {
            this.updateRollSettings( { advancedOpen: this.advancedOpen } );
        }
    }

    /**
     * Opens the Combat tab, where the DPS meter settings live.
     */
    showCombatTab(): void {
        this.openCombat.emit();
    }

    /**
     * Tells the page whether the Settings tab is on screen, so the Status card only reads the log files then.
     */
    setActive( active: boolean ): void {
        this.statusActive = active;
        this.updateStatusTimer();
    }

    private updateStatusTimer(): void {
        const needed = this.statusActive && this.section === 'status';
        if ( needed && this.statusTimerId == null ) {
            this.refreshStatus();
            this.statusTimerId = setInterval( () => this.refreshStatus(), 3000 );
        } else if ( !needed && this.statusTimerId != null ) {
            clearInterval( this.statusTimerId );
            this.statusTimerId = null;
        }
    }

    private refreshStatus(): void {
        window.api.ipc.invoke( 'app:status:watching' )?.then( ( status: IWatchStatus[] ) => {
            this.ngZone.run( () => {
                this.watchStatus = status ?? [];
                this.statusNow = Date.now();
            } );
        } ).catch( () => { } );
    }

    ngOnDestroy(): void {
        if ( this.statusTimerId != null ) {
            clearInterval( this.statusTimerId );
        }
    }

    /**
     * The characters whose log is being read now.
     */
    get watchedCharacters(): IWatchStatus[] {
        return this.watchStatus.filter( s => s.watching );
    }

    /**
     * Tells whether a setting hidden behind a section's Advanced switch differs from its default.
     */
    customised( id: string ): boolean {
        switch ( id ) {
            case 'characters':
                return this.fileReadDelays != null && ( this.fileReadDelays.readDelayMs !== 200 || this.fileReadDelays.readErrorDelayMs !== 1000 || this.fileReadDelays.flushDelayMs !== 1000 );
            case 'overlays':
                return this.enableCheckWindowPosition === false;
            case 'sound':
                return this.speechVolume !== 100 || this.audioVolume !== 100 || this.baseSpeakingRate !== 1 || this.phoneticTransforms.length > 0;
            case 'sharing':
                return ( this.quickShareAuthorListType != null && this.quickShareAuthorListType !== QuickShareAuthorListTypes.Disabled ) || this.sharedTriggerPermissions.disableSharedGlowEffects === true || this.sharedTriggerPermissions.disableAllGlowEffects === true;
            case 'rolls':
                const roll = this.rollSettings;
                const defaults = this.rollDefaults;
                return roll != null && defaults != null && ( [ 'closeAfterSeconds', 'topCount', 'resultSeconds', 'rerollRule', 'pasteTemplate', 'speakWinnerPhrase', 'speakTiePhrase' ] as ( keyof RollTrackerSettings )[] ).some( key => roll[ key ] !== defaults[ key ] );
            default:
                return false;
        }
    }

    /**
     * Describes how long ago the newest log file change was, or null when there is none.
     */
    get lastLineAge(): string | null {
        const times = this.watchedCharacters.map( s => s.lastLineAt ).filter( t => t != null );
        if ( times.length === 0 ) {
            return null;
        }
        const seconds = Math.max( 0, Math.round( ( this.statusNow - Math.max( ...times ) ) / 1000 ) );
        if ( seconds < 60 ) {
            return `${seconds} s ago`;
        } else if ( seconds < 3600 ) {
            return `${Math.floor( seconds / 60 )} min ago`;
        } else if ( seconds < 86400 ) {
            return `${Math.floor( seconds / 3600 )} h ago`;
        }
        return `${Math.floor( seconds / 86400 )} d ago`;
    }

    /**
     * The number of health findings worth a look, or null before the first check.
     */
    get healthFindings(): number | null {
        return this.healthSummary?.defaultCount ?? null;
    }










    /**
     * Allows the user to save a copy of their current log file, in zip form.
     */
    downloadLogFile() {
        this.ipcService.downloadLogZip();
    }









    
    /**
     * Allows the user to save a copy of their current data files, in zip form.
     */
    downloadDataFiles() {
        this.ipcService.downloadDataFilesZip();
    }
    








    
    /**
     * Shows the current data folder in file explorer.
     */
    showDataFolder() {
        this.ipcService.showDataFolder();
    }









    
    /**
     * Stores the default detrimental overlay id.
     */
    saveDetrimentalOverlayId() {
        this.ipcService.saveDetrimentalOverlayId( this.detrimentalOverlayId );
    }









    
    /**
     * Stores the default beneficial overlay id.
     */
    saveBeneficialOverlayId() {
        this.ipcService.saveBeneficialOverlayId( this.beneficialOverlayId );
    }









    
    /**
     * Stores the default alert overlay id.
     */
    saveAlertOverlayId() {
        this.ipcService.saveAlertOverlayId( this.alertOverlayId );
    }









    
    /**
     * Uses TTS to speak the given phrase.
     * 
     * @param phrase The phrase to speak.
     */
    speakPhrase( phrase: string, rate: number | undefined = undefined ): void {
        
        if ( rate !== undefined ) {
            let x = Math.random();
            if ( x >= 0 && x <= 0.05 ) {
                phrase = 'I promise not to overthrow my human overlords.';
            }
        }

        rate = rate ?? 0;

        if ( this.baseSpeakingRate < 1 ) {
            rate = rate - ( 1 - this.baseSpeakingRate );
        } else if ( rate < this.baseSpeakingRate ) {
            rate = this.baseSpeakingRate;
        }

        if ( this.utter ) {
            speechSynthesis.cancel();
            this.utter = undefined;
        }

        this.utter = new SpeechSynthesisUtterance();
        this.utter.text = phrase;
        this.utter.voice = this.voiceOptions[ this.voiceIndex ];
        this.utter.onend = function ( event ) { }
        this.utter.rate = MathUtilities.clamp( rate, 0.1, 4 );
        this.utter.volume = ( this.speechVolume / 100 ) * ( this.masterVolume / 100 );
        speechSynthesis.speak( this.utter );

    }









    
    /**
     * Stores the selected voice index.
     */
    onChangeVoice(): void {
        this.ipcService.updateVoiceIndex( this.voiceIndex );
    }









    
    /**
     * Stores the new master volume setting.
     */
    onChangeMasterVolume(): void {
        this.ipcService.updateMasterVolume( this.masterVolume );
    }









    









    
    /**
     * Adds a new empty phonetic transform.
     * 
     * @param table A reference to the MatTable object.
     */
    addPhoneticTransform( table: MatTable<IPhoneticTransform> ): void {
        this.phoneticTransforms.push( { id: nanoid() } );
        table?.renderRows();
        this.phoneticTransformsModified = true;
    }









    
    /**
     * Deletes the desired transform, after confirmation.
     * 
     * @param index The index of the desired transform.
     * @param table A reference to the MatTable object.
     */
    deletePhoneticTransform( index: number, table: MatTable<IPhoneticTransform> ): void {
        this.dialogService.showConfirmDialog(
            `Are you sure you want to delete ${this.phoneticTransforms[ index ].originalText}?`,
            'Click "Yes" to delete this transform.', 'Click "No" to close this dialog without deleting the transform.',
            confirmed => {
                if ( confirmed === true ) {
                    this.phoneticTransforms.splice( index, 1 );
                    this.ipcService.savePhoneticTransforms( this.getPhoneticTransformsRecord() );
                    table?.renderRows();
                    this.phoneticTransformsModified = true;
                }
            } );
    }









    
    /**
     * Saves the current phonetic transforms.
     */
    savePhoneticTransforms(): void {
        this.ipcService.savePhoneticTransforms( this.getPhoneticTransformsRecord() );
        this.phoneticTransformsModified = false;
    }









    
    /**
     * Returns the currently stored phonetic transforms.
     */
    getPhoneticTransformsRecord(): Record<string, string> {
        let transforms: Record<string, string> = {};
        let duplicates: string[] = [];

        this.phoneticTransforms.forEach( t => {
            if ( !transforms.hasOwnProperty( t.originalText ) ) {
                transforms[ t.originalText ] = t.phoneticText;
            } else {
                duplicates.push( t.originalText );
            }
        } );

        if ( duplicates.length > 0 ) {
            this.dialogService.showWarningDialog( 'Phonetics removed', [ 'Some of the phonetics in the list had duplicate original texts and were not saved.  Please review the list: ' ].concat( duplicates ) );
        }

        return transforms;
    }









    
    /**
     * Opens a dialog to show their current verified user status.
     */
    showVerifiedUserInfo() {
        this.dialogService.showCustomNotificationDialog( 'Verified Users', [ 'Your author account has been verified.', 'Verified authors are able to publish their triggers to the universal library.' ], 'verified_user' );
    }
    








    
    /**
     * Creates a new author record on the server.
     */
    createAuthor() {
        this.settingsService.createAuthor( this.author.name, this.author.discord ).subscribe( author => {
            this.ipcService.saveAuthor( author );
            this.author = author;
        } );
    }









    
    /**
     * For verified authors, allows the user to update their author details.
     */
    updateAuthor() {
        this.settingsService.updateAuthor( this.author ).subscribe( success => {
            if ( success ) {
                this.snackBar.open( 'Author file updated!', 'dismiss', { duration: 5000 } );
                this.ipcService.saveAuthor( this.author );
            }
        } );
    }









    
    /**
     * Submits a request for permissions to author and share package libraries.
     */
    requestVerification() {
        this.settingsService.requestVerification( this.author.authorId ).subscribe( success => {
            if ( success ) {
                this.snackBar.open( 'Request submitted!', 'dismiss', { duration: 5000 } );
            }
        } );
    }










    /**
     * Executes the setup wizard.
     */
    runSetupWizard() {
        this.setupService.showSetupWizard().subscribe( () => {
            this.ipcService.requestTick();
            this.characterList?.loadCharacters();
        } );
    }










    /**
     * Resets all hidden modals, allowing them to appear again.
     */
    resetHiddenModals() {
        this.ipcService.resetHiddenModalIds();
        this.snackBar.open( 'All hidden modals will now appear again.', 'dismiss', { duration: 5000 } );
    }










    /**
     * Shows a dialog that explains window checking.
     */
    explainWindowChecking() {
        this.dialogService.showInfoDialog(
            'Relative Window Positioning',
            [
                'When the renderer loads an overlay, it will check to ensure that the monitor containing the overlay has moved.',
                'If the monitor has moved, the renderer will recalculate the position of the overlay relative to the containing monitor. This will ensure that the overlay appears in the same location on the monitor.',
                'However, on some systems the OS reports the monitor as having moved, even when it has not.',
                'Disabling this setting will prevent this check from happening, which may resolve the issue.',
                'However, if disabled and your monitor positions have changed, the overlay may appear in the wrong location or entirely off-screen.  When this happens, you can use the Send to Origin button on the overlay list to reset the overlay position.',
            ],
            'wide',
        );
    }










}

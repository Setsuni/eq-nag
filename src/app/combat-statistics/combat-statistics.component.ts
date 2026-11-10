import { Component, OnInit } from '@angular/core';
import { IpcService } from '../ipc.service';
import { CharacterOptionModel, DpsMeterSettings, SettingsKeys } from '../core.model';

interface IPreviewRow {

    name: string;
    dps: number;
    total: string;
    mine: boolean;

}

@Component( {
    selector: 'app-combat-statistics',
    templateUrl: './combat-statistics.component.html',
    styleUrls: [ './combat-statistics.component.scss', '../core.scss' ]
} )
export class CombatStatisticsComponent implements OnInit {

    public characterOptions: CharacterOptionModel[] = [];
    private _combatCharacterId: string | null = null;
    public get combatCharacterId(): string {
        return this._combatCharacterId || 'auto';
    }
    public set combatCharacterId( value: string | null ) {
        this._combatCharacterId = value === 'auto' || !value ? null : value;
        this.ipcService.changeCombatCharacter( this._combatCharacterId );
    }

    public dpsMeterShow: boolean | undefined = undefined;
    private dpsMeterSettings: DpsMeterSettings = new DpsMeterSettings();
    public settingsLoaded: boolean = false;

    public readonly previewRows: IPreviewRow[] = [
        { name: 'Soandso', dps: 412, total: '18.9k', mine: true },
        { name: 'Whatshisname', dps: 355, total: '16.3k', mine: false },
        { name: 'Thatguy', dps: 241, total: '11.1k', mine: false },
        { name: 'Soandso\'s pet', dps: 96, total: '4.4k', mine: false },
    ];
    public get previewMax(): number {
        return this.previewRows[ 0 ].dps;
    }

    public get minimumDamage(): number {
        return this.dpsMeterSettings.encounterMinimumDamage;
    }
    public set minimumDamage( value: number ) {
        if ( !this.settingsLoaded ) {
            return;
        }
        this.dpsMeterSettings.encounterMinimumDamage = Number( value ) || 0;
        this.ipcService.updateSetting( SettingsKeys.dpsMeterSettings, this.dpsMeterSettings, 500 );
    }

    public get onlyWhenFocused(): boolean {
        return !this.dpsMeterSettings.keepOnScreen;
    }
    public set onlyWhenFocused( value: boolean ) {
        if ( !this.settingsLoaded ) {
            return;
        }
        this.dpsMeterSettings.keepOnScreen = !value;
        this.ipcService.updateSetting( SettingsKeys.dpsMeterSettings, this.dpsMeterSettings, 0 );
    }

    public get onlyInCombat(): boolean {
        return this.dpsMeterSettings.showOnlyInCombat;
    }
    public set onlyInCombat( value: boolean ) {
        if ( !this.settingsLoaded ) {
            return;
        }
        this.dpsMeterSettings.showOnlyInCombat = value;
        this.ipcService.updateSetting( SettingsKeys.dpsMeterSettings, this.dpsMeterSettings, 0 );
    }

    public get highlightMyName(): boolean {
        return this.dpsMeterSettings.highlightMyName;
    }
    public set highlightMyName( value: boolean ) {
        if ( !this.settingsLoaded ) {
            return;
        }
        this.dpsMeterSettings.highlightMyName = value;
        this.ipcService.updateSetting( SettingsKeys.dpsMeterSettings, this.dpsMeterSettings, 0 );
    }

    public get meterOn(): boolean {
        return this.dpsMeterShow !== false;
    }
    public set meterOn( value: boolean ) {
        if ( !this.settingsLoaded ) {
            return;
        }
        this.dpsMeterSettings.show = value;
        this.dpsMeterShow = value;
        this.ipcService.updateSetting( SettingsKeys.dpsMeterSettings, this.dpsMeterSettings, 0 );
    }

    constructor(
        private readonly ipcService: IpcService,
    ) { }

    ngOnInit(): void {

        this.ipcService.watchSetting<DpsMeterSettings>( SettingsKeys.dpsMeterSettings ).subscribe( data => {
            this.dpsMeterSettings = Object.assign( new DpsMeterSettings(), data );
            this.dpsMeterShow = this.dpsMeterSettings.show;
            this.settingsLoaded = true;
        } );
        this.ipcService.getCharacters().subscribe( characters => {
            this.characterOptions = characters?.length > 0 ? characters
                .sort( ( a, b ) => a.name.localeCompare( b.name ) )
                .sort( ( a, b ) => a.server.localeCompare( b.server ) )
                .map( x => ( { characterId: x.characterId, name: x.name, server: x.server, class: x.class, } ) ) : [];
        } );
        this.ipcService.tickReceived().subscribe( data => this.characterOptions = data.characterOptions?.length > 0 ? data.characterOptions : this.characterOptions );


        this.ipcService.onCombatCharacterChanged().subscribe( characterId => {
            this._combatCharacterId = characterId;
        } );

    }

    // public getSelectValue(): string {
    //     if ( this._combatCharacterId ) {
    //         let character = this.characterOptions.find( x => x.characterId === this._combatCharacterId );
    //         return character ? `${character.name} (${character.server})` : 'Unknown';
    //     } else {
    //         return 'Auto';
    //     }
    // }

    public getCombatName(): string {
        if ( this._combatCharacterId ) {
            let character = this.characterOptions.find( x => x.characterId === this._combatCharacterId );
            return character ? character.name : 'Unknown';
        } else {
            return 'Auto';
        }
    }

    public getCombatServer(): string {
        if (this._combatCharacterId) {
            let character = this.characterOptions.find( x => x.characterId === this._combatCharacterId );
            return character ? character.server : 'Unknown';
        } else {
            return '';
        }
    }

    public turnOnDpsMeter(): void {
        if ( !this.settingsLoaded ) {
            return;
        }
        this.dpsMeterSettings.show = true;
        this.dpsMeterShow = true;
        this.ipcService.updateSetting( SettingsKeys.dpsMeterSettings, this.dpsMeterSettings, 0 );
    }

    public openCombatStatsSettings(): void {
        this.ipcService.showSettingsWindow( 'combatStatistics' );
    }


}

import { trigger, state, style, transition, animate } from '@angular/animations';
import { FlatTreeControl } from '@angular/cdk/tree';
import { Component, OnInit, Inject } from '@angular/core';
import { MatDialog, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatTreeFlattener, MatTreeFlatDataSource } from '@angular/material/tree';
import { PackageFolder, PackageTrigger, QuickShareFileModel, QuickShareMetaModel, QuickShareModel, TriggerFolder, TriggerModel } from 'src/app/core.model';
import * as _ from 'lodash-es';
import { IpcService } from 'src/app/ipc.service';
import { combineLatest, forkJoin, Observable, timer } from 'rxjs';
import { nagId } from 'src/app/core/nag-id.util';
import { NotificationDialogModel, NotificationTypes } from '../notification-dialog/notification-dialog.model';
import { NotificationDialogComponent } from '../notification-dialog/notification-dialog.component';
import { ColoredString } from '../dialog.model';
import { MatSnackBar } from '@angular/material/snack-bar';

interface QuickShareTreeNode {
    expandable: boolean;
    name: string;
    level: number;
    item: PackageFolder | PackageTrigger;
    selected: boolean;
    folderState?: string;
    id: string;
    isFolder: boolean;
    hasChildren: boolean;
    exists: boolean;
    overwrite: boolean;
    update: boolean;
    duplicate: boolean;
}

class QuickShareTreeObject {
    name: string;
    children: QuickShareTreeObject[] = [];
    folder: PackageFolder;
    trigger: PackageTrigger;
    selected: boolean;
    exists: boolean;
    overwrite: boolean;
    update: boolean;
    duplicate: boolean;
}

@Component( {
    selector: 'app-receive-quick-share-dialog',
    templateUrl: 'receive-quick-share.component.html',
    styleUrls: [ 'receive-quick-share.component.scss', '../dialog.styles.scss', '../../core.scss' ], 
    animations: [
        trigger( 'detailExpand', [
            state( 'collapsed', style( { height: '0px', minHeight: '0' } ) ),
            state( 'expanded', style( { height: '*' } ) ),
            transition( 'expanded <=> collapsed', animate( '225ms cubic-bezier(0.4, 0.0, 0.2, 1)' ) ),
        ] ),
    ],
} )
export class ReceiveQuickShareDialogComponent implements OnInit {

    private _transformer: ( node: QuickShareTreeObject, level: number ) => QuickShareTreeNode = ( node: QuickShareTreeObject, level: number ) => {
        return {
            expandable: node.folder ? true : false, 
            name: node.name,
            level: level,
            item: node.folder ? node.folder : node.trigger,
            selected: node.selected === false ? false : true,
            id: node.folder ? node.folder.folderId : node.trigger.triggerId,
            isFolder: node.folder ? true : false,
            hasChildren: node.children?.length > 0,
            exists: node.exists,
            overwrite: node.overwrite,
            update: node.update,
            duplicate: node.duplicate,
        };
    }
    public treeControl = new FlatTreeControl<QuickShareTreeNode>( node => node ? node.level : 1, node => node.expandable );
    public treeFlattener = new MatTreeFlattener(this._transformer, node => node.level, node => node.expandable, node => node.children);
    public dataSource = new MatTreeFlatDataSource( this.treeControl, this.treeFlattener );
    public hasChild = ( _: number, node: QuickShareTreeNode ) => node.expandable;
    public stageNewTriggers: boolean = false;
    private _shownOverwriteWarning: boolean = false;
    private _overwriteExistingTriggers: boolean = true;
    public get overwriteExistingTriggers(): boolean {
        return this._overwriteExistingTriggers;
    }
    public set overwriteExistingTriggers( value: boolean ) {
        this._overwriteExistingTriggers = value;

        if ( !value && !this._shownOverwriteWarning ) {
            this.dialog.open( NotificationDialogComponent, {
                width: '675px',
                data: {
                    title: 'Overwrite Warning',
                    message: [ 'Disabling this option will not overwrite any existing triggers.','This means that if a trigger with the same id already exists, a new trigger will be created.', 'This may result in multiple duplicate actions (ex: two identical triggers, two speak phrases that say the same thing).' ],
                    notificationType: NotificationTypes.Warning,
                },
                panelClass: 'app-dialog',
            } ).afterClosed().subscribe( () => this._shownOverwriteWarning = true );
        }
    }

    private allFolders: PackageFolder[] = [];
    private allTriggers: PackageTrigger[] = [];
    /** Keeps track of the ids of all triggers that will be updated.  A trigger is updated when the trigger id matches an existing trigger. */
    private updateTriggerIds: Set<string> = new Set<string>();
    /** Keeps track of the ids of all triggers that will be overwritten.  A trigger is overwritten when the trigger names match exactly, and they're in the same folder. */
    private overwriteTriggerIds: Set<string> = new Set<string>();
    /** Keeps track of the ids of all new triggers. */
    private newTriggerIds: string[] = [];
    /** Keeps track of possible duplicate triggers. */
    private possibleDuplicateTriggers: Record<string, string[]> = {};
    /** Keeps track of the folders, whose descendants contain an updated trigger. */
    private foldersWithUpdates: Set<string> = new Set<string>();
    /** Keeps track of the folders, whose descendants contain an overwritten trigger. */
    private foldersWithOverwrites: Set<string> = new Set<string>();
    /** Keeps track of the original folder ids for each package trigger. */
    private packageTriggerOriginalFolderIds: Record<string, string> = {};
    private _realTriggers: TriggerModel[] = [];
    private _realFolders: TriggerFolder[] = [];
    /** The trigger nodes of each folder, by folder id.  Built once after the tree data is set. */
    private triggerNodesByFolder: Map<string, QuickShareTreeNode[]> = new Map<string, QuickShareTreeNode[]>();
    /** The first package folder with each folder id, in pre-order.  Built once after the tree data is set. */
    private packageFolderById: Map<string, PackageFolder> = new Map<string, PackageFolder>();

    constructor(
        public dialogRef: MatDialogRef<ReceiveQuickShareDialogComponent, boolean>,
        @Inject( MAT_DIALOG_DATA ) public data: { quickShares: QuickShareMetaModel[], files: QuickShareFileModel[] },
        public dialog: MatDialog,
        private ipcService: IpcService,
        private snackBar: MatSnackBar,
    ) { }

    ngOnInit(): void {
        
        forkJoin( {
            folders: this.ipcService.getTriggerFolders(),
            triggers: this.ipcService.getTriggers(),
        } ).subscribe( result => {

            this._realTriggers = result.triggers;
            this._realFolders = result.folders;
            
            let data: QuickShareTreeObject[] = [];
            this.data.quickShares.forEach( quickShare => {
                this.allFolders = _.concat( this.allFolders, quickShare.model.folders );
                this.allTriggers = _.concat( this.allTriggers, quickShare.model.triggers );
            } );
            
            this.processExistingTriggers( result.triggers, result.folders ); // This one here
            this.mapFolderIds( result.folders, this.allFolders );
            this.removeEmptyFolders( this.allFolders );
            this.processTriggerActions( this.allTriggers, result.triggers, result.folders );

            // Package trigger folder ids are final from here on.
            let packageTriggersByFolder = new Map<string, PackageTrigger[]>();
            this.allTriggers.forEach( t => {
                let bucket = packageTriggersByFolder.get( t.folderId );
                if ( bucket ) {
                    bucket.push( t );
                } else {
                    packageTriggersByFolder.set( t.folderId, [ t ] );
                }
            } );
            
            let realNamesByFolder = new Map<string, Set<string>>();
            result.triggers.forEach( rt => {
                let names = realNamesByFolder.get( rt.folderId );
                if ( !names ) {
                    names = new Set<string>();
                    realNamesByFolder.set( rt.folderId, names );
                }
                names.add( rt.name );
            } );

            this.allFolders.forEach( folder => this.processFolder( folder, packageTriggersByFolder, data, result.folders, realNamesByFolder ) );

            this.dataSource.data = data;

            this.buildSelectionIndexes();
            this.updateFolderStates();
        } );
        
    }










    /**
     * Removes all empty folders from the given folder hierarchy.
     * 
     * @param folders The list of folders to parse.
     * @param foldersWithTriggers The ids of all folders that contain a package trigger, built on the first call.
     */
    private removeEmptyFolders( folders: PackageFolder[], foldersWithTriggers: Set<string> = null ) {
        
        if ( foldersWithTriggers == null ) {
            foldersWithTriggers = new Set<string>();
            this.allTriggers.forEach( t => foldersWithTriggers.add( t.folderId ) );
        }

        let ri: number[] = [];

        for ( let i = 0; i < folders.length; i++ ) {

            if ( folders[ i ].children?.length > 0 ) {
                this.removeEmptyFolders( folders[ i ].children, foldersWithTriggers );
            }
            
            if ( folders[ i ].children == null || folders[ i ].children.length === 0 ) {
                if ( !foldersWithTriggers.has( folders[ i ].folderId ) ) {
                    console.log( 'remove', folders[ i ].name );
                    ri.push( i );
                }
            }
        }

        for ( let i = ri.length - 1; i >= 0; i-- ) {
            folders.splice( i, 1 );
        }

    }










    /**
     * Processes and tracks the actions against each real trigger.  Also checks 
     * for possible duplicate triggers.
     * 
     * @param packageTriggers The list of all package triggers.
     * @param realTriggers The list of all real triggers.
     */
    private processTriggerActions( packageTriggers: PackageTrigger[], realTriggers: TriggerModel[], realFolders: TriggerFolder[] ) {
        let ancestryMap = TriggerFolder.getFolderAncestryMap( realFolders );

        // The first real trigger with each id, and the first real trigger with each name in each folder.
        let realById = new Map<string, TriggerModel>();
        let realByFolderName = new Map<string, Map<string, TriggerModel>>();
        realTriggers.forEach( rt => {
            if ( !realById.has( rt.triggerId ) ) {
                realById.set( rt.triggerId, rt );
            }

            let byName = realByFolderName.get( rt.folderId );
            if ( !byName ) {
                byName = new Map<string, TriggerModel>();
                realByFolderName.set( rt.folderId, byName );
            }
            if ( !byName.has( rt.name ) ) {
                byName.set( rt.name, rt );
            }
        } );

        packageTriggers.forEach( pt => {

            // Find matches by trigger id, marking them as UPDATE.
            let matchedById = realById.get( pt.triggerId );
            if ( matchedById ) {
                this.updateTriggerIds.add( pt.triggerId );

                let t: string = matchedById.folderId;
                while ( t != null ) {
                    this.foldersWithUpdates.add( t );
                    t = ancestryMap[ t ];
                }

                // Leave this iteration.
                return;
            }

            // Find matches by name, marking them as OVERWRITE.
            let matchedByName = realByFolderName.get( pt.folderId )?.get( pt.name );
            if ( matchedByName ) {
                this.overwriteTriggerIds.add( pt.triggerId );

                let t: string = matchedByName.folderId;
                while ( t != null ) {
                    this.foldersWithOverwrites.add( t );
                    t = ancestryMap[ t ];
                }

                // Leave this iteration.
                return;
            }
        } );
    }









    
    /**
     * Traverses the package folder hierarchy, updating folder ids when the 
     * package folder exists as a real folder.
     * 
     * @param realFolders The full hierarchy of real folders.
     * @param packageFolders The full hierarchy of package folders.
     * @param triggersByFolder The package triggers by folder id, built on the first call.
     */
    private mapFolderIds( realFolders: TriggerFolder[], packageFolders: PackageFolder[], triggersByFolder: Map<string, PackageTrigger[]> = null ) {

        if ( triggersByFolder == null ) {
            triggersByFolder = new Map<string, PackageTrigger[]>();
            this.allTriggers.forEach( t => {
                let bucket = triggersByFolder.get( t.folderId );
                if ( bucket ) {
                    bucket.push( t );
                } else {
                    triggersByFolder.set( t.folderId, [ t ] );
                }
            } );
        }

        packageFolders.forEach( pf => {

            // If the folder does not exist, then create a new id for it,
            // otherwise use the existing folder id.
            let rf = realFolders?.find( f => f.name === pf.name );
            let folderId = rf?.folderId ?? nagId();

            // Update all trigger folder ids.  The buckets only drive the moves, so their order is not used.
            let bucket = triggersByFolder.get( pf.folderId );
            if ( bucket && pf.folderId !== folderId ) {
                triggersByFolder.delete( pf.folderId );
                bucket.forEach( trigger => trigger.folderId = folderId );

                let target = triggersByFolder.get( folderId );
                if ( target ) {
                    target.push( ...bucket );
                } else {
                    triggersByFolder.set( folderId, bucket );
                }
            }

            // Update the current folder id.
            pf.folderId = folderId;

            if ( pf.children?.length > 0 ) {
                this.mapFolderIds( rf?.children, pf.children, triggersByFolder );
            }
        } );
    }









    
    /**
     * Checks the real triggers against the quick share triggers, when finding 
     * a trigger id that matches, then moves it to the correct folder.
     * 
     * @param realTriggers The list of all real triggers.
     * @param realFolders The full real folder hierarchy.
     */
    private processExistingTriggers( realTriggers: TriggerModel[], realFolders: TriggerFolder[] ) {
        let realById = new Map<string, TriggerModel>();
        realTriggers.forEach( rt => {
            if ( !realById.has( rt.triggerId ) ) {
                realById.set( rt.triggerId, rt );
            }
        } );

        let ancestryMap = TriggerFolder.getFolderAncestryMap( realFolders );
        let ancestryCache = new Map<string, TriggerFolder[]>();

        this.allTriggers.forEach( qst => {
            this.packageTriggerOriginalFolderIds[ qst.triggerId ] = qst.folderId;

            // Find the trigger that is already in my library.
            let realTrigger = realById.get( qst.triggerId );

            // If this trigger exists and the folder id is not null.
            if ( realTrigger && realTrigger.folderId != null ) {

                // Get the direct parent of the folder that contains the real trigger, in this case it's the same folder thats in the quick share.
                let ancestryFolders = ancestryCache.get( realTrigger.folderId );
                if ( !ancestryFolders ) {
                    ancestryFolders = TriggerFolder.getFolderAncestry( realTrigger.folderId, realFolders, ancestryMap );
                    ancestryCache.set( realTrigger.folderId, ancestryFolders );
                }

                this.insertRealFolders( ancestryFolders );
                qst.folderId = realTrigger.folderId;
            }

        } );
    }









    
    /**
     * Inserts the given folder ancestry into the quick share folders.
     * 
     * @param realFolders The folder ancestry.
     */
    private insertRealFolders( realFolders: TriggerFolder[] ) {
        let folder = realFolders[ 0 ];
        let generation = this.allFolders;

        while ( folder != null ) {
            let pkgFolder: PackageFolder = generation.find( f => f.name === folder.name );

            if ( pkgFolder == null ) {
                pkgFolder = new PackageFolder();
            
                pkgFolder.folderId = folder.folderId;
                pkgFolder.name = folder.name;
                pkgFolder.children = [];

                generation.push( pkgFolder );
            }

            generation = pkgFolder.children;
            folder = folder.children?.length > 0 ? folder.children[ 0 ] : null;
        }
    }
    









    /**
     * Generates the tree node data.
     * 
     * @param folder The trigger folder hierarchy.
     * @param packageTriggersByFolder The full trigger list, by folder id.
     * @param data The current node heirarchy.
     * @param realFolders The real folders at this level of the hierarchy.
     * @param realNamesByFolder The names of all real triggers, by folder id.
     */
    private processFolder( folder: PackageFolder, packageTriggersByFolder: Map<string, PackageTrigger[]>, data: QuickShareTreeObject[], realFolders: TriggerFolder[], realNamesByFolder: Map<string, Set<string>> ): void {
        
        // check for real triggers by id, if found, make sure the folder appears as they do in the system.
        //      For example, I installed a quick share, then moved all the triggers to my own folders.  Those triggers should not be duplicated, and they should stay in the folder that I assigned them.

        let node = new QuickShareTreeObject();
        let realFolder = realFolders?.find( f => f.name === folder.name );
        node.name = folder.name;
        node.children = [];
        node.folder = folder;
        node.exists = realFolder != null;
        node.overwrite = this.foldersWithOverwrites.has( folder.folderId );
        node.update = this.foldersWithUpdates.has( folder.folderId );

        // Push this folder node into the data list.
        data.push( node );
        
        // Push each child folder into this node's children list.
        folder.children.forEach( f => this.processFolder( f, packageTriggersByFolder, node.children, realFolder?.children, realNamesByFolder ) );

        // Find all triggers in this folder
        let myTriggers = packageTriggersByFolder.get( folder.folderId ) ?? [];
        let myRealNames = realNamesByFolder.get( realFolder?.folderId );

        // Push each child trigger into this node's children list.
        myTriggers?.forEach( trigger => {
            let triggerNode = new QuickShareTreeObject();
            triggerNode.name = trigger.name;
            triggerNode.children = [];
            triggerNode.trigger = trigger;
            triggerNode.selected = true;
            triggerNode.exists = myRealNames ? myRealNames.has( trigger.name ) : false;
            triggerNode.overwrite = this.overwriteTriggerIds.has( trigger.triggerId );
            triggerNode.duplicate = this.possibleDuplicateTriggers[ trigger.triggerId ]?.length > 0;
            triggerNode.update = this.updateTriggerIds.has( trigger.triggerId );
            node.children.push( triggerNode );
        } );
    }
    








    
    /**
     * Builds the folder and trigger node lookups used by the selection methods.
     * Call this once after the tree data is set.
     */
    private buildSelectionIndexes(): void {

        this.triggerNodesByFolder = new Map<string, QuickShareTreeNode[]>();
        this.treeControl.dataNodes.forEach( t => {
            if ( !t.isFolder ) {
                let bucket = this.triggerNodesByFolder.get( t.item.folderId );
                if ( bucket ) {
                    bucket.push( t );
                } else {
                    this.triggerNodesByFolder.set( t.item.folderId, [ t ] );
                }
            }
        } );

        // The first folder found in pre-order wins, like PackageFolder.findFolderById.
        this.packageFolderById = new Map<string, PackageFolder>();
        const index = ( folders: PackageFolder[] ) => folders.forEach( f => {
            if ( !this.packageFolderById.has( f.folderId ) ) {
                this.packageFolderById.set( f.folderId, f );
            }
            index( f.children ?? [] );
        } );
        index( this.allFolders );

    }










    /**
     * Updates the selection state of all folders, show partial/full/none 
     * selection state based on the direct and descendant selected triggers.
     */
     private updateFolderStates(): void {

        this.treeControl.dataNodes.forEach( f => {
            if ( f.isFolder ) {
                let folder = this.packageFolderById.get( f.id );
                let familyIds = PackageFolder.getDescendantFolderIds( folder );
                let triggerCount = 0;
                let selectedTriggerCount = 0;
                
                for ( let i = 0; i < familyIds?.length; i++ ) {
                    let triggers = this.triggerNodesByFolder.get( familyIds[ i ] );
                    if ( triggers ) {
                        triggerCount += triggers.length;
                        selectedTriggerCount += triggers.filter( t => t.selected ).length;
                    }
                }

                f.folderState = triggerCount === selectedTriggerCount && triggerCount > 0 ? 'all' :
                                selectedTriggerCount === 0 ? 'none' : 'partial';
            }
        } );
        
    }









    
    /**
     * Selects all triggers in the given folder, including all descendants.
     * 
     * @param node The tree node for the folder.
     * @param value The selected state for the folder.
     */
    onFolderSelectChange( node: QuickShareTreeNode, value: boolean ): void {
        
        let folder = this.packageFolderById.get( node.id );
        let familyIds = PackageFolder.getDescendantFolderIds( folder );
        for ( let i = 0; i < familyIds?.length; i++ ) {
            let triggers = this.triggerNodesByFolder.get( familyIds[ i ] );
            triggers?.forEach( f => f.selected = value );
        }
        
        this.updateFolderStates();
    }









    
    /**
     * Triggers the update folder states method.
     */
    onTriggerSelectChange(): void {
        this.updateFolderStates();
    }









    
    /**
     * Toggles the select state on the given tree node.
     * 
     * @param node The tree node.
     */
    toggleSelect( node: QuickShareTreeNode ): void {
        let trigger = <TriggerModel>node.item;
        if ( trigger.triggerId ) {
            node.selected = !node.selected;
        }
    }










    /**
     * Shows the user an information dialog to explain the process of staging.
     */
    public showStagingFolderHelp(): void {
        let data: NotificationDialogModel = new NotificationDialogModel();
        
        data.title = 'Quick Share Folder';
        data.message = ['Using this option will import new triggers into the Quick Share Staged folder.', new ColoredString('Any existing/updated triggers will not be moved.', '#69f0ae', false), 'If a Quick Share Staged folder does not exist, a new one will be created at the root.'];
        data.notificationType = NotificationTypes.Information;

        this.dialog.open( NotificationDialogComponent, {
            width: '675px',
            data: data,
            panelClass: 'app-dialog',
        } ).afterClosed().subscribe();
    }
    








    /**
     * Imports the selected quick share triggers.
     */
    receiveSelectedTriggers(): void {

        let importTriggerIds = new Set<string>( this.treeControl.dataNodes.filter( f => f.selected && !f.isFolder ).map( f => f.id ) );
        let importFolderIds = new Set<string>( this.treeControl.dataNodes.filter( f => f.selected && f.isFolder ).map( f => f.id ) );
        let fileIds = new Set<string>();

        // For all selected triggers, create a list of used file ids.
        this.allTriggers.filter( f => importTriggerIds.has( f.triggerId ) )?.forEach( trigger => {
            trigger.actions?.forEach( action => {
                if ( action.audioFileId ) {
                    fileIds.add( action.audioFileId );
                }
                if ( action.endedPlayAudioFileId ) {
                    fileIds.add( action.endedPlayAudioFileId );
                }
                if ( action.endingPlayAudioFileId ) {
                    fileIds.add( action.endingPlayAudioFileId );
                }
            } );
        } );

        // Adding a timer makes the following easier (you can't forkjoin an empty array) and I'm being lazy today.
        let importTasks: Observable<any>[] = [ timer( 1 ) ];

        this.data.files?.forEach( file => {
            if ( fileIds.has( file.fileId ) ) {
                importTasks.push( this.ipcService.importPackageFile( file ) );
            }
        } );
        
        /** The folder id for the shared staged folder. */
        let stagedId = nagId();

        forkJoin( importTasks ).subscribe( results => {

            let installTasks: Observable<any>[] = [ timer( 1 ) ];
            
            // The first real trigger with each id, and the names of all real triggers.
            let realById = new Map<string, TriggerModel>();
            let realNames = new Set<string>();
            if ( !this.overwriteExistingTriggers ) {
                this._realTriggers.forEach( rt => {
                    if ( !realById.has( rt.triggerId ) ) {
                        realById.set( rt.triggerId, rt );
                    }
                    realNames.add( rt.name );
                } );
            }

            this.data.quickShares?.forEach( quickShare => {

                quickShare.stageNewTriggers = this.stageNewTriggers;

                // Remove from the model triggers and folders that are left un-selected.
                quickShare.model.triggers = quickShare.model.triggers.filter( f => importTriggerIds.has( f.triggerId ) );
                quickShare.model.folders = quickShare.model.folders.filter( f => importFolderIds.has( f.folderId ) );

                // If the user opts to not overwrite existing triggers, then triggers that already exist in the database will be duplicated.
                if ( !this.overwriteExistingTriggers ) {
                    for ( let i = 0; i < quickShare.model.triggers.length; i++ ) {
                        let packageTrigger = quickShare.model.triggers[ i ];
                        let existingTrigger = realById.get( packageTrigger.triggerId );

                        if ( existingTrigger ) {
                            let name = packageTrigger.name;
                            let folderId = existingTrigger.folderId;

                            let matchedTriggerName = realNames.has( name );
                            if ( matchedTriggerName ) {
                                name = `${packageTrigger.name} (Copy)`;

                                let copyCount = 1;
                                while ( matchedTriggerName ) {
                                    matchedTriggerName = realNames.has( name );
                                    if ( matchedTriggerName ) {
                                        name = `${packageTrigger.name} (Copy ${++copyCount})`;
                                    }
                                }

                            }
                            let trigger = PackageTrigger.ToTrigger( packageTrigger );
                            let newTrigger = TriggerModel.duplicateTrigger( trigger, name );

                            quickShare.model.triggers[ i ] = PackageTrigger.FromTrigger( newTrigger );
                            quickShare.model.triggers[ i ].folderId = folderId;
                        }
                    
                    }
                }

                if ( this.stageNewTriggers ) {
                    this.stageTriggers( quickShare, stagedId );
                }

                // Install the model.
                installTasks.push( this.ipcService.installQuickShare( quickShare ) );
            } );

            forkJoin( installTasks ).subscribe( results => {
                this.snackBar.open( 'Quick Share(s) installed!', 'dismiss', { duration: 2500 } );
                this.ipcService.requestTick();
                
                this.dialogRef.close( true );
            } );

        } );

    }










    /**
     * Creates a staged folder and moves all quickshare root folders into 
     * staged.
     * 
     * @param quickShare The quick share to stage.
     * @param stagedId The staged folder id.
     */
    public stageTriggers( quickShare: QuickShareMetaModel, stagedId: string ) {

            
        let pf = new PackageFolder();

        pf.folderId = stagedId;
        pf.name = 'Quick Share Staged';
        pf.children = quickShare.model.folders;

        quickShare.model.folders = [ pf ];

    }










}

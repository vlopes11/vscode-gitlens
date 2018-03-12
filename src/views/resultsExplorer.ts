'use strict';
import { Functions, Strings } from '../system';
import { commands, ConfigurationChangeEvent, ConfigurationTarget, Disposable, Event, EventEmitter, InputBoxOptions, TreeDataProvider, TreeItem, Uri, window, workspace } from 'vscode';
import { configuration, ExplorerFilesLayout, IExplorersConfig, IResultsExplorerConfig, ISavedComparisionResult, ISavedSearchResult } from '../configuration';
import { CommandContext, GlyphChars, setCommandContext, WorkspaceState } from '../constants';
import { Container } from '../container';
import { RefreshNodeCommandArgs } from './explorerCommands';
import { CommitResultsNode, CommitsResultsNode, ComparisonResultsNode, ComputedRef, ExplorerNode, MessageNode, NamedRef, RefreshReason, ResourceType } from './explorerNodes';
import { GitLog, GitLogCommit } from '../gitService';
import { Logger } from '../logger';
import { Messages } from '../messages';

export * from './explorerNodes';

export class ResultsExplorer extends Disposable implements TreeDataProvider<ExplorerNode> {

    private _disposable: Disposable | undefined;
    private _roots: ExplorerNode[] = [];

    private _onDidChangeTreeData = new EventEmitter<ExplorerNode>();
    public get onDidChangeTreeData(): Event<ExplorerNode> {
        return this._onDidChangeTreeData.event;
    }

    constructor() {
        super(() => this.dispose());

        Container.explorerCommands;
        commands.registerCommand('gitlens.resultsExplorer.refresh', this.refreshNodes, this);
        commands.registerCommand('gitlens.resultsExplorer.refreshNode', this.refreshNode, this);
        commands.registerCommand('gitlens.resultsExplorer.setFilesLayoutToAuto', () => this.setFilesLayout(ExplorerFilesLayout.Auto), this);
        commands.registerCommand('gitlens.resultsExplorer.setFilesLayoutToList', () => this.setFilesLayout(ExplorerFilesLayout.List), this);
        commands.registerCommand('gitlens.resultsExplorer.setFilesLayoutToTree', () => this.setFilesLayout(ExplorerFilesLayout.Tree), this);

        commands.registerCommand('gitlens.resultsExplorer.clearResultsNode', this.clearResultsNode, this);
        commands.registerCommand('gitlens.resultsExplorer.close', this.close, this);
        commands.registerCommand('gitlens.resultsExplorer.saveResultsNode', this.saveResultsNode, this);
        commands.registerCommand('gitlens.resultsExplorer.setKeepResultsToOn', () => this.setKeepResults(true), this);
        commands.registerCommand('gitlens.resultsExplorer.setKeepResultsToOff', () => this.setKeepResults(false), this);
        commands.registerCommand('gitlens.resultsExplorer.swapComparision', this.swapComparision, this);

        setCommandContext(CommandContext.ResultsExplorerKeepResults, this.keepResults);

        Container.context.subscriptions.push(
            configuration.onDidChange(this.onConfigurationChanged, this)
        );
        this.onConfigurationChanged(configuration.initializingChangeEvent);
    }

    dispose() {
        this._disposable && this._disposable.dispose();
    }

    private async onConfigurationChanged(e: ConfigurationChangeEvent) {
        const initializing = configuration.initializing(e);

        if (!initializing &&
            !configuration.changed(e, configuration.name('resultsExplorer').value) &&
            !configuration.changed(e, configuration.name('explorers').value) &&
            !configuration.changed(e, configuration.name('defaultGravatarsStyle').value)) return;

        if (!initializing && this._roots.length !== 0) {
            this.refresh(RefreshReason.ConfigurationChanged);
        }

        if (initializing) {
            if (Container.config.resultsExplorer.savedResults.length > 0) {
                this._roots = this.fromSaved();
                setCommandContext(CommandContext.ResultsExplorer, true);
            }

            this._disposable = window.registerTreeDataProvider('gitlens.resultsExplorer', this);
        }
    }

    get config(): IExplorersConfig & IResultsExplorerConfig {
        return { ...Container.config.explorers, ...Container.config.resultsExplorer };
    }

    get folderResourceUri(): Uri | undefined {
        // Return the uri of any workspace folder -- we just need a folder so that we can use the uri has an icon resourceUri
        if (workspace.workspaceFolders === undefined || workspace.workspaceFolders.length === 0) return undefined;

        return workspace.workspaceFolders[0].uri;
    }

    get keepResults(): boolean {
        return Container.context.workspaceState.get<boolean>(WorkspaceState.ResultsExplorerKeepResults, false);
    }

    close() {
        this.clearResults();
        setCommandContext(CommandContext.ResultsExplorer, false);
    }

    async getChildren(node?: ExplorerNode): Promise<ExplorerNode[]> {
        if (this._roots.length === 0) return [new MessageNode('No results')];

        if (node === undefined) return this._roots;
        return node.getChildren();
    }

    async getTreeItem(node: ExplorerNode): Promise<TreeItem> {
        return node.getTreeItem();
    }

    getQualifiedCommand(command: string) {
        return `gitlens.resultsExplorer.${command}`;
    }

    async refresh(reason?: RefreshReason) {
        if (reason === undefined) {
            reason = RefreshReason.Command;
        }

        Logger.log(`ResultsExplorer.refresh`, `reason='${reason}'`);

        this._onDidChangeTreeData.fire();
    }

    refreshNode(node: ExplorerNode, args?: RefreshNodeCommandArgs) {
        Logger.log(`ResultsExplorer.refreshNode`);

        if (args !== undefined && node.supportsPaging) {
            node.maxCount = args.maxCount;
        }
        node.refresh();

        // Since a root node won't actually refresh, force everything
        this._onDidChangeTreeData.fire(this._roots.includes(node) ? undefined : node);
    }

    refreshNodes() {
        Logger.log(`ResultsExplorer.refreshNodes`);

        this._roots.forEach(n => n.refresh());

        this._onDidChangeTreeData.fire();
    }

    showComparisonInResults(repoPath: string, ref1: string | NamedRef | ComputedRef, ref2: string | NamedRef | ComputedRef) {
        this.addResults(new ComparisonResultsNode(repoPath, typeof ref1 === 'string' ? { ref: ref1 } : ref1, typeof ref2 === 'string' ? { ref: ref2 } : ref2, this));
        this.showResults();
    }

    showCommitInResults(commit: GitLogCommit) {
        this.addResults(new CommitResultsNode(commit, this));
        this.showResults();
    }

    showCommitsInResults(results: GitLog, resultsLabel: string | { label: string, resultsType?: { singular: string, plural: string } }) {
        const query = results.query === undefined
            ? (maxCount: number | undefined) => Promise.resolve(results)
            : results.query;

        const labelFn = async (log: GitLog | undefined) => {
            if (typeof resultsLabel === 'string') return resultsLabel;

            const count = log !== undefined ? log.count : 0;
            const truncated = log !== undefined ? log.truncated : false;

            const resultsType = resultsLabel.resultsType === undefined
                ? { singular: 'result', plural: 'results' }
                : resultsLabel.resultsType;

            let repository = '';
            if (await Container.git.getRepositoryCount() > 1) {
                const repo = await Container.git.getRepository(results.repoPath);
                repository = ` ${Strings.pad(GlyphChars.Dash, 1, 1)} ${(repo && repo.formattedName) || results.repoPath}`;
            }

            if (count === 1) return `1 ${resultsType.singular} for ${resultsLabel.label}${repository}`;
            return `${count === 0 ? 'No' : `${count}${truncated ? '+' : ''}`} ${resultsType.plural} for ${resultsLabel.label}${repository}`;
        };

        this.addResults(new CommitsResultsNode(results.repoPath, labelFn, Functions.seeded(query, results), this, ResourceType.SearchResults));
        this.showResults();
    }

    private async showResults() {
        await commands.executeCommand('workbench.view.explorer');
        Messages.showResultExplorerInfoMessage();
        setCommandContext(CommandContext.ResultsExplorer, true);
    }

    private addResults(results: ExplorerNode): boolean {
        if (this._roots.includes(results)) return false;

        if (this._roots.length > 0 && !this.keepResults) {
            this.clearResults();
        }

        this._roots.splice(0, 0, results);

        this.refreshNode(results);
        return true;
    }

    private clearResults() {
        if (this._roots.length === 0) return;

        this._roots.forEach(r => r.dispose());
        this._roots = this.fromSaved();

        this.refresh();
    }

    private clearResultsNode(node: ExplorerNode) {
        const index = this._roots.findIndex(n => n === node);
        if (index === -1) return;

        this._roots.splice(index, 1);

        node.dispose();

        this.refresh();
    }

    private fromSaved(): ExplorerNode[] {
        const nodes = [];

        const saved = configuration.get<(ISavedComparisionResult | ISavedSearchResult)[]>(configuration.name('resultsExplorer')('savedResults').value);
        if (saved !== undefined && saved.length > 0) {
            for (const r of saved) {
                if (r.type === 'comparison') {
                    nodes.push(new ComparisonResultsNode(r.repoPath, ComputedRef.fromSaved(r.ref1, r.repoPath), ComputedRef.fromSaved(r.ref2, r.repoPath), this));
                }
            }
        }

        return nodes;
    }

    private async saveResultsNode(node: ExplorerNode) {
        if (!(node instanceof ComparisonResultsNode)) return;

        const section = configuration.name('resultsExplorer')('savedResults').value;
        const saved = configuration.get<any[]>(section);
        const results = await node.toSerializable();

        const label = await window.showInputBox({
            value: results.label,
            prompt: `Please enter a label to save results as`
        } as InputBoxOptions);
        if (label !== undefined) {
            results.label = label;
        }

        saved.push(results);
        configuration.update(configuration.name('resultsExplorer')('savedResults').value, saved, ConfigurationTarget.Global);
    }

    private async setFilesLayout(layout: ExplorerFilesLayout) {
        return configuration.update(configuration.name('resultsExplorer')('files')('layout').value, layout, ConfigurationTarget.Global);
    }

    private setKeepResults(enabled: boolean) {
        Container.context.workspaceState.update(WorkspaceState.ResultsExplorerKeepResults, enabled);
        setCommandContext(CommandContext.ResultsExplorerKeepResults, enabled);
    }

    private swapComparision(node: ExplorerNode) {
        if (!(node instanceof ComparisonResultsNode)) return;

        this.showComparisonInResults(node.repoPath, node.ref2, node.ref1);
    }
}
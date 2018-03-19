'use strict';
import { Functions, IDeferrable } from './system';
import { CancellationToken, ConfigurationChangeEvent, debug, DecorationRangeBehavior, DecorationRenderOptions, Disposable, Hover, HoverProvider, languages, Position, Range, StatusBarAlignment, StatusBarItem, TextDocument, TextEditor, TextEditorDecorationType, window } from 'vscode';
import { Annotations } from './annotations/annotations';
import { Commands } from './commands';
import { configuration, IConfig, StatusBarCommand } from './configuration';
import { isTextEditor, RangeEndOfLineIndex } from './constants';
import { Container } from './container';
import { DocumentBlameStateChangeEvent, DocumentDirtyIdleTriggerEvent, DocumentDirtyStateChangeEvent, GitDocumentState, TrackedDocument } from './trackers/gitDocumentTracker';
import { GitLineState, GitLineTracker, LinesChangeEvent } from './trackers/gitLineTracker';
import { CommitFormatter, GitBlameLine, GitCommit, ICommitFormatOptions } from './gitService';

const annotationDecoration: TextEditorDecorationType = window.createTextEditorDecorationType({
    after: {
        margin: '0 0 0 3em',
        textDecoration: 'none'
    },
    rangeBehavior: DecorationRangeBehavior.ClosedOpen
} as DecorationRenderOptions);

class AnnotationState {

    constructor(private _enabled: boolean) { }

    get enabled(): boolean {
        return this.suspended ? false : this._enabled;
    }

    private _suspendReason?: 'debugging' | 'dirty';
    get suspended(): boolean {
        return this._suspendReason !== undefined;
    }

    reset(enabled: boolean): boolean {
        // returns whether a refresh is required

        if (this._enabled === enabled && !this.suspended) return false;

        this._enabled = enabled;
        this._suspendReason = undefined;

        return true;
    }

    resume(reason: 'debugging' | 'dirty'): boolean {
        // returns whether a refresh is required

        const refresh = this._suspendReason !== undefined;
        this._suspendReason = undefined;
        return refresh;
    }

    suspend(reason: 'debugging' | 'dirty'): boolean {
        // returns whether a refresh is required

        const refresh = this._suspendReason === undefined;
        this._suspendReason = reason;
        return refresh;
    }
}

export class CurrentLineController extends Disposable {

    private _blameAnnotationState: AnnotationState | undefined;
    private _editor: TextEditor | undefined;
    private _lineTracker: GitLineTracker;
    private _statusBarItem: StatusBarItem | undefined;

    private _disposable: Disposable;
    private _debugSessionEndDisposable: Disposable | undefined;
    private _hoverProviderDisposable: Disposable | undefined;
    private _lineTrackingDisposable: Disposable | undefined;

    constructor() {
        super(() => this.dispose());

        this._lineTracker = Container.lineTracker;

        this._disposable = Disposable.from(
            this._lineTracker,
            configuration.onDidChange(this.onConfigurationChanged, this),
            Container.annotations.onDidToggleAnnotations(this.onFileAnnotationsToggled, this),
            debug.onDidStartDebugSession(this.onDebugSessionStarted, this)
        );
        this.onConfigurationChanged(configuration.initializingChangeEvent);
    }

    dispose() {
        this.clearAnnotations(this._editor);
        this.unregisterHoverProviders();

        this._debugSessionEndDisposable && this._debugSessionEndDisposable.dispose();
        this._lineTrackingDisposable && this._lineTrackingDisposable.dispose();
        this._statusBarItem && this._statusBarItem.dispose();

        this._disposable && this._disposable.dispose();
    }

    private onConfigurationChanged(e: ConfigurationChangeEvent) {
        const initializing = configuration.initializing(e);

        const cfg = configuration.get<IConfig>();

        let changed = false;

        if (initializing || configuration.changed(e, configuration.name('currentLine').value)) {
            changed = true;
            this._blameAnnotationState = undefined;
        }

        if (initializing || configuration.changed(e, configuration.name('hovers').value)) {
            changed = true;
            this.unregisterHoverProviders();
        }

        if (initializing || configuration.changed(e, configuration.name('statusBar').value)) {
            changed = true;

            if (cfg.statusBar.enabled) {
                const alignment = cfg.statusBar.alignment !== 'left' ? StatusBarAlignment.Right : StatusBarAlignment.Left;
                if (this._statusBarItem !== undefined && this._statusBarItem.alignment !== alignment) {
                    this._statusBarItem.dispose();
                    this._statusBarItem = undefined;
                }

                this._statusBarItem = this._statusBarItem || window.createStatusBarItem(alignment, alignment === StatusBarAlignment.Right ? 1000 : 0);
                this._statusBarItem.command = cfg.statusBar.command;
            }
            else if (this._statusBarItem !== undefined) {
                this._statusBarItem.dispose();
                this._statusBarItem = undefined;
            }
        }

        if (!changed) return;

        const trackCurrentLine = cfg.currentLine.enabled || cfg.statusBar.enabled || (cfg.hovers.enabled && cfg.hovers.currentLine.enabled) ||
            (this._blameAnnotationState !== undefined && this._blameAnnotationState.enabled);

        if (trackCurrentLine) {
            this._lineTracker.start();

            this._lineTrackingDisposable = this._lineTrackingDisposable || Disposable.from(
                this._lineTracker.onDidChangeActiveLines(this.onActiveLinesChanged, this),
                Container.tracker.onDidChangeBlameState(this.onBlameStateChanged, this),
                Container.tracker.onDidChangeDirtyState(this.onDirtyStateChanged, this),
                Container.tracker.onDidTriggerDirtyIdle(this.onDirtyIdleTriggered, this)
            );
        }
        else {
            this._lineTracker.stop();

            if (this._lineTrackingDisposable !== undefined) {
                this._lineTrackingDisposable.dispose();
                this._lineTrackingDisposable = undefined;
            }
        }

        this.refresh(window.activeTextEditor, { full: true });
    }

    private onActiveLinesChanged(e: LinesChangeEvent) {
        if (!e.pending && e.lines !== undefined) {
            this.refresh(e.editor);

            return;
        }

        this.clear(e.editor, (Container.config.statusBar.reduceFlicker && e.reason === 'lines' && e.lines !== undefined) ? 'lines' : undefined);
    }

    private onBlameStateChanged(e: DocumentBlameStateChangeEvent<GitDocumentState>) {
        if (e.blameable) {
            this.refresh(e.editor);

            return;
        }

        this.clear(e.editor);
    }

    private onDebugSessionStarted() {
        if (this.suspendBlameAnnotations('debugging', window.activeTextEditor)) {
            this._debugSessionEndDisposable = debug.onDidTerminateDebugSession(this.onDebugSessionEnded, this);
        }
    }

    private onDebugSessionEnded() {
        if (this._debugSessionEndDisposable !== undefined) {
            this._debugSessionEndDisposable.dispose();
            this._debugSessionEndDisposable = undefined;
        }

        this.resumeBlameAnnotations('debugging', window.activeTextEditor);
    }

    private onDirtyIdleTriggered(e: DocumentDirtyIdleTriggerEvent<GitDocumentState>) {
        const maxLines = configuration.get<number>(configuration.name('advanced')('blame')('sizeThresholdAfterEdit').value);
        if (maxLines > 0 && e.document.lineCount > maxLines) return;

        this.resumeBlameAnnotations('dirty', window.activeTextEditor);
    }

    private async onDirtyStateChanged(e: DocumentDirtyStateChangeEvent<GitDocumentState>) {
        if (e.dirty) {
            this.suspendBlameAnnotations('dirty', window.activeTextEditor);
        }
        else {
            this.resumeBlameAnnotations('dirty', window.activeTextEditor, { force: true });
        }
    }

    private onFileAnnotationsToggled() {
        this.refresh(window.activeTextEditor);
    }

    async clear(editor: TextEditor | undefined, reason?: 'lines') {
        if (this._editor !== editor && this._editor !== undefined) {
            this.clearAnnotations(this._editor);
        }
        this.clearAnnotations(editor);
        this.unregisterHoverProviders();

        this._lineTracker.reset();

        if (this._statusBarItem !== undefined && reason !== 'lines') {
            this._statusBarItem.hide();
        }
    }

    async provideDetailsHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
        if (this._editor === undefined || this._editor.document !== document || !this._lineTracker.includes(position.line)) return undefined;

        const lineState = this._lineTracker.getState(position.line);
        const commit = lineState !== undefined ? lineState.commit : undefined;
        if (commit === undefined) return undefined;

        // Avoid double annotations if we are showing the whole-file hover blame annotations
        const fileAnnotations = await Container.annotations.getAnnotationType(this._editor);
        if (fileAnnotations !== undefined && Container.config.hovers.annotations.details) return undefined;

        const wholeLine = Container.config.hovers.currentLine.over === 'line';

        const range = document.validateRange(new Range(position.line, wholeLine ? 0 : RangeEndOfLineIndex, position.line, RangeEndOfLineIndex));
        if (!wholeLine && range.start.character !== position.character) return undefined;

        // Get the full commit message -- since blame only returns the summary
        let logCommit = lineState !== undefined ? lineState.logCommit : undefined;
        if (logCommit === undefined && !commit.isUncommitted) {
            logCommit = await Container.git.getLogCommitForFile(commit.repoPath, commit.uri.fsPath, { ref: commit.sha });
            if (logCommit !== undefined) {
                // Preserve the previous commit from the blame commit
                logCommit.previousSha = commit.previousSha;
                logCommit.previousFileName = commit.previousFileName;

                if (lineState !== undefined) {
                    lineState.logCommit = logCommit;
                }
            }
        }

        const trackedDocument = await Container.tracker.get(document);
        if (trackedDocument === undefined) return undefined;

        const message = Annotations.getHoverMessage(logCommit || commit, Container.config.defaultDateFormat, await Container.git.getRemotes(commit.repoPath), fileAnnotations, position.line);
        return new Hover(message, range);
    }

    async provideChangesHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
        if (this._editor === undefined || this._editor.document !== document || !this._lineTracker.includes(position.line)) return undefined;

        const lineState = this._lineTracker.getState(position.line);
        const commit = lineState !== undefined ? lineState.commit : undefined;
        if (commit === undefined) return undefined;

        // Avoid double annotations if we are showing the whole-file hover blame annotations
        if (Container.config.hovers.annotations.changes) {
            const fileAnnotations = await Container.annotations.getAnnotationType(this._editor);
            if (fileAnnotations !== undefined) return undefined;
        }

        const wholeLine = Container.config.hovers.currentLine.over === 'line';

        const range = document.validateRange(new Range(position.line, wholeLine ? 0 : RangeEndOfLineIndex, position.line, RangeEndOfLineIndex));
        if (!wholeLine && range.start.character !== position.character) return undefined;

        const trackedDocument = await Container.tracker.get(document);
        if (trackedDocument === undefined) return undefined;

        const hover = await Annotations.changesHover(commit, position.line, trackedDocument.uri);
        if (hover.hoverMessage === undefined) return undefined;

        return new Hover(hover.hoverMessage, range);
    }

    async showAnnotations(editor: TextEditor | undefined) {
        this.setBlameAnnotationState(true, editor);
    }

    async toggleAnnotations(editor: TextEditor | undefined) {
        const state = this.getBlameAnnotationState();
        this.setBlameAnnotationState(!state.enabled, editor);
    }

    private async resumeBlameAnnotations(reason: 'debugging' | 'dirty', editor: TextEditor | undefined, options: { force?: boolean } = {}) {
        if (!options.force && (this._blameAnnotationState === undefined || !this._blameAnnotationState.suspended)) return;

        let refresh = false;
        if (this._blameAnnotationState !== undefined) {
            refresh = this._blameAnnotationState.resume(reason);
        }

        if (editor === undefined || (!options.force && !refresh)) return;

        await this.refresh(editor);
    }

    private async suspendBlameAnnotations(reason: 'debugging' | 'dirty', editor: TextEditor | undefined, options: { force?: boolean } = {}) {
        const state = this.getBlameAnnotationState();

        // If we aren't enabled, suspend doesn't matter
        if (this._blameAnnotationState === undefined && !state.enabled) return false;

        if (this._blameAnnotationState === undefined) {
            this._blameAnnotationState = new AnnotationState(state.enabled);
        }
        const refresh = this._blameAnnotationState.suspend(reason);

        if (editor === undefined || (!options.force && !refresh)) return;

        await this.refresh(editor);
        return true;
    }

    private async setBlameAnnotationState(enabled: boolean, editor: TextEditor | undefined) {
        let refresh = true;
        if (this._blameAnnotationState === undefined) {
            this._blameAnnotationState = new AnnotationState(enabled);
        }
        else {
            refresh = this._blameAnnotationState.reset(enabled);
        }

        if (editor === undefined || !refresh) return;

        await this.refresh(editor);
    }

    private clearAnnotations(editor: TextEditor | undefined) {
        if (editor === undefined || (editor as any)._disposed === true) return;

        editor.setDecorations(annotationDecoration, []);
    }

    private getBlameAnnotationState() {
        if (this._blameAnnotationState !== undefined) return this._blameAnnotationState;

        const cfg = Container.config;
        return { enabled: cfg.currentLine.enabled };
    }

    private _updateBlameDebounced: (((lines: number[], editor: TextEditor, trackedDocument: TrackedDocument<GitDocumentState>) => void) & IDeferrable) | undefined;

    private async refresh(editor: TextEditor | undefined, options: { full?: boolean, trackedDocument?: TrackedDocument<GitDocumentState> } = {}) {
        if (editor === undefined && this._editor === undefined) return;

        if (editor === undefined || this._lineTracker.lines === undefined) return this.clear(this._editor);

        if (this._editor !== editor) {
            // If we are changing editor, consider this a full refresh
            options.full = true;

            // Clear any annotations on the previously active editor
            this.clearAnnotations(this._editor);

            this._editor = editor;
        }

        const state = this.getBlameAnnotationState();
        if (state.enabled || Container.config.statusBar.enabled || (Container.config.hovers.enabled && Container.config.hovers.currentLine.enabled)) {
            if (options.trackedDocument === undefined) {
                options.trackedDocument = await Container.tracker.getOrAdd(editor.document);
            }

            if (options.trackedDocument.isBlameable) {
                if (Container.config.hovers.enabled && Container.config.hovers.currentLine.enabled &&
                    (options.full || this._hoverProviderDisposable === undefined)) {
                    this.registerHoverProviders(editor, Container.config.hovers.currentLine);
                }

                if (this._updateBlameDebounced === undefined) {
                    this._updateBlameDebounced = Functions.debounce(this.updateBlame, 50, { track: true });
                }
                this._updateBlameDebounced(this._lineTracker.lines, editor, options.trackedDocument);

                return;
            }
        }

        await this.clear(editor);
    }

    private registerHoverProviders(editor: TextEditor | undefined, providers: { details: boolean, changes: boolean }) {
        this.unregisterHoverProviders();

        if (editor === undefined) return;
        if (!providers.details && !providers.changes) return;

        const subscriptions: Disposable[] = [];
        if (providers.changes) {
            subscriptions.push(languages.registerHoverProvider({ pattern: editor.document.uri.fsPath }, { provideHover: this.provideChangesHover.bind(this) } as HoverProvider));
        }
        if (providers.details) {
            subscriptions.push(languages.registerHoverProvider({ pattern: editor.document.uri.fsPath }, { provideHover: this.provideDetailsHover.bind(this) } as HoverProvider));
        }

        this._hoverProviderDisposable = Disposable.from(...subscriptions);
    }

    private unregisterHoverProviders() {
        if (this._hoverProviderDisposable !== undefined) {
            this._hoverProviderDisposable.dispose();
            this._hoverProviderDisposable = undefined;
        }
    }

    private async updateBlame(lines: number[], editor: TextEditor, trackedDocument: TrackedDocument<GitDocumentState>) {
        this._lineTracker.reset();

        // Make sure we are still on the same line and not pending
        if (!this._lineTracker.includesAll(lines) || (this._updateBlameDebounced && this._updateBlameDebounced.pending!())) return;

        let blameLines;
        if (lines.length === 1) {
            const blameLine = editor.document.isDirty
                ? await Container.git.getBlameForLineContents(trackedDocument.uri, lines[0], editor.document.getText())
                : await Container.git.getBlameForLine(trackedDocument.uri, lines[0]);
            if (blameLine === undefined) return this.clear(editor);

            blameLines = [blameLine];
        }
        else {
            const blame = editor.document.isDirty
                ? await Container.git.getBlameForFileContents(trackedDocument.uri, editor.document.getText())
                : await Container.git.getBlameForFile(trackedDocument.uri);
            if (blame === undefined) return this.clear(editor);

            blameLines = lines.map(l => {
                const commitLine = blame.lines[l];
                return {
                    line: commitLine,
                    commit: blame.commits.get(commitLine.sha)!
                };
            });
        }

        // Make sure we are still on the same line, blameable, and not pending, after the await
        if (this._lineTracker.includesAll(lines) && trackedDocument.isBlameable && !(this._updateBlameDebounced && this._updateBlameDebounced.pending!())) {
            if (!this.getBlameAnnotationState().enabled) {
                if (!Container.config.statusBar.enabled) return this.clear(editor);

                this.clearAnnotations(editor);
            }
        }

        const activeLine = blameLines[0];
        this._lineTracker.setState(activeLine.line.line, new GitLineState(activeLine.commit));

        // I have no idea why I need this protection -- but it happens
        if (editor.document === undefined) return;

        if (editor.document.isDirty) {
            const trackedDocument = await Container.tracker.get(editor.document);
            if (trackedDocument !== undefined) {
                trackedDocument.setForceDirtyStateChangeOnNextDocumentChange();
            }
        }

        this.updateStatusBar(activeLine.commit, editor);
        this.updateTrailingAnnotations(blameLines, editor);
    }

    private updateStatusBar(commit: GitCommit, editor: TextEditor) {
        const cfg = Container.config.statusBar;
        if (!cfg.enabled || this._statusBarItem === undefined || !isTextEditor(editor)) return;

        this._statusBarItem.text = `$(git-commit) ${CommitFormatter.fromTemplate(cfg.format, commit, {
            truncateMessageAtNewLine: true,
            dateFormat: cfg.dateFormat === null ? Container.config.defaultDateFormat : cfg.dateFormat
        } as ICommitFormatOptions)}`;

        switch (cfg.command) {
            case StatusBarCommand.ToggleFileBlame:
                this._statusBarItem.tooltip = 'Toggle Blame Annotations';
                break;
            case StatusBarCommand.DiffWithPrevious:
                this._statusBarItem.command = Commands.DiffLineWithPrevious;
                this._statusBarItem.tooltip = 'Compare Line Revision with Previous';
                break;
            case StatusBarCommand.DiffWithWorking:
                this._statusBarItem.command = Commands.DiffLineWithWorking;
                this._statusBarItem.tooltip = 'Compare Line Revision with Working';
                break;
            case StatusBarCommand.ToggleCodeLens:
                this._statusBarItem.tooltip = 'Toggle Git CodeLens';
                break;
            case StatusBarCommand.ShowQuickCommitDetails:
                this._statusBarItem.tooltip = 'Show Commit Details';
                break;
            case StatusBarCommand.ShowQuickCommitFileDetails:
                this._statusBarItem.tooltip = 'Show Line Commit Details';
                break;
            case StatusBarCommand.ShowQuickFileHistory:
                this._statusBarItem.tooltip = 'Show File History';
                break;
            case StatusBarCommand.ShowQuickCurrentBranchHistory:
                this._statusBarItem.tooltip = 'Show Branch History';
                break;
        }

        this._statusBarItem.show();
    }

    private async updateTrailingAnnotations(lines: GitBlameLine[], editor: TextEditor) {
        const cfg = Container.config.currentLine;
        if (!this.getBlameAnnotationState().enabled || !isTextEditor(editor)) return this.clearAnnotations(editor);

        const decorations = [];
        for (const l of lines) {
            const line = l.line.line;

            const decoration = Annotations.trailing(l.commit, cfg.format, cfg.dateFormat === null ? Container.config.defaultDateFormat : cfg.dateFormat);
            decoration.range = editor.document.validateRange(new Range(line, RangeEndOfLineIndex, line, RangeEndOfLineIndex));
            decorations.push(decoration);
        }

        editor.setDecorations(annotationDecoration, decorations);
    }
}
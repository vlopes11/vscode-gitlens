'use strict';
import { DecorationOptions, MarkdownString, Position, Range, TextEditor, TextEditorDecorationType } from 'vscode';
import { AnnotationProviderBase } from './annotationProvider';
import { Annotations } from './annotations';
import { FileAnnotationType } from './../configuration';
import { RangeEndOfLineIndex } from '../constants';
import { Container } from '../container';
import { GitDocumentState, TrackedDocument } from '../trackers/gitDocumentTracker';
import { GitUri } from '../gitService';
import { Logger } from '../logger';

export class RecentChangesAnnotationProvider extends AnnotationProviderBase {

    private readonly _uri: GitUri;

    constructor(
        editor: TextEditor,
        trackedDocument: TrackedDocument<GitDocumentState>,
        decoration: TextEditorDecorationType,
        highlightDecoration: TextEditorDecorationType | undefined
    ) {
        super(editor, trackedDocument, decoration, highlightDecoration);

        this._uri = trackedDocument.uri;
    }

    async onProvideAnnotation(shaOrLine?: string | number): Promise<boolean> {
        this.annotationType = FileAnnotationType.RecentChanges;

        const commit = await Container.git.getRecentLogCommitForFile(this._uri.repoPath, this._uri.fsPath);
        if (commit === undefined) return false;

        const diff = await Container.git.getDiffForFile(this._uri, commit.previousSha);
        if (diff === undefined) return false;

        const start = process.hrtime();

        const cfg = Container.config;
        const dateFormat = cfg.defaultDateFormat;

        this.decorations = [];

        for (const chunk of diff.chunks) {
            let count = chunk.currentPosition.start - 2;
            for (const line of chunk.lines) {
                if (line.line === undefined) continue;

                count++;

                if (line.state === 'unchanged') continue;

                const range = this.editor.document.validateRange(new Range(new Position(count, 0), new Position(count, RangeEndOfLineIndex)));

                let message: MarkdownString | undefined = undefined;

                if (cfg.hovers.enabled && cfg.hovers.annotations.enabled) {
                    if (cfg.hovers.annotations.details) {
                        this.decorations.push({
                            hoverMessage: Annotations.getHoverMessage(commit, dateFormat, await Container.git.getRemotes(commit.repoPath), this.annotationType, this.editor.selection.active.line),
                            range: range
                        } as DecorationOptions);
                    }

                    if (cfg.hovers.annotations.changes) {
                        message = Annotations.getHoverDiffMessage(commit, this._uri, line);
                    }
                }

                this.decorations.push({
                    hoverMessage: message,
                    range: range
                } as DecorationOptions);
            }
        }

        this.editor.setDecorations(this.decoration, this.decorations);

        const duration = process.hrtime(start);
        Logger.log(`${(duration[0] * 1000) + Math.floor(duration[1] / 1000000)} ms to compute recent changes annotations`);

        return true;
    }

    async selection(shaOrLine?: string | number): Promise<void> {
    }

    async validate(): Promise<boolean> {
        return true;
    }
}
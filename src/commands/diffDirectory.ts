'use strict';
import { CancellationTokenSource, commands, TextEditor, Uri, window } from 'vscode';
import { ActiveEditorCommand, Commands, getCommandUri } from './common';
import { CommandContext, isCommandViewContextWithRef } from '../commands';
import { BuiltInCommands, GlyphChars } from '../constants';
import { Container } from '../container';
import { ComparisonResultsNode } from '../views/explorerNodes';
import { Logger } from '../logger';
import { Messages } from '../messages';
import { BranchesAndTagsQuickPick, CommandQuickPickItem } from '../quickPicks/quickPicks';

export interface DiffDirectoryCommandArgs {
    ref1?: string;
    ref2?: string;
}

export class DiffDirectoryCommand extends ActiveEditorCommand {

    constructor() {
        super([Commands.DiffDirectory, Commands.ExternalDiffAll, Commands.ExplorersOpenDirectoryDiff, Commands.ExplorersOpenDirectoryDiffWithWorking]);
    }

    protected async preExecute(context: CommandContext, args: DiffDirectoryCommandArgs = {}): Promise<any> {
        switch (context.command) {
            case Commands.ExternalDiffAll:
                args.ref1 = 'HEAD';
                args.ref2 = undefined;
                break;

            case Commands.ExplorersOpenDirectoryDiff:
                if (context.type === 'view' && context.node instanceof ComparisonResultsNode) {
                    args.ref1 = await context.node.ref1.ref;
                    args.ref2 = await context.node.ref2.ref;
                }
                break;

            case Commands.ExplorersOpenDirectoryDiffWithWorking:
                if (isCommandViewContextWithRef(context)) {
                    args.ref1 = context.node.ref;
                    args.ref2 = undefined;
                }
                break;
        }

        return this.execute(context.editor, context.uri, args);
    }

    async execute(editor?: TextEditor, uri?: Uri, args: DiffDirectoryCommandArgs = {}): Promise<any> {
        uri = getCommandUri(uri, editor);

        let progressCancellation: CancellationTokenSource | undefined;

        try {
            const repoPath = await Container.git.getRepoPath(uri);
            if (!repoPath) return Messages.showNoRepositoryWarningMessage(`Unable to open directory compare`);

            if (!args.ref1) {
                args = { ...args };

                const placeHolder = `Compare Working Tree to ${GlyphChars.Ellipsis}`;

                progressCancellation = BranchesAndTagsQuickPick.showProgress(placeHolder);

                const [branches, tags] = await Promise.all([
                    Container.git.getBranches(repoPath),
                    Container.git.getTags(repoPath)
                ]);

                if (progressCancellation.token.isCancellationRequested) return undefined;

                const pick = await BranchesAndTagsQuickPick.show(branches, tags, placeHolder, { progressCancellation: progressCancellation });
                if (pick === undefined) return undefined;

                if (pick instanceof CommandQuickPickItem) return pick.execute();

                args.ref1 = pick.name;
                if (args.ref1 === undefined) return undefined;
            }

            Container.git.openDirectoryDiff(repoPath, args.ref1, args.ref2);
            return undefined;
        }
        catch (ex) {
            const msg = ex && ex.toString();
            if (msg === 'No diff tool found') {
                const result = await window.showWarningMessage(`Unable to open directory compare because there is no Git diff tool configured`, 'View Git Docs');
                if (!result) return undefined;

                return commands.executeCommand(BuiltInCommands.Open, Uri.parse('https://git-scm.com/docs/git-config#git-config-difftool'));
            }

            Logger.error(ex, 'DiffDirectoryCommand');
            return window.showErrorMessage(`Unable to open directory compare. See output channel for more details`);
        }
        finally {
            progressCancellation && progressCancellation.dispose();
        }
    }
}
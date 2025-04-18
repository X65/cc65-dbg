/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * activateDebug.ts contains the shared extension code that can be executed both in node.js and the browser.
 */

import * as vscode from "vscode";
import type {
	CancellationToken,
	DebugConfiguration,
	ProviderResult,
	WorkspaceFolder,
} from "vscode";
import { Cc65DebugSession } from "./cc65Debug";

export function activateDebug(
	context: vscode.ExtensionContext,
	factory?: vscode.DebugAdapterDescriptorFactory,
) {
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"extension.cc65-dbg.runEditorContents",
			(resource: vscode.Uri) => {
				let targetResource = resource;
				if (!targetResource && vscode.window.activeTextEditor) {
					targetResource = vscode.window.activeTextEditor.document.uri;
				}
				if (targetResource) {
					vscode.debug.startDebugging(
						undefined,
						{
							type: "cc65-dbg",
							name: "Run File",
							request: "launch",
							program: targetResource.fsPath,
						},
						{ noDebug: true },
					);
				}
			},
		),
		vscode.commands.registerCommand(
			"extension.cc65-dbg.debugEditorContents",
			(resource: vscode.Uri) => {
				let targetResource = resource;
				if (!targetResource && vscode.window.activeTextEditor) {
					targetResource = vscode.window.activeTextEditor.document.uri;
				}
				if (targetResource) {
					vscode.debug.startDebugging(undefined, {
						type: "cc65-dbg",
						name: "Debug File",
						request: "launch",
						program: targetResource.fsPath,
						stopOnEntry: true,
					});
				}
			},
		),
		vscode.commands.registerCommand("extension.cc65-dbg.toggleFormatting", (variable) => {
			const ds = vscode.debug.activeDebugSession;
			if (ds) {
				ds.customRequest("toggleFormatting");
			}
		}),
	);

	// register a configuration provider for 'cc65-dbg' debug type
	const provider = new Cc65ConfigurationProvider();
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider("cc65-dbg", provider),
	);

	// register a dynamic configuration provider for 'cc65-dbg' debug type
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider(
			"cc65-dbg",
			{
				provideDebugConfigurations(
					folder: WorkspaceFolder | undefined,
				): ProviderResult<DebugConfiguration[]> {
					return [
						{
							name: "Dynamic Launch",
							request: "launch",
							type: "cc65-dbg",
							program: "${file}",
						},
						{
							name: "Another Dynamic Launch",
							request: "launch",
							type: "cc65-dbg",
							program: "${file}",
						},
						{
							name: "Mock Launch",
							request: "launch",
							type: "cc65-dbg",
							program: "${file}",
						},
					];
				},
			},
			vscode.DebugConfigurationProviderTriggerKind.Dynamic,
		),
	);

	if (!factory) {
		factory = new Cc65DebugAdapterFactory();
	}
	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory("cc65-dbg", factory),
	);
	if ("dispose" in factory && typeof factory.dispose === "function") {
		context.subscriptions.push(factory as vscode.Disposable);
	}
}

class Cc65ConfigurationProvider implements vscode.DebugConfigurationProvider {
	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(
		folder: WorkspaceFolder | undefined,
		config: DebugConfiguration,
		token?: CancellationToken,
	): ProviderResult<DebugConfiguration> {
		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && ["ca65", "cc65"].includes(editor.document.languageId)) {
				config.type = "cc65-dbg";
				config.name = "Launch";
				config.request = "launch";
				config.program = "${file}";
				config.stopOnEntry = true;
			}
		}

		if (!config.program) {
			return vscode.window
				.showInformationMessage("Cannot find a program to debug")
				.then((_) => {
					return undefined; // abort launch
				});
		}

		return config;
	}
}

class Cc65DebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(
		_session: vscode.DebugSession,
	): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new Cc65DebugSession());
	}
}

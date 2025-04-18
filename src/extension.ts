/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * extension.ts (and activateDebug.ts) forms the "plugin" that plugs into VS Code and contains the code that
 * connects VS Code with the debug adapter.
 *
 * extension.ts contains code for launching the debug adapter in three different ways:
 * - as an external program communicating with VS Code via stdin/stdout,
 * - as a server process communicating with VS Code via sockets or named pipes, or
 * - as inlined code running in the extension itself (default).
 *
 * Since the code in extension.ts uses node.js APIs it cannot run in the browser.
 */

import type * as vscode from "vscode";
import { activateDebug } from "./activateDebug";

export function activate(context: vscode.ExtensionContext) {
	activateDebug(context);
}

export function deactivate() {
	// nothing to do
}

/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * web-extension.ts (and activateDebug.ts) forms the "plugin" that plugs into VS Code and contains the code that
 * connects VS Code with the debug adapter.
 *
 * web-extension.ts launches the debug adapter "inlined" because that's the only supported mode for running the debug adapter in the browser.
 */

import type * as vscode from "vscode";
import { activateDebug } from "./activateDebug";

export function activate(context: vscode.ExtensionContext) {
	activateDebug(context); // activateDebug without 2nd argument launches the Debug Adapter "inlined"
}

export function deactivate() {
	// nothing to do
}

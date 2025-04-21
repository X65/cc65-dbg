/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * cc65Debug.ts implements the Debug Adapter that "adapts" or translates the Debug Adapter Protocol (DAP) used by the client (e.g. VS Code)
 * into requests and events of the real "execution engine" or "debugger".
 * When implementing your own debugger extension for VS Code, most of the work will go into the Debug Adapter.
 * Since the Debug Adapter is independent from VS Code, it can be used in any client (IDE) supporting the Debug Adapter Protocol.
 *
 * The is adapter passes most of the messages as-is to underlying adapter/debugger.
 * Its main job is to enrich the protocol with information obtained from cc65 debug info file.
 */

import { LoggingDebugSession } from "@vscode/debugadapter";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DebugSession } from "vscode";

export enum ErrorCodes {
	DAP_SPAWN_ERROR = 1000,
}

/**
 * This interface describes the cc65-dbg specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the cc65-dbg extension.
 * The interface should always match this schema.
 */
interface IRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** run without debugging */
	noDebug?: boolean;
}

interface ILaunchRequestArguments extends IRequestArguments {
	/** The command or path of the debug adapter executable. */
	command: string;
	/** An absolute path to the working directory. */
	cwd?: string;
	/** Debugee arguments. */
	args?: string[];
}

interface IAttachRequestArguments extends IRequestArguments {
	/** TCP port to attach to. */
	port: number;
	/** TCP host to attach to. */
	host?: string;
}

export class Cc65DebugSession extends LoggingDebugSession {
	private _session: DebugSession;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor(session: DebugSession) {
		super("cc65-dbg.log");
		console.log("constructor", session);

		this._session = session;

		// this debugger uses one-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	public handleMessage(message: DebugProtocol.ProtocolMessage) {
		console.debug("message", message);
		return super.handleMessage(message);
	}
}

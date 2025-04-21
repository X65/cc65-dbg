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

import {
	LoggingDebugSession,
	Logger,
	logger,
	TerminatedEvent,
	ExitedEvent,
} from "@vscode/debugadapter";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DebugSession } from "vscode";
import * as path from "path";
import { ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { sleep } from "./utils";

export enum ErrorCodes {
	DAP_NOT_SUPPORTED = 1000,
	DAP_SPAWN_ERROR = 1001,
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

	private _launchedSuccessfully = false;
	private _program: ChildProcessWithoutNullStreams | undefined;

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

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(
			this._session.configuration.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop,
			false,
		);
	}

	/**
	 * Log every incoming message for development purposes.
	 */
	public handleMessage(message: DebugProtocol.ProtocolMessage) {
		console.debug(">>> message", message);
		return super.handleMessage(message);
	}

	private async launchAdapter(
		command: string,
		args: string[],
		cwd: string,
	): Promise<string | null> {
		console.debug("launchAdapter", command, args, cwd);

		this._program = spawn(command, args, {
			cwd: path.parse(cwd || ".").dir,
		});

		let failMessage: string | null = null;
		this._program.on("error", (err) => {
			// failed to spawn, exit early
			failMessage = err.message;
			console.log(`launch error: ${err.message}`);
		});

		this._program.stdout.on("data", (data) => {
			console.log(`stdout: ${data}`);
		});

		this._program.stderr.on("data", (data) => {
			console.error(`stderr: ${data}`);
		});

		this._program.on("close", (_code) => {
			// stdio streams closed
			if (this._launchedSuccessfully) {
				this.sendEvent(new TerminatedEvent());
			}
		});

		this._program.on("exit", (code) => {
			// process terminated
			if (this._launchedSuccessfully) {
				this.sendEvent(new ExitedEvent(code || 0));
			}
		});

		while (this._program.pid == null && this._program.exitCode == null) {
			await sleep(100);
		}

		console.log(this._program.pid, this._program.exitCode, failMessage);
		return this._program.exitCode == null
			? null
			: failMessage || String(this._program.exitCode);
	}

	private connectAdapter() {}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected async initializeRequest(
		response: DebugProtocol.InitializeResponse,
		args: DebugProtocol.InitializeRequestArguments,
	) {
		console.log("initializeRequest", args);

		const { request } = this._session.configuration;

		switch (request) {
			case "launch":
				{
					const { command, args: cmd_args, cwd } = this._session.configuration;
					const cmd = path.resolve(
						this._session.workspaceFolder?.uri.fsPath || ".",
						command,
					);
					this._launchedSuccessfully = false;
					const failMessage = await this.launchAdapter(cmd, cmd_args, cwd);
					if (failMessage)
						return this.sendErrorResponse(response, {
							id: ErrorCodes.DAP_SPAWN_ERROR,
							format: "Failed to launch DAP adapter/debugger: {failMessage}",
							variables: { failMessage },
							showUser: true,
						});
					this._launchedSuccessfully = true;
				}
				break;

			default:
				return this.sendErrorResponse(response, {
					id: ErrorCodes.DAP_NOT_SUPPORTED,
					format: "Unsupported debugger request type: {request}",
					variables: { request },
					showUser: true,
				});
		}

		// TODO: get actual configuration from debugger

		this.sendResponse(response);
	}

	protected async attachRequest(
		response: DebugProtocol.AttachResponse,
		args: IAttachRequestArguments,
	) {
		console.log("attachRequest", args);
		return this.sendErrorResponse(response, {
			id: ErrorCodes.DAP_NOT_SUPPORTED,
			format: "Attaching to TCP port is not yet supported.",
			showUser: true,
		});
	}

	protected async launchRequest(
		response: DebugProtocol.LaunchResponse,
		args: ILaunchRequestArguments,
	) {
		console.log("launchRequest", args);
	}
}

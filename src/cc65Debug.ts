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
import * as path from "node:path";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { sleep } from "./utils";

export enum ErrorCodes {
	DAP_NOT_SUPPORTED = 1000,
	DAP_SPAWN_ERROR = 1001,
	DAP_CONNECT_ERROR = 1002,
}

const TWO_CRLF = "\r\n\r\n";

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

	private _data: Buffer;
	private _dataLength: number;

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

		this._data = Buffer.alloc(0);
		this._dataLength = 0;

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
	 * Handles incoming Debug Adapter Protocol messages.
	 *
	 * This function processes incoming messages and routes them appropriately.
	 * Some messages need to massaged before sending to debugger/adapter.
	 * For all other requests, it sends the message directly.
	 */
	public handleMessage(message: DebugProtocol.ProtocolMessage) {
		console.debug(">>> message", message);
		if (message.type === "request")
			switch ((message as DebugProtocol.Request).command) {
				case "initialize":
					// pass to dispatcher
					return super.handleMessage(message);
				default:
					// route to debugger/adapter
					return this.sendMessage(message);
			}
	}

	/**
	 * Sends a Debug Adapter Protocol message to the debugger/adapter.
	 *
	 * This function serializes the message to JSON, calculates its length,
	 * prepares a header with the content length, and writes both the header
	 * and the message to the stdin of the debugger/adapter process.
	 *
	 * @param message - The Debug Adapter Protocol message to be sent.
	 *                  This should be an object conforming to the DebugProtocol.ProtocolMessage interface.
	 */
	protected sendMessage(message: DebugProtocol.ProtocolMessage) {
		console.debug("sendMessage", message);
		const json = JSON.stringify(message);
		const contentLength = Buffer.byteLength(json, "utf8");

		const header = `Content-Length: ${contentLength}\r\n\r\n`;

		if (this._program) {
			this._program.stdin.write(header + json, "utf8");
		}
	}

	public sendResponse(response: DebugProtocol.Response): void {
		response.seq = 0; // underlying adapter tracks the sequence numbers on its own
		console.debug("sendResponse", response);
		super.sendResponse(response);
	}

	public sendEvent(event: DebugProtocol.Event): void {
		event.seq = 0; // underlying adapter tracks the sequence numbers on its own
		console.debug("sendEvent", event);
		super.sendEvent(event);
	}

	/**
	 * Handles incoming messages from the debugger/adapter process.
	 *
	 * @param data - A Buffer containing the raw data of the incoming message.
	 *               This data is expected to be in the Debug Adapter Protocol format.
	 */
	private _processData(data: Buffer): void {
		console.debug("_processData", data.toString());

		this._data = Buffer.concat([this._data, data]);

		while (true) {
			if (this._dataLength >= 0) {
				if (this._data.length >= this._dataLength) {
					const message = this._data.toString("utf8", 0, this._dataLength);
					this._data = this._data.slice(this._dataLength);
					this._dataLength = -1;
					if (message.length > 0) {
						try {
							const msg: DebugProtocol.ProtocolMessage = JSON.parse(message);
							switch (msg.type) {
								case "response":
									this.processResponse(msg as DebugProtocol.Response);
									break;
								case "event":
									this.processEvent(msg as DebugProtocol.Event);
									break;
								default:
									throw new Error(`Unknown message type: ${msg.type}`);
							}
						} catch (e) {
							console.error(`Error handling data: ${(e as Error)?.message}`);
						}
					}
					continue; // there may be more complete messages to process
				}
			} else {
				const idx = this._data.indexOf(TWO_CRLF);
				if (idx !== -1) {
					const header = this._data.toString("utf8", 0, idx);
					const lines = header.split("\r\n");
					for (let i = 0; i < lines.length; i++) {
						const pair = lines[i].split(/: +/);
						if (pair[0] === "Content-Length") {
							this._dataLength = +pair[1];
						}
					}
					this._data = this._data.slice(idx + TWO_CRLF.length);
					continue;
				}
			}
			break;
		}
	}

	/**
	 * Dispatches a received response message to the appropriate handler.
	 *
	 * @param response - The received response message.
	 *                   This should be an object conforming to the DebugProtocol.Response interface.
	 */
	protected processResponse(response: DebugProtocol.Response) {
		console.debug("processResponse", response);
		switch (response.command) {
			case "initialize": {
				const result = response as DebugProtocol.InitializeResponse;

				if (!result.body) result.body = {};
				result.body.supportsInstructionBreakpoints = true;
				return this.sendResponse(result);
			}
		}
		return this.sendResponse(response);
	}

	/**
	 * Dispatches an incoming event message to the appropriate handler.
	 *
	 * @param event - The received event message.
	 *                 This should be an object conforming to the DebugProtocol.Event interface.
	 */
	protected processEvent(event: DebugProtocol.Event) {
		console.debug("processEvent", event);
		return this.sendEvent(event);
	}

	/**
	 * Launches the debugger/adapter process.
	 *
	 * @param command - The full path to the debugger/adapter binary.
	 * @param args - Additional arguments to pass to the debugger/adapter.
	 * @param cwd - The working directory for the debugger/adapter.
	 * @returns A promise that resolves to null if the launch was successful, or a failure message string if it failed.
	 */
	protected async launchAdapter(
		command: string,
		args: string[],
		cwd: string,
	): Promise<string | null> {
		console.debug("launchAdapter", command, args, cwd);

		this._program = spawn(command, args, { cwd });

		let failMessage: string | null = null;
		this._program.on("error", (err) => {
			// failed to spawn, exit early
			failMessage = err.message;
			logger.error(`launch error: ${err.message}`);
		});

		this._program.stdout.on("data", (data: Buffer) => {
			this._processData(data);
		});

		this._program.stderr.on("data", (data) => {
			console.error(data.toString());
			logger.error(`stderr: ${data}`);
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

	/**
	 * Attempts to connect to an existing debugger adapter.
	 */
	protected connectAdapter(port: number, host: string): Promise<string | null> {
		throw new Error("Connecting to existing debugger not supported yet.");
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected async initializeRequest(
		response: DebugProtocol.InitializeResponse,
		args: DebugProtocol.InitializeRequestArguments,
	) {
		console.log("initializeRequest", args, response);

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

			case "attach":
				{
					const { port, host = "localhost" } = this._session.configuration;
					const failMessage = await this.connectAdapter(port, host);
					if (failMessage)
						return this.sendErrorResponse(response, {
							id: ErrorCodes.DAP_CONNECT_ERROR,
							format: "Failed to connect DAP adapter/debugger: {failMessage}",
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

		// Get configuration from debugger
		this.sendMessage({
			seq: response.request_seq,
			type: "request",
			command: response.command,
			arguments: args,
		} as DebugProtocol.InitializeRequest);
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

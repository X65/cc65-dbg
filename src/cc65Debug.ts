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

import { LoggingDebugSession, Logger, logger, TerminatedEvent } from "@vscode/debugadapter";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DebugSession } from "vscode";
import { addressToSpans, type DbgMap, readDebugFile, spansToSpanLines } from "./dbgService";
import * as path from "node:path";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { normalizePath } from "./utils";

export enum ErrorCodes {
	DAP_NOT_SUPPORTED = 1000,
	DAP_SPAWN_ERROR = 1001,
	DAP_CONNECT_ERROR = 1002,
	DAP_ENV_INCORRECT = 1003,
	DAP_PROTOCOL_VIOLATION = 1004,
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

	private _program: ChildProcessWithoutNullStreams | undefined;

	/// connected over TCP port?
	private _connected = false;

	private _debugData: DbgMap | undefined;
	private _debugPathBases: string[] = [];
	private _requestBreakpoints: Map<number, (number | string)[]> = new Map();

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
				case "attach":
				case "disconnect":
				case "setBreakpoints":
				case "setInstructionBreakpoints":
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

		this._program?.stdin.write(header + json, "utf8");
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

				const { program } = this._session.configuration;
				const programPath = path.resolve(
					this._session.workspaceFolder?.uri.fsPath || ".",
					program,
				);
				const dbgPath = `${path.join(path.dirname(programPath), path.basename(programPath, path.extname(programPath)))}.dbg`;
				try {
					this._debugData = readDebugFile(dbgPath);
				} catch (error) {
					console.error(`Error reading debug file: ${(error as Error)?.message}`);
					//can't find file
					return this.sendErrorResponse(response, {
						id: ErrorCodes.DAP_ENV_INCORRECT,
						format: "resource error: unable to find or load .dbg file: {dbgPath}",
						variables: { dbgPath },
						showUser: true,
					});
				}

				return this.sendResponse(result);
			}
			case "setBreakpoints": {
				const result = response as DebugProtocol.SetBreakpointsResponse;
				const { breakpoints } = result.body;
				const requestBreakpoints = this._requestBreakpoints.get(response.request_seq);
				this._requestBreakpoints.delete(response.request_seq);
				if (!requestBreakpoints) {
					return this.sendErrorResponse(response, {
						id: ErrorCodes.DAP_PROTOCOL_VIOLATION,
						format: "Received out-of-order setBreakpoints response",
						showUser: false,
					});
				}

				result.body.breakpoints = requestBreakpoints.map((bp) => {
					if (typeof bp === "number") {
						const res = breakpoints.shift();
						if (res) return res;
						throw new Error(
							`SetBreakpoints ${response.request_seq} returned less breakpoints than requested.`,
						);
					}
					return {
						verified: false,
						reason: "failed",
						message: bp || undefined,
					};
				});

				return this.sendResponse(result);
			}
			case "stackTrace": {
				const result = response as DebugProtocol.StackTraceResponse;
				const { stackFrames } = result.body;

				if (!this._debugData) {
					throw new Error("Cannot work without loaded .dbg file");
				}

				// Convert memory addresses to source locations
				for (const frame of stackFrames) {
					const spans = addressToSpans(this._debugData, frame.line, true);
					const lines = spansToSpanLines(this._debugData, spans);
					const dbgLine = lines[0]?.line;
					if (dbgLine) {
						frame.instructionPointerReference = `0x${frame.id.toString(16).toUpperCase()}`;
						frame.line = dbgLine.line;
						const dbgFile = this._debugData.file.find((f) => f.id === dbgLine.file);
						if (dbgFile) {
							const fileName = normalizePath(dbgFile.name);
							for (const base of this._debugPathBases) {
								if (fileName.startsWith(base)) {
									const name = fileName.slice(base.length);
									frame.source = {
										name,
										path: path.resolve(
											this._session.workspaceFolder?.uri.fsPath || ".",
											name,
										),
										presentationHint: "emphasize",
									};
									break;
								}
							}
						}
					}
				}

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
	protected launchAdapter(command: string, args: string[], cwd: string): Promise<void> {
		console.debug("launchAdapter", command, args, cwd);

		return new Promise((resolve, reject) => {
			const spawnErrorHandler = (err: Error) => {
				logger.error(`spawn error: ${err.message}`);
				reject(err);
			};

			this._program = spawn(command, args, { cwd });

			this._program.once("error", spawnErrorHandler);
			this._program.once("spawn", () => {
				if (!this._program) throw new Error("adapter disappeared");

				this._program.off("error", spawnErrorHandler);

				this._program.stdout.on("data", (data: Buffer) => {
					this._processData(data);
				});

				this._program.stderr.on("data", (data) => {
					console.error(data.toString());
					logger.error(`stderr: ${data}`);
				});

				this._program.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
					// stdio streams closed
					this.sendEvent(new TerminatedEvent());
					if (signal && signal !== "SIGTERM") {
						const errorMsg = `Adapter process was terminated by signal ${signal}`;
						logger.error(errorMsg);
						console.error(errorMsg);
					}
				});

				resolve();
			});
		});
	}

	/**
	 * Attempts to connect to an existing debugger adapter.
	 */
	protected connectAdapter(port: number, host: string): Promise<void> {
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
					try {
						await this.launchAdapter(cmd, cmd_args, cwd);
					} catch (error) {
						return this.sendErrorResponse(response, {
							id: ErrorCodes.DAP_SPAWN_ERROR,
							format: "Failed to launch DAP adapter/debugger: {error}",
							variables: { error: String(error) },
							showUser: true,
						});
					}
				}
				break;

			case "attach":
				{
					const { port, host = "localhost" } = this._session.configuration;
					try {
						await this.connectAdapter(port, host);
					} catch (error) {
						return this.sendErrorResponse(response, {
							id: ErrorCodes.DAP_CONNECT_ERROR,
							format: "Failed to connect DAP adapter/debugger: {error}",
							variables: { error: String(error) },
							showUser: true,
						});
					}
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
		return this.sendMessage({
			seq: response.request_seq,
			type: "request",
			command: response.command,
			arguments: args,
		} as DebugProtocol.InitializeRequest);
	}

	protected attachRequest(
		response: DebugProtocol.AttachResponse,
		args: DebugProtocol.AttachRequestArguments,
		request?: DebugProtocol.Request,
	) {
		console.log("attachRequest", args);
		return this.sendErrorResponse(response, {
			id: ErrorCodes.DAP_NOT_SUPPORTED,
			format: "Attaching to TCP port is not yet supported.",
			showUser: true,
		});
	}

	protected disconnectRequest(
		response: DebugProtocol.DisconnectResponse,
		args: DebugProtocol.DisconnectArguments,
		request?: DebugProtocol.Request,
	) {
		console.log("disconnectRequest", args, request);
		if (!request) throw new Error("Original request not provided");

		request.arguments.terminateDebuggee = !this._connected;
		return this.sendMessage(request);
	}

	protected setBreakPointsRequest(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments,
		request: DebugProtocol.Request,
	) {
		console.log("setBreakPointsRequest", args);

		const workspacePath = path.resolve(this._session.workspaceFolder?.uri.fsPath || ".");
		const { source, breakpoints, lines } = args;

		if (!source.path) throw new Error("Source path is required");
		if (!breakpoints && !lines) throw new Error("Either breakpoints or lines are required");

		const sourceLines = lines || breakpoints?.map(({ line }) => line) || [];

		const sourcePath = normalizePath(source.path);
		const sourceBase = path.relative(workspacePath, sourcePath);
		const dbgFile = this._debugData?.file.find((file) => {
			const filePath = normalizePath(file.name);
			return filePath.endsWith(`${path.posix.sep}${sourceBase}`);
		});

		if (!response.body) response.body = { breakpoints: [] };
		if (!response.body.breakpoints) response.body.breakpoints = [];

		if (!dbgFile) {
			response.body.breakpoints = sourceLines.map((line) => ({
				verified: false,
				source,
				line,
				reason: "failed",
				message: `Source file '${sourceBase}' is missing in debug info file`,
			}));
			return this.sendResponse(response);
		}

		// Store path base for later name reconstruction
		const fileBase = normalizePath(dbgFile.name).slice(0, -sourceBase.length);
		if (!this._debugPathBases.includes(fileBase)) this._debugPathBases.push(fileBase);

		// map source lines to memory addresses
		const { arguments: requestArguments } = request as DebugProtocol.SetBreakpointsRequest;

		// unset breakpoints, as we use lines as memory addresses to break
		requestArguments.breakpoints = undefined;
		// update source information in the request
		requestArguments.source = {
			/// @name - used only for display in the UI
			name: sourceBase,
			/// @sourceReference - used to identify the source of breaks in the debug adapter
			sourceReference: dbgFile.id,
		};

		const reqBreakpoints = sourceLines.map((lineNo) => {
			const dbgLine = this._debugData?.line.find(
				({ file, line }) => file === dbgFile.id && line === lineNo,
			);
			if (!dbgLine) {
				console.info(`Line ${lineNo} does not exist in '${sourceBase}' debug info.`);
				return "";
			}

			if (dbgLine.span) {
				const dbgSpans = this._debugData?.span.filter(({ id }) =>
					dbgLine.span?.includes(id),
				);

				for (const dbgSpan of dbgSpans || []) {
					const dbgSeg = this._debugData?.seg.find(({ id }) => id === dbgSpan.seg);
					if (!dbgSeg) {
						return `Span ${dbgSpan.id} does not exist in '${sourceBase}' debug info.`;
					}

					if (Number.isInteger(dbgSeg.start)) {
						return dbgSeg.start + dbgSpan.start;
					}

					return `'${sourceBase}:${lineNo}' does not map to memory address.`;
				}
			}

			const dbgSym = this._debugData?.sym.find(({ def }) => def.includes(dbgLine.id));
			if (dbgSym) {
				const address = Number(dbgSym.val);
				if (Number.isInteger(address)) {
					return address;
				}
				return `Invalid memory address for symbol ${dbgSym.name} in debug info.`;
			}

			return `'${sourceBase}:${lineNo}' does not map to memory.`;
		});

		// Store for later reintegration
		this._requestBreakpoints.set(request.seq, reqBreakpoints);
		// Send only valid addresses to the debugger
		requestArguments.lines = reqBreakpoints.filter((bp) => Number.isInteger(bp)) as number[];

		return this.sendMessage(request);
	}

	protected setInstructionBreakpointsRequest(
		response: DebugProtocol.SetInstructionBreakpointsResponse,
		args: DebugProtocol.SetInstructionBreakpointsArguments,
		request?: DebugProtocol.Request,
	): void {
		console.log("setInstructionBreakpointsRequest", args);
	}
}

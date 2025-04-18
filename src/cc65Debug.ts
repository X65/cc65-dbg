/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * mockDebug.ts implements the Debug Adapter that "adapts" or translates the Debug Adapter Protocol (DAP) used by the client (e.g. VS Code)
 * into requests and events of the real "execution engine" or "debugger" (here: class MockRuntime).
 * When implementing your own debugger extension for VS Code, most of the work will go into the Debug Adapter.
 * Since the Debug Adapter is independent from VS Code, it can be used in any client (IDE) supporting the Debug Adapter Protocol.
 *
 * The most important class of the Debug Adapter is the MockDebugSession which implements many DAP requests by talking to the MockRuntime.
 */

import {
	Breakpoint,
	BreakpointEvent,
	ExitedEvent,
	Handles,
	InitializedEvent,
	InvalidatedEvent,
	Logger,
	LoggingDebugSession,
	MemoryEvent,
	OutputEvent,
	ProgressEndEvent,
	ProgressStartEvent,
	ProgressUpdateEvent,
	Scope,
	Source,
	StackFrame,
	StoppedEvent,
	TerminatedEvent,
	Thread,
	logger,
} from "@vscode/debugadapter";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type * as vscode from "vscode";
import { Subject } from "await-notify";
import * as base64 from "base64-js";
import * as path from "path";
import { basename } from "path-browserify";
import { ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "child_process";

export function timeout(time: number) {
	return new Promise((resolve) => setTimeout(resolve, time));
}

export enum ErrorCodes {
	DAP_SPAWN_ERROR = 1000,
}

/**
 * This interface describes the cc65-dbg specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the cc65-dbg extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** run without debugging */
	noDebug?: boolean;
	/** An absolute path to the working directory. */
	cwd?: string;
	/** Debugee arguments. */
	args?: string[];
}

interface IAttachRequestArguments extends ILaunchRequestArguments {}

export class Cc65DebugSession extends LoggingDebugSession {
	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static threadID = 1;

	private _program: ChildProcessWithoutNullStreams | undefined;

	private _launchedSuccessfully = false;

	private _variableHandles = new Handles<"locals" | "globals">();

	private _configurationDone = new Subject();

	private _cancellationTokens = new Map<number, boolean>();

	private _reportProgress = false;
	private _progressId = 10000;
	private _cancelledProgressId: string | undefined = undefined;
	private _isProgressCancellable = true;

	private _valuesInHex = false;
	private _useInvalidatedEvent = false;

	private _addressesInHex = true;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		console.log("constructor");
		super("cc65-dbg.log");

		// this debugger uses one-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	public handleMessage(message: DebugProtocol.ProtocolMessage) {
		console.log("message", message);
		return super.handleMessage(message);
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(
		response: DebugProtocol.InitializeResponse,
		args: DebugProtocol.InitializeRequestArguments,
	): void {
		console.log("initializeRequest", response, args);
		if (args.supportsProgressReporting) {
			this._reportProgress = true;
		}
		if (args.supportsInvalidatedEvent) {
			this._useInvalidatedEvent = true;
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDone request.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code show a 'step back' button
		response.body.supportsStepBack = true;

		// make VS Code support data breakpoints
		response.body.supportsDataBreakpoints = true;

		// make VS Code support completion in REPL
		response.body.supportsCompletionsRequest = true;
		response.body.completionTriggerCharacters = [".", "["];

		// make VS Code send cancel request
		response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		// make VS Code provide "Step in Target" functionality
		response.body.supportsStepInTargetsRequest = true;

		// the adapter defines two exceptions filters, one with support for conditions.
		response.body.supportsExceptionFilterOptions = true;
		response.body.exceptionBreakpointFilters = [
			{
				filter: "namedException",
				label: "Named Exception",
				description: `Break on named exceptions. Enter the exception's name as the Condition.`,
				default: false,
				supportsCondition: true,
				conditionDescription: `Enter the exception's name`,
			},
			{
				filter: "otherExceptions",
				label: "Other Exceptions",
				description: "This is a other exception",
				default: true,
				supportsCondition: false,
			},
		];

		// make VS Code send exceptionInfo request
		response.body.supportsExceptionInfoRequest = true;

		// make VS Code send setVariable request
		response.body.supportsSetVariable = true;

		// make VS Code send setExpression request
		response.body.supportsSetExpression = true;

		// make VS Code send disassemble request
		response.body.supportsDisassembleRequest = true;
		response.body.supportsSteppingGranularity = true;
		response.body.supportsInstructionBreakpoints = true;

		// make VS Code able to read and write variable memory
		response.body.supportsReadMemoryRequest = true;
		response.body.supportsWriteMemoryRequest = true;

		response.body.supportSuspendDebuggee = true;
		response.body.supportTerminateDebuggee = true;
		response.body.supportsFunctionBreakpoints = true;
		response.body.supportsDelayedStackTraceLoading = true;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(
		response: DebugProtocol.ConfigurationDoneResponse,
		args: DebugProtocol.ConfigurationDoneArguments,
	): void {
		console.log("configurationDoneRequest");
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected disconnectRequest(
		response: DebugProtocol.DisconnectResponse,
		args: DebugProtocol.DisconnectArguments,
		request?: DebugProtocol.Request,
	): void {
		console.log("disconnectRequest");
		this.terminateRequest(response, args, request);
	}

	protected terminateRequest(
		response: DebugProtocol.DisconnectResponse,
		args: DebugProtocol.DisconnectArguments,
		request?: DebugProtocol.Request,
	): void {
		console.log("terminateRequest");
		console.log(
			`terminateRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`,
			request,
			response,
		);

		this.sendResponse(response);

		if (args.terminateDebuggee) {
			this._program?.stdin.destroy();
			this._program?.stdout.destroy();
			this._program?.stderr.destroy();
			this._program?.kill("SIGTERM");
		}
	}

	protected async attachRequest(
		response: DebugProtocol.AttachResponse,
		args: IAttachRequestArguments,
	) {
		console.log("attachRequest");
		return this.launchRequest(response, args);
	}

	protected async launchRequest(
		response: DebugProtocol.LaunchResponse,
		args: ILaunchRequestArguments,
	) {
		console.log("launchRequest");
		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait 1 second until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// // start the program
		// this._launchedSuccessfully = false;
		// this._program = spawn(args.program, args.args, {
		// 	cwd: path.parse(args.cwd || ".").dir,
		// });

		// let failMessage = "";
		// this._program.on("error", (err) => {
		// 	// failed to spawn, exit early
		// 	failMessage = err.message;
		// 	console.log(`launch error: ${err.message}`);
		// });

		// this._program.stdout.on("data", (data) => {
		// 	console.log(`stdout: ${data}`);
		// });

		// this._program.stderr.on("data", (data) => {
		// 	console.error(`stderr: ${data}`);
		// });

		// this._program.on("close", (_code) => {
		// 	// stdio streams closed
		// 	if (this._launchedSuccessfully) {
		// 		this.sendEvent(new TerminatedEvent());
		// 	}
		// });

		// this._program.on("exit", (code) => {
		// 	// process terminated
		// 	if (this._launchedSuccessfully) {
		// 		this.sendEvent(new ExitedEvent(code || 0));
		// 	}
		// });

		// while (!this._program.pid == null && this._program.exitCode == null) {
		// 	await timeout(500);
		// }

		// if (this._program.pid) {
		// 	this._launchedSuccessfully = true;
		// 	this.sendResponse(response);
		// } else {
		// 	this.sendErrorResponse(response, {
		// 		id: ErrorCodes.DAP_SPAWN_ERROR,
		// 		format: "Failed to launch DAP adapter/debugger: {failMessage}",
		// 		variables: { failMessage },
		// 		showUser: true,
		// 	});
		// }
	}

	protected setFunctionBreakPointsRequest(
		response: DebugProtocol.SetFunctionBreakpointsResponse,
		args: DebugProtocol.SetFunctionBreakpointsArguments,
		request?: DebugProtocol.Request,
	): void {
		console.log("setFunctionBreakPointsRequest");
		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments,
	): Promise<void> {
		console.log("setBreakPointsRequest");
		const path = args.source.path as string;
		const clientLines = args.lines || [];

		// // clear all breakpoints for this file
		// this._runtime.clearBreakpoints(path);

		// // set and verify breakpoint locations
		// const actualBreakpoints0 = clientLines.map(async (l) => {
		// 	const { verified, line, id } = await this._runtime.setBreakPoint(
		// 		path,
		// 		this.convertClientLineToDebugger(l),
		// 	);
		// 	const bp = new Breakpoint(
		// 		verified,
		// 		this.convertDebuggerLineToClient(line),
		// 	) as DebugProtocol.Breakpoint;
		// 	bp.id = id;
		// 	return bp;
		// });
		// const actualBreakpoints = await Promise.all<DebugProtocol.Breakpoint>(actualBreakpoints0);

		// // send back the actual breakpoint positions
		// response.body = {
		// 	breakpoints: actualBreakpoints,
		// };
		this.sendResponse(response);
	}

	protected breakpointLocationsRequest(
		response: DebugProtocol.BreakpointLocationsResponse,
		args: DebugProtocol.BreakpointLocationsArguments,
		request?: DebugProtocol.Request,
	): void {
		console.log("breakpointLocationsRequest");
		// if (args.source.path) {
		// 	const bps = this._runtime.getBreakpoints(
		// 		args.source.path,
		// 		this.convertClientLineToDebugger(args.line),
		// 	);
		// 	response.body = {
		// 		breakpoints: bps.map((col) => {
		// 			return {
		// 				line: args.line,
		// 				column: this.convertDebuggerColumnToClient(col),
		// 			};
		// 		}),
		// 	};
		// } else {
		// 	response.body = {
		// 		breakpoints: [],
		// 	};
		// }
		this.sendResponse(response);
	}

	protected async setExceptionBreakPointsRequest(
		response: DebugProtocol.SetExceptionBreakpointsResponse,
		args: DebugProtocol.SetExceptionBreakpointsArguments,
	): Promise<void> {
		console.log("setExceptionBreakPointsRequest");
		let namedException: string | undefined = undefined;
		let otherExceptions = false;

		if (args.filterOptions) {
			for (const filterOption of args.filterOptions) {
				switch (filterOption.filterId) {
					case "namedException":
						namedException = args.filterOptions[0].condition;
						break;
					case "otherExceptions":
						otherExceptions = true;
						break;
				}
			}
		}

		if (args.filters) {
			if (args.filters.indexOf("otherExceptions") >= 0) {
				otherExceptions = true;
			}
		}

		// this._runtime.setExceptionsFilters(namedException, otherExceptions);

		this.sendResponse(response);
	}

	protected exceptionInfoRequest(
		response: DebugProtocol.ExceptionInfoResponse,
		args: DebugProtocol.ExceptionInfoArguments,
	) {
		console.log("exceptionInfoRequest");
		response.body = {
			exceptionId: "Exception ID",
			description: "This is a descriptive description of the exception.",
			breakMode: "always",
			details: {
				message: "Message contained in the exception.",
				typeName: "Short type name of the exception object",
				stackTrace: "stack frame 1\nstack frame 2",
			},
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		console.log("threadsRequest");
		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(Cc65DebugSession.threadID, "thread 1"),
				new Thread(Cc65DebugSession.threadID + 1, "thread 2"),
			],
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(
		response: DebugProtocol.StackTraceResponse,
		args: DebugProtocol.StackTraceArguments,
	): void {
		console.log("stackTraceRequest");
		const startFrame = typeof args.startFrame === "number" ? args.startFrame : 0;
		const maxLevels = typeof args.levels === "number" ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		// const stk = this._runtime.stack(startFrame, endFrame);

		// response.body = {
		// 	stackFrames: stk.frames.map((f, ix) => {
		// 		const sf: DebugProtocol.StackFrame = new StackFrame(
		// 			f.index,
		// 			f.name,
		// 			this.createSource(f.file),
		// 			this.convertDebuggerLineToClient(f.line),
		// 		);
		// 		if (typeof f.column === "number") {
		// 			sf.column = this.convertDebuggerColumnToClient(f.column);
		// 		}
		// 		if (typeof f.instruction === "number") {
		// 			const address = this.formatAddress(f.instruction);
		// 			sf.name = `${f.name} ${address}`;
		// 			sf.instructionPointerReference = address;
		// 		}

		// 		return sf;
		// 	}),
		// 	// 4 options for 'totalFrames':
		// 	//omit totalFrames property: 	// VS Code has to probe/guess. Should result in a max. of two requests
		// 	totalFrames: stk.count, // stk.count is the correct size, should result in a max. of two requests
		// 	//totalFrames: 1000000 			// not the correct size, should result in a max. of two requests
		// 	//totalFrames: endFrame + 20 	// dynamically increases the size with every requested chunk, results in paging
		// };
		this.sendResponse(response);
	}

	protected scopesRequest(
		response: DebugProtocol.ScopesResponse,
		args: DebugProtocol.ScopesArguments,
	): void {
		console.log("scopesRequest");
		response.body = {
			scopes: [
				new Scope("Locals", this._variableHandles.create("locals"), false),
				new Scope("Globals", this._variableHandles.create("globals"), true),
			],
		};
		this.sendResponse(response);
	}

	protected async writeMemoryRequest(
		response: DebugProtocol.WriteMemoryResponse,
		{ data, memoryReference, offset = 0 }: DebugProtocol.WriteMemoryArguments,
	) {
		console.log("writeMemoryRequest");
		const variable = this._variableHandles.get(Number(memoryReference));
		if (typeof variable === "object") {
			const decoded = base64.toByteArray(data);
			// variable.setMemory(decoded, offset);
			response.body = { bytesWritten: decoded.length };
		} else {
			response.body = { bytesWritten: 0 };
		}

		this.sendResponse(response);
		this.sendEvent(new InvalidatedEvent(["variables"]));
	}

	protected async readMemoryRequest(
		response: DebugProtocol.ReadMemoryResponse,
		{ offset = 0, count, memoryReference }: DebugProtocol.ReadMemoryArguments,
	) {
		console.log("readMemoryRequest");
		const variable = this._variableHandles.get(Number(memoryReference));
		// if (typeof variable === "object" && variable.memory) {
		// 	const memory = variable.memory.subarray(
		// 		Math.min(offset, variable.memory.length),
		// 		Math.min(offset + count, variable.memory.length),
		// 	);

		// 	response.body = {
		// 		address: offset.toString(),
		// 		data: base64.fromByteArray(memory),
		// 		unreadableBytes: count - memory.length,
		// 	};
		// } else {
		response.body = {
			address: offset.toString(),
			data: "",
			unreadableBytes: count,
		};
		// }

		this.sendResponse(response);
	}

	protected async variablesRequest(
		response: DebugProtocol.VariablesResponse,
		args: DebugProtocol.VariablesArguments,
		request?: DebugProtocol.Request,
	): Promise<void> {
		console.log("variablesRequest");
		// let vs: RuntimeVariable[] = [];

		// const v = this._variableHandles.get(args.variablesReference);
		// if (v === "locals") {
		// 	vs = this._runtime.getLocalVariables();
		// } else if (v === "globals") {
		// 	if (request) {
		// 		this._cancellationTokens.set(request.seq, false);
		// 		vs = await this._runtime.getGlobalVariables(
		// 			() => !!this._cancellationTokens.get(request.seq),
		// 		);
		// 		this._cancellationTokens.delete(request.seq);
		// 	} else {
		// 		vs = await this._runtime.getGlobalVariables();
		// 	}
		// } else if (v && Array.isArray(v.value)) {
		// 	vs = v.value;
		// }

		// response.body = {
		// 	variables: vs.map((v) => this.convertFromRuntime(v)),
		// };
		this.sendResponse(response);
	}

	protected setVariableRequest(
		response: DebugProtocol.SetVariableResponse,
		args: DebugProtocol.SetVariableArguments,
	): void {
		console.log("setVariableRequest");
		const container = this._variableHandles.get(args.variablesReference);
		// const rv =
		// 	container === "locals"
		// 		? this._runtime.getLocalVariable(args.name)
		// 		: container instanceof RuntimeVariable && Array.isArray(container.value)
		// 			? container.value.find((v) => v.name === args.name)
		// 			: undefined;

		// if (rv) {
		// 	rv.value = this.convertToRuntime(args.value);
		// 	response.body = this.convertFromRuntime(rv);

		// 	if (rv.memory && rv.reference) {
		// 		this.sendEvent(new MemoryEvent(String(rv.reference), 0, rv.memory.length));
		// 	}
		// }

		this.sendResponse(response);
	}

	protected continueRequest(
		response: DebugProtocol.ContinueResponse,
		args: DebugProtocol.ContinueArguments,
	): void {
		console.log("continueRequest");
		// this._runtime.continue(false);
		this.sendResponse(response);
	}

	protected reverseContinueRequest(
		response: DebugProtocol.ReverseContinueResponse,
		args: DebugProtocol.ReverseContinueArguments,
	): void {
		console.log("reverseContinueRequest");
		// this._runtime.continue(true);
		this.sendResponse(response);
	}

	protected nextRequest(
		response: DebugProtocol.NextResponse,
		args: DebugProtocol.NextArguments,
	): void {
		console.log("nextRequest");
		// this._runtime.step(args.granularity === "instruction", false);
		this.sendResponse(response);
	}

	protected stepBackRequest(
		response: DebugProtocol.StepBackResponse,
		args: DebugProtocol.StepBackArguments,
	): void {
		console.log("stepBackRequest");
		// this._runtime.step(args.granularity === "instruction", true);
		this.sendResponse(response);
	}

	protected stepInTargetsRequest(
		response: DebugProtocol.StepInTargetsResponse,
		args: DebugProtocol.StepInTargetsArguments,
	) {
		console.log("stepInTargetsRequest");
		// const targets = this._runtime.getStepInTargets(args.frameId);
		// response.body = {
		// 	targets: targets.map((t) => {
		// 		return { id: t.id, label: t.label };
		// 	}),
		// };
		this.sendResponse(response);
	}

	protected stepInRequest(
		response: DebugProtocol.StepInResponse,
		args: DebugProtocol.StepInArguments,
	): void {
		console.log("stepInRequest");
		// this._runtime.stepIn(args.targetId);
		this.sendResponse(response);
	}

	protected stepOutRequest(
		response: DebugProtocol.StepOutResponse,
		args: DebugProtocol.StepOutArguments,
	): void {
		console.log("stepOutRequest");
		// this._runtime.stepOut();
		this.sendResponse(response);
	}

	protected async evaluateRequest(
		response: DebugProtocol.EvaluateResponse,
		args: DebugProtocol.EvaluateArguments,
	): Promise<void> {
		console.log("evaluateRequest");
		let reply: string | undefined;
		// let rv: RuntimeVariable | undefined;

		// switch (args.context) {
		// 	// biome-ignore lint/suspicious/noFallthroughSwitchClause: falls through
		// 	case "repl": {
		// 		// handle some REPL commands:
		// 		// 'evaluate' supports to create and delete breakpoints from the 'repl':
		// 		const matches = /new +([0-9]+)/.exec(args.expression);
		// 		if (matches && matches.length === 2) {
		// 			const mbp = await this._runtime.setBreakPoint(
		// 				this._runtime.sourceFile,
		// 				this.convertClientLineToDebugger(Number.parseInt(matches[1])),
		// 			);
		// 			const bp = new Breakpoint(
		// 				mbp.verified,
		// 				this.convertDebuggerLineToClient(mbp.line),
		// 				undefined,
		// 				this.createSource(this._runtime.sourceFile),
		// 			) as DebugProtocol.Breakpoint;
		// 			bp.id = mbp.id;
		// 			this.sendEvent(new BreakpointEvent("new", bp));
		// 			reply = "breakpoint created";
		// 		} else {
		// 			const matches = /del +([0-9]+)/.exec(args.expression);
		// 			if (matches && matches.length === 2) {
		// 				const mbp = this._runtime.clearBreakPoint(
		// 					this._runtime.sourceFile,
		// 					this.convertClientLineToDebugger(Number.parseInt(matches[1])),
		// 				);
		// 				if (mbp) {
		// 					const bp = new Breakpoint(false) as DebugProtocol.Breakpoint;
		// 					bp.id = mbp.id;
		// 					this.sendEvent(new BreakpointEvent("removed", bp));
		// 					reply = "breakpoint deleted";
		// 				}
		// 			} else {
		// 				const matches = /progress/.exec(args.expression);
		// 				if (matches && matches.length === 1) {
		// 					if (this._reportProgress) {
		// 						reply = "progress started";
		// 						this.progressSequence();
		// 					} else {
		// 						reply = `frontend doesn't support progress (capability 'supportsProgressReporting' not set)`;
		// 					}
		// 				}
		// 			}
		// 		}
		// 	}
		// 	// falls through

		// 	default:
		// 		if (args.expression.startsWith("$")) {
		// 			rv = this._runtime.getLocalVariable(args.expression.substr(1));
		// 		} else {
		// 			rv = new RuntimeVariable("eval", this.convertToRuntime(args.expression));
		// 		}
		// 		break;
		// }

		// if (rv) {
		// 	const v = this.convertFromRuntime(rv);
		// 	response.body = {
		// 		result: v.value,
		// 		type: v.type,
		// 		variablesReference: v.variablesReference,
		// 		presentationHint: v.presentationHint,
		// 	};
		// } else {
		// 	response.body = {
		// 		result: reply
		// 			? reply
		// 			: `evaluate(context: '${args.context}', '${args.expression}')`,
		// 		variablesReference: 0,
		// 	};
		// }

		this.sendResponse(response);
	}

	protected setExpressionRequest(
		response: DebugProtocol.SetExpressionResponse,
		args: DebugProtocol.SetExpressionArguments,
	): void {
		console.log("setExpressionRequest");
		// if (args.expression.startsWith("$")) {
		// 	const rv = this._runtime.getLocalVariable(args.expression.substr(1));
		// 	if (rv) {
		// 		rv.value = this.convertToRuntime(args.value);
		// 		response.body = this.convertFromRuntime(rv);
		// 		this.sendResponse(response);
		// 	} else {
		// 		this.sendErrorResponse(response, {
		// 			id: 1002,
		// 			format: `variable '{lexpr}' not found`,
		// 			variables: { lexpr: args.expression },
		// 			showUser: true,
		// 		});
		// 	}
		// } else {
		// 	this.sendErrorResponse(response, {
		// 		id: 1003,
		// 		format: `'{lexpr}' not an assignable expression`,
		// 		variables: { lexpr: args.expression },
		// 		showUser: true,
		// 	});
		// }
	}

	protected dataBreakpointInfoRequest(
		response: DebugProtocol.DataBreakpointInfoResponse,
		args: DebugProtocol.DataBreakpointInfoArguments,
	): void {
		console.log("dataBreakpointInfoRequest");
		response.body = {
			dataId: null,
			description: "cannot break on data access",
			accessTypes: undefined,
			canPersist: false,
		};

		if (args.variablesReference && args.name) {
			const v = this._variableHandles.get(args.variablesReference);
			if (v === "globals") {
				response.body.dataId = args.name;
				response.body.description = args.name;
				response.body.accessTypes = ["write"];
				response.body.canPersist = true;
			} else {
				response.body.dataId = args.name;
				response.body.description = args.name;
				response.body.accessTypes = ["read", "write", "readWrite"];
				response.body.canPersist = true;
			}
		}

		this.sendResponse(response);
	}

	protected setDataBreakpointsRequest(
		response: DebugProtocol.SetDataBreakpointsResponse,
		args: DebugProtocol.SetDataBreakpointsArguments,
	): void {
		console.log("setDataBreakpointsRequest");
		// clear all data breakpoints
		// this._runtime.clearAllDataBreakpoints();

		response.body = {
			breakpoints: [],
		};

		// for (const dbp of args.breakpoints) {
		// 	const ok = this._runtime.setDataBreakpoint(dbp.dataId, dbp.accessType || "write");
		// 	response.body.breakpoints.push({
		// 		verified: ok,
		// 	});
		// }

		this.sendResponse(response);
	}

	protected completionsRequest(
		response: DebugProtocol.CompletionsResponse,
		args: DebugProtocol.CompletionsArguments,
	): void {
		console.log("completionsRequest");
		response.body = {
			targets: [
				{
					label: "item 10",
					sortText: "10",
				},
				{
					label: "item 1",
					sortText: "01",
					detail: "detail 1",
				},
				{
					label: "item 2",
					sortText: "02",
					detail: "detail 2",
				},
				{
					label: "array[]",
					selectionStart: 6,
					sortText: "03",
				},
				{
					label: "func(arg)",
					selectionStart: 5,
					selectionLength: 3,
					sortText: "04",
				},
			],
		};
		this.sendResponse(response);
	}

	protected cancelRequest(
		response: DebugProtocol.CancelResponse,
		args: DebugProtocol.CancelArguments,
	) {
		console.log("cancelRequest");
		if (args.requestId) {
			this._cancellationTokens.set(args.requestId, true);
		}
		if (args.progressId) {
			this._cancelledProgressId = args.progressId;
		}
	}

	protected disassembleRequest(
		response: DebugProtocol.DisassembleResponse,
		args: DebugProtocol.DisassembleArguments,
	) {
		console.log("disassembleRequest");
		const memoryInt = args.memoryReference.slice(3);
		const baseAddress = Number.parseInt(memoryInt);
		const offset = args.instructionOffset || 0;
		const count = args.instructionCount;

		const isHex = memoryInt.startsWith("0x");
		const pad = isHex ? memoryInt.length - 2 : memoryInt.length;

		// const loc = this.createSource(this._runtime.sourceFile);

		// let lastLine = -1;

		// const instructions = this._runtime
		// 	.disassemble(baseAddress + offset, count)
		// 	.map((instruction) => {
		// 		const address = Math.abs(instruction.address)
		// 			.toString(isHex ? 16 : 10)
		// 			.padStart(pad, "0");
		// 		const sign = instruction.address < 0 ? "-" : "";
		// 		const instr: DebugProtocol.DisassembledInstruction = {
		// 			address: sign + (isHex ? `0x${address}` : `${address}`),
		// 			instruction: instruction.instruction,
		// 		};
		// 		// if instruction's source starts on a new line add the source to instruction
		// 		if (instruction.line !== undefined && lastLine !== instruction.line) {
		// 			lastLine = instruction.line;
		// 			instr.location = loc;
		// 			instr.line = this.convertDebuggerLineToClient(instruction.line);
		// 		}
		// 		return instr;
		// 	});

		// response.body = {
		// 	instructions: instructions,
		// };
		this.sendResponse(response);
	}

	protected setInstructionBreakpointsRequest(
		response: DebugProtocol.SetInstructionBreakpointsResponse,
		args: DebugProtocol.SetInstructionBreakpointsArguments,
	) {
		console.log("setInstructionBreakpointsRequest");
		// clear all instruction breakpoints
		// this._runtime.clearInstructionBreakpoints();

		// // set instruction breakpoints
		// const breakpoints = args.breakpoints.map((ibp) => {
		// 	const address = Number.parseInt(ibp.instructionReference.slice(3));
		// 	const offset = ibp.offset || 0;
		// 	return <DebugProtocol.Breakpoint>{
		// 		verified: this._runtime.setInstructionBreakpoint(address + offset),
		// 	};
		// });

		// response.body = {
		// 	breakpoints: breakpoints,
		// };
		this.sendResponse(response);
	}

	protected customRequest(command: string, response: DebugProtocol.Response, args: unknown) {
		console.log("customRequest");
		if (command === "toggleFormatting") {
			this._valuesInHex = !this._valuesInHex;
			if (this._useInvalidatedEvent) {
				this.sendEvent(new InvalidatedEvent(["variables"]));
			}
			this.sendResponse(response);
		} else {
			super.customRequest(command, response, args);
		}
	}

	//---- helpers

	private formatAddress(x: number, pad = 8) {
		return `mem${this._addressesInHex ? `0x${x.toString(16).padStart(8, "0")}` : x.toString(10)}`;
	}

	private formatNumber(x: number) {
		return this._valuesInHex ? `0x${x.toString(16)}` : x.toString(10);
	}

	private createSource(filePath: string): Source {
		return new Source(
			basename(filePath),
			this.convertDebuggerPathToClient(filePath),
			undefined,
			undefined,
			"cc65-dbg-adapter-data",
		);
	}
}

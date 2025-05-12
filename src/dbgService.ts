// from: https://raw.githubusercontent.com/AlchemicRaker/alchemy65/master/src/dbgService.ts
// with slight modifications and comments by tmr4

//import { readFile } from 'fs/promises';
import * as fs from "node:fs";

export type AddrSize = "zeropage" | "absolute" | "far";
export interface DbgMap {
	csym: DbgCSym[];
	file: DbgFile[];
	line: DbgLine[];
	mod: DbgMod[];
	scope: DbgScope[];
	seg: DbgSeg[];
	span: DbgSpan[];
	sym: DbgSym[];
	type: DbgType[];
}

export interface DbgFile {
	/// reference #
	id: number;
	/// path (not normalized)
	name: string;
	/// file size in bytes
	size: number;
	/// time of last modification
	mtime: string;
	/// modules that use this file
	mod: number[];
}

export interface DbgLine {
	/// reference #
	id: number;
	/// associated file reference #
	file: number;
	/// source file line #
	line: number;
	/// line type: 0|undefined = assembler (ca65)
	///            1 = external (cc65)
	///            2 = macro (span references macro source)
	///            3 = macro (span doesn't reference macro source but simply points to where it's invoked)
	///      it's unclear what causes a macro to be designated type 2 or 3 (hard to figure from source code)
	///      perhaps the macro is too complex to create a proper span reference, in any case we can't link
	///      to type 3 macro source
	type?: number;
	/// number of active macro expansions
	count?: number;
	/// span(s) associated with line (macros can reference more than one span)
	span?: number[];
}

export interface DbgMod {
	/// reference #
	id: number;
	/// object module name (without path)
	name: string;
	/// associated file reference #
	file: number;
}

export interface DbgSeg {
	/// reference #
	id: number;
	/// segment name
	name: string;
	/// segment address (hex)
	start: number;
	/// segment size (hex)
	size: number;
	/// absolute | zeropage
	addrsize: AddrSize;
	/// segment read/write, read only
	type: "rw" | "ro";
	/// assiciated binary file name
	oname: string;
	/// segment offset in output file (decimal)
	ooffs: number;
}

export interface DbgSpan {
	/// reference #
	id: number;
	/// associated segment reference #
	seg: number;
	/// index from start of segment
	start: number;
	/// size of span
	size: number;
	/// type reference number
	type?: number;
}

export interface DbgScope {
	/// reference #
	id: number;
	/// name (if any)
	name: string;
	/// associated module reference #
	mod: number;
	/// default=file
	type?: "scope" | "struct" | "global";
	/// scope size in bytes (if available)
	size?: number;
	/// parent scope reference # (if any)
	parent?: number;
	/// associated symbol reference # (if labeled)
	sym?: number;
	/// associated span reference # (if any)
	span?: number[];
}

export interface DbgSym {
	/// reference #
	id: number;
	/// name
	name: string;
	/// absolute | zeropage | far
	addrsize: AddrSize;
	/// size in bytes if known
	size?: number;
	/// associated scope reference # (if any)
	/// there is also an optional parent property for local labels
	scope?: number;
	/// line reference number where defined
	def: number[];
	/// line reference number(s) where referenced (if any)
	ref?: number[];
	/// address (hex)
	val?: string;
	/// associated segment reference #
	seg?: number;
	/// declaration type: label, equality or import
	type?: "lab" | "equ" | "imp";
	/// matching export span if an import
	exp?: number;
}

export const DbgSymType: Record<Required<DbgSym>["type"], string> = {
	lab: "label",
	equ: "equality",
	imp: "import",
};

export interface DbgCSym {
	// csym	id=0,name="pal_bg",scope=1,type=5,sc=ext,sym=487
	/// reference #
	id: number;
	/// name
	name: string;
	/// associated scope reference #
	scope: number;
	type: number;
	/// 'auto' | 'reg' | 'static' | 'ext',
	sc: string;
	/// storage class:
	/// *** note that using static local variables removes all reference to the variable in the debug file and thus db65xx can't dereference them ***
	///  auto   - on stack at offset
	///  reg    - zero page (will have a sym reference pointing to the zeropage 'regbank')
	///  static - static linkage. I haven't seen this (static variables are renamed by cc65 and thus not easily dereferenced by db65xx)
	///  ext    - external linkage (will have a sym reference)
	//    sc: 'auto' | 'reg' | 'static' | 'ext',
	/// associated assembler symbol reference #
	sym?: number;
	/// offset from stack pointer if not zero
	offs?: number;
}

export interface DbgType {
	/// reference #
	id: number;
	/// see cc65 gentype.c/gentype.h
	val: string;
}

function lineToData(line: string): {
	name: string;
	body: { [key: string]: string };
} {
	const [name, kvps] = line.trim().split("\t");
	if (kvps === undefined) {
		const k = 5;
	}
	const kvp = kvps.split(",").map((s) => {
		const [key, value] = s.split("=");
		return [key, value];
	});
	const body: { [key: string]: string } = Object.fromEntries(kvp);
	return { name, body };
}

function dataToFile(data: { [key: string]: string }): DbgFile {
	return {
		id: Number.parseInt(data.id),
		name: data.name,
		size: Number.parseInt(data.size),
		mtime: data.mtime,
		mod: data.mod.split("+").map((m) => Number.parseInt(m)),
	};
}

function dataToLine(data: { [key: string]: string }): DbgLine {
	return {
		id: Number.parseInt(data.id),
		file: Number.parseInt(data.file),
		line: Number.parseInt(data.line),
		count: data.count ? Number.parseInt(data.count) : undefined,
		type: data.type ? Number.parseInt(data.type) : undefined,
		span: data.span ? data.span.split("+").map((s) => Number.parseInt(s)) : undefined,
	};
}

function dataToMod(data: { [key: string]: string }): DbgMod {
	return {
		id: Number.parseInt(data.id),
		file: Number.parseInt(data.file),
		name: data.name,
	};
}

function dataToScope(data: { [key: string]: string }): DbgScope {
	return {
		id: Number.parseInt(data.id),
		mod: Number.parseInt(data.mod),
		name: data.name,
		parent: data.parent ? Number.parseInt(data.parent) : undefined,
		size: data.size ? Number.parseInt(data.size) : undefined,
		span: data.span ? data.span.split("+").map((s) => Number.parseInt(s)) : undefined,
		sym: data.sym ? Number.parseInt(data.sym) : undefined,
		type: data.type as DbgScope["type"],
	};
}

function dataToSeg(data: { [key: string]: string }): DbgSeg {
	return {
		id: Number.parseInt(data.id),
		name: data.name,
		addrsize: <AddrSize>data.addrsize,
		oname: data.oname,
		ooffs: Number.parseInt(data.ooffs),
		size: Number.parseInt(data.size.substr(2), 16),
		start: Number.parseInt(data.start.substr(2), 16),
		type: <"ro" | "rw">data.type,
	};
}

function dataToSpan(data: { [key: string]: string }): DbgSpan {
	return {
		id: Number.parseInt(data.id),
		seg: Number.parseInt(data.seg),
		size: Number.parseInt(data.size),
		start: Number.parseInt(data.start),
		type: data.type ? Number.parseInt(data.type) : undefined,
	};
}

function dataToSym(data: { [key: string]: string }): DbgSym {
	return {
		id: Number.parseInt(data.id),
		addrsize: <AddrSize>data.addrsize,
		def: data.def.split("+").map((s) => Number.parseInt(s)),
		name: data.name,
		exp: data.exp ? Number.parseInt(data.exp) : undefined,
		scope: data.scope ? Number.parseInt(data.scope) : undefined,
		seg: data.seg ? Number.parseInt(data.seg) : undefined,
		size: data.size ? Number.parseInt(data.size) : undefined,
		ref: data.ref ? data.ref.split("+").map((s) => Number.parseInt(s)) : undefined,
		type: data.type ? <"lab" | "equ" | "imp">data.type : undefined,
		val: data.val,
	};
}

function dataToCSym(data: { [key: string]: string }): DbgCSym {
	return {
		id: Number.parseInt(data.id),
		name: data.name,
		scope: Number.parseInt(data.scope),
		type: Number.parseInt(data.type),
		sc: data.sc,
		offs: Number.parseInt(data.offs),
		sym: Number.parseInt(data.sym),
	};
}

function dataToType(data: { [key: string]: string }): DbgType {
	return {
		id: Number.parseInt(data.id),
		val: data.val,
	};
}

//export async function readDebugFile(path: string): Promise<DbgMap> {
//    const debugFile = await readFile(path, "utf8");
export function readDebugFile(path: string): DbgMap {
	const debugFile = fs.readFileSync(path, "utf8");
	// split it into lines
	const [versionLine, infoLine, ...lineStrings] = debugFile
		.split("\n")
		.filter((line) => line.length > 1);
	const lines = lineStrings.map(lineToData);
	const filterName = (fName: string) =>
		lines.filter(({ name }) => name === fName).map(({ body }) => body);
	const map: DbgMap = {
		// TODO maybe, sort by id (should already be ordered)
		csym: filterName("csym").map(dataToCSym),
		file: filterName("file").map(dataToFile),
		line: filterName("line").map(dataToLine),
		mod: filterName("mod").map(dataToMod),
		scope: filterName("scope").map(dataToScope),
		seg: filterName("seg").map(dataToSeg),
		span: filterName("span").map(dataToSpan),
		sym: filterName("sym").map(dataToSym),
		type: filterName("type").map(dataToType),
	};
	return map;
}

export function addressToSpans(dbg: DbgMap, address: number, cpuSpace: boolean): number[] {
	const segBase: (seg: DbgSeg) => number = (seg) => (cpuSpace ? seg.start : seg.ooffs - 16);
	// find the segments containing the address
	const segments = dbg.seg
		.filter((seg) => segBase(seg) <= address && address < segBase(seg) + seg.size)
		.map((seg) => seg.id);
	const spans = dbg.span
		.filter((span) => {
			if (!segments.includes(span.seg)) {
				return false;
			}
			const segment = dbg.seg[span.seg];
			return (
				segBase(segment) + span.start <= address &&
				address < segBase(segment) + span.start + span.size
			);
		})
		.map((span) => span.id);
	return spans;
}

export function spansToSpanLines(
	dbg: DbgMap,
	spans: number[],
): { spans: DbgSpan[]; line: DbgLine }[] {
	const r: { spans: DbgSpan[]; line: DbgLine }[] = dbg.line.flatMap((line) => {
		if (!line.span) {
			return [];
		}
		// spans for this line
		const lineSpans = line.span.filter((span) => spans.includes(span)).map((s) => dbg.span[s]);
		return lineSpans.map((ls) => {
			return {
				line,
				spans: lineSpans,
			};
		});
	}); //.map(line => line.id);
	return r;
}

export function spansToScopes(dbg: DbgMap, spanIds: number[]) {
	const spans = spanIds.map((id) => dbg.span[id]);
	return dbg.scope.filter((scope) => {
		// if one of the scope's spans include the linespans, match the scope
		// const scopeSpans = this.debugFile?.span.filter(span => scope.span?.includes(span.id));
		const scopeSpans = (scope.span || []).map((sid) => dbg.span[sid]);

		const matchedScopes = scopeSpans.filter((scopeSpan) => {
			// if any of the linespans are within this scopespan
			return (
				spans.filter(
					(span) =>
						span.seg === scopeSpan.seg &&
						scopeSpan.start <= span.start &&
						span.start <= scopeSpan.start + scopeSpan.size,
				).length > 0
			);
		});
		return matchedScopes.length > 0;
	});
}

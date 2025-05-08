import * as path from "node:path";

export function sleep(delay: number) {
	return new Promise((resolve) => setTimeout(resolve, delay));
}

export function unquote(str: string): string {
	if (str.startsWith('"') && str.endsWith('"')) {
		return str.slice(1, -1);
	}
	return str;
}

export function normalizePath(pathString: string): string {
	return path.normalize(unquote(pathString).replaceAll(path.win32.sep, path.posix.sep));
}

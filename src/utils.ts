export function sleep(delay: number) {
	return new Promise((resolve) => setTimeout(resolve, delay));
}

export function unquote(str: string): string {
	if (str.startsWith('"') && str.endsWith('"')) {
		return str.slice(1, -1);
	}
	return str;
}

export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers as unknown as Iterable<[string, string]>) {
		result[key] = value;
	}
	return result;
}

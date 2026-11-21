/** Every failure the library reports, by code. Fallible functions report through an `ErrorSink` instead of throwing. */
export type ErrorCode =
	| "BAD_ARGS"
	| "BAD_CODE"
	| "BAD_FILE"
	| "BAD_MONEY"
	| "BAD_NAME"
	| "BAD_QUANTITY"
	| "BAD_SKU"
	| "BAD_TRANSITION"
	| "DUPLICATE_SKU"
	| "EMPTY_ORDER"
	| "INSUFFICIENT_STOCK"
	| "UNKNOWN_ORDER"
	| "UNKNOWN_SKU";

export interface InvError {
	code: ErrorCode;
	message: string;
}

/** Receives the error of a failed call. A fallible function calls it at most once, then returns `undefined` or `false`. */
export type ErrorSink = (error: InvError) => void;

/** Reports `code` to `onError` and returns `undefined`, so a caller can write `return fail(onError, …)`. */
export function fail(onError: ErrorSink, code: ErrorCode, message: string): undefined {
	onError({ code, message });
	return undefined;
}

/** A sink that keeps every error it receives, for callers that inspect errors after the call. */
export function collect(): { sink: ErrorSink; errors: InvError[] } {
	const errors: InvError[] = [];
	return { sink: (error) => errors.push(error), errors };
}

/** Formats an error as the CLI prints it. */
export const describe = (error: InvError) => `error: ${error.code}: ${error.message}`;

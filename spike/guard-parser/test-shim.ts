// Stands in for node:test when corpus.ts runs a guard test file: runs each test body once, ignoring failures.
const pending: Promise<unknown>[] = [];
export default function test(_name: string, fn: (t: { after: (f: () => void) => void }) => unknown): void {
	const after: (() => void)[] = [];
	pending.push(
		Promise.resolve()
			.then(() => fn({ after: (f) => after.push(f) }))
			.catch(() => undefined)
			.finally(() => {
				for (const f of after) f();
			}),
	);
}
export const done = () => Promise.all(pending);

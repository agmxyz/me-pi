// Stands in for node:assert/strict when corpus.ts runs a guard test file: never throws, so a loop whose rows fail on
// main's guard (a branch's new expectations) still reaches every row.
const pass = () => undefined;
const assert: any = Object.assign(pass, {
	equal: pass,
	notEqual: pass,
	ok: pass,
	match: pass,
	doesNotMatch: pass,
	deepEqual: pass,
	notDeepEqual: pass,
	strictEqual: pass,
	throws: pass,
	rejects: async () => undefined,
});
export default assert;

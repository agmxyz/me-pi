/**
 * Decision 3 regression: every spike-corpus row that guard 0.1.3's `tmpdirMayChange` flags and that names
 * `${TMPDIR:?}` (the #77/#87 rebinding rows, plus incidental ones) is listed with the parser's `tmpdirRebinds`
 * verdict. `node spike/guard-policy/rebind-check.ts`; exits 1 if a row the guard tests expect to ask on for a
 * rebinding no longer counts as one.
 */
import { corpus } from "../guard-parser/corpus.ts";
import { guard } from "../guard-parser/guard-rules.ts";
import { initShellAst, tmpdirRebinds } from "../guard-parser/shell-ast.ts";

await initShellAst();
const rows = corpus().filter((r) => r.command.includes(guard.TMPDIR_REF) && guard.tmpdirMayChange(r.command));
const unflagged = rows.filter((r) => !tmpdirRebinds(r.command));
console.log(`${rows.length} rows flagged by tmpdirMayChange; ${rows.length - unflagged.length} also by tmpdirRebinds`);
for (const r of unflagged) console.log(`  no longer a rebinding: ${JSON.stringify(r.command)} [${r.source}]`);
// The rows guard's tests expect to ask *because of* a rebinding come from test/guard.test.ts's rebinding block and
// #78/#87 rows; any of those here is a regression.
// (The `${TMPDIR:?}` reference itself is dropped first; it isn't a rebinding.)
const construct =
	/TMP|DIR|\b(?:env|sudo|doas|su|runuser|pkexec|source|eval|declare|local|typeset|export|read|printf|unset|set)\b|(?:^|[;&|(\s])\.\s/;
const regress = unflagged.filter((r) => construct.test(r.command.replaceAll(guard.TMPDIR_REF, "")));
console.log(`${regress.length} of them name a rebinding construct`);
if (regress.length) process.exitCode = 1;

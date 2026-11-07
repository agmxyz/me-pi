// Dumps tree-sitter-bash ASTs for the sources in a JSON array file (a dev aid for writing shell-ast.ts).
// Usage: node spike/guard-parser/probe.mjs <file.json>
import { readFileSync } from "node:fs";
import { Language, Parser } from "web-tree-sitter";

await Parser.init();
const bash = await Language.load(new URL("./vendor/tree-sitter-bash.wasm", import.meta.url).pathname);
const parser = new Parser();
parser.setLanguage(bash);
for (const src of JSON.parse(readFileSync(process.argv[2], "utf8"))) {
	const tree = parser.parse(src);
	console.log(`--- ${JSON.stringify(src)} hasError=${tree.rootNode.hasError}`);
	const walk = (n, d, field) => {
		const label = `${field ? `${field}: ` : ""}${n.isNamed ? n.type : JSON.stringify(n.type)}`;
		console.log(`${"  ".repeat(d)}${label}${n.childCount ? "" : ` = ${JSON.stringify(n.text)}`}`);
		for (const [i, c] of n.children.entries()) walk(c, d + 1, n.fieldNameForChild(i));
	};
	walk(tree.rootNode, 0);
}

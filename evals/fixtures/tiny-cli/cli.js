#!/usr/bin/env node
export function greet(name = "world") {
	return `Hello, ${name}!`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	console.log(greet(args[0]));
}

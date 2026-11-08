/** Small helpers shared by the measurement scripts. */

/** Runs `f` over `items` with at most `n` in flight; results keep the input order. */
export async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: n }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await f(items[i]);
			}
		}),
	);
	return out;
}

/** Counts (or sums `weight`) by key, largest first. */
export function countBy<T>(xs: T[], key: (x: T) => string, weight: (x: T) => number = () => 1): Record<string, number> {
	const m: Record<string, number> = {};
	for (const x of xs) m[key(x)] = (m[key(x)] ?? 0) + weight(x);
	return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}

/**
 * Synthetic fixture for the "one file, several change sites" shape.
 *
 * It exists so the experiment can show a file where changes sit far apart
 * (line ~10, ~34, ~78) with unchanged code in between — the case where a diff
 * has several segments, not one.
 */

export function alpha(n: number): number {
	let total = 0;
	for (let i = 0; i < n; i += 1) {
		total += i * 2;
	}
	return total;
}

export function beta(xs: readonly number[]): number {
	let best = xs.length > 0 ? xs[0]! : 0;
	for (const x of xs) {
		if (x > best) {
			best = x;
		}
	}
	return best;
}

export function gamma(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return "";
	}
	return trimmed.toUpperCase();
}

export function delta(rows: readonly string[]): string[] {
	const out: string[] = [];
	for (const row of rows) {
		if (row.length === 0) {
			continue;
		}
		out.push(row.trim());
	}
	return out;
}

export function epsilon(flag: boolean, a: number, b: number): number {
	if (flag) {
		return a + b;
	}
	return a - b;
}

export function zeta(values: readonly number[]): number {
	let sum = 0;
	for (const value of values) {
		sum += value;
	}
	return sum;
}

export function eta(text: string): number {
	let count = 0;
	for (const ch of text) {
		if (ch === "a") {
			count += 1;
		}
	}
	return count;
}

export function theta(xs: readonly number[]): number {
	let out = 0;
	for (const x of xs) {
		out += x * x;
	}
	return out;
}

export function iota(text: string): string {
	return text.split("").reverse().join("");
}

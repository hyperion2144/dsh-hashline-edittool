/**
 * 启发式作用域检测（**原型**）：从源码文本里找出「块」的行区间与头部文本。
 *
 * 只处理花括号语言（TS/JS/Go/Java/C#…），够原型回答两个问题：
 *   1. 改动的这几行，外层函数 / 类 / 分支是什么？
 *   2. 想把整个函数带出来时，它的行区间是哪儿？
 *
 * 产品实现不该照抄这个原型：它要么走 AST（要 wasm 语法，见 docs/research/
 * diff-presentation-repo-facts.md §10），要么按语言细化启发式（Python 缩进、
 * Ruby def…end、Go func…）。原型只用它**看形态**，不作为最终实现。
 */

/** 一行的花括号净增减（跳过字符串、行注释、块注释）。 */
function braceDeltas(lines) {
	const deltas = [];
	let inBlockComment = false;
	for (const line of lines) {
		let delta = 0;
		let i = 0;
		while (i < line.length) {
			const ch = line[i];
			const next = line[i + 1];
			if (inBlockComment) {
				if (ch === "*" && next === "/") {
					inBlockComment = false;
					i += 2;
					continue;
				}
				i += 1;
				continue;
			}
			if (ch === "/" && next === "/") break; // 行注释之后全是注释
			if (ch === "/" && next === "*") {
				inBlockComment = true;
				i += 2;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				const quote = ch;
				i += 1;
				while (i < line.length) {
					if (line[i] === "\\") {
						i += 2;
						continue;
					}
					if (line[i] === quote) break;
					i += 1;
				}
				i += 1;
				continue;
			}
			if (ch === "{") delta += 1;
			else if (ch === "}") delta -= 1;
			i += 1;
		}
		deltas.push(delta);
	}
	return deltas;
}

const RE_FUNCTION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/;
const RE_ARROW = /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/;
const RE_CLASS = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\b/;
const RE_TYPE = /^(?:export\s+)?(?:interface|enum|type|namespace)\b/;
const RE_CONTROL = /^(?:if|else\s+if|for|while|switch|try|catch|finally|do|using|with|else)\b/;
const RE_METHOD =
	/^(?:(?:public|private|protected|static|readonly|abstract|async|get|set|\*)\s+)*[\w$]+\s*(?:<[^>]*>)?\s*\(/;

/**
 * 一个块：行区间 + 头部文本 + 归类。
 *
 * @typedef {Object} Scope
 * @property {"function"|"method"|"class"|"type"|"control"|"block"} kind
 * @property {string} header
 * @property {string} name
 * @property {number} startLine 1-indexed 闭区间
 * @property {number} endLine 1-indexed 闭区间
 */

/** 头部的名字：函数 / 方法取标识符，class 取类名，control 取关键字。 */
function nameOf(kind, header) {
	const clean = header.replace(/\s*\{.*$/, "").trim();
	if (kind === "function" || kind === "method") {
		const m = /([\w$]+)\s*(?:<[^>]*>)?\s*\(/.exec(clean);
		if (m) return m[1];
	}
	if (kind === "class" || kind === "type") {
		const m = /([\w$]+)/.exec(clean);
		if (m) return m[1];
	}
	if (kind === "control") {
		const m = /^(if|else\s+if|for|while|switch|try|catch|finally|do|using|with|else)\b/.exec(clean);
		if (m) return m[1];
	}
	return "";
}

function classify(header, parentKind) {
	const clean = header.replace(/\s*\{.*$/, "").trim();
	if (RE_FUNCTION.test(clean) || RE_ARROW.test(clean)) return "function";
	if (RE_CLASS.test(clean)) return "class";
	if (RE_TYPE.test(clean)) return "type";
	if (RE_CONTROL.test(clean)) return "control";
	if (RE_METHOD.test(clean)) return parentKind === "class" ? "method" : "function";
	return "block";
}

/**
 * 往上找声明行。多行签名（`function foo(\n a: string,\n): void {`）的开括号
 * 行自己认不出函数名，只能回到声明处。
 *
 * @param {string[]} lines
 * @param {number[]} deltas 每行花括号净增减
 * @param {number} i 开括号所在行（0-based）
 * @returns {{text: string, line: number} | undefined} line 是 1-indexed
 */
function findDeclaration(lines, deltas, i) {
	for (let j = i - 1; j >= 0 && j >= i - 40; j--) {
		const t = lines[j].trim();
		if (t === "") continue;
		// 跨过花括号就出了这一层，别往上认。
		if (deltas[j] !== 0) return undefined;
		if (RE_FUNCTION.test(t) || RE_ARROW.test(t) || RE_CLASS.test(t) || RE_TYPE.test(t)) {
			return { text: t, line: j + 1 };
		}
		if (RE_CONTROL.test(t)) return undefined;
	}
	return undefined;
}

/**
 * 扫出全文的所有块。
 * @param {string} text 源码文本
 * @returns {Scope[]} 每个块一行区间
 */
export function detectScopes(text) {
	const lines = text.split("\n");
	const deltas = braceDeltas(lines);
	const stack = [];
	const scopes = [];

	for (let i = 0; i < lines.length; i++) {
		const delta = deltas[i];
		if (delta > 0) {
			for (let k = 0; k < delta; k++) {
				let header = k === 0 ? lines[i].trim() : "";
				let startLine = i + 1;
				if (k === 0 && header !== "" && classify(header, "block") === "block") {
					const decl = findDeclaration(lines, deltas, i);
					if (decl !== undefined) {
						header = decl.text;
						startLine = decl.line;
					}
				}
				const parent = stack.length > 0 ? stack[stack.length - 1] : undefined;
				stack.push({
					header,
					kind: classify(header, parent === undefined ? "block" : parent.kind),
					startLine,
				});
			}
		} else if (delta < 0) {
			for (let k = 0; k < -delta; k++) {
				const opened = stack.pop();
				if (opened === undefined) continue;
				scopes.push({
					kind: opened.kind,
					header: opened.header,
					name: nameOf(opened.kind, opened.header),
					startLine: opened.startLine,
					endLine: i + 1,
				});
			}
		}
	}
	// 没闭合的（文件被截断等）：把区间补到文件尾。
	const lastLine = lines.length;
	while (stack.length > 0) {
		const opened = stack.pop();
		scopes.push({
			kind: opened.kind,
			header: opened.header,
			name: nameOf(opened.kind, opened.header),
			startLine: opened.startLine,
			endLine: lastLine,
		});
	}
	return scopes;
}

/**
 * 某一行的外层块链（由外到内）。
 * @param {Scope[]} scopes
 * @param {number} line 1-indexed
 * @returns {Scope[]}
 */
export function scopeChainAt(scopes, line) {
	return scopes
		.filter((s) => s.startLine <= line && s.endLine >= line)
		.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}

/**
 * 包住一组行的「命名块」（函数 / 方法优先，其次 class）：没有就返回 undefined。
 * @param {Scope[]} scopes
 * @param {number[]} lines 1-indexed 行号
 * @returns {Scope | undefined}
 */
export function enclosingScope(scopes, lines) {
	const covers = (s) => lines.every((l) => l >= s.startLine && l <= s.endLine);
	const named = scopes.filter((s) => covers(s) && (s.kind === "function" || s.kind === "method"));
	if (named.length > 0) {
		// 最内层的那一个（起始行最大）
		return named.reduce((best, s) => (s.startLine > best.startLine ? s : best));
	}
	const classes = scopes.filter((s) => covers(s) && s.kind === "class");
	if (classes.length > 0) {
		return classes.reduce((best, s) => (s.startLine > best.startLine ? s : best));
	}
	return undefined;
}

/** 块链的可读串：myersRange() › for (…) */
export function chainText(chain) {
	return chain
		.filter((s) => s.kind !== "block")
		.map((s) => {
			if (s.kind === "function" || s.kind === "method") return `${s.name}()`;
			if (s.kind === "class" || s.kind === "type") return s.name;
			return s.header.replace(/\s*\{.*$/, "").trim();
		})
		.join(" › ");
}

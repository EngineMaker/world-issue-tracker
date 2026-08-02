/**
 * JSONC（コメント付き JSON）をパースする。
 *
 * wrangler や tsconfig の設定ファイルはコメントを許すため `JSON.parse` に
 * 直接は渡せない。JSONC パーサは直接の依存に無いので、文字列リテラルの内側を
 * 避けながらコメントだけを落としてから `JSON.parse` する。`vars` には
 * `https://...` のような `//` を含む値が入るため、文字列の追跡は省略できない。
 */
export function parseJsonc(source: string): unknown {
	let result = "";
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		const next = source[i + 1];

		if (inLineComment) {
			// 改行はそのまま残す。JSON.parse の失敗位置を元の行と対応させるため
			if (char === "\n") {
				inLineComment = false;
				result += char;
			}
			continue;
		}

		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				i++;
			} else if (char === "\n") {
				result += char;
			}
			continue;
		}

		if (inString) {
			result += char;
			// エスケープされた文字は次の 1 文字ごと取り込む（`\"` で閉じない）
			if (char === "\\") {
				result += next ?? "";
				i++;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			result += char;
			continue;
		}

		if (char === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}

		if (char === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}

		result += char;
	}

	return JSON.parse(result);
}

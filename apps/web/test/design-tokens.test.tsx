/**
 * デザイントークン（#86）のテスト。
 *
 * 色・文字サイズ・余白を決める仕組みが無く、各コンポーネントがその都度
 * 値を直接書いていた。結果として同じ意味の色に別々の値が使われ
 * （エラーの赤が `#b00` と `#b91c1c` の 2 種類）、見た目を変えるには
 * 全ファイルを手で直す必要があった。
 *
 * このテストが見るのは「値が 1 箇所に集約されているか」で、見た目そのものでは
 * ない。描画結果を目視で比べても、値がどこに書かれているかは分からない。
 * 直書きが再び増えたときに気付けるよう、ソースを直接走査する。
 *
 * 走査対象を `.tsx` と `globals.css` に限っているのは、色や寸法が
 * 実際に書かれうる場所がそこだけのため（`lib/` は数値計算とデータ取得のみ）。
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueList } from "../src/app/components/IssueList";
import { MyIssueList } from "../src/app/components/MyIssueList";
import IssueDetailPage from "../src/app/issues/[id]/page";

const APP_DIR = join(import.meta.dir, "../src/app");
const GLOBALS_CSS = join(APP_DIR, "globals.css");

function collectFiles(dir: string, extension: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			found.push(...collectFiles(path, extension));
		} else if (entry.endsWith(extension)) {
			found.push(path);
		}
	}
	return found;
}

const tsxFiles = collectFiles(APP_DIR, ".tsx");
const css = readFileSync(GLOBALS_CSS, "utf8");

/**
 * ブロックコメントを外す。CSS と tsx で記法が同じなので共用する。
 *
 * 「以前は #666 を使っていた」のように、どの値から寄せたかを記録した
 * コメントが残っている。実際のスタイル指定ではないので走査から外す
 * （記録自体はレビューのときに必要）。
 */
function stripBlockComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** `--token: 値;` の宣言を拾う。`var(--token)` の参照側とは区別する */
function declaredTokens(source: string): Map<string, string> {
	const tokens = new Map<string, string>();
	for (const match of source.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
		tokens.set(match[1], match[2].trim());
	}
	return tokens;
}

describe("トークンの定義", () => {
	const tokens = declaredTokens(css);

	// 値はデザイン見本で決まっている。ここを実装に合わせて書き換えると
	// 「見本のとおりか」を誰も見ていない状態になるので、見本の値を写す
	const expected: Record<string, string> = {
		"--ink": "#1c2420",
		"--ink-soft": "#55605a",
		"--ink-faint": "#8b958f",
		"--ground": "#f7f9f7",
		"--surface": "#ffffff",
		"--line": "#e2e8e4",
		"--accent": "#1a7f5a",
		"--accent-soft": "#e8f5ef",
		"--accent-line": "#b8ddcb",
		"--danger": "#b91c1c",
		"--warning": "#b45309",
		"--success": "#1a7f5a",
		"--text-xl": "1.75rem",
		"--text-lg": "1.0625rem",
		"--text-base": "1rem",
		"--text-sm": "0.875rem",
		"--text-xs": "0.75rem",
		"--space-1": "0.25rem",
		"--space-2": "0.5rem",
		"--space-3": "0.75rem",
		"--space-4": "1rem",
		"--space-5": "1.25rem",
		"--space-6": "1.5rem",
	};

	for (const [name, value] of Object.entries(expected)) {
		it(`${name} を ${value} として定義している`, () => {
			expect(tokens.get(name)).toBe(value);
		});
	}

	it("トークンは :root にまとめて定義する（後からダークモードで値だけ差し替えられるように）", () => {
		const root = css.match(/:root\s*\{([^}]*)\}/);
		expect(root).not.toBeNull();
		const inRoot = declaredTokens(root?.[1] ?? "");
		for (const name of Object.keys(expected)) {
			expect(inRoot.has(name)).toBe(true);
		}
	});
});

describe("直書きの色が残っていない", () => {
	/**
	 * `#rgb` / `#rrggbb` 形式の色。トークンを定義している `:root` の中は
	 * 唯一の定義場所なので除く。
	 */
	function hexColorsOutsideRoot(source: string): string[] {
		const withoutRoot = stripBlockComments(source).replace(
			/:root\s*\{[^}]*\}/g,
			"",
		);
		return [...withoutRoot.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
	}

	it("globals.css は :root 以外で色を直書きしない", () => {
		expect(hexColorsOutsideRoot(css)).toEqual([]);
	});

	for (const file of tsxFiles) {
		const source = stripBlockComments(readFileSync(file, "utf8"));
		const relative = file.slice(APP_DIR.length + 1);
		it(`${relative} は色を直書きしない`, () => {
			expect(
				[...source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]),
			).toEqual([]);
		});
	}
});

describe("インライン style が残っていない", () => {
	/**
	 * `style={{ ... }}` のうち、値が定数でないもの（テンプレートリテラルや
	 * 変数を含むもの）は対象外。地図（`IssueMap`）のタイル配置は座標から
	 * 計算した px を渡していて、CSS へ移せない。
	 */
	function constantInlineStyles(source: string): string[] {
		return [...source.matchAll(/style=\{\{([^}]*)\}\}/g)]
			.map((m) => m[1])
			.filter(
				(body) => !/[`$]|\b(VIEW_SIZE|TILE_SIZE|offsetX|offsetY)\b/.test(body),
			);
	}

	for (const file of tsxFiles) {
		const source = readFileSync(file, "utf8");
		const relative = file.slice(APP_DIR.length + 1);
		it(`${relative} は定数のインライン style を持たない`, () => {
			expect(constantInlineStyles(source)).toEqual([]);
		});
	}
});

describe("文字サイズは 5 段階に収まっている", () => {
	it("globals.css は rem の文字サイズを直書きしない", () => {
		const withoutRoot = css.replace(/:root\s*\{[^}]*\}/g, "");
		const sizes = [...withoutRoot.matchAll(/font-size:\s*([^;]+);/g)].map((m) =>
			m[1].trim(),
		);
		// var(--text-*) 以外が混ざっていないこと
		expect(sizes.filter((size) => !size.startsWith("var(--text-"))).toEqual([]);
	});

	/*
	 * どの段階を使っているかまで見る。「var(--text-*) を使っているか」だけだと
	 * 補助情報が --text-xs に、ラベルが --text-lg に化けても通ってしまう
	 * （置き換えの際に段階を取り違える間違いを、これで拾う）。
	 */
	const sizeBindings: Record<string, string> = {
		"issue-meta": "var(--text-sm)",
		"list-summary": "var(--text-sm)",
		"block-detail": "var(--text-sm)",
		"section-lead": "var(--text-sm)",
		"field-hint": "var(--text-sm)",
		"comment-date": "var(--text-xs)",
		"issue-map-attribution": "var(--text-xs)",
		"issue-card-title": "var(--text-base)",
	};

	for (const [className, token] of Object.entries(sizeBindings)) {
		it(`.${className} の文字サイズは ${token}`, () => {
			const rule = css.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`));
			expect(rule, `.${className} の定義が見つからない`).not.toBeNull();
			expect(rule?.[1]).toContain(`font-size: ${token}`);
		});
	}
});

describe("同じ意味の色が同じ値で描かれる", () => {
	/**
	 * ここはソースの走査ではなく、実際に描いた結果を見る。
	 * トークンを定義しても参照先を間違えれば意味が無いため、
	 * 「取得に失敗した」を表す 3 箇所が同じクラスに揃っているかを確かめる。
	 *
	 * かつて `IssueList` と `MyIssueList` は `#b00`、`CommentSection` は
	 * `#b91c1c` を使っていた。どちらも同じ意味だが値が違った。
	 */
	function errorClasses(html: string): string[] {
		return [...html.matchAll(/class="([^"]*)"/g)]
			.map((m) => m[1])
			.filter((className) => className.split(/\s+/).includes("error-block"));
	}

	/*
	 * クラス名が揃っているだけでは、実際に同じ色で描かれる保証にならない。
	 * クラスが存在して中身が空でも、色が別のトークンを指していても、
	 * 描画結果の class 属性は変わらないため。意味を持つクラスについては
	 * どのトークンを指しているかを CSS 側で照合する。
	 *
	 * ここを見ていないと、クラスを残したまま宣言だけ消しても
	 * テストが通ってしまう（レビューで実際に指摘された穴）。
	 */
	const colorBindings: Record<string, string> = {
		"error-block": "var(--danger)",
		"text-danger": "var(--danger)",
		"text-warning": "var(--warning)",
		"text-success": "var(--success)",
		"text-soft": "var(--ink-soft)",
		"text-faint": "var(--ink-faint)",
	};

	for (const [className, token] of Object.entries(colorBindings)) {
		it(`.${className} は ${token} で色を決めている`, () => {
			const rule = css.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`));
			expect(rule, `.${className} の定義が見つからない`).not.toBeNull();
			expect(rule?.[1]).toContain(`color: ${token}`);
		});
	}

	/*
	 * `<output>` は既定で inline のため、単独の行として出したいときに
	 * display の指定が要る。これが消えると文が前の要素に続いて表示される
	 */
	it(".notice は block で表示する", () => {
		const rule = css.match(/\.notice\s*\{([^}]*)\}/);
		expect(rule, ".notice の定義が見つからない").not.toBeNull();
		expect(rule?.[1]).toContain("display: block");
	});

	/*
	 * 枠を持つまとまり（カード）は、ルールごと消えても描画結果の
	 * class 属性は変わらない。定義の存在と、枠がトークンを指すことを見る
	 */
	for (const className of ["issue-card", "comment-card"]) {
		it(`.${className} は --line の枠を持つ`, () => {
			const rule = css.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`));
			expect(rule, `.${className} の定義が見つからない`).not.toBeNull();
			expect(rule?.[1]).toContain("border: 1px solid var(--line)");
		});
	}

	it("Issue 一覧の取得失敗は --danger で描く", () => {
		const html = renderToStaticMarkup(
			<IssueList result={{ ok: false, error: "接続できません" }} />,
		);
		expect(errorClasses(html).length).toBeGreaterThan(0);
	});

	it("自分の Issue 一覧の取得失敗は --danger で描く", () => {
		const html = renderToStaticMarkup(
			<MyIssueList
				result={{ ok: false, unauthorized: false, error: "接続できません" }}
			/>,
		);
		expect(errorClasses(html).length).toBeGreaterThan(0);
	});

	it("Issue 詳細の取得失敗も同じ --danger で描く（かつて #b00 と #b91c1c に割れていた）", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("", { status: 500 })) as unknown as typeof globalThis.fetch;
		try {
			const html = renderToStaticMarkup(
				await IssueDetailPage({ params: Promise.resolve({ id: "issue-1" }) }),
			);
			expect(errorClasses(html).length).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

/*
 * クラス名を書き間違えても、CSS が当たらないだけで描画は成立してしまう。
 * 見た目だけが崩れて誰も気付かない状態になるので、主要な部品が
 * 実際に出しているクラスを描画結果から確かめる。
 *
 * クラス名は境界付きで照合する。`toContain("issue-card")` だと
 * `issue-card-title` にも一致して、カード本体のクラスが消えていても通る
 * （`map.test.tsx` のマーカーの照合と同じ考え方）。
 */
describe("部品が期待するクラスを出している", () => {
	function hasClass(html: string, className: string): boolean {
		return [...html.matchAll(/class="([^"]*)"/g)].some((m) =>
			m[1].split(/\s+/).includes(className),
		);
	}

	const sampleIssue = {
		id: "ebbcf9d7680ad57cedeeb513a90d461f",
		title: "駅前の街灯が切れている",
		description: "夜道が暗くて危ない",
		scope: "community" as const,
		status: "open" as const,
		latitude: 35.681236,
		longitude: 139.767125,
		category: "道路・交通",
		created_at: "2026-08-01 12:00:00.000",
		updated_at: "2026-08-02 09:30:00.000",
	};

	const listResult = {
		ok: true as const,
		issues: [sampleIssue],
		total: 1,
		limit: 20,
		offset: 0,
	};

	it("Issue カードは issue-card と、その中の見出し・説明・補助情報を出す", () => {
		const html = renderToStaticMarkup(<IssueList result={listResult} />);
		for (const className of [
			"issue-cards",
			"issue-card",
			"issue-card-title",
			"issue-card-description",
			"issue-meta",
			"list-summary",
		]) {
			expect(hasClass(html, className), `${className} が出ていない`).toBe(true);
		}
	});

	it("自分の Issue 一覧も同じカードのクラスを使う", () => {
		const html = renderToStaticMarkup(<MyIssueList result={listResult} />);
		expect(hasClass(html, "issue-card")).toBe(true);
		expect(hasClass(html, "list-summary")).toBe(true);
	});

	it("0 件の案内は text-soft で描く", () => {
		const html = renderToStaticMarkup(
			<IssueList
				result={{ ok: true, issues: [], total: 0, limit: 20, offset: 0 }}
			/>,
		);
		expect(hasClass(html, "text-soft")).toBe(true);
	});
});

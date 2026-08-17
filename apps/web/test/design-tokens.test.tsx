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
import {
	ISSUE_STATUS_LABELS,
	ISSUE_STATUS_VALUES,
} from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueList } from "../src/app/components/IssueList";
import { MyIssueList } from "../src/app/components/MyIssueList";
import { StatusPill } from "../src/app/components/StatusPill";
import IssueDetailPage from "../src/app/issues/[id]/page";
import IssuesPage from "../src/app/issues/page";

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

/**
 * 描画結果がそのクラスを出しているか。
 *
 * クラス名は境界付きで照合する。`toContain("issue-card")` だと
 * `issue-card-title` にも一致して、カード本体のクラスが消えていても通る
 * （`map.test.tsx` のマーカーの照合と同じ考え方）。
 */
function hasClass(html: string, className: string): boolean {
	return [...html.matchAll(/class="([^"]*)"/g)].some((m) =>
		m[1].split(/\s+/).includes(className),
	);
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
		"--surface-muted": "#f1f5f2",
		"--surface-accent": "#f3faf6",
		"--sun": "#f3c76a",
		"--sun-soft": "#fff4d6",
		"--danger": "#b91c1c",
		"--warning": "#b45309",
		"--success": "#1a7f5a",
		"--text-xl": "1.75rem",
		"--text-lg": "1.0625rem",
		"--text-base": "1rem",
		"--text-sm": "0.875rem",
		"--text-xs": "0.75rem",

		/*
		 * 見出しの段階（#94 の結論）。5 段階には畳まず、見出し専用に
		 * 3 段階を持つ。#86 は「畳むかどうかは後続の Issue で決める」と
		 * 申し送っていた。
		 *
		 * --text-heading-site だけは 1.2rem → 1.0625rem に変更した。
		 * サイト名が本文より大きい必要はなく、狭い画面でヘッダが崩れる一因
		 * でもあるため。#94 が認めた既存値の変更はこの 1 つだけ。
		 *
		 * B1 で 2 つ変えている:
		 * - --text-heading-section を可変にした（1.25rem では本文との差が
		 *   小さく、節の変わり目が読み取れなかった）
		 * - --text-heading-hero を足した。トップページのヒーロー専用で、
		 *   --text-heading-page とは分ける（あちらは詳細ページの h1 でも
		 *   使われ、中身は利用者が書いた最大 200 文字のタイトル）
		 */
		"--text-heading-page": "2rem",
		"--text-heading-section": "clamp(1.625rem, 3vw, 2.125rem)",
		"--text-heading-site": "1.0625rem",
		"--text-heading-hero": "clamp(2.75rem, 13cqi, 3.25rem)",

		"--space-1": "0.25rem",
		"--space-2": "0.5rem",
		"--space-3": "0.75rem",
		"--space-4": "1rem",
		"--space-5": "1.25rem",
		"--space-6": "1.5rem",

		/* 節の区切り。0.25rem 刻みの続きにせず、用途の名前で 2 段階だけ持つ（#95） */
		"--space-section": "2rem",
		"--space-page": "3rem",

		"--radius-sm": "0.25rem",
		"--radius-md": "0.5rem",
		"--radius-lg": "0.75rem",
		"--radius-pill": "999px",
		"--shadow-card": "0 8px 24px rgba(28, 36, 32, 0.08)",
		"--shadow-card-hover": "0 12px 28px rgba(28, 36, 32, 0.12)",
		"--shadow-button": "0 4px 16px rgba(26, 127, 90, 0.18)",
		"--shadow-marker": "0 0 0 1px rgba(0, 0, 0, 0.4)",
		"--leading-tight": "1.2",
		"--leading-snug": "1.4",
		"--leading-normal": "1.6",
		"--tracking-tight": "-0.01em",
		"--tracking-normal": "0",
		/* 特大の見出し用（B1）。大きい字は同じ倍率でも行間・字間が広く見える */
		"--leading-hero": "1.14",
		"--tracking-hero": "-0.03em",
		"--transition-fast": "160ms ease",
		"--transition-base": "240ms ease",

		/*
		 * ライフサイクル 6 段階の色（#95）。#94 の見本には無かったので
		 * ここで新しく足した。進むほど --accent（緑）に近づく。
		 * 下の「ピルの文字色がコントラスト比を満たす」が、この組み合わせを
		 * 実際に計算して検証している
		 */
		"--status-open": "#55605a",
		"--status-open-soft": "#eef1ef",
		"--status-triaged": "#7a5f14",
		"--status-triaged-soft": "#fbf3de",
		"--status-in-progress": "#1f6f8b",
		"--status-in-progress-soft": "#e4f1f6",
		"--status-review": "#2a6f5c",
		"--status-review-soft": "#e6f2ee",
		"--status-resolved": "#146b4c",
		"--status-resolved-soft": "#e8f5ef",
		"--status-closed": "#5d6763",
		"--status-closed-soft": "#f2f4f3",
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
	 *
	 * #95 で `fill` / `index` を除外に足した。どちらもデータから算出した値を
	 * CSS カスタムプロパティ（`--fill` / `--depth`）へ渡すためのもので、
	 * 色や寸法の直書きではない。CSS 側に段数を書くと、段階が増えたときに
	 * 片方だけ古くなるので、あえてこの向きにしている
	 */
	function constantInlineStyles(source: string): string[] {
		return [...source.matchAll(/style=\{\{([^}]*)\}\}/g)]
			.map((m) => m[1])
			.filter(
				(body) =>
					!/[`$]|\b(VIEW_SIZE|TILE_SIZE|offsetX|offsetY|fill|index)\b/.test(
						body,
					),
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
		/*
		 * カードの見出しは #95 で --text-base（本文と同じ）から --text-lg へ上げた。
		 * 一覧はカードが並ぶ画面で、タイトルが説明文と同じ重みだと
		 * どこから読めばよいか分からない（#94 の見本もタイトルを一段強くしている）
		 */
		"issue-card-title": "var(--text-lg)",
	};

	for (const [className, token] of Object.entries(sizeBindings)) {
		it(`.${className} の文字サイズは ${token}`, () => {
			const rule = css.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`));
			expect(rule, `.${className} の定義が見つからない`).not.toBeNull();
			expect(rule?.[1]).toContain(`font-size: ${token}`);
		});
	}
});

describe("見出し・角丸・影・遷移の決定が CSS に反映されている", () => {
	function ruleBody(selector: string): string {
		const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const rule = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
		expect(rule, `${selector} の定義が見つからない`).not.toBeNull();
		return rule?.[1] ?? "";
	}

	it("body の行間は --leading-normal を使う", () => {
		expect(ruleBody("body")).toContain("line-height: var(--leading-normal)");
	});

	it("h1 / h2 / .site-header-title は見出し用の行間と字送りを使う", () => {
		expect(ruleBody("h1")).toContain("line-height: var(--leading-tight)");
		expect(ruleBody("h1")).toContain("letter-spacing: var(--tracking-tight)");
		/*
		 * h2 は B1 で大きくした（最大 34px）ので、行間も --leading-snug（1.4）
		 * から詰めている。大きい字は同じ倍率でも行が離れて見えるため
		 */
		expect(ruleBody("h2")).toContain("line-height: var(--leading-tight)");
		expect(ruleBody("h2")).toContain("letter-spacing: var(--tracking-tight)");
		expect(ruleBody(".site-header-title")).toContain(
			"font-size: var(--text-heading-site)",
		);
		expect(ruleBody(".site-header-title")).toContain(
			"line-height: var(--leading-snug)",
		);
	});

	/*
	 * ヒーローの見出し（B1）。
	 *
	 * ここが --text-heading-page に戻ると、詳細ページの h1（利用者が書いた
	 * 最大 200 文字のタイトル）と同じ物差しに乗る。文言をこちらで決められる
	 * ヒーローだけが大きくてよい、という切り分けが崩れていないことを見る
	 */
	it(".hero-heading はヒーロー専用の大きさと行間を使う", () => {
		const body = ruleBody(".hero-heading");

		expect(body).toContain("font-size: var(--text-heading-hero)");
		expect(body).toContain("line-height: var(--leading-hero)");
		expect(body).toContain("letter-spacing: var(--tracking-hero)");
	});

	it("主要なカードと大きい面は角丸・影をトークンで決める", () => {
		for (const selector of [
			".issue-card",
			".comment-card",
			".issue-filters",
			".location",
			".issue-map-view",
		]) {
			const body = ruleBody(selector);
			expect(body).toContain("border-radius: var(--radius-md)");
			expect(body).toContain("box-shadow: var(--shadow-card)");
		}
	});

	it("リンクとボタンは遷移トークンを使う", () => {
		const linkRule = ruleBody("a");
		expect(linkRule).toContain("color var(--transition-fast)");
		expect(linkRule).toContain("background-color var(--transition-fast)");
		expect(linkRule).toContain("box-shadow var(--transition-base)");
		expect(ruleBody(".button-primary")).toContain(
			"box-shadow: var(--shadow-button)",
		);
		expect(ruleBody(".button-primary")).toContain("var(--transition-fast)");
		expect(ruleBody(".button-secondary")).toContain("var(--transition-fast)");
	});

	it("border-radius に 4px / 6px を直書きしない", () => {
		const withoutRoot = css.replace(/:root\s*\{[^}]*\}/g, "");
		expect(withoutRoot.match(/border-radius:\s*(4px|6px)/g) ?? []).toEqual([]);
	});
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

	/*
	 * 0 件の案内（#95 で `.empty-state` に統一）。
	 *
	 * 以前は `<p className="text-soft">` の 1 行で、しかも出す場所ごとに
	 * 書き方が割れていた（4 通り）。まとまりとして出す形に変えたので、
	 * クラスの存在と、色がトークンを指していることの両方を見る。
	 * クラスだけを見ると、ルールごと消えても描画結果の class 属性は
	 * 変わらないため通ってしまう（上の .issue-card と同じ考え方）
	 */
	it("0 件の案内は empty-state で描く", () => {
		const html = renderToStaticMarkup(
			<IssueList
				result={{ ok: true, issues: [], total: 0, limit: 20, offset: 0 }}
			/>,
		);
		expect(hasClass(html, "empty-state")).toBe(true);
	});

	it(".empty-state は本文より弱い色（--ink-soft）で描く", () => {
		const rule = css.match(/\.empty-state\s*\{([^}]*)\}/);
		expect(rule, ".empty-state の定義が見つからない").not.toBeNull();
		expect(rule?.[1]).toContain("color: var(--ink-soft)");
	});
});

/*
 * ここから下は #95（見本を各画面に当てる）で足した部品の検証。
 *
 * 見た目そのもの（ピクセル）は見ていない（それは #96 の担当）。
 * 見ているのは「Issue の受け入れ条件として機械的に確かめられること」で、
 * 具体的にはコントラスト比・色以外の手がかり・トークン経由かの 3 つ。
 */

/** `#rrggbb` の相対輝度（WCAG 2.1 の定義） */
function relativeLuminance(hex: string): number {
	const value = hex.replace("#", "");
	const channels = [0, 2, 4].map(
		(i) => Number.parseInt(value.slice(i, i + 2), 16) / 255,
	);
	const [r, g, b] = channels.map((c) =>
		c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 2 色のコントラスト比（1〜21）。順序は問わない */
function contrastRatio(a: string, b: string): number {
	const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort(
		(x, y) => y - x,
	);
	return (lighter + 0.05) / (darker + 0.05);
}

describe("ライフサイクルの段階が読み取れる", () => {
	const tokens = declaredTokens(css);

	/*
	 * ピルは色で段階を示すが、文字が読めなければ意味が無い。
	 * Issue #95 の受け入れ条件は「本文 4.5:1 以上」。
	 * ピルの文字は本文と同じ扱いなので、この基準を全段階に課す。
	 *
	 * 値を目で確かめるのではなく計算する。手で計算した結果をコメントに
	 * 書く方式だと、後から色を変えたときにコメントだけが古くなる
	 */
	for (const status of ISSUE_STATUS_VALUES) {
		// CSS のトークン名は `in_progress` ではなく `in-progress`
		const name = status.replace(/_/g, "-");

		it(`${status} のピルは文字色と下地が 4.5:1 以上`, () => {
			const foreground = tokens.get(`--status-${name}`);
			const background = tokens.get(`--status-${name}-soft`);
			expect(foreground, `--status-${name} が無い`).toBeTruthy();
			expect(background, `--status-${name}-soft が無い`).toBeTruthy();

			const ratio = contrastRatio(foreground ?? "", background ?? "");
			expect(
				ratio,
				`${status} のコントラスト比が ${ratio.toFixed(2)}:1 しかない`,
			).toBeGreaterThanOrEqual(4.5);
		});
	}

	/*
	 * 色だけに頼らない（#94 が明記した条件）。段階ごとに印の塗りが変わり、
	 * 色を見分けられなくても順序が読める。
	 *
	 * 塗りの割合は段階の並びから算出しているので、実際に描いた結果の
	 * `--fill` が段階ごとに違うことを見る。CSS の宣言を見るだけだと、
	 * 全段階が同じ値を渡していても気付けない
	 */
	it("段階ごとに印の塗りが変わる（色を見分けられなくても順序が読める）", () => {
		const fills = ISSUE_STATUS_VALUES.map((status) => {
			const html = renderToStaticMarkup(<StatusPill status={status} />);
			return html.match(/--fill:\s*([\d.]+)/)?.[1];
		});

		// どの段階でも印が出ていること（値が取れない＝印そのものが無い）
		for (const [index, fill] of fills.entries()) {
			expect(fill, `${ISSUE_STATUS_VALUES[index]} に印が無い`).toBeTruthy();
		}
		// 段階の数だけ違う値になっていること
		expect(new Set(fills).size).toBe(ISSUE_STATUS_VALUES.length);
		// 進むほど増えること。順序が読めることがこの印の役目
		const numbers = fills.map((fill) => Number(fill));
		for (let i = 1; i < numbers.length; i++) {
			expect(numbers[i]).toBeGreaterThan(numbers[i - 1]);
		}
		// 最初の段階でも 0 にしない。塗りが無いと印が出ていないのと区別できない
		expect(numbers[0]).toBeGreaterThan(0);
	});

	/*
	 * 印は装飾なので読み上げから外す。ラベルの文字列だけが読まれればよく、
	 * 印まで読ませると「● 受付」のように冗長になる
	 */
	it("印は読み上げから外してある", () => {
		const html = renderToStaticMarkup(<StatusPill status="open" />);
		expect(html).toMatch(/status-pill-mark[^>]*aria-hidden="true"/);
	});

	/*
	 * ピルのラベルは辞書から引く（#82）。ここに写すと、
	 * 英語表示のときにピルだけ日本語が残る
	 */
	for (const locale of ["ja", "en"] as const) {
		it(`${locale} でのラベルが辞書と一致する`, () => {
			const html = renderToStaticMarkup(
				<StatusPill status="in_progress" locale={locale} />,
			);
			expect(html).toContain(ISSUE_STATUS_LABELS[locale].in_progress);
		});
	}
});

describe("#95 で足した部品がトークン経由で描かれている", () => {
	/*
	 * クラスが存在して中身が空でも描画結果は変わらない。
	 * 意味を持つ部品については、どのトークンを指しているかを CSS 側で照合する
	 * （上の .issue-card / .comment-card と同じ考え方）
	 */
	const tokenBindings: Record<string, string[]> = {
		// カードの面と浮き。#94 が「border だけで平面的」と指摘した点
		"issue-card": ["var(--surface)", "var(--shadow-card)", "var(--radius-md)"],
		// 0 件のまとまり。暖色を使うのはヒーローとここだけ
		"empty-state": ["var(--sun-soft)", "var(--radius-md)"],
		// ヒーロー。文字は絵に重ねず隣に置く
		hero: ["var(--sun-soft)", "var(--radius-md)"],
		// 絞り込み・ページ送りはクラスだけあって定義が無かった
		"issue-filters": ["var(--surface)", "var(--radius-md)"],
		// ピルは丸め切る段階を使う
		"status-pill": ["var(--radius-pill)"],
	};

	for (const [className, tokens] of Object.entries(tokenBindings)) {
		for (const token of tokens) {
			it(`.${className} は ${token} を使う`, () => {
				const rule = css.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`));
				expect(rule, `.${className} の定義が見つからない`).not.toBeNull();
				expect(rule?.[1]).toContain(token);
			});
		}
	}

	/*
	 * 遷移（#94 が「現在ゼロ。手触りの硬さの主因」とした点）。
	 * トークンを定義しただけで誰も使っていない状態を弾く
	 */
	it("遷移のトークンが実際に使われている", () => {
		const withoutRoot = stripBlockComments(css).replace(
			/:root\s*\{[^}]*\}/g,
			"",
		);
		for (const token of ["--transition-fast", "--transition-base"]) {
			expect(
				withoutRoot.includes(`var(${token})`),
				`${token} を参照している箇所が無い`,
			).toBe(true);
		}
	});

	/*
	 * 影も同じ。#94 が足すと決めたもので、定義だけあって使われていないと
	 * 「平面的なまま」の状態が変わらない
	 */
	it("影のトークンが実際に使われている", () => {
		const withoutRoot = stripBlockComments(css).replace(
			/:root\s*\{[^}]*\}/g,
			"",
		);
		for (const token of ["--shadow-card", "--shadow-card-hover"]) {
			expect(
				withoutRoot.includes(`var(${token})`),
				`${token} を参照している箇所が無い`,
			).toBe(true);
		}
	});

	/*
	 * 入力欄のスタイルは、要素セレクタではなくまとまりのクラスに閉じる
	 * （globals.css のコメント参照。Clerk のモーダルに当たるため）。
	 * #95 で対象を .issue-filters / .status-control へ広げたので、
	 * 素の要素セレクタに戻っていないことを見る
	 */
	it("入力要素のスタイルを素の要素セレクタで書いていない", () => {
		const withoutRoot = stripBlockComments(css);
		for (const element of ["input", "textarea", "select", "button"]) {
			// 行頭またはカンマ直後に素の要素名が来るセレクタを探す
			const bare = new RegExp(
				`(?:^|,)\\s*${element}\\s*(?::[\\w-]+(?:\\([^)]*\\))?)?\\s*[,{]`,
				"m",
			);
			expect(
				bare.test(withoutRoot),
				`${element} を素の要素セレクタで指定している（Clerk のモーダルにも当たる）`,
			).toBe(false);
		}
	});

	/*
	 * #95 で入力欄を持つまとまりを増やした。フォーカスの見え方が
	 * まとまりごとに欠けていないことを見る（受け入れ条件の
	 * 「キーボードのみで全操作ができ、フォーカス位置が常に見える」）
	 */
	/*
	 * セレクタの存在だけを見ると、そのルールの `outline` の宣言を消しても
	 * 通ってしまう（変異体で実際にすり抜けた）。フォーカス位置が見えるかは
	 * 「そのまとまりを含むルールが outline を引いているか」で決まるので、
	 * まとまりごとに、それを含むルールの中身まで見る
	 */
	const focusScopes = [
		".issue-form",
		".issue-filters",
		".status-control",
		".button-primary",
		".button-secondary",
		".button-link",
		"a",
	];

	for (const scope of focusScopes) {
		it(`${scope} の :focus-visible がアウトラインを引いている`, () => {
			const rules = [
				...stripBlockComments(css).matchAll(
					/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/g,
				),
			];

			/*
			 * セレクタ列を分解して、そのまとまりに属するものを含むルールを拾う。
			 * `a` が `.locale-switcher a` に一致してしまわないよう、
			 * `a:focus-visible` のように「まとまり名で始まる」ものだけを見る
			 */
			const matching = rules.filter((rule) =>
				rule[1]
					.split(",")
					.map((part) => part.trim())
					.some(
						(selector) =>
							selector === `${scope}:focus-visible` ||
							selector.startsWith(`${scope} `) ||
							selector.startsWith(`${scope}:`),
					),
			);

			expect(
				matching.length,
				`${scope} を含む :focus-visible のルールが無い`,
			).toBeGreaterThan(0);
			// 中身が空でも、outline 以外しか書いていなくても落ちる
			expect(
				matching.some((rule) => /(?:^|;)\s*outline\s*:/.test(rule[2])),
				`${scope} の :focus-visible に outline の指定が無い`,
			).toBe(true);
		});
	}
});

/*
 * 空の状態（#94 が「決めること」に挙げた項目）。
 *
 * 見た目が整っているかではなく、**空の画面が行き止まりになっていないか**を見る。
 * 0 件のときこそ次に何をすればよいかが要る。`EmptyState` の `action` を
 * 渡し忘れても描画は成立してしまうので、実際に導線が出ているかを確かめる。
 */
describe("空の画面が行き止まりになっていない", () => {
	/** 描画結果に含まれるリンクの遷移先 */
	function linkTargets(html: string): string[] {
		return [...html.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]);
	}

	it("Issue が 1 件も無いときは起票への導線を出す", () => {
		const html = renderToStaticMarkup(
			<IssueList
				result={{ ok: true, issues: [], total: 0, limit: 20, offset: 0 }}
			/>,
		);
		expect(hasClass(html, "empty-state-action"), "次の一歩が出ていない").toBe(
			true,
		);
		expect(linkTargets(html)).toContain("/issues/new");
	});

	it("自分の Issue が 1 件も無いときも起票への導線を出す", () => {
		const html = renderToStaticMarkup(
			<MyIssueList
				result={{ ok: true, issues: [], total: 0, limit: 20, offset: 0 }}
			/>,
		);
		expect(hasClass(html, "empty-state-action"), "次の一歩が出ていない").toBe(
			true,
		);
		expect(linkTargets(html)).toContain("/issues/new");
	});

	/*
	 * 絞り込みの結果 0 件は、投稿が無いのとは意味が違う。
	 * 次の一歩も「起票する」ではなく「条件を解除する」でなければならない
	 */
	it("絞り込みの結果 0 件のときは条件を解除する導線を出す", async () => {
		const originalFetch = globalThis.fetch;
		// レスポンスの形は `parseListIssuesResponse`（lib/issues.ts）が決めている。
		// `{ data, total }` 以外を返すと「形式が想定と異なる」として失敗扱いになり、
		// 空の状態ではなくエラーの画面が描かれる
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ data: [], total: 0 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof globalThis.fetch;
		try {
			const html = renderToStaticMarkup(
				await IssuesPage({
					searchParams: Promise.resolve({ scope: "personal" }),
				}),
			);
			expect(hasClass(html, "empty-state-action"), "次の一歩が出ていない").toBe(
				true,
			);
			// 条件を解除した先（条件なしの一覧）へ戻れること
			expect(linkTargets(html)).toContain("/issues");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

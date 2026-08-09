/**
 * 「スタイルの指定が存在すること」の検査（Issue #96）。
 *
 * #86 のテスト（design-tokens.test.tsx）は 363 件が通っていたのに、実機では
 * リンクが紫で、ヘッダが 3 行に潰れ、コメント欄の textarea が 3 行分の幅しか
 * 無かった（#93）。363 件はすべて **「書かれている値が正しいか」** を見ており、
 * **「そもそも書かれているか」** を誰も見ていなかった。
 *
 * この二つは検査として別物になる:
 *
 * - 「直書きの `#rrggbb` が無い」は、指定が 1 つも無いときも通る。
 *   `a { color }` を書き忘れた状態は、直書きが無い状態と区別が付かない
 * - 「`.foo` の font-size が `var(--text-sm)`」は、`.foo` を **列挙した分しか**
 *   見ていない。列挙から漏れたクラスは検査対象ですらない
 *
 * つまり従来の走査は「悪いものが増えていないか」の検査で、
 * 「必要なものが在るか」は守備範囲の外だった。ここはその外側を埋める。
 *
 * 埋め方は網羅を機械で担保する形にしている。個別のクラス名を書き並べると
 * 「書き並べた分しか見ていない」という同じ穴を作るので、**tsx が実際に出す
 * クラスを全部拾って、CSS 側と突き合わせる**。新しいクラスを足した人が
 * このテストに追記しなくても、CSS の定義を忘れれば落ちる。
 *
 * ここで見ないと決めたもの（Issue の「検討する手立て」のうち採らなかったもの）:
 *
 * - **視覚回帰テスト（画像比較）**: 採らない。Issue 自身が「#95 で見た目が
 *   固まってから入れないと差分だらけで機能しない」と書いており、いま入れると
 *   #94 / #95 のデザイン適用でスナップショットが全滅する。加えて描画エンジンを
 *   持つ新しい依存が要る（この worktree では追加できない）。#95 の後に別 Issue で
 *   検討する
 * - **実際のレイアウト計算（折り返し・重なり）**: 採らない。CSS カスケードと
 *   ボックスモデルの実装が要る＝実質ヘッドレスブラウザで、上と同じ話になる。
 *   代わりに「折り返しの逃げ場が宣言されているか」を静的に見る
 *   （layout-integrity.test.tsx が #93 の 4 件について既に行っている）
 *
 * 手で確認する軸は docs/visual-check.md に書いた。上の 2 つを自動化しないと
 * 決めた以上、その穴を人が塞ぐ手順は残す必要がある。
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(import.meta.dir, "../src/app");
const GLOBALS_CSS = join(APP_DIR, "globals.css");
const DOCS_DIR = join(import.meta.dir, "../../../docs");

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

/** ブロックコメントを外す。コメント中の記述を宣言と取り違えないため */
function stripBlockComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

const tsxFiles = collectFiles(APP_DIR, ".tsx");
const css = readFileSync(GLOBALS_CSS, "utf8");
const cssWithoutComments = stripBlockComments(css);

/**
 * tsx が `className` に書いているクラス名を、ファイルごとに集める。
 *
 * `className="a b"` に加えて `className={cond ? "a" : "b"}` も拾う。
 * 後者は `HelpOfferButton` が実際に使っている正当な書き方で、
 * **式の中に書かれたクラス名も CSS の定義が要る点は同じ**。静的な形だけを
 * 見ると、条件分岐の中に書いたクラスが黙って検査から外れる
 * （検査が効いているように見えて効いていない状態になる）。
 *
 * 拾えるのは式の中の文字列リテラルまで。テンプレートリテラルで組み立てる
 * 形（`` `card ${variant}` ``）は拾えないので、その書き方が入ったことを
 * 下の「クラス名が文字列リテラルとして読める」で落とす。
 */
function classNamesIn(source: string): string[] {
	const withoutComments = stripBlockComments(source);
	const names: string[] = [];
	// `className="..."` と `className={... "..." ...}` の両方。
	// 後者は式の中に現れる文字列リテラルをすべて拾う
	for (const match of withoutComments.matchAll(
		/className=(?:"([^"]*)"|\{([^}]*)\})/g,
	)) {
		const literals =
			match[1] !== undefined
				? [match[1]]
				: [...(match[2] ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
		for (const literal of literals) {
			names.push(...literal.split(/\s+/).filter((name) => name.length > 0));
		}
	}
	return names;
}

/** CSS のセレクタ列に現れるクラス名をすべて集める */
function definedClassNames(): Set<string> {
	const names = new Set<string>();
	// 宣言ブロックの中（プロパティ値）を除いてセレクタ側だけを見る。
	// `content: ".foo"` のような値をクラス定義と誤認しないため
	const selectorText = cssWithoutComments.replace(/\{[^{}]*\}/g, "{}");
	for (const match of selectorText.matchAll(/\.([\w-]+)/g)) {
		names.add(match[1]);
	}
	return names;
}

describe("tsx が出すクラスに CSS の定義がある", () => {
	/*
	 * 「クラスを書いたのに CSS を書き忘れた」を拾う。
	 *
	 * この形の抜けは既存のどのテストでも落ちない。クラス名は tsx にあり、
	 * 直書きの色もインライン style も無いので #86 の走査はすべて通る。
	 * 描画結果にクラス名が出ていることを見るテストも、クラス名が出ている
	 * ことは本当なので通る。**指定が無いことだけが誰にも見えていない。**
	 *
	 * 実際にこの状態で見つかったもの:
	 * - `.issue-filters`（一覧の絞り込みフォーム）
	 * - `.issue-pagination`（一覧のページ送り）
	 *
	 * どちらも #86 より前から tsx にあり、385 件のテストをすべてすり抜けていた。
	 */
	const defined = definedClassNames();

	for (const file of tsxFiles) {
		const relative = file.slice(APP_DIR.length + 1);
		const used = [...new Set(classNamesIn(readFileSync(file, "utf8")))];
		if (used.length === 0) {
			continue;
		}
		it(`${relative} のクラスがすべて globals.css に定義されている`, () => {
			const missing = used.filter((name) => !defined.has(name));
			expect(
				missing,
				`globals.css に定義が無いクラス: ${missing.join(", ")}`,
			).toEqual([]);
		});
	}
});

describe("既定値のままだと壊れる要素にスタイルが当たっている", () => {
	/*
	 * 「指定が無い」と「正しく指定されている」を区別する検査。
	 *
	 * ブラウザ既定値が存在する要素は、指定を書き忘れても画面には出る。
	 * 出るが、サービスの見た目とは無関係な既定値で出る。#93 の 4 件は
	 * すべてこの形だった（リンクの紫、textarea の cols 幅）。
	 *
	 * ここに並べるのは「既定値で出ると破綻するもの」に限る。
	 * すべての要素を並べると、指定する必要の無いものまで縛ることになる。
	 */

	/**
	 * セレクタに対応する宣言ブロックを集める。
	 *
	 * `layout-integrity.test.tsx` の `rulesFor` と同じ役割だが、あちらは
	 * 「セレクタ列に完全一致で含まれるか」を見る（`a` が `.issue-card a` に
	 * 一致しないように）。こちらは逆に **子孫セレクタも含めて** 「その要素に
	 * 何らかの指定が届いているか」を見たいので、別に持つ。
	 */
	function hasDeclarationFor(
		selectorPattern: RegExp,
		property: string,
	): boolean {
		// アンカーは **消費しない** 先読みで書くこと。`(?:^|[{}])` のように
		// 括弧を消費すると、その `}` が次のルールのアンカーとして使えなくなり、
		// **隣り合うルールが 1 つおきに飛ばされる**。実際に `body` の次の
		// `a { ... }` と `h1` と `ul` が丸ごと走査から漏れていた
		// （「リンクの色が無い」と誤検出して気付いた）
		for (const match of cssWithoutComments.matchAll(
			/(?<=^|[{}])\s*([^{}]+?)\{([^}]*)\}/g,
		)) {
			// セレクタ列は改行を挟んで並ぶ（`.issue-form input,\n\t.issue-form textarea`）。
			// カンマで割ったあと空白を落としてから照合する
			const selectors = match[1]
				.split(",")
				.map((part) => part.replace(/\s+/g, " ").trim())
				.filter((part) => part.length > 0);
			if (!selectors.some((selector) => selectorPattern.test(selector))) {
				continue;
			}
			if (new RegExp(`(?:^|;)\\s*${property}\\s*:`).test(match[2])) {
				return true;
			}
		}
		return false;
	}

	/*
	 * リンクは色を指定しないとブラウザ既定の青紫（訪問済み）／紫になる。
	 * #93 で直したが、`a` のルールが `.issue-card a` のように部分的な
	 * スコープへ狭められると、スコープ外のリンクだけが紫に戻る。
	 * 「ページ全体に届く指定であること」まで見る
	 */
	it("リンクの色がページ全体に届く指定になっている", () => {
		// `a` 単体（子孫セレクタでない）のルールであること
		expect(
			hasDeclarationFor(/^a$/, "color"),
			"a 単体の color が無い（スコープ内のリンクしか色が付かない）",
		).toBe(true);
	});

	/*
	 * 入力要素は既定の `size` / `cols` 由来の幅で出る。textarea の既定は
	 * 20 文字 x 2 行で、2000 文字書ける欄がこの幅で出ていたのが #93 の症状。
	 *
	 * `.issue-form` に閉じる方針（#86）は壊さない。見るのは
	 * 「フォームを名乗るクラスの中で幅が決まっていること」
	 */
	for (const element of ["input", "textarea", "select"]) {
		it(`${element} に枠と余白の指定が届いている`, () => {
			expect(
				hasDeclarationFor(new RegExp(`\\s${element}$`), "border"),
				`${element} に border の指定が無い（ブラウザ既定の枠で出る）`,
			).toBe(true);
		});
	}

	it("textarea に幅の指定が届いている", () => {
		expect(
			hasDeclarationFor(/\stextarea$/, "width"),
			"textarea に width が無い（既定の cols 幅で出る）",
		).toBe(true);
	});

	/*
	 * ボタンは既定だとフォントが本文と揃わない（ブラウザ既定の
	 * system UI フォント・小さめの文字サイズ）。`font: inherit` が要る
	 */
	for (const className of ["button-primary", "button-secondary"]) {
		it(`.${className} が本文のフォントを継いでいる`, () => {
			const rule = cssWithoutComments.match(
				new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`),
			);
			expect(rule, `.${className} の定義が無い`).not.toBeNull();
			expect(
				rule?.[1],
				"font: inherit が無い（既定のフォントで出る）",
			).toContain("font: inherit");
		});
	}
});

describe("フォームの入力欄がスタイルの届く場所に置かれている", () => {
	/*
	 * #93 のコメント欄と同じ形の抜けを、他のフォームについても拾う。
	 *
	 * 入力要素のスタイルは `.issue-form` の子孫にしか無い（#86 の方針。
	 * 素の要素セレクタは Clerk のモーダルにも当たるため）。つまり
	 * **`.issue-form` の外にある入力要素は、スタイルが 1 つも当たらない。**
	 *
	 * この関係は CSS 側からは見えない。tsx 側で「入力要素を持つ form が
	 * `.issue-form` を名乗っているか」を見るしかない。
	 *
	 * 実際にこの状態で見つかったもの:
	 * - `IssueFilterForm`（一覧の絞り込み）— input 3 つと select 3 つが
	 *   すべて素のまま。コメント欄（#93）とまったく同じ症状が、
	 *   直された後も別の画面に残っていた
	 */
	const INPUT_ELEMENTS = /<(input|textarea|select)\b/;

	for (const file of tsxFiles) {
		const relative = file.slice(APP_DIR.length + 1);
		const source = stripBlockComments(readFileSync(file, "utf8"));
		const formTags = [...source.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
		if (formTags.length === 0) {
			continue;
		}
		it(`${relative} の form が入力欄のスタイルスコープを名乗っている`, () => {
			// このファイルに入力要素が無いなら、スコープは要らない
			if (!INPUT_ELEMENTS.test(source)) {
				return;
			}
			for (const tag of formTags) {
				expect(
					tag,
					`form に issue-form が無い。中の input / textarea / select に` +
						` スタイルが 1 つも当たらない（#93 のコメント欄と同じ症状）`,
				).toContain("issue-form");
			}
		});
	}
});

describe("クラス名が文字列リテラルとして読める", () => {
	/*
	 * 上の突き合わせは、クラス名が **文字列リテラルとして書かれている** ことに
	 * 依存している。テンプレートリテラルで組み立てる形（`` `card ${variant}` ``）が
	 * 入ると、そのクラスは突き合わせの対象から静かに外れる
	 * — **検査が効いているように見えて効かなくなる。**
	 *
	 * 条件分岐（`cond ? "a" : "b"`）は上の `classNamesIn` が拾えるので許す。
	 * 拾えない書き方が入ったことだけを落として、気付けるようにする。
	 * 組み立てが必要になったら、このテストを直すときに走査側も一緒に直る。
	 */
	for (const file of tsxFiles) {
		const relative = file.slice(APP_DIR.length + 1);
		const source = stripBlockComments(readFileSync(file, "utf8"));
		it(`${relative} は className を組み立てずに書いている`, () => {
			const composed = [...source.matchAll(/className=\{([^}]*)\}/g)]
				.map((m) => m[1])
				.filter((expression) => /[`]/.test(expression));
			expect(
				composed,
				"className がテンプレートリテラルで組み立てられており、" +
					"クラス名が突き合わせから外れる",
			).toEqual([]);
		});
	}
});

describe("手で見る手順が残っている", () => {
	/*
	 * 自動化しないと決めたもの（視覚回帰・実際のレイアウト計算）の穴を
	 * 人が塞ぐための手順。「自動化しないと決めた」だけで手順が無いと、
	 * 誰も見ない状態と区別が付かない。
	 *
	 * 中身が正しいかは機械では見られないので、**確認軸が消えていないこと**
	 * だけを見る。Issue #96 が挙げた軸（幅 360px / 日本語・英語 /
	 * キーボードのみ）と、#93 で実際に壊れていた 4 箇所を残す。
	 */
	const checklistPath = join(DOCS_DIR, "visual-check.md");

	it("視覚確認の手順書がある", () => {
		expect(() => statSync(checklistPath)).not.toThrow();
	});

	for (const axis of [
		"360px",
		"日本語",
		"English",
		"キーボード",
		"リンク",
		"ヘッダ",
		"コメント",
		"横スクロール",
	]) {
		it(`手順書に「${axis}」の確認軸が残っている`, () => {
			const doc = readFileSync(checklistPath, "utf8");
			expect(doc).toContain(axis);
		});
	}
});

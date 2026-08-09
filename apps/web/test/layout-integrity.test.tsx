/**
 * 画面の破綻を止めるスタイル（Issue #93）のテスト。
 *
 * #86 でトークンを定義したが、当てる先が無かった要素が残っていた。
 * トークンは正しいのに実機（Android / Chrome）で画面が崩れる:
 *
 * 1. `a` のスタイルが 1 つも無く、リンクがブラウザ既定の紫のまま
 * 2. `.site-header-nav` / `.locale-switcher` に `flex-wrap` が無く、
 *    狭い画面で各項目が単語の途中で折り返して縦に潰れる
 * 3. コメント欄の textarea に幅の指定が当たらず、既定の `cols` 幅で出る
 *    （入力要素のスタイルが `.issue-form` の子孫にしか無いため）
 * 4. `@media` が 1 つも無く、`body` の `padding: 2rem` が狭い画面を食う
 *
 * このテストが見るのは CSS の宣言と、部品が実際に出しているクラスの
 * 対応。描画結果のピクセルは見ていない（見た目の検証の仕組みは #96）。
 * ただし「クラスを書いたが CSS が無い」「CSS を書いたがクラスが付いて
 * いない」のどちらでも落ちるように、両側から挟んでいる。
 */

// `LocaleSwitcher` は `useSearchParams()` を呼ぶ。ルーターコンテキストの
// 無いこのテストでは null が返って描画そのものが落ちるため、テスト対象より
// 先に評価させる（`my-issues-page.test.tsx` と同じ形。名前付き import だけに
// すると Biome が並べ替えて評価順が崩れるので、副作用 import を別に置く）
import "./helpers/mock-navigation";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleSwitcher } from "../src/app/components/LocaleSwitcher";
import { clearTestLocation, setTestLocation } from "./helpers/mock-navigation";

afterEach(() => {
	clearTestLocation();
});

const GLOBALS_CSS = join(import.meta.dir, "../src/app/globals.css");
const css = readFileSync(GLOBALS_CSS, "utf8");

/** ブロックコメントを外す。コメント中の記述を宣言と取り違えないため */
function stripBlockComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

const cssWithoutComments = stripBlockComments(css);

/**
 * セレクタに対応する宣言ブロックを集める。
 *
 * 同じセレクタが複数回現れる（`@media` の中と外など）ので配列で返す。
 * セレクタは「そのセレクタ単体、またはカンマで並ぶ列の一員」として照合する。
 */
function rulesFor(selector: string): string[] {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// 先頭のアンカーに `{` を含めること。含めないと `@media (...) {` の
	// 直後に来る最初のルールを取りこぼす。素の要素セレクタを禁じるテストが
	// `@media` の中だけすり抜ける穴になっていた（レビューで指摘）
	const pattern = new RegExp(
		`(?:^|[{},])\\s*((?:[^{}]*?,\\s*)?${escaped}\\s*(?:,[^{}]*?)?)\\{([^}]*)\\}`,
		"g",
	);
	const found: string[] = [];
	for (const match of cssWithoutComments.matchAll(pattern)) {
		// セレクタ列に完全一致で含まれるものだけ拾う。`a` が `.a-b` に
		// 一致したり、`.locale-switcher` が `.locale-switcher-label` に
		// 一致したりするのを防ぐ
		const selectors = match[1].split(",").map((part) => part.trim());
		if (selectors.includes(selector)) {
			found.push(match[2]);
		}
	}
	return found;
}

/**
 * 狭い画面向けの `@media` の中身を取り出す。
 *
 * `@media` はネストした波括弧を持つので `[^}]*` では取れない。
 * 開き括弧から数えて対応する閉じ括弧までを手で拾う。
 *
 * `max-width` の `@media` が**複数ある前提**で、すべての中身を繋いで返す。
 * 以前は最初の 1 つだけを見ていたが、#95 で 2 つ目
 * （`.detail-list` を 1 列に落とすもの）が先に現れた途端、
 * 「body の余白を詰めているか」を見ていたテストがそちらを見て落ちた。
 * どの `@media` に書くかは実装の都合で、テストが縛るべきことではない。
 */
function narrowScreenBlocks(): string {
	const found: string[] = [];
	for (const opening of cssWithoutComments.matchAll(
		/@media[^{]*max-width[^{]*\{/g,
	)) {
		if (opening.index === undefined) {
			continue;
		}
		let depth = 0;
		const start = opening.index + opening[0].length;
		for (let i = start - 1; i < cssWithoutComments.length; i++) {
			const char = cssWithoutComments[i];
			if (char === "{") {
				depth++;
			} else if (char === "}") {
				depth--;
				if (depth === 0) {
					found.push(cssWithoutComments.slice(start, i));
					break;
				}
			}
		}
	}
	return found.join("\n");
}

/** 宣言ブロック群のどれかが指定のプロパティを持つか */
function declares(blocks: string[], property: string): boolean {
	return blocks.some((block) =>
		new RegExp(`(?:^|;)\\s*${property}\\s*:`).test(block),
	);
}

describe("リンクに色と状態が当たっている", () => {
	/*
	 * トップページはリンクが主要な導線なので、既定の紫のままだと
	 * 画面のほぼ全体が紫と青紫（訪問済み）で埋まる。
	 * 緑（--accent）を主役に据えたトークンと噛み合っていない
	 */
	it("a の色を --accent 系のトークンで決めている", () => {
		const blocks = rulesFor("a");
		expect(blocks.length, "a のルールが 1 つも無い").toBeGreaterThan(0);
		const colored = blocks.filter((block) => /(?:^|;)\s*color\s*:/.test(block));
		expect(colored.length, "a に color の指定が無い").toBeGreaterThan(0);
		expect(colored.join("\n")).toContain("var(--accent)");
	});

	/*
	 * `a:visited` を指定しないと、訪問済みだけがブラウザ既定の青紫で残る。
	 * 一覧から Issue を何件か開いた時点で、色が 2 種類に割れる
	 */
	it("訪問済みリンクが既定の紫にならない", () => {
		const blocks = rulesFor("a:visited");
		expect(blocks.length, "a:visited のルールが無い").toBeGreaterThan(0);
		expect(declares(blocks, "color"), "a:visited に色の指定が無い").toBe(true);
		// 値まで見ること。プロパティの有無だけだと `color: purple` でも通る
		// （受け入れ条件を直撃する変異が検出できていなかった）
		expect(blocks.join("\n"), "訪問済みの色がトークンを指していない").toContain(
			"var(--accent)",
		);
	});

	it("a:hover に見た目の変化がある", () => {
		expect(
			rulesFor("a:hover").length,
			"a:hover のルールが無い",
		).toBeGreaterThan(0);
	});

	/*
	 * キーボード操作でどこにいるか分からなくなるのを防ぐ。
	 * `.issue-form` の入力欄とボタンには既に outline があるが、
	 * リンクには無く、Tab で辿ると現在位置が消える
	 */
	it("a:focus-visible に outline がある", () => {
		const blocks = rulesFor("a:focus-visible");
		expect(blocks.length, "a:focus-visible のルールが無い").toBeGreaterThan(0);
		expect(declares(blocks, "outline")).toBe(true);
	});
});

describe("ヘッダが狭い画面で潰れない", () => {
	/*
	 * `flex-wrap` が無いと、flex アイテムは縮められる分だけ縮められる。
	 * 逃げ場が無いので「World Issue Tracker」が 3 行、「Issue を起票」が
	 * 3 行に割れて、ヘッダだけで画面の 1/4 を占める
	 */
	for (const selector of [".site-header", ".site-header-nav"]) {
		it(`${selector} は折り返しを許す`, () => {
			const blocks = rulesFor(selector);
			expect(blocks.length, `${selector} の定義が無い`).toBeGreaterThan(0);
			expect(blocks.join("\n")).toContain("flex-wrap: wrap");
		});
	}

	/*
	 * 折り返しを許しただけでは足りない。項目そのものが縮められると
	 * 単語の途中で改行される。項目の側にも縮まない指定が要る
	 */
	it("ヘッダの項目が単語の途中で折り返さない", () => {
		const blocks = [
			...rulesFor(".site-header-title"),
			...rulesFor(".site-header-nav > *"),
			...rulesFor(".site-header-nav"),
		];
		expect(blocks.join("\n")).toContain("white-space: nowrap");
	});

	/*
	 * `.locale-switcher`（#82）も `.site-header-nav` と同じ作りで、
	 * 「言語: 日本語 / English」が同様に潰れる
	 */
	it(".locale-switcher も折り返しを許し、言語名が割れない", () => {
		const blocks = rulesFor(".locale-switcher");
		expect(blocks.length, ".locale-switcher の定義が無い").toBeGreaterThan(0);
		expect(blocks.join("\n")).toContain("flex-wrap: wrap");
		expect(
			[...blocks, ...rulesFor(".locale-switcher > *")].join("\n"),
		).toContain("white-space: nowrap");
	});

	/*
	 * CSS 側だけ直しても、部品が別のクラスを出していれば当たらない。
	 * LocaleSwitcher が実際に `.locale-switcher` を出していることを見る
	 */
	it("LocaleSwitcher は locale-switcher のクラスを出す", () => {
		setTestLocation("/issues", "scope=community");
		const html = renderToStaticMarkup(<LocaleSwitcher locale="ja" />);
		const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) =>
			m[1].split(/\s+/),
		);
		expect(classes).toContain("locale-switcher");
	});

	/*
	 * `mock.module` はモジュール全体を差し替えるため、モックに書かなかった
	 * export が消える。`next/navigation` は詳細ページの `notFound` と
	 * Clerk が使う `redirect` も出しており、それらが消えると
	 * `Export named 'notFound' not found in module` で落ちる。
	 * `next/headers` のモックが同じ形で CI を落としたことがあるので、
	 * モックを読み込んだ状態で実物の export が残っているかを直接確かめる
	 */
	it("next/navigation のモックが他の export を消していない", async () => {
		const navigation = await import("next/navigation");
		for (const name of ["notFound", "redirect", "useRouter", "useParams"]) {
			expect(name in navigation, `${name} がモックで消えている`).toBe(true);
		}
	});
});

describe("コメント欄の入力欄が本文の幅いっぱいに広がる", () => {
	/*
	 * 入力要素のスタイルは `.issue-form` の子孫にしか当たっていない。
	 * コメント投稿フォームは `.issue-form` を持たないため、`width` が
	 * まったく効かず、textarea が既定の `cols` 幅（約 3 行分）で出る。
	 * 2000 文字書ける入力欄がこの幅なのは、実質書けないのと同じ。
	 *
	 * 素の要素セレクタ（`textarea { ... }`）にすると Clerk のモーダル内の
	 * 入力にも当たるため、その方針は壊さずクラスを与えて解く（Issue の補足）
	 */
	it("コメント欄のフォームが幅を決めるクラスを持つ", () => {
		const source = readFileSync(
			join(import.meta.dir, "../src/app/components/CommentSection.tsx"),
			"utf8",
		);
		const formTag = source.match(/<form[^>]*>/);
		expect(formTag, "form が見つからない").not.toBeNull();
		expect(
			formTag?.[0],
			"コメント投稿フォームにフォーム共通のクラスが無い",
		).toContain('className="issue-form"');
	});

	it("フォーム内の textarea に幅 100% が当たる", () => {
		const blocks = rulesFor(".issue-form textarea");
		expect(blocks.length, ".issue-form textarea の定義が無い").toBeGreaterThan(
			0,
		);
		expect(blocks.join("\n")).toContain("width: 100%");
	});

	/*
	 * 入力要素のスタイルを `.issue-form` 配下に閉じる方針（#86）を
	 * 壊していないこと。素の要素セレクタが増えると Clerk のモーダルに
	 * 当たって、この Issue とは別の崩れを作る
	 */
	for (const element of ["input", "textarea", "select"]) {
		it(`${element} を素の要素セレクタで指定していない`, () => {
			expect(rulesFor(element)).toEqual([]);
		});
	}
});

describe("狭い画面で横スクロールが出ない", () => {
	/*
	 * `body` は `max-width: 800px; padding: 2rem` の固定で、
	 * 幅 360px の画面では左右 2rem がそのまま食われる
	 */
	it("狭い画面向けに body の余白を詰める @media がある", () => {
		const queries = [...cssWithoutComments.matchAll(/@media([^{]*)\{/g)].map(
			(m) => m[1].trim(),
		);
		expect(queries.length, "@media が 1 つも無い").toBeGreaterThan(0);
		expect(
			queries.some((query) => /max-width/.test(query)),
			"狭い画面向けの @media が無い",
		).toBe(true);
	});

	/*
	 * `@media` があるだけでは足りない。中身が空でも、body に触れて
	 * いなくても上のテストは通る。実際に余白が詰まるところまで見る。
	 *
	 * 幅 360px の画面で `padding: 2rem` は左右で 64px を食う。
	 * 分岐後の値がそれ以上なら詰めた意味が無いので、上限も見る
	 */
	it("狭い画面では body の余白が 2rem より小さくなる", () => {
		const narrow = narrowScreenBlocks();
		expect(narrow, "max-width の @media の中身が取れない").not.toBe("");

		const bodyRule = narrow.match(/(?:^|})\s*body\s*\{([^}]*)\}/);
		expect(bodyRule, "@media の中で body の余白を詰めていない").not.toBeNull();

		const padding = bodyRule?.[1].match(/padding\s*:\s*([^;]+);/)?.[1].trim();
		expect(padding, "@media の中の body に padding が無い").toBeTruthy();
		// トークン（--space-1 〜 --space-6 は最大 1.5rem）を使っていれば
		// 既定の 2rem より必ず小さい。直書きの rem は #86 の方針に反する
		expect(padding, "余白がトークンで指定されていない").toMatch(
			/var\(--space-[1-6]\)/,
		);
	});

	/*
	 * 幅の広い要素（地図・画像・入力欄）が親からはみ出すと、
	 * ページ全体に横スクロールが出る。はみ出しうる要素には
	 * max-width の逃げ場が要る
	 */
	for (const selector of [
		".issue-map-view",
		".photo-preview",
		".issue-photo",
	]) {
		it(`${selector} は親の幅を超えない`, () => {
			expect(rulesFor(selector).join("\n")).toContain("max-width: 100%");
		});
	}

	/*
	 * 幅を制限しても、折り返せない文字列は要素を押し広げる。
	 * コメントと Issue の説明文は自由入力（コメントは 2000 文字）なので、
	 * スペースを含まない長い URL が貼られることは普通に起きる。
	 * `white-space: pre-wrap` を持つ本文（.issue-description / .comment-body）は
	 * 改行では折り返すが、単語の途中では折り返さない。
	 *
	 * 実機で試すと、URL を 1 本貼っただけでページ全体に横スクロールが出る。
	 * max-width では防げない経路（レビューで指摘）
	 */
	it("折り返せない長い文字列が要素を押し広げない", () => {
		const bodyRules = rulesFor("body");
		expect(bodyRules.length, "body の定義が無い").toBeGreaterThan(0);
		expect(
			bodyRules.join("\n"),
			"長い URL の折り返し指定が無い（横スクロールが出る）",
		).toMatch(/overflow-wrap\s*:\s*(anywhere|break-word)/);
	});

	/*
	 * 起票フォームの `.field-narrow` は 12rem 固定だが max-width で
	 * 逃げている。同じ配慮が入力欄の共通指定にも要る
	 */
	it(".issue-form の入力欄が親の幅を超えない", () => {
		const blocks = rulesFor(".issue-form input[type='text']");
		const alt = rulesFor('.issue-form input[type="text"]');
		expect([...blocks, ...alt].join("\n")).toContain("width: 100%");
	});
});

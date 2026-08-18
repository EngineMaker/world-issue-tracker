/**
 * 起票フォーム（`apps/web/src/app/issues/new/page.tsx`）の入力補助のテスト。
 *
 * web にはテストランナーが無く、このページは React のクライアント
 * コンポーネントなので描画しての検証ができない。
 * `web-onboarding.test.ts` と同じく、JSX のソースを文字列として読み、
 * 「入力の手がかりが画面に出ているか」を構文の形で確認する。
 *
 * ここで見たいのは「何を書けばいいか分かるか」という、型チェックでも
 * 既存のユニットテストでも検出できない欠落（Issue #48）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CreateIssueFields,
	ISSUE_SCOPE_LABELS,
	IssueScope,
	Locale,
	UI_MESSAGES,
} from "@world-issue-tracker/shared";
import { describe, expect, it } from "vitest";
import { ISSUE_CATEGORY_SUGGESTIONS } from "../../../web/src/lib/api";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const readRepoFile = (relativePath: string) =>
	readFileSync(join(repoRoot, relativePath), "utf8");

/**
 * フォームの本体は `NewIssueForm`（Client Component）にある。
 *
 * Issue #82 で `issues/new/page.tsx` から切り出した。表示言語を Cookie から
 * 読むのは Server Component 側の役目で、ページはそれを props で渡すだけの
 * 薄いラッパになっている。入力補助の構造はすべて切り出した先にある。
 */
const formPage = readRepoFile("apps/web/src/app/components/NewIssueForm.tsx");

/**
 * コメントを落とした本文。
 * 「コメントに例を書いただけ」で通ってしまうのを防ぐ
 */
const formPageBody = formPage
	.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.replace(/^\s*\/\/.*$/gm, "");

/** 属性の出現回数。0 だと「一つも無い」ことが分かる */
const countAttribute = (attribute: string) =>
	formPageBody.split(attribute).length - 1;

/**
 * CSS からセレクタの宣言ブロックの中身を取り出し、空白を潰して返す。
 *
 * クラス名の有無だけを見ると、中身が空でも、二つのクラスが同じ見た目でも
 * 通ってしまう。宣言そのものを比べられるようにする。
 * 見つからなければ null。
 */
function declarationsOf(css: string, selector: string): string | null {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
	return match?.[1]?.replace(/\s+/g, " ").trim() ?? null;
}

describe("起票フォームの入力補助", () => {
	it("入力例（placeholder）が主要な項目に入っている", () => {
		// タイトル・説明・カテゴリ・緯度経度の 5 項目
		expect(countAttribute("placeholder=")).toBeGreaterThanOrEqual(5);
	});

	it("placeholder の中身が空でなく、例として読める長さがある", () => {
		// 属性の数だけ数えると `placeholder=""` を並べても通ってしまう。
		// 「緯度経度を直接入力できない」への答えが例そのものなので中身を見る。
		//
		// 文言は `UI_MESSAGES` に外部化した（Issue #82）ので、値は辞書から引く。
		// 全ロケールを見ているのは、翻訳したときに例が空や記号だけになるのを
		// 防ぐため
		for (const locale of Locale.options) {
			const newIssue = UI_MESSAGES[locale].newIssue;
			const values = [
				newIssue.titlePlaceholder,
				newIssue.descriptionPlaceholder,
				newIssue.categoryPlaceholder,
				newIssue.latitudePlaceholder,
				newIssue.longitudePlaceholder,
			];

			expect(values.length).toBeGreaterThanOrEqual(5);
			for (const value of values) {
				expect(value, `${locale} に空の placeholder がある`).not.toBe("");
				expect(
					value.length,
					`${locale} の placeholder「${value}」が短すぎる`,
				).toBeGreaterThan(3);
			}
		}

		// 辞書に値があっても、フォームがそれを描いていなければ画面には出ない
		expect(countAttribute("placeholder=")).toBeGreaterThanOrEqual(5);
	});

	it("緯度・経度に数値の入力例が入っている", () => {
		// Issue が名指しした「一般の利用者が数値を直接入力できない」への答え。
		// 小数を含む座標の例が出ていること
		for (const locale of Locale.options) {
			const newIssue = UI_MESSAGES[locale].newIssue;
			expect(
				newIssue.latitudePlaceholder,
				`${locale} の緯度の入力例が数値でない`,
			).toMatch(/\d+\.\d+/);
			expect(
				newIssue.longitudePlaceholder,
				`${locale} の経度の入力例が数値でない`,
			).toMatch(/\d+\.\d+/);
		}
	});

	it("入力中も読める補助テキストを aria-describedby で結んでいる", () => {
		// placeholder は入力を始めると消えるため、書いている最中に参照できない。
		// 補助テキストを別要素に置き、支援技術からも辿れるようにする
		const describedBy = [
			...formPageBody.matchAll(/aria-describedby="([^"]+)"/g),
		].flatMap((match) => match[1]?.split(/\s+/) ?? []);

		expect(describedBy.length).toBeGreaterThanOrEqual(5);

		// 結び先の要素が実在しないと、読み上げでも視覚でも何も出ない。
		// id は直書きか、`FormField` が `${id}-hint` として生成するかのどちらか。
		// 後者は、対応するフィールドに hint が渡されていることで実在を確かめる
		// 中身が空の hint（`hint=""`）は、渡されていても描画されない可能性があり、
		// aria-describedby だけが残って存在しない id を指す。中身まで見る
		const hintFields = new Set(
			[...formPageBody.matchAll(/<FormField\b([\s\S]*?)>/g)].flatMap(
				(match) => {
					const attributes = match[1] ?? "";
					const fieldId = attributes.match(/\bid="([^"]+)"/)?.[1];
					if (!fieldId) return [];
					// 文字列リテラルと JSX 式（テンプレートリテラル）の両方を受ける
					const literal = attributes.match(/\bhint="([^"]*)"/)?.[1];
					const expression = /\bhint=\{[^}]/.test(attributes);
					if (literal !== undefined) {
						expect(literal, `${fieldId} の hint が空文字`).not.toBe("");
						return [fieldId];
					}
					return expression ? [fieldId] : [];
				},
			),
		);
		expect(
			hintFields.size,
			"hint を渡している FormField が無い",
		).toBeGreaterThanOrEqual(5);

		// `FormField` が hint を受け取っても描画しなければ、
		// aria-describedby の参照先が存在しない状態になる。
		// 渡されているだけで通らないよう、生成側の描画も確かめる
		const formFieldComponent = formPageBody.slice(
			formPageBody.indexOf("function FormField"),
		);
		expect(formFieldComponent, "FormField の定義が見つからない").not.toBe("");
		expect(
			formFieldComponent,
			"FormField が hint を描画していない（渡されているだけ）",
		).toMatch(/id=\{`\$\{id\}-hint`\}/);
		expect(formFieldComponent).toMatch(/\{hint\}/);
		// hint を任意にすると、省略した呼び出し側で参照先が消える。
		// 型で必須にしておくことを構文で固定する
		expect(
			formFieldComponent,
			"FormField の hint が任意（`hint?: string`）になっている",
		).not.toMatch(/hint\?\s*:/);

		for (const id of describedBy) {
			const generated = id.endsWith("-hint")
				? hintFields.has(id.slice(0, -"-hint".length))
				: false;
			expect(
				generated || formPageBody.includes(`id="${id}"`),
				`id="${id}" の補助テキストが存在しない`,
			).toBe(true);
		}
	});

	it("タイトルに粒度の分かる具体例を示している", () => {
		// 「街灯が消えている」で止まらず、どこの・どれくらい続いているかまで
		// 書いた例を出す。トップページの説明（街灯）と地続きにする
		for (const locale of Locale.options) {
			expect(
				UI_MESSAGES[locale].newIssue.titlePlaceholder,
				`${locale} のタイトルの例がトップページの説明と繋がっていない`,
			).toMatch(/街灯|streetlight/i);
		}
	});

	it("説明欄に何を書けば解決に繋がるかの観点を示している", () => {
		// 「いつから / どこで / 誰が困っているか」の 3 観点。
		// 英語では語順も語彙も変わるので、観点ごとに両ロケールの表現を並べる
		const perspectives: { ja: RegExp; en: RegExp; name: string }[] = [
			{ name: "いつから", ja: /いつから/, en: /since when/i },
			{ name: "どこで", ja: /どこで/, en: /where/i },
			{ name: "誰が", ja: /誰が/, en: /who/i },
		];

		for (const locale of Locale.options) {
			const hint = UI_MESSAGES[locale].newIssue.descriptionHint;
			for (const perspective of perspectives) {
				expect(
					hint,
					`${locale} に説明の観点「${perspective.name}」が無い`,
				).toMatch(perspective[locale]);
			}
		}
	});
});

describe("起票フォームのカテゴリ候補", () => {
	it("候補を datalist で提示している", () => {
		expect(formPageBody).toContain("<datalist");
		// input と datalist が list 属性で結ばれていないと候補が出ない
		const listId = formPageBody.match(/list="([^"]+)"/)?.[1];
		expect(listId, "input に list 属性が無い").toBeTruthy();
		expect(formPageBody).toContain(`<datalist id="${listId}"`);
	});

	it("候補を定数から描画している（画面側で重複定義しない）", () => {
		// 候補を page.tsx に直書きすると、後から enum 化するときや
		// 集計するときに語彙がずれる。定数に一本化する。
		// import しているだけでは候補は出ないので、datalist の中で
		// 実際に展開していることまで見る
		expect(formPageBody).toContain("ISSUE_CATEGORY_SUGGESTIONS");

		const datalist = formPageBody.match(/<datalist[\s\S]*?<\/datalist>/)?.[0];
		expect(datalist, "<datalist> が見つからない").toBeTruthy();
		expect(
			datalist,
			"datalist が候補を定数から展開していない（空の候補リストになる）",
		).toMatch(/(ISSUE_CATEGORY_SUGGESTIONS|CATEGORY_SUGGESTIONS)\s*\.map\(/);
		expect(datalist).toMatch(/<option\b/);
	});

	it("候補が実際に 1 件以上ある", () => {
		// 定数が空配列だと datalist は空になり、候補提示という目的が消える
		expect(ISSUE_CATEGORY_SUGGESTIONS.length).toBeGreaterThanOrEqual(5);
	});

	it("候補に無いものも投稿できる（自由入力を残す）", () => {
		// datalist は入力を候補に制限しない。select に置き換えると
		// 候補外の困りごとが起票できなくなるため、input のままであること
		expect(formPageBody).toMatch(/id="category"[\s\S]{0,400}?list=/);
		expect(formPageBody).not.toMatch(/<select[^>]*id="category"/);
	});
});

describe("起票フォームの位置情報の説明", () => {
	it("現在地ボタンを押すと何が起きるかを事前に説明している", () => {
		for (const locale of Locale.options) {
			const hint = UI_MESSAGES[locale].newIssue.locationHint;
			expect(hint, `${locale} に許可を求める旨の説明が無い`).toMatch(
				/許可|確認を求め|permission/i,
			);
			expect(hint, `${locale} に位置情報という語が無い`).toMatch(
				/位置情報|location/i,
			);
		}
	});

	it("取得中の状態を表示する", () => {
		// 押しても何も起きないように見える時間があると、連打されるか諦められる
		for (const locale of Locale.options) {
			expect(
				UI_MESSAGES[locale].newIssue.locating,
				`${locale} に取得中の表示が無い`,
			).toMatch(/取得中|Locating/i);
		}
		// 辞書にあっても、押した後にその文言へ切り替わらなければ意味が無い
		expect(formPageBody).toContain("newIssue.locating");
	});

	it("取得に失敗したことを画面に出す", () => {
		// 位置情報を拒否した利用者が、何も起きないまま放置されないようにする。
		// 状態を持つだけでなく、その状態を描画する分岐があること
		expect(formPageBody, "失敗状態を持っていない").toMatch(
			/geolocation === "failed"|"failed"/,
		);
		const failureBranch = formPageBody.match(
			/geolocation === "failed"[\s\S]{0,400}?\)\}/,
		)?.[0];
		expect(
			failureBranch,
			"失敗状態を描画する分岐が無い（拒否しても何も表示されない）",
		).toBeTruthy();
		// 文言そのものは辞書にあるので、分岐がその文言を描いていることを見る
		expect(failureBranch).toContain("newIssue.geolocationFailed");

		for (const locale of Locale.options) {
			const message = UI_MESSAGES[locale].newIssue.geolocationFailed;
			expect(message, `${locale} に失敗した旨が無い`).toMatch(
				/取得できませんでした|失敗|Could not get/i,
			);
			// 失敗したら手入力に切り替えられることを伝える
			expect(message, `${locale} に手入力への案内が無い`).toMatch(
				/直接入力|手入力|enter the coordinates directly/i,
			);
		}
	});

	it("現地にいないときの手段を案内している", () => {
		// 地図 UI が無いので、緯度経度を自分で調べる手段を示す必要がある
		for (const locale of Locale.options) {
			expect(
				UI_MESSAGES[locale].newIssue.locationHint,
				`${locale} に現地にいないときの手段が無い`,
			).toMatch(/地図|現地にいない|map service|not on site/i);
		}
	});
});

describe("起票フォームのスコープ説明", () => {
	it("選んだスコープが何を指すかをフォーム上に出している", () => {
		// トップページには説明があるのに、選ぶ場所には無いという分断を埋める。
		// 文言は shared のラベル辞書を使い、トップページとずらさない。
		// 説明を画面に出さず変数に入れただけ、では通らないよう JSX 側で見る
		expect(formPageBody).toMatch(/ISSUE_SCOPE_LABELS|SCOPE_LABELS/);
		expect(formPageBody, "スコープの説明が JSX に埋め込まれていない").toMatch(
			/\{[^{}]*\.description[^{}]*\}|\$\{[^}]*\.description[^}]*\}/,
		);
		// select の補助テキストとして結ばれていること
		expect(formPageBody).toMatch(/id="scope"[\s\S]{0,300}?aria-describedby=/);
	});
});

describe("起票フォームのスタイル", () => {
	const globalCss = readRepoFile("apps/web/src/app/globals.css");

	it("page.tsx が使うクラスが globals.css に定義され、中身が空でない", () => {
		const used = [...formPage.matchAll(/className="([^"]+)"/g)].flatMap(
			(match) => match[1]?.split(/\s+/) ?? [],
		);
		expect(used.length).toBeGreaterThan(0);
		for (const className of used) {
			expect(globalCss, `.${className} が globals.css に無い`).toContain(
				`.${className}`,
			);

			// 単独ブロック（`.foo { ... }`）を持つクラスは、中身が空だと
			// 付けた意味が無いので宣言まで見る。
			// `.issue-form` のようにスコープ用の前置きとしてしか使わないクラスは
			// 単独ブロックを持たないため、その場合は子孫セレクタでの使用を確かめる
			const declarations = declarationsOf(globalCss, `.${className}`);
			if (declarations === null) {
				expect(
					globalCss,
					`.${className} が子孫セレクタでも使われていない`,
				).toMatch(new RegExp(`\\.${className}\\s+\\S`));
			} else {
				expect(declarations, `.${className} の宣言が空`).not.toBe("");
			}
		}
	});

	it("入力要素にスタイルが当たっている（ブラウザ既定のままにしない）", () => {
		for (const selector of ["input", "textarea", "select"]) {
			expect(
				globalCss,
				`${selector} のスタイル指定が globals.css に無い`,
			).toMatch(new RegExp(`\\.issue-form ${selector}[\\s,{:\\[]`));
		}
		// ボタンはクラスで指定する（下の「主要操作と補助操作」で中身も見る）
		expect(globalCss).toMatch(/\.button-primary\s*[,{]/);
	});

	// globals.css は全ページに効く。素の要素セレクタを足すと、この Issue と
	// 無関係な Header のサインインボタンや、同じ document に描画される
	// Clerk のモーダルにまで影響が及ぶ
	it("フォーム要素のスタイルが他ページに漏れない", () => {
		// コメントを除いた本文で見る（コメント中の例示に反応しないため）
		const cssBody = globalCss.replace(/\/\*[\s\S]*?\*\//g, "");
		for (const selector of ["input", "textarea", "select", "button"]) {
			// 行頭が要素名で始まるセレクタ（`input {`, `button,` など）を禁じる。
			// `.issue-form input` のように前置きがあるものは許す
			expect(
				cssBody,
				`要素セレクタ \`${selector}\` が全ページに効いてしまう`,
			).not.toMatch(new RegExp(`^${selector}\\s*[,{]`, "m"));
		}
	});

	it("緯度経度の入力欄が説明欄と同じ幅にならない", () => {
		// 「緯度と説明文が同じ重みに見える」への対応。
		// クラスがあるだけでなく、実際に幅が絞られていること
		const narrow = declarationsOf(globalCss, ".field-narrow");
		expect(narrow, ".field-narrow の定義が無い").toBeTruthy();
		expect(narrow).toMatch(/width\s*:/);
		// 説明欄（textarea）は逆に広く使う
		expect(globalCss).toMatch(
			/\.issue-form textarea[\s\S]{0,200}?width\s*:\s*100%/,
		);
	});

	it("主要操作と補助操作を見た目で区別している", () => {
		// 「起票する」と「現在地から入力」が同じ見た目だと優先度が伝わらない。
		// クラス名が両方あるだけでは、中身が同一でも通ってしまう
		const primary = declarationsOf(globalCss, ".button-primary");
		const secondary = declarationsOf(globalCss, ".button-secondary");
		expect(primary, ".button-primary の定義が無い").toBeTruthy();
		expect(secondary, ".button-secondary の定義が無い").toBeTruthy();
		expect(primary, "主要操作と補助操作のスタイルが同一").not.toBe(secondary);
		// 主要操作は背景色で押すべきものだと分かるようにする
		expect(primary).toMatch(/background\s*:/);
		expect(primary).not.toBe(secondary);
	});
});

describe("カテゴリ候補の定数", () => {
	it("候補が空でない", () => {
		expect(ISSUE_CATEGORY_SUGGESTIONS.length).toBeGreaterThan(0);
		for (const suggestion of ISSUE_CATEGORY_SUGGESTIONS) {
			expect(suggestion, "空の候補がある").not.toBe("");
		}
	});

	it("候補が重複していない", () => {
		// 同じ語が二つ並ぶと、どちらを選んでも同じという判断がしにくい
		expect(new Set(ISSUE_CATEGORY_SUGGESTIONS).size).toBe(
			ISSUE_CATEGORY_SUGGESTIONS.length,
		);
	});

	it("候補がスキーマの category 制約に収まっている", () => {
		// 候補をそのまま選ぶと API 側の検証で 400 になる、という事故を防ぐ。
		// 制約はここで書き直さず、スキーマそのものに通して確かめる。
		//
		// 項目単位のスキーマを引くので `CreateIssueSchema`（緯度経度が対に
		// なっているかの `superRefine` を掛けた形）ではなく、その素の
		// `ZodObject` である `CreateIssueFields` を見る。検証している制約は
		// どちらも同じもの（#124 で refine を足した際に分けた）。
		for (const suggestion of ISSUE_CATEGORY_SUGGESTIONS) {
			const parsed = CreateIssueFields.shape.category.safeParse(suggestion);
			expect(parsed.success, `候補「${suggestion}」がスキーマに通らない`).toBe(
				true,
			);
		}
	});

	it("スコープのラベルと説明が全スコープ分ある（フォームで参照するため）", () => {
		for (const scope of IssueScope.options) {
			expect(ISSUE_SCOPE_LABELS.ja[scope].description).not.toBe("");
		}
	});
});

/**
 * UI 文言の多言語対応（Issue #82）のテスト。
 *
 * 「日本語以外で表示する手段が無い」ことが問題だったので、
 * 検証の主題は「英語ロケールで描画したら英語が出るか」に置く。
 * ラベルが辞書に外部化されただけで、画面が日本語のままなら意味が無い。
 *
 * 型で翻訳漏れを検出する（`ja` にあって `en` に無いキーがコンパイルエラーになる）
 * ことは `bun run check` が担当するので、ここでは実行時に確かめられる
 * 「両ロケールのキー集合が一致していること」を見る。型が効いていれば
 * このテストは常に通るが、辞書の形を `Record<string, string>` などに
 * 緩めたときに気付ける。
 */

import { describe, expect, it } from "bun:test";
import {
	DEFAULT_LOCALE,
	getUiMessages,
	Locale,
	parseLocale,
	UI_MESSAGES,
} from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueCreated } from "../src/app/components/IssueCreated";
import { IssueFilterForm } from "../src/app/components/IssueFilterForm";
import { IssueList } from "../src/app/components/IssueList";
import { IssuePagination } from "../src/app/components/IssuePagination";
import { MyIssueList } from "../src/app/components/MyIssueList";
import {
	DEFAULT_ISSUE_FILTERS,
	type FetchIssuesResult,
} from "../src/lib/issues";
import { LOCALE_COOKIE_NAME } from "../src/lib/locale";

const sampleIssue = {
	id: "ebbcf9d7680ad57cedeeb513a90d461f",
	title: "駅前の街灯が切れている",
	description: "夜道が暗くて危ない",
	scope: "community",
	status: "open",
	latitude: 35.68,
	longitude: 139.76,
	category: "infrastructure",
	created_at: "2026-08-01 12:00:00.000",
	updated_at: "2026-08-01 12:00:00.000",
} as const;

describe("UI 文言の辞書", () => {
	it("ja と en の両方が揃っている", () => {
		for (const locale of Locale.options) {
			expect(UI_MESSAGES[locale]).toBeDefined();
		}
	});

	/**
	 * 型（`Record<Locale, UiMessages>`）で防いでいることの実行時の裏取り。
	 * ネストしたキーまで含めて突き合わせる。
	 */
	it("ja と en でキーの集合が完全に一致する", () => {
		const flatten = (value: unknown, prefix = ""): string[] => {
			if (typeof value !== "object" || value === null) return [prefix];
			return Object.entries(value).flatMap(([key, child]) =>
				flatten(child, prefix ? `${prefix}.${key}` : key),
			);
		};

		expect(flatten(UI_MESSAGES.en).sort()).toEqual(
			flatten(UI_MESSAGES.ja).sort(),
		);
	});

	it("空文字の文言を残していない（未翻訳の穴を作らない）", () => {
		const collect = (value: unknown): unknown[] =>
			typeof value === "object" && value !== null
				? Object.values(value).flatMap(collect)
				: [value];

		for (const locale of Locale.options) {
			for (const message of collect(UI_MESSAGES[locale])) {
				if (typeof message === "string") {
					expect(message.trim().length).toBeGreaterThan(0);
				}
			}
		}
	});

	it("en の文言に日本語が混ざっていない（翻訳し忘れの検出）", () => {
		const collect = (value: unknown): unknown[] =>
			typeof value === "object" && value !== null
				? Object.values(value).flatMap(collect)
				: [value];

		// 言語切り替えの選択肢だけは、どのロケールでもその言語自身の表記で出す。
		// 英語表示のときに切り替え先が "Japanese" だと、日本語しか読めない人が
		// 自分の言語を見つけられない。ここは翻訳漏れではなく意図した例外
		const localeNames = new Set(
			Object.values(UI_MESSAGES.en.localeSwitcher.names),
		);

		for (const message of collect(UI_MESSAGES.en)) {
			if (typeof message === "string" && !localeNames.has(message)) {
				// ひらがな・カタカナ・漢字のいずれも含まないこと。
				// 関数（複数形の組み立て等）は対象外なので文字列だけ見る
				expect(message).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
			}
		}
	});
});

describe("parseLocale", () => {
	it("既知のロケールをそのまま返す", () => {
		expect(parseLocale("en")).toBe("en");
		expect(parseLocale("ja")).toBe("ja");
	});

	it("未知の値・未指定は既定ロケールに倒す", () => {
		// Cookie は利用者が手で書き換えられる。壊れた値で画面が落ちないこと
		expect(parseLocale("fr")).toBe(DEFAULT_LOCALE);
		expect(parseLocale(undefined)).toBe(DEFAULT_LOCALE);
		expect(parseLocale("")).toBe(DEFAULT_LOCALE);
	});
});

/**
 * 画面が実際に英語で出るか。
 *
 * ここが Issue #82 の本題。辞書を作っただけでコンポーネントが日本語を
 * 直書きしたままなら、この describe が落ちる。
 */
describe("英語ロケールでの描画", () => {
	const en = getUiMessages("en");
	const ja = getUiMessages("ja");

	function renderList(result: FetchIssuesResult, locale: Locale) {
		return renderToStaticMarkup(IssueList({ result, locale }));
	}

	it("IssueList の 0 件表示が英語になる", () => {
		const html = renderList(
			{ ok: true, issues: [], total: 0, limit: 20, offset: 0 },
			"en",
		);

		expect(html).toContain(en.issueList.empty);
		expect(html).not.toContain(ja.issueList.empty);
		// 日本語が一切残っていないこと
		expect(html.replace(/<[^>]*>/g, "")).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
	});

	it("IssueList の取得失敗が英語になる", () => {
		const html = renderList({ ok: false, error: "boom" }, "en");

		expect(html).toContain(en.issueList.fetchFailed);
		expect(html).not.toContain(ja.issueList.fetchFailed);
	});

	it("IssueList の件数表示が英語になる", () => {
		const html = renderList(
			{ ok: true, issues: [sampleIssue], total: 42, limit: 100, offset: 0 },
			"en",
		);
		const visibleText = html.replace(/<[^>]*>/g, "");

		// Issue のタイトル・説明は利用者の投稿なので翻訳対象外（#66）。
		// それ以外の UI 文言に日本語が残っていないことを見る
		const withoutUserContent = visibleText
			.replace(sampleIssue.title, "")
			.replace(sampleIssue.description, "");
		expect(withoutUserContent).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
	});

	it("スコープ・ステータスのラベルも英語で出る", () => {
		const html = renderList(
			{ ok: true, issues: [sampleIssue], total: 1, limit: 20, offset: 0 },
			"en",
		);

		expect(html).toContain("Community");
		expect(html).toContain("Open");
		expect(html).not.toContain("コミュニティ");
	});

	it("MyIssueList の 3 状態がすべて英語になる", () => {
		const empty = renderToStaticMarkup(
			MyIssueList({ result: { ok: true, issues: [], total: 0 }, locale: "en" }),
		);
		expect(empty).toContain(en.myIssueList.empty);
		expect(empty.replace(/<[^>]*>/g, "")).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);

		const unauthorized = renderToStaticMarkup(
			MyIssueList({
				result: { ok: false, error: "unauthorized", unauthorized: true },
				locale: "en",
			}),
		);
		expect(unauthorized).toContain(en.myIssueList.signInRequired);
		expect(unauthorized.replace(/<[^>]*>/g, "")).not.toMatch(
			/[ぁ-んァ-ヶ一-龠]/,
		);

		const failed = renderToStaticMarkup(
			MyIssueList({
				result: { ok: false, error: "boom", unauthorized: false },
				locale: "en",
			}),
		);
		expect(failed).toContain(en.issueList.fetchFailed);
	});

	it("IssuePagination が英語になる", () => {
		const html = renderToStaticMarkup(
			IssuePagination({
				filters: DEFAULT_ISSUE_FILTERS,
				total: 45,
				limit: 20,
				offset: 20,
				locale: "en",
			}),
		);
		const visibleText = html.replace(/<[^>]*>/g, "");

		expect(html).toContain(en.pagination.previous);
		expect(html).toContain(en.pagination.next);
		expect(visibleText).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
	});

	it("IssueFilterForm が英語になる", () => {
		const html = renderToStaticMarkup(
			IssueFilterForm({ filters: DEFAULT_ISSUE_FILTERS, locale: "en" }),
		);
		const visibleText = html.replace(/<[^>]*>/g, "");

		expect(html).toContain(en.filterForm.legend);
		// カテゴリの候補（`ISSUE_CATEGORY_SUGGESTIONS`）は option の value 属性に
		// 入るため可視テキストには出ない。可視テキストだけを見る
		expect(visibleText).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
	});

	it("IssueCreated が英語になる", () => {
		const html = renderToStaticMarkup(
			IssueCreated({ id: "abc123", locale: "en" }),
		);

		expect(html.replace(/<[^>]*>/g, "")).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
		expect(html).toContain("abc123");
	});
});

/**
 * 日本語ロケールでの描画が今までどおりであること。
 *
 * 辞書へ移す作業で文言が入れ替わっていないかを見る。既定ロケールは `ja` なので、
 * `locale` を省略した呼び出しも日本語のままであること。
 */
describe("日本語ロケールでの描画", () => {
	const ja = getUiMessages("ja");

	it("locale を省略すると既定ロケール（ja）で出る", () => {
		const html = renderToStaticMarkup(
			IssueList({
				result: { ok: true, issues: [], total: 0, limit: 20, offset: 0 },
			}),
		);

		expect(html).toContain(ja.issueList.empty);
	});
});

describe("ロケールの保持", () => {
	it("Cookie 名が定数として公開されている（切り替えと読み出しで同じ名前を使う）", () => {
		expect(typeof LOCALE_COOKIE_NAME).toBe("string");
		expect(LOCALE_COOKIE_NAME.length).toBeGreaterThan(0);
	});
});

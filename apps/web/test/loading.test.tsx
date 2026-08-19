// 読み込み中フォールバックも表示言語を Cookie から読む（#82）ため、
// Server Component を直接呼ぶこのテストにはリクエストスコープが要る。
// テスト対象より先に評価させる（helpers/mock-cookies の注記を参照）
import "./helpers/mock-cookies";
import { afterEach, describe, expect, it } from "bun:test";
import { getUiMessages } from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { LOCALE_COOKIE_NAME } from "../src/lib/locale";
import { clearTestCookies, setTestCookies } from "./helpers/mock-cookies";

/**
 * 各ルートの `loading.tsx`（Suspense フォールバック）の検査（Issue #146）。
 *
 * App Router のクライアント遷移では、`loading.tsx` が無いと遷移先の RSC が
 * 届くまで画面が前のまま無反応になり、「押しても何も起きない」ように見える。
 * ボタン操作には `aria-busy` ＋「送信中…」で手応えを出しているのに、ページ
 * 遷移だけがこの原則から漏れていた。
 *
 * ここで見るのは「主要ルートに `loading.tsx` があり、押した瞬間に手応え
 * （見出し＋読み込み中の文言＋`aria-busy`）を返すか」。ファイルの有無を
 * `find` で見るだけでは、空の `loading.tsx` でも通ってしまうので、実際に
 * 描画して中身を確かめる。
 */

/** 問題の該当箇所として Issue が名指ししている 4 ルート。 */
const LOADING_ROUTES = [
	{
		label: "issues（一覧）",
		load: () => import("../src/app/issues/loading"),
		heading: (locale: "ja" | "en") => getUiMessages(locale).issuesPage.heading,
	},
	{
		label: "issues/[id]（詳細）",
		load: () => import("../src/app/issues/[id]/loading"),
		heading: (locale: "ja" | "en") =>
			getUiMessages(locale).issueDetail.loadingHeading,
	},
	{
		label: "map（地図）",
		load: () => import("../src/app/map/loading"),
		heading: (locale: "ja" | "en") => getUiMessages(locale).mapPage.heading,
	},
	{
		label: "my-issues（自分の Issue）",
		load: () => import("../src/app/my-issues/loading"),
		heading: (locale: "ja" | "en") =>
			getUiMessages(locale).myIssuesPage.heading,
	},
] as const;

/** 指定ロケールの Cookie を積んで loading.tsx を描画する。 */
async function renderLoading(
	route: (typeof LOADING_ROUTES)[number],
	locale: "ja" | "en",
): Promise<string> {
	setTestCookies({ [LOCALE_COOKIE_NAME]: locale });
	const { default: Loading } = await route.load();
	return renderToStaticMarkup(await Loading());
}

afterEach(() => {
	clearTestCookies();
});

describe("各ルートの loading.tsx（読み込み中フォールバック）", () => {
	for (const route of LOADING_ROUTES) {
		it(`${route.label}: 読み込み中の文言を出す`, async () => {
			const html = await renderLoading(route, "ja");
			expect(html).toContain(getUiMessages("ja").common.loading);
		});

		// 「押しても何も起きないように見える時間を作らない」ための手応え。
		// 支援技術にも処理中であることを伝える（送信中の各ボタンと揃える）
		it(`${route.label}: aria-busy で処理中であることを伝える`, async () => {
			const html = await renderLoading(route, "ja");
			expect(html).toContain('aria-busy="true"');
		});

		// 骨格（見出し）が保たれたまま中身だけがフォールバックへ切り替わる。
		// 遷移していることが分かるように、そのページの見出しを出す
		it(`${route.label}: そのページの見出しを出す`, async () => {
			const html = await renderLoading(route, "ja");
			expect(html).toContain(route.heading("ja"));
		});

		// 表示言語が英語なら、フォールバックも英語で出る（#82 の原則を
		// ページ遷移区間にも通す）
		it(`${route.label}: 英語ロケールでは英語で出る`, async () => {
			const html = await renderLoading(route, "en");
			expect(html).toContain(getUiMessages("en").common.loading);
			expect(html).toContain(route.heading("en"));
			// UI 文言に日本語が残っていないこと
			expect(html.replace(/<[^>]*>/g, "")).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
		});
	}
});

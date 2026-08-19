/**
 * 見つからないページ（404）の受け皿（Issue #145）のテスト。
 *
 * `not-found.tsx` が無いと、Next.js は英語・無装飾・戻り導線なしの既定 404 に
 * 落ちる。他の画面は ja/en を出し分け、行き止まりを作らないのに、404 だけが
 * 英語のまま導線も無い、という食い違いを解消したことを見る。
 *
 * 「既定 404 が出ないこと」自体はユニットテストでは直接掴めない（Next.js の
 * ルーティングの挙動なので）。代わりに、置いた `not-found.tsx` が
 * (1) ローカライズされた文言を出し、(2) 次に行ける導線を出すことを見る。
 * この 2 つが満たされていれば、既定 404 の「英語・導線なし」は解消している。
 */

// 表示言語を Cookie から読むため（Issue #82）、Server Component を直接呼ぶ
// このテストにはリクエストスコープが要る。テスト対象より先に評価させる
import "./helpers/mock-cookies";
import { describe, expect, it } from "bun:test";
import { getUiMessages } from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import NotFound from "../src/app/not-found";
import { LOCALE_COOKIE_NAME } from "../src/lib/locale";
import { clearTestCookies, setTestCookies } from "./helpers/mock-cookies";

async function renderNotFound() {
	// afterEach を持たないので、テストごとに Cookie を明示的に戻す。
	// 他のテストが残した英語を持ち越すと、既定ロケールの検証が崩れる
	return renderToStaticMarkup(await NotFound());
}

describe("見つからないページ（404）", () => {
	it("既定ロケール（ja）で見出しと説明を出す", async () => {
		clearTestCookies();
		const ja = getUiMessages("ja");
		const html = await renderNotFound();
		const text = html.replace(/<[^>]*>/g, "");

		expect(text).toContain(ja.notFound.heading);
		expect(text).toContain(ja.notFound.body);
		// 導線のラベルもローカライズされていること。href は下の it.each で、
		// 英語化は英語テストで見ているが、ja のリンク文言そのものは
		// どこも直接見ていなかった。3 つとも可視テキストとして出す
		expect(text).toContain(ja.notFound.browseIssues);
		expect(text).toContain(ja.notFound.writeIssue);
		expect(text).toContain(ja.notFound.backToHome);
	});

	// 読み終えたときに行き止まりにしない。一覧・起票・トップの 3 つへ逃がす。
	// href の文字列で見るのは、ラベルを変えてもリンク先が壊れていないこと自体を
	// 押さえるため（ラベルは下の英語テストで別に見る）
	it.each([
		["/issues"],
		["/issues/new"],
		["/"],
	])("%s への導線を出す", async (href) => {
		clearTestCookies();
		const html = await renderNotFound();

		expect(html).toContain(`href="${href}"`);
	});

	// Issue #145 の本題。既定 404 は英語固定だった。ここが英語ロケールで
	// 英語になり、日本語が残らないことを見る（他画面と同じ出し分け）
	it("英語ロケールなら英語で出て、日本語が残らない", async () => {
		setTestCookies({ [LOCALE_COOKIE_NAME]: "en" });
		try {
			const en = getUiMessages("en");
			const ja = getUiMessages("ja");
			const html = await renderNotFound();
			const text = html.replace(/<[^>]*>/g, "");

			expect(text).toContain(en.notFound.heading);
			expect(text).not.toContain(ja.notFound.heading);
			// UI 文言に日本語が一切残っていないこと
			expect(text).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
		} finally {
			clearTestCookies();
		}
	});
});

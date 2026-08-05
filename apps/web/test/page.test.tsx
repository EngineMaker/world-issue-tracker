import { describe, expect, it } from "bun:test";
import {
	DEFAULT_LOCALE,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
	IssueScope,
	IssueStatus,
} from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import {
	formatCreatedAt,
	IssueList,
	scopeLabels,
	statusLabels,
} from "../src/app/components/IssueList";
import Home from "../src/app/page";
import type { FetchIssuesResult } from "../src/lib/issues";

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

/** Server Component を呼び出して静的 HTML にする。 */
function render(result: FetchIssuesResult) {
	return renderToStaticMarkup(IssueList({ result }));
}

describe("IssueList", () => {
	it("Issue のタイトル・スコープ・ステータス・作成日時を表示する", () => {
		const html = render({
			ok: true,
			issues: [sampleIssue],
			total: 1,
		});

		expect(html).toContain("駅前の街灯が切れている");
		// スコープ・ステータスは日本語ラベルで出す（Issue #59）
		expect(html).toContain("コミュニティ");
		expect(html).toContain("受付");
		// `dateTime` 属性ではなく、画面に見えるテキストとして日時が出ていること。
		// 属性値だけを見ると、表示から日時が消えても気付けない
		const visibleText = html.replace(/<[^>]*>/g, "");
		expect(visibleText).toContain("2026-08-01 12:00 UTC");
	});

	it("スコープ・ステータスの enum の生の値を画面に出さない", () => {
		// Issue #59。`municipality` / `open` がそのまま見えていた。
		// 属性値には含まれ得るので、タグを剥がした可視テキストだけを見る
		for (const scope of IssueScope.options) {
			for (const status of IssueStatus.options) {
				const html = render({
					ok: true,
					issues: [{ ...sampleIssue, scope, status }],
					total: 1,
				});
				const visibleText = html.replace(/<[^>]*>/g, "");

				expect(visibleText).not.toContain(scope);
				expect(visibleText).not.toContain(status);
			}
		}
	});

	it("全スコープ・全ステータスを shared のラベルで、この順に表示する", () => {
		const expectedScopeLabels = ISSUE_SCOPE_LABELS[DEFAULT_LOCALE];
		const expectedStatusLabels = ISSUE_STATUS_LABELS[DEFAULT_LOCALE];

		for (const scope of IssueScope.options) {
			for (const status of IssueStatus.options) {
				const html = render({
					ok: true,
					issues: [{ ...sampleIssue, scope, status }],
					total: 1,
				});
				const visibleText = html.replace(/<[^>]*>/g, "");

				// 「含まれているか」だけを見ると、スコープとステータスを
				// 逆の位置に出す実装を見逃す（どちらのラベルも画面には出るため）。
				// 並び順まで固定する
				expect(visibleText).toContain(
					`${expectedScopeLabels[scope].label} / ${expectedStatusLabels[status]} /`,
				);
			}
		}
	});

	it("ラベルの対応表を shared から引いている（写していない）", () => {
		// ラベルを写した実装でも描画結果は同じになるため、描画では見分けられない。
		// 二重管理になると shared 側を直しても一覧だけ古いまま残る。
		// 中身の一致（toEqual）ではなく同一のオブジェクトであること（toBe）を見る
		expect(scopeLabels).toBe(ISSUE_SCOPE_LABELS[DEFAULT_LOCALE]);
		expect(statusLabels).toBe(ISSUE_STATUS_LABELS[DEFAULT_LOCALE]);
	});

	it("表示件数と総件数を取り違えずに出す", () => {
		const html = render({
			ok: true,
			issues: [sampleIssue],
			// 全 42 件のうち 1 件だけ受け取っている状況
			total: 42,
		});

		expect(html).toContain("42 件中 1 件を表示");
	});

	it("複数件をすべて表示する", () => {
		const html = render({
			ok: true,
			issues: [
				sampleIssue,
				{
					...sampleIssue,
					id: "c5a2e9b38fda7955d1f82377881a646b",
					title: "ゴミ集積所があふれている",
				},
			],
			total: 2,
		});

		expect(html).toContain("駅前の街灯が切れている");
		expect(html).toContain("ゴミ集積所があふれている");
	});

	it("1 件も無いときは空であることを伝える文言を出す", () => {
		const html = render({ ok: true, issues: [], total: 0 });

		expect(html).toContain("まだ Issue がありません");
		// 白い画面にならないこと（何らかのテキストが出ている）
		expect(html.replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(0);
	});

	it("取得に失敗したときはエラーを伝える文言を出す", () => {
		const html = render({ ok: false, error: "接続できませんでした" });

		expect(html).toContain("Issue を取得できませんでした");
		expect(html.replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(0);
	});

	it("失敗時に「まだ Issue がありません」とは出さない（空と混同させない）", () => {
		const html = render({ ok: false, error: "接続できませんでした" });

		expect(html).not.toContain("まだ Issue がありません");
	});

	it("Issue の本文を HTML としてではなくテキストとして出す", () => {
		const html = render({
			ok: true,
			issues: [
				{
					...sampleIssue,
					title: "<script>alert(1)</script>",
					description: "<img src=x onerror=alert(1)>",
				},
			],
			total: 1,
		});

		// タグとして解釈される形では出さず、エスケープされた文字列として出す
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img ");
		expect(html).toContain("&lt;script&gt;");
	});
});

describe("formatCreatedAt", () => {
	it("API の値を UTC として読む（実行環境のタイムゾーンでずらさない）", () => {
		// JST として解釈されると 2026-08-01 03:00 になってしまう
		expect(formatCreatedAt("2026-08-01 12:00:00.000")).toBe(
			"2026-08-01 12:00 UTC",
		);
	});

	it("秒精度の値（DEFAULT で入った古い行）も読める", () => {
		expect(formatCreatedAt("2026-08-01 12:00:00")).toBe("2026-08-01 12:00 UTC");
	});

	it("想定外の書式なら Invalid Date ではなく元の値を返す", () => {
		expect(formatCreatedAt("not a date")).toBe("not a date");
	});
});

/**
 * トップページが実際に API を呼んで結果を描画しているかを見る。
 *
 * `fetchIssues` と `IssueList` が個別に正しくても、`page.tsx` が両者を
 * 繋いでいなければ Issue #30 の「API を一度も呼んでいない」状態に逆戻りする。
 * その結線だけは、ページを実際に描画してみないと確認できない。
 */
describe("トップページ", () => {
	/** `globalThis.fetch` を差し替えてページを描画する。呼ばれた URL を返す。 */
	async function renderHome(response: Response) {
		const originalFetch = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			calls.push(typeof input === "string" ? input : input.toString());
			return response;
		}) as unknown as typeof globalThis.fetch;

		try {
			const html = renderToStaticMarkup(await Home());
			return { html, calls };
		} finally {
			globalThis.fetch = originalFetch;
		}
	}

	it("API を呼び、返ってきた Issue を描画する", async () => {
		const { html, calls } = await renderHome(
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		// API を呼んでいること（呼ばずに空を出す実装だとここで落ちる）
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("/issues");
		// 返ってきた内容が実際に描画されていること
		expect(html).toContain("駅前の街灯が切れている");
		expect(html).not.toContain("まだ Issue がありません");
	});

	it("API が 0 件を返したら空の案内を出す", async () => {
		const { html } = await renderHome(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		expect(html).toContain("まだ Issue がありません");
	});

	it("API が落ちていたらエラーの案内を出す", async () => {
		const originalError = console.error;
		console.error = () => {};
		try {
			const { html } = await renderHome(new Response("boom", { status: 500 }));

			expect(html).toContain("Issue を取得できませんでした");
			expect(html).not.toContain("まだ Issue がありません");
		} finally {
			console.error = originalError;
		}
	});
});

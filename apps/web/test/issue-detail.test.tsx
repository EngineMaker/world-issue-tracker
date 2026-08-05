/**
 * Issue 詳細ページ（`/issues/[id]`）とコメント欄の描画テスト。
 *
 * `fetchIssue` / `fetchComments` / `CommentSection` が個別に正しくても、
 * ページがそれらを繋いでいなければコメントは画面に出ない。
 * 結線の確認は、ページを実際に描画してみないとできない。
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueList } from "../src/app/components/IssueList";
import IssueDetailPage from "../src/app/issues/[id]/page";
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

const sampleComment = {
	id: "0b1b2c3d4e5f60718293a4b5c6d7e8f9",
	issue_id: sampleIssue.id,
	body: "同じ場所で先週も転びそうになりました",
	created_at: "2026-08-02 09:30:00.000",
};

/**
 * `globalThis.fetch` を差し替えて詳細ページを描画する。
 *
 * ページは Issue 本体とコメントの 2 本を投げるので、URL で振り分ける。
 * 呼ばれた URL も返し、「そもそもコメントを取りに行っていない」実装を拾えるようにする。
 */
async function renderDetail(
	responses: { issue: Response; comments: Response },
	id: string = sampleIssue.id,
) {
	const originalFetch = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push(url);
		return url.endsWith("/comments") ? responses.comments : responses.issue;
	}) as unknown as typeof globalThis.fetch;

	try {
		const html = renderToStaticMarkup(
			await IssueDetailPage({ params: Promise.resolve({ id }) }),
		);
		return { html, calls };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

describe("Issue 詳細ページ", () => {
	it("Issue の内容とコメントをどちらも描画する", async () => {
		const { html, calls } = await renderDetail({
			issue: Response.json(sampleIssue),
			comments: Response.json({ data: [sampleComment], total: 1 }),
		});

		// Issue とコメントの両方を取りに行っていること
		expect(calls).toHaveLength(2);
		expect(calls.some((url) => url.endsWith("/comments"))).toBe(true);

		expect(html).toContain("駅前の街灯が切れている");
		expect(html).toContain("夜道が暗くて危ない");
		// コメント本文が実際に画面へ出ていること
		expect(html).toContain("同じ場所で先週も転びそうになりました");
	});

	it("コメント投稿の入口を出す（未ログインでも欄自体は見える）", async () => {
		const { html } = await renderDetail({
			issue: Response.json(sampleIssue),
			comments: Response.json({ data: [], total: 0 }),
		});

		// 「みんなで直す」の装置が画面上に存在すること（Issue #60 の主眼）
		expect(html).toContain("コメント");
		expect(html).toContain("コメントする");
	});

	it("コメントが 0 件なら、その旨を伝えて投稿を促す", async () => {
		const { html } = await renderDetail({
			issue: Response.json(sampleIssue),
			comments: Response.json({ data: [], total: 0 }),
		});

		expect(html).toContain("まだコメントがありません");
	});

	it("コメントの取得に失敗したら、0 件と混同させない文言を出す", async () => {
		const originalError = console.error;
		console.error = () => {};
		try {
			const { html } = await renderDetail({
				issue: Response.json(sampleIssue),
				comments: new Response("boom", { status: 500 }),
			});

			expect(html).toContain("コメントを取得できませんでした");
			expect(html).not.toContain("まだコメントがありません");
		} finally {
			console.error = originalError;
		}
	});

	it("存在しない Issue では notFound() に落ちる（エラー画面にしない）", async () => {
		// `notFound()` は例外を投げて Next.js の 404 に落とす仕組みなので、
		// 投げること自体を成功として扱う
		const promise = renderDetail(
			{
				issue: Response.json({ error: "Issue not found" }, { status: 404 }),
				comments: Response.json({ error: "Issue not found" }, { status: 404 }),
			},
			"no-such-issue",
		);

		expect(promise).rejects.toThrow();
	});

	it("Issue の取得に失敗したら 404 ではなくエラーとして伝える", async () => {
		// API の一時障害で「Issue が消えた」と見せない
		const originalError = console.error;
		console.error = () => {};
		try {
			const { html } = await renderDetail({
				issue: new Response("boom", { status: 500 }),
				comments: new Response("boom", { status: 500 }),
			});

			expect(html).toContain("Issue を取得できません");
		} finally {
			console.error = originalError;
		}
	});

	it("コメント本文を HTML としてではなくテキストとして出す", async () => {
		const { html } = await renderDetail({
			issue: Response.json(sampleIssue),
			comments: Response.json({
				data: [{ ...sampleComment, body: "<img src=x onerror=alert(1)>" }],
				total: 1,
			}),
		});

		expect(html).not.toContain("<img ");
		expect(html).toContain("&lt;img");
	});
});

describe("一覧から詳細ページへの導線", () => {
	function renderList(result: FetchIssuesResult) {
		return renderToStaticMarkup(IssueList({ result }));
	}

	it("Issue のタイトルが詳細ページへのリンクになっている", () => {
		// コメント欄は詳細ページにあるため、ここに導線が無いと
		// 一覧から議論に辿り着けない（機能があっても使われない）
		const html = renderList({ ok: true, issues: [sampleIssue], total: 1 });

		expect(html).toContain(`href="/issues/${sampleIssue.id}"`);
	});
});

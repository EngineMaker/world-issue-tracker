// 表示言語を Cookie から読むため（Issue #82）、Server Component を直接呼ぶ
// このテストにはリクエストスコープが要る。テスト対象より先に評価させる
import "./helpers/mock-cookies";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * `/my-issues` ページの結線を見る（Issue #68）。
 *
 * `fetchMyIssues` と `MyIssueList` が個別に正しくても、ページが両者を
 * 繋いでいなければ画面には何も出ない。特にこのページは Clerk の
 * セッショントークンを API へ渡す一手間が挟まるため、そこが抜けると
 * 「ログイン済みなのに毎回サインインを促される」状態になる。
 * その結線は、ページを実際に描画してみないと確認できない。
 *
 * `@clerk/nextjs/server` の `auth()` は Next.js のリクエストコンテキストを
 * 要求するため、テストからは呼べない。トークンを返すだけの関数に差し替える。
 * `mock.module` はファイル単位で効くため、このページ専用のファイルに分けている。
 */

/** `auth()` が返すトークン。テストごとに差し替える。 */
let mockToken: string | null = "tok_test";

mock.module("@clerk/nextjs/server", () => ({
	auth: async () => ({ getToken: async () => mockToken }),
}));

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
};

/** `globalThis.fetch` を差し替えてページを描画する。リクエストの内容も返す。 */
async function renderMyIssues(response: Response) {
	const originalFetch = globalThis.fetch;
	const calls: { url: string; init?: RequestInit }[] = [];
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({ url: String(input), init });
		return response;
	}) as unknown as typeof globalThis.fetch;

	try {
		const { default: MyIssuesPage } = await import("../src/app/my-issues/page");
		const html = renderToStaticMarkup(await MyIssuesPage());
		return { html, calls };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

afterEach(() => {
	mockToken = "tok_test";
});

describe("/my-issues ページ", () => {
	it("自分の Issue を返すエンドポイントを呼ぶ（公開一覧ではない）", async () => {
		const { calls } = await renderMyIssues(
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/issues/mine");
	});

	it("Clerk のトークンを Authorization ヘッダで API へ渡す", async () => {
		const { calls } = await renderMyIssues(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		const headers = new Headers(calls[0]?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer tok_test");
	});

	it("返ってきた Issue を実際に描画する", async () => {
		const { html } = await renderMyIssues(
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		expect(html).toContain("駅前の街灯が切れている");
	});

	it("1 件も無ければ、まだ起票していないことを伝えて起票へ導く", async () => {
		const { html } = await renderMyIssues(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		expect(html).toContain("まだ Issue を起票していません");
		expect(html).toContain('href="/issues/new"');
	});

	it("未ログインなら API を呼ばずにログインを促す", async () => {
		mockToken = null;

		const { html, calls } = await renderMyIssues(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		expect(calls).toHaveLength(0);
		expect(html).toContain("ログイン");
		expect(html).not.toContain("まだ Issue を起票していません");
	});

	it("トークンが期限切れ（API が 401）ならログインを促す", async () => {
		const { html } = await renderMyIssues(
			Response.json({ error: "Unauthorized" }, { status: 401 }),
		);

		expect(html).toContain("ログイン");
		expect(html).not.toContain("まだ Issue を起票していません");
	});

	it("API が落ちていたら取得失敗として伝える（サインインの案内にはしない）", async () => {
		const originalError = console.error;
		console.error = () => {};
		try {
			const { html } = await renderMyIssues(
				new Response("boom", { status: 500 }),
			);

			expect(html).toContain("Issue を取得できませんでした");
			expect(html).not.toContain("まだ Issue を起票していません");
		} finally {
			console.error = originalError;
		}
	});

	// 一覧から先へ進めない・戻れない画面にしない
	it("起票画面と全体一覧への導線を持つ", async () => {
		const { html } = await renderMyIssues(
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		expect(html).toContain('href="/issues/new"');
		expect(html).toContain('href="/issues"');
		expect(html).toContain('href="/"');
	});
});

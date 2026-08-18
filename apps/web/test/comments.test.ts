/**
 * Issue 詳細ページが使う取得関数（`fetchIssue` / `fetchComments`）のテスト。
 *
 * 純粋なロジック（本文の検証、投稿、レスポンス形の検証）は
 * `apps/api/test/node/web-comments.test.ts` にある。こちらは
 * `cache: "no-store"` や URL の組み立てなど、実際に API を叩く側を見る。
 */

import { afterEach, describe, expect, it } from "bun:test";
import { fetchComments, fetchIssue } from "../src/lib/issues";

/** テスト用に `process.env` を差し替え、終了後に元へ戻す。 */
const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
	if (originalApiUrl === undefined) {
		delete process.env.NEXT_PUBLIC_API_URL;
	} else {
		process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
	}
});

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

const sampleComment = {
	id: "0b1b2c3d4e5f60718293a4b5c6d7e8f9",
	issue_id: sampleIssue.id,
	body: "同じ場所で先週も転びそうになりました",
	created_at: "2026-08-02 09:30:00.000",
};

/** 指定のレスポンスを返す `fetch` の代役。呼ばれた URL と init を記録する。 */
function stubFetch(response: Response | (() => Promise<Response>)) {
	const calls: string[] = [];
	const inits: (RequestInit | undefined)[] = [];
	const fn = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(typeof input === "string" ? input : input.toString());
		inits.push(init);
		return typeof response === "function" ? response() : response;
	};
	return { fetch: fn as unknown as typeof globalThis.fetch, calls, inits };
}

describe("fetchIssue", () => {
	it("GET /issues/:id を呼び、Issue を返す", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(Response.json(sampleIssue));

		const result = await fetchIssue(sampleIssue.id, { fetchImpl: fetch });

		expect(calls).toEqual([`https://api.example.com/issues/${sampleIssue.id}`]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.issue.title).toBe("駅前の街灯が切れている");
	});

	it("404 は「存在しない」として区別する", async () => {
		// ここを他の失敗と同じ扱いにすると、詳細ページが Next.js の 404 を
		// 出せず、存在しない URL がエラー画面として表示されてしまう
		const { fetch } = stubFetch(
			Response.json({ error: "Issue not found" }, { status: 404 }),
		);

		const result = await fetchIssue("no-such-issue", { fetchImpl: fetch });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.notFound).toBe(true);
	});

	it("500 は「存在しない」ではなく取得失敗として扱う", async () => {
		// API の一時障害を 404 にすると「Issue が消えた」ように見えてしまう
		const { fetch } = stubFetch(new Response("boom", { status: 500 }));

		const result = await fetchIssue(sampleIssue.id, { fetchImpl: fetch });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.notFound).toBe(false);
	});

	it("ネットワークエラーでも throw せず失敗を返す", async () => {
		const { fetch } = stubFetch(async () => {
			throw new TypeError("fetch failed");
		});

		const result = await fetchIssue(sampleIssue.id, { fetchImpl: fetch });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.notFound).toBe(false);
	});

	it("想定外の形の JSON でも throw せず失敗を返す", async () => {
		const { fetch } = stubFetch(Response.json({ unexpected: true }));

		const result = await fetchIssue(sampleIssue.id, { fetchImpl: fetch });

		expect(result.ok).toBe(false);
	});

	it("id をエスケープする（別のエンドポイントを指さないように）", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(Response.json(sampleIssue));

		await fetchIssue("a/b?c", { fetchImpl: fetch });

		expect(calls[0]).toBe("https://api.example.com/issues/a%2Fb%3Fc");
	});

	it("キャッシュせずに毎回取りに行く", async () => {
		const { fetch, inits } = stubFetch(Response.json(sampleIssue));

		await fetchIssue(sampleIssue.id, { fetchImpl: fetch });

		expect(inits[0]?.cache).toBe("no-store");
	});
});

describe("fetchComments", () => {
	it("GET /issues/:id/comments を呼び、コメントを返す", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(
			Response.json({ data: [sampleComment], total: 1 }),
		);

		const result = await fetchComments(sampleIssue.id, { fetchImpl: fetch });

		// パスを間違えると、コメントが永久に 0 件のまま表示され続ける
		expect(calls).toEqual([
			`https://api.example.com/issues/${sampleIssue.id}/comments`,
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.comments).toHaveLength(1);
		expect(result.comments[0]?.body).toBe(
			"同じ場所で先週も転びそうになりました",
		);
		expect(result.total).toBe(1);
	});

	it("0 件でも成功として扱う（エラーにしない）", async () => {
		const { fetch } = stubFetch(Response.json({ data: [], total: 0 }));

		const result = await fetchComments(sampleIssue.id, { fetchImpl: fetch });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.comments).toEqual([]);
	});

	it("API が 500 を返したら失敗として扱う", async () => {
		const { fetch } = stubFetch(new Response("boom", { status: 500 }));

		const result = await fetchComments(sampleIssue.id, { fetchImpl: fetch });

		expect(result.ok).toBe(false);
	});

	it("Issue が無いとき（404）は障害ではなく空として扱う", async () => {
		// 詳細ページは Issue とコメントを並行に取りに行くため、その隙に Issue が
		// 削除されるとコメント側だけが 404 になる。これを失敗にすると
		// 「時間をおいて再度お試しください」という、時間をおいても直らない案内が出る
		const { fetch } = stubFetch(
			Response.json({ error: "Issue not found" }, { status: 404 }),
		);

		const result = await fetchComments("no-such-issue", { fetchImpl: fetch });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.comments).toEqual([]);
	});

	it("想定外の形の JSON でも throw せず失敗を返す", async () => {
		// 検証を外すと、壊れた値がそのまま画面の描画まで届く
		const { fetch } = stubFetch(Response.json({ unexpected: true }));

		const result = await fetchComments(sampleIssue.id, { fetchImpl: fetch });

		expect(result.ok).toBe(false);
	});

	it("形の合わないコメントが混ざっていたら失敗として扱う", async () => {
		const { fetch } = stubFetch(
			Response.json({
				data: [sampleComment, { ...sampleComment, body: 123 }],
				total: 2,
			}),
		);

		const result = await fetchComments(sampleIssue.id, { fetchImpl: fetch });

		expect(result.ok).toBe(false);
	});

	it("JSON として壊れている本文でも throw せず失敗を返す", async () => {
		const { fetch } = stubFetch(
			new Response("<html>not json</html>", {
				headers: { "Content-Type": "text/html" },
			}),
		);

		const result = await fetchComments(sampleIssue.id, { fetchImpl: fetch });

		expect(result.ok).toBe(false);
	});

	it("ネットワークエラーでも throw せず失敗を返す", async () => {
		const { fetch } = stubFetch(async () => {
			throw new TypeError("fetch failed");
		});

		const result = await fetchComments(sampleIssue.id, { fetchImpl: fetch });

		expect(result.ok).toBe(false);
	});

	it("失敗の詳細は画面ではなくサーバーのログに出す", async () => {
		const { fetch } = stubFetch(async () => {
			throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:8787");
		});
		const originalError = console.error;
		const logged: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};

		try {
			const result = await fetchComments(sampleIssue.id, { fetchImpl: fetch });

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).not.toContain("ECONNREFUSED");
			expect(logged).toHaveLength(1);
		} finally {
			console.error = originalError;
		}
	});

	it("id をエスケープする", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(Response.json({ data: [], total: 0 }));

		await fetchComments("a/b?c", { fetchImpl: fetch });

		expect(calls[0]).toBe("https://api.example.com/issues/a%2Fb%3Fc/comments");
	});

	it("キャッシュせずに毎回取りに行く（投稿したコメントが反映されるように）", async () => {
		const { fetch, inits } = stubFetch(Response.json({ data: [], total: 0 }));

		await fetchComments(sampleIssue.id, { fetchImpl: fetch });

		expect(inits[0]?.cache).toBe("no-store");
	});

	// --- トークン（#99） ---

	it("トークンを渡すと Authorization を付ける", async () => {
		// これが無いと API から見て未ログインになり、`viewer_is_author` が
		// 全件 false で返る＝自分のコメントにも削除ボタンが出ない
		const { fetch, inits } = stubFetch(Response.json({ data: [], total: 0 }));

		await fetchComments(sampleIssue.id, { fetchImpl: fetch, token: "tok_123" });

		expect(
			(inits[0]?.headers as Record<string, string> | undefined)?.Authorization,
		).toBe("Bearer tok_123");
	});

	it("トークンが無ければ Authorization を付けない", async () => {
		// Server Component からの取得がこれ。未ログイン扱いで公開分だけが返る
		const { fetch, inits } = stubFetch(Response.json({ data: [], total: 0 }));

		await fetchComments(sampleIssue.id, { fetchImpl: fetch });

		expect(
			(inits[0]?.headers as Record<string, string> | undefined)?.Authorization,
		).toBeUndefined();
	});
});

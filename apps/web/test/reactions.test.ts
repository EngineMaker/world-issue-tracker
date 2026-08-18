import { afterEach, describe, expect, it } from "bun:test";
import {
	fetchReactions,
	parseReactionsResponse,
	ReactionError,
	react,
	withdrawReaction,
} from "../src/lib/reactions";

const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
const originalFetch = globalThis.fetch;

afterEach(() => {
	if (originalApiUrl === undefined) {
		delete process.env.NEXT_PUBLIC_API_URL;
	} else {
		process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
	}
	globalThis.fetch = originalFetch;
});

const ISSUE_ID = "ebbcf9d7680ad57cedeeb513a90d461f";

/** `GET /issues/:id/reactions` が返す形。 */
const sampleResponse = { total: 3, viewer_reacted: false };

/** 呼ばれた URL と初期化オプションを記録する `fetch` の代役。 */
function stubFetch(response: Response | (() => Promise<Response>)) {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	const impl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		calls.push({ url: String(input), init });
		return typeof response === "function" ? await response() : response.clone();
	};
	return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

describe("parseReactionsResponse", () => {
	it("正しい形を読める", () => {
		const parsed = parseReactionsResponse(sampleResponse);

		expect(parsed).toEqual({ total: 3, viewerReacted: false });
	});

	it("viewer_reacted が真なら反映する", () => {
		const parsed = parseReactionsResponse({ total: 1, viewer_reacted: true });

		expect(parsed?.viewerReacted).toBe(true);
	});

	it.each([
		["record でない", 42],
		["null", null],
		["total が無い", { viewer_reacted: false }],
		["total が数値でない", { total: "3", viewer_reacted: false }],
		["viewer_reacted が無い", { total: 3 }],
		["viewer_reacted が真偽値でない", { total: 3, viewer_reacted: 1 }],
	])("%s なら null", (_label, value) => {
		expect(parseReactionsResponse(value)).toBeNull();
	});

	// `viewer_reacted` が欠けたレスポンスを false として通すと、反応済みの人にも
	// 「私も困っている」ボタンを出し続けることになる。押しても状態は変わらないので、
	// 利用者から見ると「押せないボタン」になる
	it("viewer_reacted が欠けていれば false に倒さず失敗させる", () => {
		expect(parseReactionsResponse({ total: 3 })).toBeNull();
	});

	// API は誰が押したかを返さない（#112 の決定 3）。もし将来 `data` のような
	// 一覧が混ざって返ってきても、こちら側はそれを読まない
	it("余分なキーがあっても読み取るのは件数と真偽値だけ", () => {
		const parsed = parseReactionsResponse({
			total: 2,
			viewer_reacted: true,
			data: [{ user_id: "user_leak" }],
		});

		expect(parsed).toEqual({ total: 2, viewerReacted: true });
		expect(JSON.stringify(parsed)).not.toContain("user_leak");
	});
});

describe("fetchReactions", () => {
	it("Issue の反応エンドポイントを叩く", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { impl, calls } = stubFetch(Response.json(sampleResponse));

		const result = await fetchReactions(ISSUE_ID, { fetchImpl: impl });

		expect(result.ok).toBe(true);
		expect(calls[0]?.url).toBe(
			`https://api.example.com/issues/${ISSUE_ID}/reactions`,
		);
	});

	it("件数を読み取って返す", async () => {
		const { impl } = stubFetch(Response.json(sampleResponse));

		const result = await fetchReactions(ISSUE_ID, { fetchImpl: impl });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.summary.total).toBe(3);
	});

	it("トークンを渡すと Authorization を付ける", async () => {
		// これが付かないと `viewer_reacted` が常に false になり、
		// 反応済みの人にも「私も困っている」が出続ける
		const { impl, calls } = stubFetch(Response.json(sampleResponse));

		await fetchReactions(ISSUE_ID, { fetchImpl: impl, token: "tok_1" });

		expect(calls[0]?.init?.headers).toEqual({ Authorization: "Bearer tok_1" });
	});

	it("トークンが無ければ Authorization を付けない", async () => {
		const { impl, calls } = stubFetch(Response.json(sampleResponse));

		await fetchReactions(ISSUE_ID, { fetchImpl: impl });

		expect(calls[0]?.init?.headers).toEqual({});
	});

	it("押した直後に古い件数を見せないようキャッシュしない", async () => {
		const { impl, calls } = stubFetch(Response.json(sampleResponse));

		await fetchReactions(ISSUE_ID, { fetchImpl: impl });

		expect(calls[0]?.init?.cache).toBe("no-store");
	});

	it("Issue ID をエスケープする", async () => {
		const { impl, calls } = stubFetch(Response.json(sampleResponse));

		await fetchReactions("a/../b", { fetchImpl: impl });

		expect(calls[0]?.url).toContain("a%2F..%2Fb");
	});

	it("API がエラーを返せば失敗として返す", async () => {
		const { impl } = stubFetch(new Response("", { status: 500 }));

		const result = await fetchReactions(ISSUE_ID, { fetchImpl: impl });

		expect(result.ok).toBe(false);
	});

	it("形が違えば失敗として返す", async () => {
		const { impl } = stubFetch(Response.json({ total: "many" }));

		const result = await fetchReactions(ISSUE_ID, { fetchImpl: impl });

		expect(result.ok).toBe(false);
	});

	it("通信そのものが失敗しても throw しない", async () => {
		// 反応が取れなくても Issue 本体は表示できる。
		// ページ全体を落とさないため、失敗は値で返す
		const impl = (async () => {
			throw new Error("fetch failed");
		}) as unknown as typeof globalThis.fetch;

		const result = await fetchReactions(ISSUE_ID, { fetchImpl: impl });

		expect(result.ok).toBe(false);
	});
});

describe("react / withdrawReaction", () => {
	it("POST で反応する", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { impl, calls } = stubFetch(new Response("", { status: 201 }));
		globalThis.fetch = impl;

		await react(ISSUE_ID, "tok_1");

		expect(calls[0]?.url).toBe(
			`https://api.example.com/issues/${ISSUE_ID}/reactions`,
		);
		expect(calls[0]?.init?.method).toBe("POST");
		expect(calls[0]?.init?.headers).toEqual({ Authorization: "Bearer tok_1" });
	});

	it("DELETE で取り消す", async () => {
		const { impl, calls } = stubFetch(new Response(null, { status: 204 }));
		globalThis.fetch = impl;

		await withdrawReaction(ISSUE_ID, "tok_1");

		expect(calls[0]?.init?.method).toBe("DELETE");
	});

	// 取り消しは URL に対象の ID を取らない（誰の反応を消すかはトークンから決まる）。
	// ID を取る形に変わると、他人の分を消せないことの確認が別途要る
	it("取り消しの URL に反応の ID を含めない", async () => {
		const { impl, calls } = stubFetch(new Response(null, { status: 204 }));
		globalThis.fetch = impl;

		await withdrawReaction(ISSUE_ID, "tok_1");

		expect(calls[0]?.url).toEndWith(`/issues/${ISSUE_ID}/reactions`);
	});

	it("トークンが無ければ通信せずに 401 のエラーを投げる", async () => {
		// 送っても 401 が返るだけなので、往復を省く
		const { impl, calls } = stubFetch(new Response("", { status: 201 }));
		globalThis.fetch = impl;

		expect(react(ISSUE_ID, null)).rejects.toBeInstanceOf(ReactionError);
		expect(calls).toHaveLength(0);
	});

	it.each([
		[401, "ログイン"],
		[403, "許可されていません"],
		[404, "見つかりませんでした"],
	])("%s は利用者向けの文言にする", async (status, expected) => {
		const { impl } = stubFetch(new Response("", { status }));
		globalThis.fetch = impl;

		try {
			await react(ISSUE_ID, "tok_1");
			throw new Error("エラーが投げられなかった");
		} catch (err) {
			expect(err).toBeInstanceOf(ReactionError);
			expect((err as ReactionError).message).toContain(expected);
			expect((err as ReactionError).status).toBe(status);
		}
	});

	it("通信そのものが失敗すればステータス無しのエラーになる", async () => {
		globalThis.fetch = (async () => {
			throw new Error("fetch failed");
		}) as unknown as typeof globalThis.fetch;

		try {
			await react(ISSUE_ID, "tok_1");
			throw new Error("エラーが投げられなかった");
		} catch (err) {
			expect(err).toBeInstanceOf(ReactionError);
			expect((err as ReactionError).status).toBeNull();
		}
	});
});

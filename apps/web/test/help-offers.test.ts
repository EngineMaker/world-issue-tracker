import { afterEach, describe, expect, it } from "bun:test";
import {
	fetchHelpOffers,
	HelpOfferError,
	offerHelp,
	parseHelpOffer,
	parseHelpOffersResponse,
	withdrawHelp,
} from "../src/lib/help-offers";

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

/** `GET /issues/:id/help-offers` が返す表明 1 件分。 */
const sampleOffer = {
	id: "3c1f9a52a1a94e6ab0d0b6f8f8a7c123",
	user_id: "user_2abcdefghijklmnop",
	created_at: "2026-08-01 12:00:00.000",
};

const ISSUE_ID = "ebbcf9d7680ad57cedeeb513a90d461f";

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

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("parseHelpOffer", () => {
	it("正しい形の表明を通す", () => {
		expect(parseHelpOffer(sampleOffer)).toEqual(sampleOffer);
	});

	it("必須フィールドが欠けていれば null", () => {
		for (const key of ["id", "user_id", "created_at"]) {
			const broken = { ...sampleOffer } as Record<string, unknown>;
			delete broken[key];
			expect(parseHelpOffer(broken)).toBeNull();
		}
	});

	it("型が違えば null", () => {
		expect(parseHelpOffer({ ...sampleOffer, user_id: 123 })).toBeNull();
		expect(parseHelpOffer(null)).toBeNull();
		expect(parseHelpOffer("offer")).toBeNull();
	});
});

describe("parseHelpOffersResponse", () => {
	const valid = {
		data: [sampleOffer],
		total: 1,
		viewer_offered: false,
		viewer_user_id: null,
	};

	it("正しい形のレスポンスを通す", () => {
		expect(parseHelpOffersResponse(valid)).toEqual({
			offers: [sampleOffer],
			total: 1,
			viewerOffered: false,
			viewerUserId: null,
		});
	});

	it("viewer_user_id が文字列でも通す", () => {
		const parsed = parseHelpOffersResponse({
			...valid,
			viewer_offered: true,
			viewer_user_id: sampleOffer.user_id,
		});
		expect(parsed?.viewerUserId).toBe(sampleOffer.user_id);
		expect(parsed?.viewerOffered).toBe(true);
	});

	it("viewer_offered が欠けていれば null", () => {
		// 欠けたものを false として黙って通すと、表明済みの人にも
		// 「手伝います」ボタンを出し続けることになる
		const { viewer_offered, ...withoutFlag } = valid;
		expect(parseHelpOffersResponse(withoutFlag)).toBeNull();
	});

	it("viewer_offered が真偽値でなければ null", () => {
		expect(
			parseHelpOffersResponse({ ...valid, viewer_offered: "true" }),
		).toBeNull();
	});

	it("viewer_user_id が文字列でも null でもなければ null", () => {
		expect(
			parseHelpOffersResponse({ ...valid, viewer_user_id: 42 }),
		).toBeNull();
	});

	it("data の 1 件でも形が違えば全体を失敗にする", () => {
		expect(
			parseHelpOffersResponse({
				...valid,
				data: [sampleOffer, { id: "x" }],
				total: 2,
			}),
		).toBeNull();
	});

	it("data が配列でなければ null", () => {
		expect(parseHelpOffersResponse({ ...valid, data: null })).toBeNull();
	});
});

describe("fetchHelpOffers", () => {
	it("Issue ID を含む URL を叩き、結果を返す", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { impl, calls } = stubFetch(
			jsonResponse({
				data: [sampleOffer],
				total: 1,
				viewer_offered: true,
				viewer_user_id: sampleOffer.user_id,
			}),
		);

		const result = await fetchHelpOffers(ISSUE_ID, { fetchImpl: impl });

		expect(calls[0].url).toBe(
			`https://api.example.com/issues/${ISSUE_ID}/help-offers`,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.summary.total).toBe(1);
			expect(result.summary.viewerOffered).toBe(true);
		}
	});

	it("トークンを渡すと Authorization ヘッダを付ける", async () => {
		// 付かないと API から見て未ログインになり、`viewer_offered` が
		// 常に false になる（表明済みでも「手伝います」が出続ける）
		const { impl, calls } = stubFetch(
			jsonResponse({
				data: [],
				total: 0,
				viewer_offered: false,
				viewer_user_id: null,
			}),
		);

		await fetchHelpOffers(ISSUE_ID, { fetchImpl: impl, token: "tok_123" });

		const headers = calls[0].init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer tok_123");
	});

	it("トークンが無ければ Authorization ヘッダを付けない", async () => {
		const { impl, calls } = stubFetch(
			jsonResponse({
				data: [],
				total: 0,
				viewer_offered: false,
				viewer_user_id: null,
			}),
		);

		await fetchHelpOffers(ISSUE_ID, { fetchImpl: impl });

		const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it("Issue ID をエスケープしてパスに入れる", async () => {
		// id は API 側で任意の TEXT なので、`/` を含む値がパスを
		// 書き換えないことを確かめる
		const { impl, calls } = stubFetch(
			jsonResponse({
				data: [],
				total: 0,
				viewer_offered: false,
				viewer_user_id: null,
			}),
		);

		await fetchHelpOffers("a/b", { fetchImpl: impl });

		expect(calls[0].url).toContain("/issues/a%2Fb/help-offers");
	});

	it("API がエラーを返せば失敗として返す", async () => {
		const { impl } = stubFetch(jsonResponse({ error: "Issue not found" }, 404));

		const result = await fetchHelpOffers(ISSUE_ID, { fetchImpl: impl });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("404");
		}
	});

	it("レスポンスの形が違えば失敗として返す", async () => {
		const { impl } = stubFetch(jsonResponse({ unexpected: true }));

		const result = await fetchHelpOffers(ISSUE_ID, { fetchImpl: impl });

		expect(result.ok).toBe(false);
	});

	it("通信そのものが失敗しても throw しない", async () => {
		const impl = (async () => {
			throw new Error("fetch failed");
		}) as unknown as typeof globalThis.fetch;

		const result = await fetchHelpOffers(ISSUE_ID, { fetchImpl: impl });

		expect(result.ok).toBe(false);
	});
});

describe("offerHelp / withdrawHelp", () => {
	it("トークンが無ければ通信せずに 401 のエラーを投げる", async () => {
		const { impl, calls } = stubFetch(new Response(null, { status: 201 }));
		globalThis.fetch = impl;

		await expect(offerHelp(ISSUE_ID, null)).rejects.toThrow(HelpOfferError);
		// 通信していないこと（未ログインのまま API を叩かない）
		expect(calls.length).toBe(0);
	});

	it("POST で表明し、Authorization ヘッダを付ける", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { impl, calls } = stubFetch(new Response(null, { status: 201 }));
		globalThis.fetch = impl;

		await offerHelp(ISSUE_ID, "tok_123");

		expect(calls[0].url).toBe(
			`https://api.example.com/issues/${ISSUE_ID}/help-offers`,
		);
		expect(calls[0].init?.method).toBe("POST");
		const headers = calls[0].init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer tok_123");
	});

	it("DELETE で取り消す", async () => {
		const { impl, calls } = stubFetch(new Response(null, { status: 204 }));
		globalThis.fetch = impl;

		await withdrawHelp(ISSUE_ID, "tok_123");

		expect(calls[0].init?.method).toBe("DELETE");
	});

	it("401 なら再サインインを促すメッセージを出す", async () => {
		const { impl } = stubFetch(jsonResponse({ error: "Unauthorized" }, 401));
		globalThis.fetch = impl;

		await expect(offerHelp(ISSUE_ID, "tok_expired")).rejects.toThrow(
			/ログインが必要/,
		);
	});

	it("404 なら Issue が見つからない旨を出す", async () => {
		const { impl } = stubFetch(jsonResponse({ error: "Issue not found" }, 404));
		globalThis.fetch = impl;

		await expect(offerHelp(ISSUE_ID, "tok_123")).rejects.toThrow(
			/見つかりません/,
		);
	});

	it("通信そのものが失敗したら接続エラーとして投げる", async () => {
		globalThis.fetch = (async () => {
			throw new Error("fetch failed");
		}) as unknown as typeof globalThis.fetch;

		await expect(offerHelp(ISSUE_ID, "tok_123")).rejects.toThrow(
			/接続できません/,
		);
	});

	it("エラーには HTTP ステータスが載る", async () => {
		const { impl } = stubFetch(jsonResponse({ error: "Forbidden" }, 403));
		globalThis.fetch = impl;

		try {
			await offerHelp(ISSUE_ID, "tok_123");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HelpOfferError);
			expect((err as HelpOfferError).status).toBe(403);
		}
	});
});

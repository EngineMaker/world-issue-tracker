import { afterEach, describe, expect, it } from "bun:test";
import {
	fetchIssues,
	fetchMyIssues,
	parseListIssuesResponse,
	parsePublicIssue,
	resolveApiBaseUrl,
} from "../src/lib/issues";

/** テスト用に `process.env` を差し替え、終了後に元へ戻す。 */
const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
	if (originalApiUrl === undefined) {
		delete process.env.NEXT_PUBLIC_API_URL;
	} else {
		process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
	}
});

/**
 * `GET /issues` が返す形の 1 件分。
 *
 * `id` は `TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))`（`0001_initial.sql`）
 * なので数値ではなく 32 桁の 16 進文字列。実物と同じ形にしてある。
 */
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

/** 指定のレスポンスを返す `fetch` の代役。呼ばれた URL を記録する。 */
function stubFetch(response: Response | (() => Promise<Response>)) {
	const calls: string[] = [];
	const fn = async (input: string | URL | Request) => {
		calls.push(typeof input === "string" ? input : input.toString());
		return typeof response === "function" ? response() : response;
	};
	return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

describe("resolveApiBaseUrl", () => {
	it("NEXT_PUBLIC_API_URL が設定されていればそれを使う", () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		expect(resolveApiBaseUrl()).toBe("https://api.example.com");
	});

	it("末尾のスラッシュを取り除く（パス結合で // にならないように）", () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com/";
		expect(resolveApiBaseUrl()).toBe("https://api.example.com");
	});

	it("未設定ならローカルの API を指す", () => {
		delete process.env.NEXT_PUBLIC_API_URL;
		expect(resolveApiBaseUrl()).toBe("http://localhost:8787");
	});
});

describe("fetchIssues", () => {
	it("GET /issues を呼び、data 配列を返す", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		const result = await fetchIssues({ fetchImpl: fetch });

		expect(calls).toHaveLength(1);
		expect(calls[0]).toStartWith("https://api.example.com/issues");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.total).toBe(1);
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0]?.title).toBe("駅前の街灯が切れている");
	});

	it("limit をクエリに載せる", async () => {
		const { fetch, calls } = stubFetch(
			Response.json({ data: [], total: 0, limit: 5, offset: 0 }),
		);

		await fetchIssues({ limit: 5, fetchImpl: fetch });

		expect(calls[0]).toContain("limit=5");
	});

	it("0 件でも成功として扱う（エラーにしない）", async () => {
		const { fetch } = stubFetch(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		const result = await fetchIssues({ fetchImpl: fetch });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.issues).toEqual([]);
		expect(result.total).toBe(0);
	});

	it("API が 500 を返したら失敗として扱う", async () => {
		const { fetch } = stubFetch(
			new Response("boom", { status: 500, statusText: "Internal Error" }),
		);

		const result = await fetchIssues({ fetchImpl: fetch });

		expect(result.ok).toBe(false);
	});

	it("ネットワークエラー（API が落ちている）でも throw せず失敗を返す", async () => {
		const { fetch } = stubFetch(async () => {
			throw new TypeError("fetch failed");
		});

		const result = await fetchIssues({ fetchImpl: fetch });

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
			const result = await fetchIssues({ fetchImpl: fetch });

			expect(result.ok).toBe(false);
			// 画面に出す文言に生の例外メッセージを混ぜない
			if (result.ok) return;
			expect(result.error).not.toContain("ECONNREFUSED");
			// 切り分け用の情報はログには残す
			expect(logged).toHaveLength(1);
			const loggedError = logged[0]?.[1];
			expect(loggedError).toBeInstanceOf(Error);
			expect((loggedError as Error).message).toContain("ECONNREFUSED");
		} finally {
			console.error = originalError;
		}
	});

	it("想定外の形の JSON でも throw せず失敗を返す", async () => {
		const { fetch } = stubFetch(Response.json({ unexpected: true }));

		const result = await fetchIssues({ fetchImpl: fetch });

		expect(result.ok).toBe(false);
	});

	it("JSON として壊れている本文でも throw せず失敗を返す", async () => {
		const { fetch } = stubFetch(
			new Response("<html>not json</html>", {
				headers: { "Content-Type": "text/html" },
			}),
		);

		const result = await fetchIssues({ fetchImpl: fetch });

		expect(result.ok).toBe(false);
	});

	it("スキーマに合わない Issue が混ざっていたら失敗として扱う", async () => {
		const { fetch } = stubFetch(
			Response.json({
				data: [{ ...sampleIssue, scope: "galactic" }],
				total: 1,
				limit: 20,
				offset: 0,
			}),
		);

		const result = await fetchIssues({ fetchImpl: fetch });

		expect(result.ok).toBe(false);
	});

	it("キャッシュせずに毎回取りに行く（新しい Issue が反映されるように）", async () => {
		let init: RequestInit | undefined;
		const fetchImpl = (async (
			_input: string | URL | Request,
			requestInit?: RequestInit,
		) => {
			init = requestInit;
			return Response.json({ data: [], total: 0, limit: 20, offset: 0 });
		}) as unknown as typeof globalThis.fetch;

		await fetchIssues({ fetchImpl });

		expect(init?.cache).toBe("no-store");
	});
});

describe("fetchMyIssues", () => {
	/** リクエストの URL と init の両方を記録する `fetch` の代役。 */
	function recordingFetch(response: Response | (() => Promise<Response>)) {
		const calls: { url: string; init?: RequestInit }[] = [];
		const fn = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: typeof input === "string" ? input : input.toString(),
				init,
			});
			return typeof response === "function" ? response() : response;
		};
		return { fetch: fn as unknown as typeof globalThis.fetch, calls };
	}

	it("公開一覧ではなく GET /issues/mine を呼ぶ", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = recordingFetch(
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		const result = await fetchMyIssues({ token: "tok_1", fetchImpl: fetch });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toStartWith("https://api.example.com/issues/mine");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.issues[0]?.title).toBe("駅前の街灯が切れている");
	});

	// Web と API は別オリジンなので Clerk の Cookie は届かない。
	// Bearer を付け忘れると本番で必ず 401 になるが、URL だけを見ていると気付けない。
	it("Authorization: Bearer にトークンを載せる", async () => {
		const { fetch, calls } = recordingFetch(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		await fetchMyIssues({ token: "tok_abc", fetchImpl: fetch });

		const headers = new Headers(calls[0]?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer tok_abc");
	});

	// トークンが無いまま叩くと API から 401 が返るだけで、画面には
	// 「取得できませんでした」としか出ない。サインインを促せるよう区別する。
	it("トークンが無ければ API を呼ばずに未認証として返す", async () => {
		const { fetch, calls } = recordingFetch(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		const result = await fetchMyIssues({ token: null, fetchImpl: fetch });

		expect(calls).toHaveLength(0);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.unauthorized).toBe(true);
	});

	it("API が 401 を返したら未認証として返す", async () => {
		const { fetch } = recordingFetch(
			Response.json({ error: "Unauthorized" }, { status: 401 }),
		);

		const result = await fetchMyIssues({ token: "expired", fetchImpl: fetch });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.unauthorized).toBe(true);
	});

	// 401 以外の失敗まで「サインインしてください」にすると、
	// サインインし直しても直らない案内を出し続けることになる。
	it("500 は未認証ではなく取得失敗として返す", async () => {
		const { fetch } = recordingFetch(new Response("boom", { status: 500 }));

		const result = await fetchMyIssues({ token: "tok_1", fetchImpl: fetch });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.unauthorized).toBe(false);
	});

	it("ネットワークエラーでも throw せず失敗を返す", async () => {
		const { fetch } = recordingFetch(async () => {
			throw new TypeError("fetch failed");
		});
		const originalError = console.error;
		console.error = () => {};

		try {
			const result = await fetchMyIssues({ token: "tok_1", fetchImpl: fetch });

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.unauthorized).toBe(false);
		} finally {
			console.error = originalError;
		}
	});

	it("想定外の形の JSON でも throw せず失敗を返す", async () => {
		const { fetch } = recordingFetch(Response.json({ unexpected: true }));

		const result = await fetchMyIssues({ token: "tok_1", fetchImpl: fetch });

		expect(result.ok).toBe(false);
	});

	it("キャッシュせずに毎回取りに行く", async () => {
		const { fetch, calls } = recordingFetch(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		await fetchMyIssues({ token: "tok_1", fetchImpl: fetch });

		expect(calls[0]?.init?.cache).toBe("no-store");
	});

	it("0 件でも成功として扱う（起票していないだけなので）", async () => {
		const { fetch } = recordingFetch(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		const result = await fetchMyIssues({ token: "tok_1", fetchImpl: fetch });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.issues).toEqual([]);
		expect(result.total).toBe(0);
	});
});

describe("parsePublicIssue", () => {
	it("実際の API と同じ形の 1 件を受け付ける", () => {
		expect(parsePublicIssue(sampleIssue)).not.toBeNull();
	});

	it("category が null でも受け付ける", () => {
		expect(parsePublicIssue({ ...sampleIssue, category: null })).not.toBeNull();
	});

	it("緯度経度が NaN / Infinity なら弾く（地図に渡すと壊れる）", () => {
		expect(parsePublicIssue({ ...sampleIssue, latitude: NaN })).toBeNull();
		expect(
			parsePublicIssue({ ...sampleIssue, longitude: Number.POSITIVE_INFINITY }),
		).toBeNull();
	});

	it("scope / status が定義外の値なら弾く", () => {
		expect(parsePublicIssue({ ...sampleIssue, scope: "galactic" })).toBeNull();
		expect(parsePublicIssue({ ...sampleIssue, status: "wontfix" })).toBeNull();
	});

	it("Object.prototype 由来の名前を値域として認めない", () => {
		// オブジェクトのキー参照で値域を判定していると、`toString` のような
		// プロトタイプのプロパティが通ってしまう
		expect(parsePublicIssue({ ...sampleIssue, scope: "toString" })).toBeNull();
		expect(
			parsePublicIssue({ ...sampleIssue, status: "constructor" }),
		).toBeNull();
	});

	it("必須フィールドが欠けていたら弾く", () => {
		const { title: _title, ...withoutTitle } = sampleIssue;
		expect(parsePublicIssue(withoutTitle)).toBeNull();
		expect(parsePublicIssue(null)).toBeNull();
		expect(parsePublicIssue("not an object")).toBeNull();
	});
});

/**
 * 実際に `wrangler dev` の API が返した本物のレスポンスをそのまま貼ったもの。
 *
 * 手で書いたサンプルだけで検証すると、こちらの思い込み（例: `id` が数値）が
 * そのままテストにも写り、実物と食い違っても緑のままになる。実物の 1 通りを
 * 固定しておくことで、API の形が変わったときにここで気付ける。
 */
const realApiResponse = {
	data: [
		{
			id: "ebbcf9d7680ad57cedeeb513a90d461f",
			title: "駅前の街灯が切れている",
			description: "夜道が暗くて危ないので直してほしい",
			scope: "community",
			status: "open",
			latitude: 35.68,
			longitude: 139.76,
			category: "infrastructure",
			created_at: "2026-08-01 20:44:11.342",
			updated_at: "2026-08-01 20:44:11.342",
		},
		{
			id: "c5a2e9b38fda7955d1f82377881a646b",
			title: "ゴミ集積所があふれている",
			description: "回収頻度を上げてほしい",
			scope: "municipality",
			status: "open",
			latitude: 35.69,
			longitude: 139.7,
			category: null,
			created_at: "2026-08-01 20:44:11.342",
			updated_at: "2026-08-01 20:44:11.342",
		},
	],
	total: 2,
	limit: 20,
	offset: 0,
};

describe("実際の API レスポンス", () => {
	it("wrangler dev が返したレスポンスをそのまま受け付ける", () => {
		const parsed = parseListIssuesResponse(realApiResponse);

		expect(parsed).not.toBeNull();
		expect(parsed?.total).toBe(2);
		expect(parsed?.issues).toHaveLength(2);
		expect(parsed?.issues[0]?.id).toBe("ebbcf9d7680ad57cedeeb513a90d461f");
		// category が null の行も落とさない
		expect(parsed?.issues[1]?.category).toBeNull();
	});

	it("id は文字列（TEXT PRIMARY KEY）として扱う", () => {
		// 数値の id を要求する実装だと実物を全部弾いてしまう
		const parsed = parseListIssuesResponse(realApiResponse);

		expect(typeof parsed?.issues[0]?.id).toBe("string");
	});
});

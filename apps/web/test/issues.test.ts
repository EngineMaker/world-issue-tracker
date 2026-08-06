import { afterEach, describe, expect, it } from "bun:test";
import {
	buildIssuesHref,
	DEFAULT_ISSUE_FILTERS,
	fetchIssues,
	hasActiveFilters,
	parseIssueFilters,
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

	it("絞り込み条件をクエリに載せる", async () => {
		const { fetch, calls } = stubFetch(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		await fetchIssues({
			filters: {
				scope: "municipality",
				status: "in_progress",
				category: "道路・交通",
				q: "街灯",
				sort: "oldest",
				offset: 40,
			},
			fetchImpl: fetch,
		});

		const url = new URL(calls[0] ?? "");
		expect(url.searchParams.get("scope")).toBe("municipality");
		expect(url.searchParams.get("status")).toBe("in_progress");
		expect(url.searchParams.get("category")).toBe("道路・交通");
		expect(url.searchParams.get("q")).toBe("街灯");
		expect(url.searchParams.get("sort")).toBe("oldest");
		expect(url.searchParams.get("offset")).toBe("40");
	});

	it("条件が無ければ余計なクエリを付けない（既定の一覧と同じ URL になる）", async () => {
		const { fetch, calls } = stubFetch(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		await fetchIssues({ fetchImpl: fetch });

		const url = new URL(calls[0] ?? "");
		expect(url.searchParams.get("scope")).toBeNull();
		expect(url.searchParams.get("status")).toBeNull();
		expect(url.searchParams.get("category")).toBeNull();
		expect(url.searchParams.get("q")).toBeNull();
		expect(url.searchParams.get("sort")).toBeNull();
		expect(url.searchParams.get("offset")).toBeNull();
	});

	// 手で連結していると、カテゴリやキーワードに含まれる `&` が
	// 別のパラメータとして解釈され、意図と違う絞り込みになる
	it("キーワードに含まれる記号をエスケープして送る", async () => {
		const { fetch, calls } = stubFetch(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		await fetchIssues({
			filters: { ...DEFAULT_ISSUE_FILTERS, q: "a&scope=global#x" },
			fetchImpl: fetch,
		});

		const url = new URL(calls[0] ?? "");
		expect(url.searchParams.get("q")).toBe("a&scope=global#x");
		// 記号がクエリを割ってしまっていないこと
		expect(url.searchParams.get("scope")).toBeNull();
	});

	it("要求した limit / offset を結果に添えて返す（ページング UI が使う）", async () => {
		const { fetch } = stubFetch(
			Response.json({ data: [], total: 100, limit: 20, offset: 0 }),
		);

		const result = await fetchIssues({
			limit: 10,
			filters: { ...DEFAULT_ISSUE_FILTERS, offset: 30 },
			fetchImpl: fetch,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.limit).toBe(10);
		expect(result.offset).toBe(30);
		expect(result.total).toBe(100);
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

describe("parseIssueFilters", () => {
	it("URL のクエリを絞り込み条件として読む", () => {
		const filters = parseIssueFilters({
			scope: "municipality",
			status: "resolved",
			category: "道路・交通",
			q: "街灯",
			sort: "oldest",
			offset: "40",
		});

		expect(filters).toEqual({
			scope: "municipality",
			status: "resolved",
			category: "道路・交通",
			q: "街灯",
			sort: "oldest",
			offset: 40,
		});
	});

	it("何も指定が無ければ既定値になる", () => {
		expect(parseIssueFilters({})).toEqual(DEFAULT_ISSUE_FILTERS);
	});

	// URL は利用者が手で編集できる。想定外の値でエラー画面を出さず、
	// 「その条件は無かったもの」として一覧を成立させる
	it("定義外の scope / status / sort は捨てる", () => {
		const filters = parseIssueFilters({
			scope: "galactic",
			status: "wontfix",
			sort: "random",
		});

		expect(filters.scope).toBeUndefined();
		expect(filters.status).toBeUndefined();
		expect(filters.sort).toBe("newest");
	});

	it("Object.prototype 由来の名前を値域として認めない", () => {
		const filters = parseIssueFilters({
			scope: "toString",
			status: "constructor",
			sort: "valueOf",
		});

		expect(filters.scope).toBeUndefined();
		expect(filters.status).toBeUndefined();
		expect(filters.sort).toBe("newest");
	});

	it("整数でない offset は先頭ページに倒す", () => {
		expect(parseIssueFilters({ offset: "abc" }).offset).toBe(0);
		expect(parseIssueFilters({ offset: "-5" }).offset).toBe(0);
		expect(parseIssueFilters({ offset: "1.5" }).offset).toBe(0);
		// 16 進表記も通さない（API 側の DecimalIntQueryParam と同じ契約）
		expect(parseIssueFilters({ offset: "0x10" }).offset).toBe(0);
	});

	it("空文字や空白だけの入力は未指定として扱う", () => {
		const filters = parseIssueFilters({ q: "   ", category: "", scope: "" });

		expect(filters.q).toBeUndefined();
		expect(filters.category).toBeUndefined();
		expect(filters.scope).toBeUndefined();
	});

	it("キーワードの前後の空白は落とす", () => {
		expect(parseIssueFilters({ q: "  街灯  " }).q).toBe("街灯");
	});

	// API 側の上限を超える値を送っても 400 になるだけなので、
	// ここで落として「その条件は無し」として描画を続ける
	it("上限を超える長さの入力は捨てる", () => {
		expect(parseIssueFilters({ q: "a".repeat(201) }).q).toBeUndefined();
		expect(parseIssueFilters({ q: "a".repeat(200) }).q).toHaveLength(200);
		expect(
			parseIssueFilters({ category: "a".repeat(101) }).category,
		).toBeUndefined();
		expect(
			parseIssueFilters({ category: "a".repeat(100) }).category,
		).toHaveLength(100);
	});

	it("同名キーが複数あるときは最初の値を使う（描画を落とさない）", () => {
		const filters = parseIssueFilters({ scope: ["national", "global"] });

		expect(filters.scope).toBe("national");
	});
});

describe("buildIssuesHref", () => {
	it("条件が既定値だけならクエリを付けない", () => {
		expect(buildIssuesHref(DEFAULT_ISSUE_FILTERS)).toBe("/issues");
	});

	it("指定された条件をクエリに載せる", () => {
		const href = buildIssuesHref({
			scope: "national",
			status: "open",
			category: "道路・交通",
			q: "街灯",
			sort: "oldest",
			offset: 20,
		});

		const url = new URL(href, "https://example.com");
		expect(url.pathname).toBe("/issues");
		expect(url.searchParams.get("scope")).toBe("national");
		expect(url.searchParams.get("status")).toBe("open");
		expect(url.searchParams.get("category")).toBe("道路・交通");
		expect(url.searchParams.get("q")).toBe("街灯");
		expect(url.searchParams.get("sort")).toBe("oldest");
		expect(url.searchParams.get("offset")).toBe("20");
	});

	// ページ送りのリンクを踏んだあとも条件が保たれること。
	// ここが壊れると「2 ページ目に行った瞬間に絞り込みが外れる」
	it("offset だけを差し替えても他の条件が落ちない", () => {
		const filters = parseIssueFilters({ scope: "global", q: "街灯" });
		const href = buildIssuesHref({ ...filters, offset: 20 });

		const url = new URL(href, "https://example.com");
		expect(url.searchParams.get("scope")).toBe("global");
		expect(url.searchParams.get("q")).toBe("街灯");
		expect(url.searchParams.get("offset")).toBe("20");
	});

	it("parseIssueFilters と往復して同じ条件に戻る", () => {
		const filters = {
			scope: "community",
			status: "review",
			category: "衛生・ごみ",
			q: "ゴミ",
			sort: "oldest",
			offset: 60,
		} as const;

		const href = buildIssuesHref(filters);
		const query = Object.fromEntries(
			new URL(href, "https://example.com").searchParams,
		);

		expect(parseIssueFilters(query)).toEqual(filters);
	});
});

describe("hasActiveFilters", () => {
	it("何も絞っていなければ false", () => {
		expect(hasActiveFilters(DEFAULT_ISSUE_FILTERS)).toBe(false);
	});

	it("ページを送っただけでは条件が付いているとは見なさない", () => {
		expect(hasActiveFilters({ ...DEFAULT_ISSUE_FILTERS, offset: 20 })).toBe(
			false,
		);
	});

	it("条件が 1 つでも付いていれば true", () => {
		expect(hasActiveFilters({ ...DEFAULT_ISSUE_FILTERS, q: "街灯" })).toBe(
			true,
		);
		expect(
			hasActiveFilters({ ...DEFAULT_ISSUE_FILTERS, scope: "global" }),
		).toBe(true);
		expect(hasActiveFilters({ ...DEFAULT_ISSUE_FILTERS, sort: "oldest" })).toBe(
			true,
		);
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

		expect(calls).toHaveLength(1);
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

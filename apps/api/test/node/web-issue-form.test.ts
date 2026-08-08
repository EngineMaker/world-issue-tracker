/**
 * Web の起票フォーム（`apps/web/src/lib/api.ts`）の検証ロジックのテスト。
 *
 * web ワークスペースにはテストランナーが無いため、Node 環境で動く
 * このスイートから対象モジュールを直接読み込んでいる。
 * 検証したいのは React に依存しない純粋な関数（入力の検証と
 * エラーメッセージの組み立て）なので、DOM は必要ない。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CreateIssueError,
	createIssue,
	type IssueFormValues,
	validateIssueForm,
} from "../../../web/src/lib/api";

/** 検証を通る入力。個々のテストでは崩したい項目だけ上書きする。 */
const VALID_INPUT: IssueFormValues = {
	title: "近所の街灯が切れている",
	description: "夜道が暗くて危ない",
	scope: "community",
	latitude: "35.681236",
	longitude: "139.767125",
	category: "安全",
	// フォームの初期状態と同じく、既定はチェックなし（＝匿名）。
	showName: false,
};

describe("validateIssueForm", () => {
	it("正しい入力を CreateIssue に変換する", () => {
		const result = validateIssueForm(VALID_INPUT);

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual({
			title: "近所の街灯が切れている",
			description: "夜道が暗くて危ない",
			scope: "community",
			latitude: 35.681236,
			longitude: 139.767125,
			category: "安全",
			is_anonymous: true,
		});
	});

	// 画面の「名前を出す」と API の `is_anonymous` は逆向きなので、
	// 反転が抜けていないことを両方向で見る。片方だけだと、
	// 常に true / 常に false を返す実装でも通ってしまう。
	it("「名前を出す」が未チェックなら匿名として送る", () => {
		const result = validateIssueForm({ ...VALID_INPUT, showName: false });

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.is_anonymous).toBe(true);
	});

	it("「名前を出す」にチェックすると匿名にしない", () => {
		const result = validateIssueForm({ ...VALID_INPUT, showName: true });

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.is_anonymous).toBe(false);
	});

	it("緯度経度を数値に変換する（文字列のまま送らない）", () => {
		const result = validateIssueForm(VALID_INPUT);

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(typeof result.data.latitude).toBe("number");
		expect(typeof result.data.longitude).toBe("number");
	});

	it("任意項目のカテゴリが未入力なら送信内容に含めない", () => {
		const result = validateIssueForm({ ...VALID_INPUT, category: "" });

		expect(result.success).toBe(true);
		if (!result.success) return;
		// 空文字のまま送ると API 側の `min(1)` で 400 になる
		expect(result.data.category).toBeUndefined();
	});

	it("前後の空白を除いたうえで検証する", () => {
		const result = validateIssueForm({
			...VALID_INPUT,
			title: "  街灯  ",
			latitude: " 35.5 ",
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.title).toBe("街灯");
		expect(result.data.latitude).toBe(35.5);
	});

	it("空白だけのタイトルを弾く", () => {
		const result = validateIssueForm({ ...VALID_INPUT, title: "   " });

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.fieldErrors.title?.length).toBeGreaterThan(0);
	});

	// 緯度経度は空欄でも `Number("")` が 0 になるため、
	// 「未入力」が「赤道・本初子午線の座標」として通ってしまう事故が起きうる。
	it.each([
		["緯度", "latitude"],
		["経度", "longitude"],
	] as const)("%s が未入力なら 0 として通さない", (_label, field) => {
		const result = validateIssueForm({ ...VALID_INPUT, [field]: "" });

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.fieldErrors[field]?.length).toBeGreaterThan(0);
	});

	it("数値でない緯度を弾く", () => {
		const result = validateIssueForm({ ...VALID_INPUT, latitude: "abc" });

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.fieldErrors.latitude?.length).toBeGreaterThan(0);
	});

	// 制約は packages/shared のスキーマ側にあり、ここで書き直していないことの確認。
	// スキーマの範囲外の値がフォームを素通りしてしまうと、API で 400 になる。
	it.each([
		["緯度の上限超え", { latitude: "91" }],
		["緯度の下限未満", { latitude: "-91" }],
		["経度の上限超え", { longitude: "181" }],
		["経度の下限未満", { longitude: "-181" }],
	])("%s を弾く", (_label, override) => {
		const result = validateIssueForm({ ...VALID_INPUT, ...override });

		expect(result.success).toBe(false);
	});

	it("スキーマにないスコープを弾く", () => {
		const result = validateIssueForm({ ...VALID_INPUT, scope: "galactic" });

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.fieldErrors.scope?.length).toBeGreaterThan(0);
	});

	it("長すぎるタイトルを弾く", () => {
		const result = validateIssueForm({
			...VALID_INPUT,
			title: "あ".repeat(201),
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.fieldErrors.title?.length).toBeGreaterThan(0);
	});
});

describe("createIssue", () => {
	/**
	 * `fetch` を差し替えて、渡されたリクエストを観測できるようにする。
	 *
	 * 引数を受け取る形で宣言しているのは、`mock.calls` から
	 * URL と `RequestInit` を型付きで取り出すため。
	 */
	function mockFetch(response: Response | Error) {
		const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
			response instanceof Error
				? Promise.reject(response)
				: Promise.resolve(response),
		);
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	const input = {
		title: "街灯",
		description: "切れている",
		scope: "community",
		latitude: 35.5,
		longitude: 139.5,
		// `CreateIssue` は `validateIssueForm` を通った後の形なので、
		// `is_anonymous` は既に確定している（`.default(true)` が適用済み）。
		is_anonymous: true,
	} as const;

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// Web と API は別オリジンなので Clerk の Cookie は届かない。
	// Bearer が抜けると API 側で 401 になる（かつ Origin 検証も走る）ため、
	// ヘッダに載っていることをリクエストの中身で確認する。
	it("セッショントークンを Authorization: Bearer で送る", async () => {
		const fetchMock = mockFetch(
			new Response(JSON.stringify({ id: "issue-1" }), { status: 201 }),
		);

		await createIssue(input, "session-token");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const call = fetchMock.mock.calls[0];
		if (!call) throw new Error("fetch が呼ばれていない");
		const [url, init] = call;
		expect(url).toMatch(/\/issues$/);
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer session-token");
		// simple request にせず、必ずプリフライトを経由させるためのヘッダでもある
		// （API 側の Origin 検証と併せて CSRF の前提になっている）
		expect(headers["Content-Type"]).toBe("application/json");
		expect(JSON.parse(init.body as string)).toEqual(input);
	});

	// 未ログインのまま通信させると、CORS エラーなど分かりにくい失敗になる。
	it("トークンが無ければ送信せず 401 のエラーを投げる", async () => {
		const fetchMock = mockFetch(new Response("{}", { status: 201 }));

		await expect(createIssue(input, null)).rejects.toBeInstanceOf(
			CreateIssueError,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("API のバリデーションエラーの中身をメッセージに含める", async () => {
		mockFetch(
			new Response(
				JSON.stringify({
					error: {
						formErrors: [],
						fieldErrors: { title: ["Too short"] },
					},
				}),
				{ status: 400 },
			),
		);

		await expect(createIssue(input, "t")).rejects.toMatchObject({
			status: 400,
			message: expect.stringContaining("Too short"),
		});
	});

	// `POST /issues` が返す `flatten()` の結果には、特定のフィールドに紐づかない
	// エラーが `formErrors` に入る。ここを読み落とすと原因が一切表示されない。
	it("フィールドに紐づかないエラー(formErrors)もメッセージに含める", async () => {
		mockFetch(
			new Response(
				JSON.stringify({
					error: { formErrors: ["Invalid payload"], fieldErrors: {} },
				}),
				{ status: 400 },
			),
		);

		await expect(createIssue(input, "t")).rejects.toMatchObject({
			message: expect.stringContaining("Invalid payload"),
		});
	});

	it("文字列で返るエラー(`{ error: '...' }`)をそのまま伝える", async () => {
		mockFetch(
			new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 }),
		);

		await expect(createIssue(input, "t")).rejects.toMatchObject({
			message: "Invalid JSON",
		});
	});

	// 401 と 403 は利用者が取るべき行動が違う（サインインし直す / 諦める）。
	// 定型文に退化したり取り違えたりすると、要件「何が起きたかを伝える」を満たさない。
	it("401 ではサインインを促すメッセージにする", async () => {
		mockFetch(new Response(JSON.stringify({}), { status: 401 }));

		const error = await createIssue(input, "t").catch((e) => e);
		expect(error).toBeInstanceOf(CreateIssueError);
		expect(error.status).toBe(401);
		expect(error.message).toContain("ログイン");
	});

	it("403 ではサインインを促さない（促しても解決しないため）", async () => {
		mockFetch(new Response(JSON.stringify({}), { status: 403 }));

		const error = await createIssue(input, "t").catch((e) => e);
		expect(error.status).toBe(403);
		expect(error.message).toContain("許可されていません");
		expect(error.message).not.toContain("ログイン");
	});

	// Workers が返す 5xx は HTML やプレーンテキストのことがある。
	// JSON 解析に失敗してそのまま例外が漏れると、利用者には何も表示されない。
	it("JSON でないエラー応答でも CreateIssueError にする", async () => {
		mockFetch(new Response("<html>error</html>", { status: 500 }));

		const error = await createIssue(input, "t").catch((e) => e);
		expect(error).toBeInstanceOf(CreateIssueError);
		expect(error.status).toBe(500);
	});

	it("通信自体が失敗した場合もエラーメッセージにする", async () => {
		mockFetch(new TypeError("Failed to fetch"));

		const error = await createIssue(input, "t").catch((e) => e);
		expect(error).toBeInstanceOf(CreateIssueError);
		expect(error.status).toBeNull();
	});
});

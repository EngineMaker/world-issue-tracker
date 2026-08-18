/**
 * Web のコメント関連ロジック（`apps/web/src/lib/comments.ts`）のテスト。
 *
 * web ワークスペースにはテストランナーが無いため、Node 環境で動く
 * このスイートから対象モジュールを直接読み込んでいる
 * （`web-issue-form.test.ts` と同じ理由）。
 */

import { describe, expect, it, vi } from "vitest";
import {
	applyViewerFlags,
	COMMENT_MAX_LENGTH,
	DeleteCommentError,
	deleteComment,
	PostCommentError,
	parseListCommentsResponse,
	parsePublicComment,
	postComment,
	validateCommentBody,
} from "../../../web/src/lib/comments";

/** API が返すコメント 1 件の形。個々のテストでは崩したい項目だけ上書きする。 */
const VALID_COMMENT = {
	id: "c1",
	issue_id: "i1",
	body: "私も困っています",
	created_at: "2026-01-01 00:00:00.000",
	// 投稿者の表示（#67）。`is_anonymous` は「この投稿者を匿名として扱うか」で、
	// 匿名で立てられた Issue の起票者本人のコメントだけ真になる。
	// `display_name` は Clerk から引いた表示名（未設定・取得失敗なら null）
	is_anonymous: false,
	display_name: "花子 山田",
	// 「これを書いたのは閲覧者本人か」（#99）。削除ボタンの出し分けに使う。
	// トークンを付けずに取得したときは常に false
	viewer_is_author: false,
};

describe("validateCommentBody", () => {
	it("通常の本文を受け付ける", () => {
		const result = validateCommentBody("直しましょう");

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.body).toBe("直しましょう");
	});

	it("前後の空白を落とす（API 側の trim と一致させる）", () => {
		const result = validateCommentBody("  直しましょう  ");

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.body).toBe("直しましょう");
	});

	it("空文字を拒否する", () => {
		const result = validateCommentBody("");

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toContain("入力してください");
	});

	it("空白だけの本文を拒否する", () => {
		// これを通すと、一覧に読めない行が増えるうえ API 側で 400 になる
		const result = validateCommentBody("   \n\t  ");

		expect(result.success).toBe(false);
	});

	it("上限を超える本文を拒否する", () => {
		const result = validateCommentBody("あ".repeat(COMMENT_MAX_LENGTH + 1));

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toContain(String(COMMENT_MAX_LENGTH));
	});

	it("上限ちょうどの本文は受け付ける", () => {
		// 拒否だけを固定すると上限を狭める退行を拾えない
		const body = "あ".repeat(COMMENT_MAX_LENGTH);
		const result = validateCommentBody(body);

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.body).toBe(body);
	});

	it("末尾の空白だけで上限を超える入力は受け付ける", () => {
		// trim してから長さを見るので、見た目の文字数と判定が一致する
		const result = validateCommentBody(`${"あ".repeat(COMMENT_MAX_LENGTH)}   `);

		expect(result.success).toBe(true);
	});
});

describe("parsePublicComment", () => {
	it("正しい形をそのまま返す", () => {
		expect(parsePublicComment(VALID_COMMENT)).toEqual(VALID_COMMENT);
	});

	it("公開されるべきでないフィールドを持ち込まない", () => {
		// API が誤って `user_id` を返しても、画面側の型には入れない
		const parsed = parsePublicComment({
			...VALID_COMMENT,
			user_id: "secret-user",
		});

		expect(parsed).not.toBeNull();
		expect(parsed).not.toHaveProperty("user_id");
	});

	it.each([
		["id が無い", { ...VALID_COMMENT, id: undefined }],
		["id が数値", { ...VALID_COMMENT, id: 1 }],
		["issue_id が無い", { ...VALID_COMMENT, issue_id: undefined }],
		["body が数値", { ...VALID_COMMENT, body: 123 }],
		["body が null", { ...VALID_COMMENT, body: null }],
		["created_at が数値", { ...VALID_COMMENT, created_at: 0 }],
	])("形が違えば null を返す: %s", (_label, value) => {
		expect(parsePublicComment(value)).toBeNull();
	});

	it("オブジェクトでなければ null を返す", () => {
		expect(parsePublicComment(null)).toBeNull();
		expect(parsePublicComment("comment")).toBeNull();
		expect(parsePublicComment(42)).toBeNull();
	});

	// --- viewer_is_author（#99） ---

	it("viewer_is_author が無ければ false に倒す", () => {
		// これを返さない古い API に対してコメント欄ごと失敗させない。
		// 倒す先は false（削除ボタンを出さない）。true に倒すと、他人の
		// コメントに削除ボタンが出て、押しても 403 で失敗する
		const { viewer_is_author: _omitted, ...withoutFlag } = VALID_COMMENT;

		expect(parsePublicComment(withoutFlag)?.viewer_is_author).toBe(false);
	});

	it("viewer_is_author が真偽値でなければ null を返す", () => {
		// 「無い」と「形が違う」は別。文字列の "true" を通すと、
		// 真偽値として評価したときに全件が自分のものになる
		expect(
			parsePublicComment({ ...VALID_COMMENT, viewer_is_author: "true" }),
		).toBeNull();
	});

	it("viewer_is_author が true ならそのまま通す", () => {
		expect(
			parsePublicComment({ ...VALID_COMMENT, viewer_is_author: true })
				?.viewer_is_author,
		).toBe(true);
	});
});

describe("parseListCommentsResponse", () => {
	it("一覧レスポンスを解釈する", () => {
		const parsed = parseListCommentsResponse({
			data: [VALID_COMMENT],
			total: 1,
		});

		expect(parsed).toEqual({ comments: [VALID_COMMENT], total: 1 });
	});

	it("空の一覧を受け付ける", () => {
		expect(parseListCommentsResponse({ data: [], total: 0 })).toEqual({
			comments: [],
			total: 0,
		});
	});

	it("1 件でも形が違えば全体を失敗にする", () => {
		// 一部だけ欠けた会話を「これで全部です」という顔で見せない
		const parsed = parseListCommentsResponse({
			data: [VALID_COMMENT, { ...VALID_COMMENT, body: 123 }],
			total: 2,
		});

		expect(parsed).toBeNull();
	});

	it.each([
		["data が配列でない", { data: "comments", total: 0 }],
		["total が無い", { data: [] }],
		["total が文字列", { data: [], total: "0" }],
		["オブジェクトでない", null],
	])("形が違えば null を返す: %s", (_label, value) => {
		expect(parseListCommentsResponse(value)).toBeNull();
	});
});

describe("postComment", () => {
	/**
	 * 指定のレスポンスを返す `fetch` を作る。呼び出し内容も観測できるようにする。
	 *
	 * 引数を受け取る形で宣言しているのは、`mock.calls` から URL と init を
	 * 型付きで取り出すため（引数なしの関数だと `calls[0]` が空タプルになる）。
	 */
	function fetchReturning(response: Response) {
		return vi.fn(async (_url: string, _init?: RequestInit) => response);
	}

	function jsonResponse(body: unknown, status = 201): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}

	it("Bearer トークンを付けて POST する", async () => {
		// Web と API は別オリジンなので Cookie は届かない。
		// トークンを載せ忘れると本番でだけ 401 になる
		const fetchImpl = fetchReturning(jsonResponse(VALID_COMMENT));

		await postComment("i1", "直しましょう", "tok_123", fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		// 直前に 1 回呼ばれたことを確認済みなので、0 番目は必ずある
		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toContain("/issues/i1/comments");
		expect(init?.method).toBe("POST");
		expect((init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok_123",
		);
		expect(JSON.parse(init?.body as string)).toEqual({ body: "直しましょう" });
	});

	it("Issue ID をエスケープする", async () => {
		// エスケープしないと `/` を含む値が別のエンドポイントを指しうる
		const fetchImpl = fetchReturning(jsonResponse(VALID_COMMENT));

		await postComment("a/b?c", "本文", "tok_123", fetchImpl);

		const [url] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toContain("/issues/a%2Fb%3Fc/comments");
	});

	it("作成されたコメントを返す", async () => {
		const fetchImpl = fetchReturning(jsonResponse(VALID_COMMENT));

		const created = await postComment("i1", "本文", "tok_123", fetchImpl);

		expect(created).toEqual(VALID_COMMENT);
	});

	it("トークンが無ければ通信せずに 401 のエラーを投げる", async () => {
		const fetchImpl = fetchReturning(jsonResponse(VALID_COMMENT));

		await expect(
			postComment("i1", "本文", null, fetchImpl),
		).rejects.toBeInstanceOf(PostCommentError);
		// 通信そのものを行わない（無駄なリクエストを投げない）
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("401 を利用者向けの文言に変える", async () => {
		const fetchImpl = fetchReturning(
			jsonResponse({ error: "Unauthorized" }, 401),
		);

		await expect(
			postComment("i1", "本文", "tok_123", fetchImpl),
		).rejects.toMatchObject({
			status: 401,
			message: expect.stringContaining("ログイン"),
		});
	});

	it("404 を利用者向けの文言に変える", async () => {
		const fetchImpl = fetchReturning(
			jsonResponse({ error: "Issue not found" }, 404),
		);

		await expect(
			postComment("i1", "本文", "tok_123", fetchImpl),
		).rejects.toMatchObject({
			status: 404,
			message: expect.stringContaining("見つかりません"),
		});
	});

	it("バリデーションエラーの内容を取り出す", async () => {
		const fetchImpl = fetchReturning(
			jsonResponse(
				{
					error: {
						formErrors: [],
						fieldErrors: { body: ["String must contain at least 1 character"] },
					},
				},
				400,
			),
		);

		await expect(
			postComment("i1", "", "tok_123", fetchImpl),
		).rejects.toMatchObject({
			status: 400,
			message: expect.stringContaining("at least 1 character"),
		});
	});

	it("JSON でないエラー本文でもステータス由来の文言で失敗させる", async () => {
		const fetchImpl = fetchReturning(
			new Response("<html>502</html>", { status: 502 }),
		);

		await expect(
			postComment("i1", "本文", "tok_123", fetchImpl),
		).rejects.toMatchObject({
			status: 502,
			message: expect.stringContaining("502"),
		});
	});

	it("通信そのものが失敗したら status なしのエラーを投げる", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("Failed to fetch");
		});

		await expect(
			postComment("i1", "本文", "tok_123", fetchImpl),
		).rejects.toMatchObject({
			status: null,
			message: expect.stringContaining("接続できません"),
		});
	});

	it("成功レスポンスの形が想定と違えば失敗として扱う", async () => {
		// 壊れた値を一覧に挿し込むより、再読み込みを促す方が安全
		const fetchImpl = fetchReturning(jsonResponse({ id: 1 }, 201));

		await expect(
			postComment("i1", "本文", "tok_123", fetchImpl),
		).rejects.toBeInstanceOf(PostCommentError);
	});
});

describe("deleteComment", () => {
	function fetchReturning(response: Response) {
		return vi.fn(async (_url: string, _init?: RequestInit) => response);
	}

	it("Bearer トークンを付けて DELETE する", async () => {
		// Web と API は別オリジンなので Cookie は届かない。
		// トークンを載せ忘れると本番でだけ 401 になる
		const fetchImpl = fetchReturning(new Response(null, { status: 204 }));

		await deleteComment("i1", "c1", "tok_123", fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toContain("/issues/i1/comments/c1");
		expect(init?.method).toBe("DELETE");
		expect((init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok_123",
		);
	});

	it("ID をエスケープする", async () => {
		// エスケープしないと `/` を含む値が別のエンドポイントを指しうる
		const fetchImpl = fetchReturning(new Response(null, { status: 204 }));

		await deleteComment("a/b", "c/d", "tok_123", fetchImpl);

		const [url] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toContain("/issues/a%2Fb/comments/c%2Fd");
	});

	it("トークンが無ければ通信せずに 401 のエラーを投げる", async () => {
		const fetchImpl = fetchReturning(new Response(null, { status: 204 }));

		await expect(
			deleteComment("i1", "c1", null, fetchImpl),
		).rejects.toBeInstanceOf(DeleteCommentError);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("403 はそのステータスのまま失敗として扱う", async () => {
		// 他人のコメントは API が弾く。画面側の出し分けを迂回されても消えない
		const fetchImpl = fetchReturning(
			new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
		);

		await expect(
			deleteComment("i1", "c1", "tok_123", fetchImpl),
		).rejects.toMatchObject({ status: 403 });
	});

	it("404 も失敗として扱う（消えたことにしない）", async () => {
		const fetchImpl = fetchReturning(
			new Response(JSON.stringify({ error: "Comment not found" }), {
				status: 404,
			}),
		);

		await expect(
			deleteComment("i1", "c1", "tok_123", fetchImpl),
		).rejects.toMatchObject({ status: 404 });
	});

	it("通信そのものが失敗したら status なしのエラーを投げる", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("Failed to fetch");
		});

		await expect(
			deleteComment("i1", "c1", "tok_123", fetchImpl),
		).rejects.toMatchObject({ status: null });
	});
});

describe("applyViewerFlags", () => {
	const base = {
		issue_id: "i1",
		created_at: "2026-01-01 00:00:00.000",
		is_anonymous: false,
		display_name: null,
	};
	const comment = (id: string, viewer_is_author = false) => ({
		...base,
		id,
		body: id,
		viewer_is_author,
	});

	it("取り直しで自分のものだった行だけ true になる", () => {
		const current = [comment("a"), comment("b")];
		const fetched = [comment("a", true), comment("b")];

		expect(
			applyViewerFlags(current, fetched).map((c) => c.viewer_is_author),
		).toEqual([true, false]);
	});

	it("手元にしか無いコメントを落とさない", () => {
		// 取り直しの最中に投稿されたコメントは手元にしか無い。
		// 一覧を丸ごと差し替える実装だと、書いた直後に消える
		const current = [comment("a"), comment("just-posted", true)];
		const fetched = [comment("a", true)];

		const merged = applyViewerFlags(current, fetched);

		expect(merged.map((c) => c.id)).toEqual(["a", "just-posted"]);
		expect(merged[1]?.viewer_is_author).toBe(true);
	});

	it("取り直しに含まれない行の true を false へ戻さない", () => {
		// 投稿が届く前の一覧が返ってくることがある。それで自分の投稿が
		// 「自分のものではない」ことにされると、消せなくなる
		const current = [comment("just-posted", true)];

		expect(
			applyViewerFlags(current, []).map((c) => c.viewer_is_author),
		).toEqual([true]);
	});

	it("取り直しにしか無い行は増やさない", () => {
		// 目的は削除ボタンの出し分けだけ。会話そのものの更新はしない
		const current = [comment("a")];
		const fetched = [comment("a"), comment("someone-elses")];

		expect(applyViewerFlags(current, fetched).map((c) => c.id)).toEqual(["a"]);
	});
});

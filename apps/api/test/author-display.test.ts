import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 他の API テストと同じく、`@hono/clerk-auth` ではなく内部の `@clerk/backend` を
// モックして `clerkMiddleware` の本体は実物を通す（理由は helpers/clerk-mock.ts）。
vi.mock("@clerk/backend", async () => {
	const { clerkBackendMockFactory } = await import("./helpers/clerk-mock");
	return clerkBackendMockFactory();
});

import { createApp } from "../src/index";
import {
	getUserListCalls,
	resetMockClerkUsers,
	setMockClerkUsers,
	setMockUserId,
	setMockUserListError,
} from "./helpers/clerk-mock";
import { applyMigrations } from "./helpers/migrate";

/**
 * 起票者とコメント投稿者の表示名（#67）。
 *
 * #108 が「手伝います」の表明者に入れた仕組み（`lib/display-names.ts`）を、
 * Issue の起票者とコメントの投稿者へ広げたもの。3 箇所で名前の出方が
 * 食い違うと利用者が混乱するため、規則の検証を 1 ファイルにまとめている。
 *
 * ここで守りたい規則は 4 つ:
 *
 * 1. 匿名を選んだ人には表示名を出さない（Clerk へ問い合わせもしない）
 * 2. 表示名が未設定でも一覧は出る（`display_name` が null になるだけ）
 * 3. Clerk への問い合わせが失敗しても一覧は必ず出る
 * 4. まとめて取得する（1 人ずつ問い合わせない）
 *
 * 生の `user_id` を新たに公開しないことは、`issues.test.ts` の
 * `Public response fields` / `Defence layers` が引き続き見ている。
 */

const app = createApp();

// biome-ignore lint/suspicious/noExplicitAny: テストからレスポンスを緩く読むための意図的な型
type Body = Record<string, any>;

async function readBody(res: Response): Promise<Body> {
	return (await res.json()) as Body;
}

/**
 * Issue を DB へ直接投入する。
 *
 * API 経由で作ると認証状態の切り替えがテストの本筋（表示名の出し分け）と
 * 絡むため、前提データはここで用意する。`is_anonymous` は SQLite の
 * 0/1 で持つので、真偽値をそのまま渡せるようにしている。
 */
async function insertIssue(
	id: string,
	userId: string | null,
	isAnonymous: boolean,
	createdAt = "2026-01-01 00:00:00.000",
): Promise<string> {
	await env.DB.prepare(
		`INSERT INTO issues (id, title, description, scope, latitude, longitude, user_id, is_anonymous, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			`街灯が切れている（${id}）`,
			"夜道が暗い",
			"community",
			35.68,
			139.76,
			userId,
			isAnonymous ? 1 : 0,
			createdAt,
			createdAt,
		)
		.run();
	return id;
}

async function insertComment(
	id: string,
	issueId: string,
	userId: string,
	body: string,
	createdAt = "2026-01-01 00:00:00.000",
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO comments (id, issue_id, user_id, body, created_at)
     VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(id, issueId, userId, body, createdAt)
		.run();
}

/** Clerk 側に「表示名を持つ人」として登録する。 */
function clerkUser(id: string, firstName: string, lastName: string) {
	return { id, firstName, lastName, username: null };
}

describe("起票者とコメント投稿者の表示名（#67）", () => {
	beforeAll(async () => {
		await applyMigrations();
	});

	beforeEach(async () => {
		await env.DB.exec("DELETE FROM comments");
		await env.DB.exec("DELETE FROM issues");
		setMockUserId(null);
		resetMockClerkUsers();
	});

	describe("Issue の起票者", () => {
		it("名乗っている起票者の表示名を display_name として返す", async () => {
			await insertIssue("i1", "user_named", false);
			setMockClerkUsers([clerkUser("user_named", "花子", "山田")]);

			const res = await app.request("/issues", {}, env);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.data[0].display_name).toBe("花子 山田");
		});

		// この Issue の核心。匿名を選んだ人の名前は、どの経路からも出ない。
		it("匿名の Issue には display_name を出さない", async () => {
			await insertIssue("i1", "user_named", true);
			setMockClerkUsers([clerkUser("user_named", "花子", "山田")]);

			const res = await app.request("/issues", {}, env);
			const body = await readBody(res);
			expect(body.data[0].display_name).toBeNull();
			expect(JSON.stringify(body)).not.toContain("花子");
		});

		// 「出さない」だけでなく「問い合わせない」ところまで守る。
		// Clerk へ ID を送ってしまうと、匿名で書いた人の身元が
		// 外部サービスの側で「この Issue を見た人が引いた ID」として残る。
		it("匿名の Issue の user_id を Clerk へ送らない", async () => {
			await insertIssue("i1", "user_anon", true);
			await insertIssue("i2", "user_named", false);
			setMockClerkUsers([clerkUser("user_named", "花子", "山田")]);

			await app.request("/issues", {}, env);

			const sentIds = getUserListCalls().flat();
			expect(sentIds).toContain("user_named");
			expect(sentIds).not.toContain("user_anon");
		});

		it("全員が匿名なら Clerk へ問い合わせない", async () => {
			await insertIssue("i1", "user_a", true);
			await insertIssue("i2", "user_b", true);

			await app.request("/issues", {}, env);

			expect(getUserListCalls()).toHaveLength(0);
		});

		it("表示名が未設定のユーザーは display_name が null", async () => {
			await insertIssue("i1", "user_blank", false);
			setMockClerkUsers([
				{ id: "user_blank", firstName: null, lastName: null, username: null },
			]);

			const res = await app.request("/issues", {}, env);
			const body = await readBody(res);
			expect(body.data[0].display_name).toBeNull();
		});

		// 認証導入前に入った行は user_id が NULL。匿名扱いのまま素通りさせる。
		it("user_id が NULL の行でも壊れない", async () => {
			await insertIssue("i1", null, false);

			const res = await app.request("/issues", {}, env);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.data[0].display_name).toBeNull();
			expect(getUserListCalls()).toHaveLength(0);
		});

		// 規則 4。表示名は「あると嬉しい」情報であって、それが取れないことで
		// 困りごとの一覧が見えなくなるのは本末転倒。
		it("Clerk への問い合わせが失敗しても一覧は返る", async () => {
			await insertIssue("i1", "user_named", false);
			setMockClerkUsers([clerkUser("user_named", "花子", "山田")]);
			setMockUserListError(new Error("Clerk is down"));

			const res = await app.request("/issues", {}, env);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.data).toHaveLength(1);
			expect(body.data[0].display_name).toBeNull();
		});

		// 規則 5。1 人ずつ問い合わせるとレート制限（本番 1000 req / 10 秒）に
		// すぐ触れる。一覧の上限 100 件は 1 回で収まる。
		it("複数の起票者をまとめて 1 回で問い合わせる", async () => {
			for (let i = 0; i < 5; i++) {
				await insertIssue(
					`i${i}`,
					`user_${i}`,
					false,
					`2026-01-01 00:00:0${i}.000`,
				);
			}
			setMockClerkUsers(
				Array.from({ length: 5 }, (_, i) =>
					clerkUser(`user_${i}`, `名前${i}`, "テスト"),
				),
			);

			const res = await app.request("/issues", {}, env);
			const body = await readBody(res);

			expect(body.data).toHaveLength(5);
			const calls = getUserListCalls();
			expect(calls).toHaveLength(1);
			expect(calls[0]).toHaveLength(5);
		});

		it("同じ起票者の Issue が並んでも ID は重複して送らない", async () => {
			await insertIssue("i1", "user_same", false, "2026-01-01 00:00:01.000");
			await insertIssue("i2", "user_same", false, "2026-01-01 00:00:02.000");
			setMockClerkUsers([clerkUser("user_same", "花子", "山田")]);

			const res = await app.request("/issues", {}, env);
			const body = await readBody(res);

			expect(body.data.map((issue: Body) => issue.display_name)).toEqual([
				"花子 山田",
				"花子 山田",
			]);
			expect(getUserListCalls()[0]).toEqual(["user_same"]);
		});

		// 「Clerk へ送らない」だけでは匿名を守り切れない。同じ人が匿名の Issue と
		// 名乗った Issue を両方持っていると、その user_id は名乗った側のために
		// Clerk へ送られ、表示名が手元に載る。返す直前の匿名判定
		// （`withAuthorNames` の `issue.is_anonymous || ...`）が無いと、
		// そこで匿名側にも名前が入る。
		//
		// 送信 ID の filter とレスポンス組み立ての 2 段構えのうち、
		// 2 段目だけを消しても他のテストは全部通ってしまうため、この形で押さえる。
		it("同じ人が匿名と実名の Issue を持っていても、匿名側に名前が漏れない", async () => {
			await insertIssue("i-anon", "user_same", true, "2026-01-01 00:00:01.000");
			await insertIssue(
				"i-named",
				"user_same",
				false,
				"2026-01-01 00:00:02.000",
			);
			setMockClerkUsers([clerkUser("user_same", "花子", "山田")]);

			const body = await readBody(await app.request("/issues", {}, env));
			expect(body.data).toHaveLength(2);

			const anon = body.data.find((issue: Body) => issue.id === "i-anon");
			const named = body.data.find((issue: Body) => issue.id === "i-named");

			// 名乗った側には出る（前提が成立していることの確認。ここが null だと
			// 「そもそも引けていないだけ」で下の assertion が通ってしまう）
			expect(named.display_name).toBe("花子 山田");
			expect(anon.display_name).toBeNull();
		});

		// 詳細ページも同じ経路を通るが、こちらは 1 件しか読まないので
		// 「他の行のために引いた名前が混ざる」ことは起きない。
		// 代わりに、匿名の 1 件だけを読んだときに Clerk を叩かないことを見る
		// （上のテストと合わせて、匿名側は送りも受けもしないことになる）。
		it("詳細（GET /issues/:id）でも同じ規則が働く", async () => {
			await insertIssue("i1", "user_named", false);
			await insertIssue("i2", "user_anon", true);
			setMockClerkUsers([
				clerkUser("user_named", "花子", "山田"),
				clerkUser("user_anon", "太郎", "鈴木"),
			]);

			const named = await readBody(await app.request("/issues/i1", {}, env));
			expect(named.display_name).toBe("花子 山田");

			const anon = await readBody(await app.request("/issues/i2", {}, env));
			expect(anon.display_name).toBeNull();
			expect(JSON.stringify(anon)).not.toContain("太郎");
		});

		it("詳細でも Clerk の失敗が 200 を壊さない", async () => {
			await insertIssue("i1", "user_named", false);
			setMockUserListError(new Error("Clerk is down"));

			const res = await app.request("/issues/i1", {}, env);
			expect(res.status).toBe(200);
			expect((await readBody(res)).display_name).toBeNull();
		});

		it("自分の Issue 一覧（/issues/mine）でも表示名が出る", async () => {
			await insertIssue("i1", "user_me", false);
			setMockClerkUsers([clerkUser("user_me", "自分", "テスト")]);
			setMockUserId("user_me");

			const res = await app.request("/issues/mine", {}, env);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.data[0].display_name).toBe("自分 テスト");
		});

		// 表示名を載せるために SELECT が user_id を読むようになるが、
		// レスポンスへ出てはいけない。二段構えの 2 段目（`toPublicIssue`）が
		// 落とし続けていることを、実際のレスポンスで確かめる。
		it("表示名を返しても生の user_id は公開しない", async () => {
			await insertIssue("i1", "user_2abcSECRETclerkid", false);
			setMockClerkUsers([clerkUser("user_2abcSECRETclerkid", "花子", "山田")]);

			const list = await readBody(await app.request("/issues", {}, env));
			expect(list.data[0]).not.toHaveProperty("user_id");
			expect(JSON.stringify(list)).not.toContain("user_2abcSECRETclerkid");

			const detail = await readBody(await app.request("/issues/i1", {}, env));
			expect(detail).not.toHaveProperty("user_id");
			expect(JSON.stringify(detail)).not.toContain("user_2abcSECRETclerkid");
		});
	});

	describe("コメントの投稿者", () => {
		it("投稿者の表示名を display_name として返す", async () => {
			await insertIssue("i1", "user_author", false);
			await insertComment("c1", "i1", "user_commenter", "似た経験があります");
			setMockClerkUsers([clerkUser("user_commenter", "次郎", "佐藤")]);

			const res = await app.request("/issues/i1/comments", {}, env);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.data[0].display_name).toBe("次郎 佐藤");
			expect(body.data[0].is_anonymous).toBe(false);
		});

		// コメントに匿名の経路は無いが、匿名で立てた Issue に本人が
		// コメントすると、そこだけ実名が出て匿名の選択が壊れる。
		// 「その Issue の匿名性を壊さない」という規則で塞ぐ。
		it("匿名で立てた Issue の起票者本人のコメントには表示名を出さない", async () => {
			await insertIssue("i1", "user_author", true);
			await insertComment("c1", "i1", "user_author", "書いた本人の追記です");
			setMockClerkUsers([clerkUser("user_author", "花子", "山田")]);

			const res = await app.request("/issues/i1/comments", {}, env);
			const body = await readBody(res);
			expect(body.data[0].display_name).toBeNull();
			expect(body.data[0].is_anonymous).toBe(true);
			expect(JSON.stringify(body)).not.toContain("花子");
		});

		it("匿名で立てた Issue の起票者本人の user_id は Clerk へ送らない", async () => {
			await insertIssue("i1", "user_author", true);
			await insertComment(
				"c1",
				"i1",
				"user_author",
				"本人",
				"2026-01-01 00:00:01.000",
			);
			await insertComment(
				"c2",
				"i1",
				"user_other",
				"第三者",
				"2026-01-01 00:00:02.000",
			);
			setMockClerkUsers([clerkUser("user_other", "次郎", "佐藤")]);

			await app.request("/issues/i1/comments", {}, env);

			const sentIds = getUserListCalls().flat();
			expect(sentIds).toContain("user_other");
			expect(sentIds).not.toContain("user_author");
		});

		// 匿名で守るのは「その Issue を匿名で書いた」という選択であって、
		// 本人が別の場所で自分の意思で発言することまでは覆わない
		// （#108 の「手伝いますは自ら名乗り出る行為」と同じ考え方）。
		it("匿名の Issue でも第三者のコメントには表示名を出す", async () => {
			await insertIssue("i1", "user_author", true);
			await insertComment("c1", "i1", "user_other", "こういう制度があります");
			setMockClerkUsers([clerkUser("user_other", "次郎", "佐藤")]);

			const res = await app.request("/issues/i1/comments", {}, env);
			const body = await readBody(res);
			expect(body.data[0].display_name).toBe("次郎 佐藤");
			expect(body.data[0].is_anonymous).toBe(false);
		});

		it("名乗っている Issue なら起票者本人のコメントにも表示名を出す", async () => {
			await insertIssue("i1", "user_author", false);
			await insertComment("c1", "i1", "user_author", "その後の状況です");
			setMockClerkUsers([clerkUser("user_author", "花子", "山田")]);

			const res = await app.request("/issues/i1/comments", {}, env);
			const body = await readBody(res);
			expect(body.data[0].display_name).toBe("花子 山田");
			expect(body.data[0].is_anonymous).toBe(false);
		});

		it("表示名が未設定の投稿者は display_name が null（匿名扱いにはしない）", async () => {
			await insertIssue("i1", "user_author", false);
			await insertComment("c1", "i1", "user_blank", "本文");
			setMockClerkUsers([
				{ id: "user_blank", firstName: null, lastName: null, username: null },
			]);

			const res = await app.request("/issues/i1/comments", {}, env);
			const body = await readBody(res);
			expect(body.data[0].display_name).toBeNull();
			// 「名乗ったが名前が無い」と「匿名を選んだ」を混同しない。
			// 画面はこの真偽値で文言を出し分ける
			expect(body.data[0].is_anonymous).toBe(false);
		});

		it("Clerk への問い合わせが失敗してもコメント一覧は返る", async () => {
			await insertIssue("i1", "user_author", false);
			await insertComment("c1", "i1", "user_commenter", "本文");
			setMockUserListError(new Error("Clerk is down"));

			const res = await app.request("/issues/i1/comments", {}, env);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.data).toHaveLength(1);
			expect(body.data[0].body).toBe("本文");
			expect(body.data[0].display_name).toBeNull();
		});

		it("複数の投稿者をまとめて 1 回で問い合わせる", async () => {
			await insertIssue("i1", "user_author", false);
			for (let i = 0; i < 5; i++) {
				await insertComment(
					`c${i}`,
					"i1",
					`user_${i}`,
					`本文 ${i}`,
					`2026-01-01 00:00:0${i}.000`,
				);
			}
			setMockClerkUsers(
				Array.from({ length: 5 }, (_, i) =>
					clerkUser(`user_${i}`, `名前${i}`, "テスト"),
				),
			);

			const res = await app.request("/issues/i1/comments", {}, env);
			const body = await readBody(res);

			expect(body.data).toHaveLength(5);
			const calls = getUserListCalls();
			expect(calls).toHaveLength(1);
			expect(calls[0]).toHaveLength(5);
		});

		// コメント一覧はページングが無く全件返す（別 Issue）。100 件を
		// 超えたときに 1 人ずつへ退行していないこと、`fetchDisplayNames` の
		// 分割（100 件ずつ）に乗っていることを呼び出し元からも見ておく。
		it("投稿者が 100 人を超えたら 100 件ずつに分割して問い合わせる", async () => {
			await insertIssue("i1", "user_author", false);
			for (let i = 0; i < 150; i++) {
				await insertComment(
					`c${String(i).padStart(3, "0")}`,
					"i1",
					`user_${i}`,
					`本文 ${i}`,
					"2026-01-01 00:00:00.000",
				);
			}

			const res = await app.request("/issues/i1/comments", {}, env);
			expect(res.status).toBe(200);

			const calls = getUserListCalls();
			expect(calls).toHaveLength(2);
			expect(calls[0]).toHaveLength(100);
			expect(calls[1]).toHaveLength(50);
		});

		it("コメントが無ければ Clerk へ問い合わせない", async () => {
			await insertIssue("i1", "user_author", false);

			const res = await app.request("/issues/i1/comments", {}, env);
			expect(res.status).toBe(200);
			expect(getUserListCalls()).toHaveLength(0);
		});

		// 画面は投稿に成功したコメントを手元の一覧へそのまま追記する。
		// POST だけ形が違うと、投稿直後だけ「名前未設定の方」として並び、
		// 再読み込みで名前が出る、というちらつきになる。
		it("投稿（POST）のレスポンスも一覧と同じ形で返る", async () => {
			await insertIssue("i1", "user_author", false);
			setMockClerkUsers([clerkUser("user_commenter", "次郎", "佐藤")]);
			setMockUserId("user_commenter");

			const res = await app.request(
				"/issues/i1/comments",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost:3000",
					},
					body: JSON.stringify({ body: "似た経験があります" }),
				},
				env,
			);

			expect(res.status).toBe(201);
			const body = await readBody(res);
			expect(body.display_name).toBe("次郎 佐藤");
			expect(body.is_anonymous).toBe(false);
			expect(body).not.toHaveProperty("user_id");
			expect(JSON.stringify(body)).not.toContain("user_commenter");
		});

		it("匿名で立てた Issue に本人が投稿しても、その場で名前は出ない", async () => {
			await insertIssue("i1", "user_author", true);
			setMockClerkUsers([clerkUser("user_author", "花子", "山田")]);
			setMockUserId("user_author");

			const res = await app.request(
				"/issues/i1/comments",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost:3000",
					},
					body: JSON.stringify({ body: "書いた本人の追記です" }),
				},
				env,
			);

			expect(res.status).toBe(201);
			const body = await readBody(res);
			expect(body.is_anonymous).toBe(true);
			expect(body.display_name).toBeNull();
			expect(JSON.stringify(body)).not.toContain("花子");
			expect(getUserListCalls()).toHaveLength(0);
		});

		it("表示名を返しても生の user_id は公開しない", async () => {
			await insertIssue("i1", "user_author", false);
			await insertComment("c1", "i1", "user_2abcSECRETclerkid", "本文");
			setMockClerkUsers([clerkUser("user_2abcSECRETclerkid", "花子", "山田")]);

			const res = await app.request("/issues/i1/comments", {}, env);
			const body = await readBody(res);

			expect(body.data[0]).not.toHaveProperty("user_id");
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
			expect(Object.keys(body.data[0]).sort()).toEqual(
				[
					"id",
					"issue_id",
					"body",
					"created_at",
					"is_anonymous",
					"display_name",
				].sort(),
			);
		});
	});
});

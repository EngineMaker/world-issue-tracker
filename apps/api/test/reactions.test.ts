import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `help-offers.test.ts` と同じ方針で、`@hono/clerk-auth` の内部が使う
// `@clerk/backend` だけを差し替える。詳細は helpers/clerk-mock.ts。
vi.mock("@clerk/backend", async () => {
	const { clerkBackendMockFactory } = await import("./helpers/clerk-mock");
	return clerkBackendMockFactory();
});

import { createApp } from "../src/index";
import { setMockUserId } from "./helpers/clerk-mock";
import { applyMigrations } from "./helpers/migrate";

const app = createApp();

/** 書き込み系は Origin 検証を通す必要がある（`csrf.test.ts` 参照）。 */
const ALLOWED_ORIGIN = "http://localhost:3000";

const OWNER = "user_owner";
const REACTOR = "user_reactor";
const OTHER_REACTOR = "user_other_reactor";

// biome-ignore lint/suspicious/noExplicitAny: テストからレスポンスを緩く読むための意図的な型
type Body = Record<string, any>;

async function readBody(res: Response): Promise<Body> {
	return (await res.json()) as Body;
}

/**
 * 反応の対象になる Issue を DB へ直接投入する。
 *
 * API 経由で作ると起票者の切り替え（`setMockUserId`）が要り、
 * 反応そのものを見たいテストの本筋から離れるため直接入れる。
 */
async function insertIssue(id: string, userId = OWNER): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO issues (id, title, description, scope, latitude, longitude, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			"街灯が切れている",
			"夜道が暗い",
			"community",
			35.68,
			139.76,
			userId,
		)
		.run();
}

function reactionUrl(issueId: string): string {
	return `/issues/${issueId}/reactions`;
}

/** 「私も困っている」と反応する。 */
async function postReaction(issueId: string, origin = ALLOWED_ORIGIN) {
	return app.request(
		reactionUrl(issueId),
		{ method: "POST", headers: { Origin: origin } },
		env,
	);
}

/** 反応を取り消す。 */
async function deleteReaction(issueId: string, origin = ALLOWED_ORIGIN) {
	return app.request(
		reactionUrl(issueId),
		{ method: "DELETE", headers: { Origin: origin } },
		env,
	);
}

async function getReactions(issueId: string) {
	return app.request(reactionUrl(issueId), {}, env);
}

/** DB に実際に入っている反応の件数。レスポンスを信じずに永続化を確かめる。 */
async function countStoredReactions(issueId: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) as total FROM reactions WHERE issue_id = ?",
	)
		.bind(issueId)
		.first<{ total: number }>();
	return row?.total ?? 0;
}

const ISSUE_ID = "2222222222222222bbbbbbbbbbbbbbbb";

describe("Reactions", () => {
	beforeAll(async () => {
		await applyMigrations();
	});

	beforeEach(async () => {
		// 子テーブルから先に消す（外部キーが有効な環境で順序に引っかからないため）
		await env.DB.exec("DELETE FROM reactions");
		await env.DB.exec("DELETE FROM issues");
		await insertIssue(ISSUE_ID);
		setMockUserId(REACTOR);
	});

	describe("POST /issues/:id/reactions", () => {
		it("認証済みなら反応でき、DB に永続化される", async () => {
			const res = await postReaction(ISSUE_ID);

			expect(res.status).toBe(201);
			const body = await readBody(res);
			expect(typeof body.id).toBe("string");
			expect(await countStoredReactions(ISSUE_ID)).toBe(1);
		});

		it("作成のレスポンスに user_id が含まれない", async () => {
			// 「誰が押したか」は公開しない（#112 の決定）。POST は自分の操作の
			// 結果を返すだけなので自分の ID を返しても直ちに他人へ漏れはしないが、
			// 公開する形を経路ごとに揺らすと、どこかで一覧に混ざる
			const body = await readBody(await postReaction(ISSUE_ID));

			expect(body).not.toHaveProperty("user_id");
			expect(body).not.toHaveProperty("issue_id");
			expect(Object.keys(body).sort()).toEqual(["created_at", "id"]);
		});

		it("未認証なら 401 を返し、反応も作らない", async () => {
			setMockUserId(null);
			const res = await postReaction(ISSUE_ID);

			expect(res.status).toBe(401);
			// ステータスだけでなく副作用も見る。401 を返しつつ INSERT してしまう
			// 実装をここで落とす
			expect(await countStoredReactions(ISSUE_ID)).toBe(0);
		});

		it("セッション以外のトークン（OAuth トークン）では反応できない", async () => {
			// `requireAuth` はセッショントークンだけを通す（`middleware/auth.ts`）
			setMockUserId(REACTOR, "oauth_token");
			const res = await postReaction(ISSUE_ID);

			expect(res.status).toBe(401);
			expect(await countStoredReactions(ISSUE_ID)).toBe(0);
		});

		it("許可されていない Origin からは反応できない", async () => {
			const res = await postReaction(ISSUE_ID, "https://evil.example.com");

			expect(res.status).toBe(403);
			expect(await countStoredReactions(ISSUE_ID)).toBe(0);
		});

		it("同じユーザーが二重に反応しても件数は増えない", async () => {
			const first = await postReaction(ISSUE_ID);
			const second = await postReaction(ISSUE_ID);

			expect(first.status).toBe(201);
			expect(second.status).toBe(201);
			expect(await countStoredReactions(ISSUE_ID)).toBe(1);

			// 2 回目も同じ行を指していること（別の行が作られていない）
			const firstBody = await readBody(first);
			const secondBody = await readBody(second);
			expect(secondBody.id).toBe(firstBody.id);
			// 「最初に反応した時刻」が連打で上書きされない
			expect(secondBody.created_at).toBe(firstBody.created_at);
		});

		it("別のユーザーはそれぞれ反応できる", async () => {
			await postReaction(ISSUE_ID);
			setMockUserId(OTHER_REACTOR);
			await postReaction(ISSUE_ID);

			expect(await countStoredReactions(ISSUE_ID)).toBe(2);
			const body = await readBody(await getReactions(ISSUE_ID));
			expect(body.total).toBe(2);
		});

		it("存在しない Issue への反応は 404 で、行も作らない", async () => {
			const missingId = "9999999999999999zzzzzzzzzzzzzzzz";
			const res = await postReaction(missingId);

			expect(res.status).toBe(404);
			const body = await readBody(res);
			expect(body.error).toBe("Issue not found");
			// 外部キーが効いていない環境でも、どこからも読めない行を作らないこと
			expect(await countStoredReactions(missingId)).toBe(0);
		});

		it("起票者自身も反応できる", async () => {
			// 自分の Issue に「私も困っている」を押すのは冗長だが、禁じる理由が無い。
			// 意図せず 403 を返すようになったら気付けるようにしておく
			setMockUserId(OWNER);
			const res = await postReaction(ISSUE_ID);

			expect(res.status).toBe(201);
		});
	});

	describe("GET /issues/:id/reactions", () => {
		it("未ログインでも件数を読める", async () => {
			await postReaction(ISSUE_ID);
			setMockUserId(OTHER_REACTOR);
			await postReaction(ISSUE_ID);

			setMockUserId(null);
			const res = await getReactions(ISSUE_ID);

			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.total).toBe(2);
		});

		// この機能の中心的な決定（#112 の 3）。件数だけを出し、誰が押したかは出さない。
		//
		// 「私も困っている」は生活圏の露出につながりえるため、`help_offers` と
		// 違って表明者を公開しない。ここが緩むと、その決定が黙って崩れる。
		it("レスポンスに user_id も反応者の一覧も含まれない", async () => {
			await postReaction(ISSUE_ID);
			setMockUserId(OTHER_REACTOR);
			await postReaction(ISSUE_ID);

			const body = await readBody(await getReactions(ISSUE_ID));

			// 返すキーそのものを固定する。`data` のような入れ物が増えれば
			// ここで落ちるので、後から一覧を足す変更は必ず意図的になる
			expect(Object.keys(body).sort()).toEqual(["total", "viewer_reacted"]);

			// レスポンス全体を文字列として見て、User ID がどこにも現れないこと。
			// キーの検査だけだと、入れ子の中に混ぜられたときに素通りする
			const serialized = JSON.stringify(body);
			expect(serialized).not.toContain(REACTOR);
			expect(serialized).not.toContain(OTHER_REACTOR);
			expect(serialized).not.toContain("user_id");
		});

		it("反応が無ければ 0 を返す", async () => {
			const body = await readBody(await getReactions(ISSUE_ID));

			expect(body.total).toBe(0);
			expect(body.viewer_reacted).toBe(false);
		});

		it("ログイン中は自分が反応済みかどうかを返す", async () => {
			await postReaction(ISSUE_ID);

			const body = await readBody(await getReactions(ISSUE_ID));
			expect(body.viewer_reacted).toBe(true);
		});

		it("他人の反応を自分の反応として数えない", async () => {
			await postReaction(ISSUE_ID);

			setMockUserId(OTHER_REACTOR);
			const body = await readBody(await getReactions(ISSUE_ID));

			expect(body.total).toBe(1);
			// 件数はあるが、自分は押していない
			expect(body.viewer_reacted).toBe(false);
		});

		it("未ログインなら viewer_reacted は false", async () => {
			await postReaction(ISSUE_ID);

			setMockUserId(null);
			const body = await readBody(await getReactions(ISSUE_ID));

			expect(body.total).toBe(1);
			expect(body.viewer_reacted).toBe(false);
		});

		it("別の Issue の反応を混ぜない", async () => {
			const otherId = "3333333333333333cccccccccccccccc";
			await insertIssue(otherId);
			await postReaction(otherId);

			const body = await readBody(await getReactions(ISSUE_ID));
			expect(body.total).toBe(0);
		});

		it("存在しない Issue の件数は 404", async () => {
			const res = await getReactions("9999999999999999zzzzzzzzzzzzzzzz");

			expect(res.status).toBe(404);
		});

		it("Clerk のキーが無くても 200 を返す", async () => {
			// 公開エンドポイントなので、Clerk が使えない環境でも読めること。
			// `clerkAuth()` はキー不在でも未認証のまま先へ進む
			await postReaction(ISSUE_ID);

			const res = await app.request(
				reactionUrl(ISSUE_ID),
				{},
				{
					...env,
					CLERK_SECRET_KEY: undefined,
					CLERK_PUBLISHABLE_KEY: undefined,
				},
			);

			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.total).toBe(1);
			expect(body.viewer_reacted).toBe(false);
		});
	});

	describe("DELETE /issues/:id/reactions", () => {
		it("自分の反応を取り消せる", async () => {
			await postReaction(ISSUE_ID);
			expect(await countStoredReactions(ISSUE_ID)).toBe(1);

			const res = await deleteReaction(ISSUE_ID);

			expect(res.status).toBe(204);
			expect(await countStoredReactions(ISSUE_ID)).toBe(0);
		});

		it("未認証なら 401 で、反応は残る", async () => {
			await postReaction(ISSUE_ID);

			setMockUserId(null);
			const res = await deleteReaction(ISSUE_ID);

			expect(res.status).toBe(401);
			// 401 を返しつつ削除してしまう実装をここで落とす
			expect(await countStoredReactions(ISSUE_ID)).toBe(1);
		});

		it("セッション以外のトークンでは取り消せない", async () => {
			await postReaction(ISSUE_ID);

			setMockUserId(REACTOR, "oauth_token");
			const res = await deleteReaction(ISSUE_ID);

			expect(res.status).toBe(401);
			expect(await countStoredReactions(ISSUE_ID)).toBe(1);
		});

		it("許可されていない Origin からは取り消せない", async () => {
			await postReaction(ISSUE_ID);

			const res = await deleteReaction(ISSUE_ID, "https://evil.example.com");

			expect(res.status).toBe(403);
			expect(await countStoredReactions(ISSUE_ID)).toBe(1);
		});

		it("他人の反応は取り消せない", async () => {
			// REACTOR が反応した状態で、OTHER_REACTOR が取り消しを試みる。
			// 204 は返る（自分の反応が無い状態は成立している）が、
			// 他人の行が消えていないことが本題
			await postReaction(ISSUE_ID);

			setMockUserId(OTHER_REACTOR);
			const res = await deleteReaction(ISSUE_ID);

			expect(res.status).toBe(204);
			expect(await countStoredReactions(ISSUE_ID)).toBe(1);

			// 残っているのが REACTOR の反応であること。
			// レスポンスからは誰の分か分からないので DB を直接見る
			const row = await env.DB.prepare(
				"SELECT user_id FROM reactions WHERE issue_id = ?",
			)
				.bind(ISSUE_ID)
				.first<{ user_id: string }>();
			expect(row?.user_id).toBe(REACTOR);
		});

		it("反応していなくても 204（冪等）", async () => {
			const res = await deleteReaction(ISSUE_ID);

			expect(res.status).toBe(204);
		});

		it("取り消した後にもう一度反応できる", async () => {
			await postReaction(ISSUE_ID);
			await deleteReaction(ISSUE_ID);
			const res = await postReaction(ISSUE_ID);

			expect(res.status).toBe(201);
			expect(await countStoredReactions(ISSUE_ID)).toBe(1);
		});

		it("存在しない Issue への取り消しは 404", async () => {
			const res = await deleteReaction("9999999999999999zzzzzzzzzzzzzzzz");

			expect(res.status).toBe(404);
		});
	});

	describe("Issue 本体との関係", () => {
		it("詳細に反応の件数が載る", async () => {
			await postReaction(ISSUE_ID);
			setMockUserId(OTHER_REACTOR);
			await postReaction(ISSUE_ID);

			const body = await readBody(
				await app.request(`/issues/${ISSUE_ID}`, {}, env),
			);

			expect(body.reaction_count).toBe(2);
		});

		it("一覧に反応の件数が載る", async () => {
			// 一覧のカードに件数を出すのが #112 の要件のひとつ。
			// 件数を Issue の行と一緒に返さないと、一覧の件数分だけ
			// 追加の往復が要ることになる
			const quietId = "4444444444444444dddddddddddddddd";
			await insertIssue(quietId);
			await postReaction(ISSUE_ID);

			const body = await readBody(await app.request("/issues", {}, env));

			const counts = new Map<string, number>(
				body.data.map((issue: Body) => [issue.id, issue.reaction_count]),
			);
			expect(counts.get(ISSUE_ID)).toBe(1);
			// 反応の無い Issue は 0（キーごと消えたり undefined になったりしない）
			expect(counts.get(quietId)).toBe(0);
		});

		it("一覧・詳細のどちらにも反応した人の情報が漏れない", async () => {
			await postReaction(ISSUE_ID);

			const detail = await readBody(
				await app.request(`/issues/${ISSUE_ID}`, {}, env),
			);
			const list = await readBody(await app.request("/issues", {}, env));

			// Issue 本体の `user_id` を伏せる方針（#88）ごと確かめる。
			// 反応の User ID がここに混ざっていないことも同時に見ている
			expect(detail).not.toHaveProperty("user_id");
			expect(JSON.stringify(detail)).not.toContain(REACTOR);
			expect(JSON.stringify(list)).not.toContain(REACTOR);
		});

		it("Issue を削除すると、その反応も残らない", async () => {
			await postReaction(ISSUE_ID);

			setMockUserId(OWNER);
			const res = await app.request(
				`/issues/${ISSUE_ID}`,
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);
			expect(res.status).toBe(200);

			// 親が消えた後に孤児の反応が残ると、Issue の ID が再利用されない
			// 前提に寄りかかることになる
			expect(await countStoredReactions(ISSUE_ID)).toBe(0);
		});
	});

	// `/issues/:id/reactions` は親ルーターが `:id` をコンテキストへ移してから
	// 子ルーターへ委譲する形で組んでいる（`routes/issues.ts`）。
	// この繋ぎ込みは各ハンドラの中には現れないため、経路そのものを固定しておく。
	describe("ルーティング", () => {
		it("Issue の削除と反応の取り消しを取り違えない", async () => {
			// `DELETE /issues/:id` と `DELETE /issues/:id/reactions` は
			// 前者のパターンが後者にも一致しうる形をしている。取り違えると
			// 「反応を取り消したつもりが Issue ごと消える」ことになる
			await postReaction(ISSUE_ID);

			const res = await deleteReaction(ISSUE_ID);
			expect(res.status).toBe(204);

			// Issue 本体は残っていること
			const issueRes = await app.request(`/issues/${ISSUE_ID}`, {}, env);
			expect(issueRes.status).toBe(200);
		});

		it("Issue ID が子ルーターへ渡っている", async () => {
			// 親から子へ `issueId` を移し損ねると、子側の存在確認が
			// 空文字で走って常に 404 になる
			const res = await getReactions(ISSUE_ID);

			expect(res.status).toBe(200);
		});

		it("reactions の下の未定義パスは 404", async () => {
			// 子ルーターは `"/"` しか持たない
			const res = await app.request(
				`/issues/${ISSUE_ID}/reactions/something`,
				{},
				env,
			);

			expect(res.status).toBe(404);
		});

		it("help-offers と reactions が互いに干渉しない", async () => {
			// 2 つの子ルーターが同じ形で mount されている。片方の反応が
			// もう片方の件数に現れたら、mount の繋ぎ込みが混線している
			await postReaction(ISSUE_ID);

			const offers = await readBody(
				await app.request(`/issues/${ISSUE_ID}/help-offers`, {}, env),
			);
			expect(offers.total).toBe(0);

			await app.request(
				`/issues/${ISSUE_ID}/help-offers`,
				{ method: "POST", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);

			const reactionBody = await readBody(await getReactions(ISSUE_ID));
			expect(reactionBody.total).toBe(1);
		});
	});
});

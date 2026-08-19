import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `issues.test.ts` と同じ方針で、`@hono/clerk-auth` の内部が使う
// `@clerk/backend` だけを差し替える。詳細は helpers/clerk-mock.ts。
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

const app = createApp();

/** 書き込み系は Origin 検証を通す必要がある（`csrf.test.ts` 参照）。 */
const ALLOWED_ORIGIN = "http://localhost:3000";

const OWNER = "user_owner";
const HELPER = "user_helper";
const OTHER_HELPER = "user_other_helper";

// biome-ignore lint/suspicious/noExplicitAny: テストからレスポンスを緩く読むための意図的な型
type Body = Record<string, any>;

async function readBody(res: Response): Promise<Body> {
	return (await res.json()) as Body;
}

/**
 * 表明の対象になる Issue を DB へ直接投入する。
 *
 * API 経由で作ると起票者の切り替え（`setMockUserId`）が要り、
 * 「誰が表明したか」を見たいテストの本筋から離れるため直接入れる。
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

function offerUrl(issueId: string): string {
	return `/issues/${issueId}/help-offers`;
}

/** 「手伝います」と表明する。 */
async function postOffer(issueId: string, origin = ALLOWED_ORIGIN) {
	return app.request(
		offerUrl(issueId),
		{ method: "POST", headers: { Origin: origin } },
		env,
	);
}

/** 表明を取り消す。 */
async function deleteOffer(issueId: string, origin = ALLOWED_ORIGIN) {
	return app.request(
		offerUrl(issueId),
		{ method: "DELETE", headers: { Origin: origin } },
		env,
	);
}

async function listOffers(issueId: string) {
	return app.request(offerUrl(issueId), {}, env);
}

/** 表示名キャッシュ（#135）を空にする。テスト間でキャッシュを持ち越さないため。 */
async function clearDisplayNameCache(): Promise<void> {
	const cache = env.DISPLAY_NAME_CACHE;
	if (!cache) {
		return;
	}
	const { keys } = await cache.list();
	await Promise.all(keys.map((key) => cache.delete(key.name)));
}

/** DB に実際に入っている表明の件数。レスポンスを信じずに永続化を確かめる。 */
async function countStoredOffers(issueId: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) as total FROM help_offers WHERE issue_id = ?",
	)
		.bind(issueId)
		.first<{ total: number }>();
	return row?.total ?? 0;
}

const ISSUE_ID = "1111111111111111aaaaaaaaaaaaaaaa";

describe("Help offers", () => {
	beforeAll(async () => {
		await applyMigrations();
	});

	beforeEach(async () => {
		// 子テーブルから先に消す（外部キーが有効な環境で順序に引っかからないため）
		await env.DB.exec("DELETE FROM help_offers");
		await env.DB.exec("DELETE FROM issues");
		await insertIssue(ISSUE_ID);
		setMockUserId(HELPER);
		// 表示名まわりのモック（#108）。前のテストのユーザーや呼び出し記録が
		// 残っていると、「引けた」「1 回で済んだ」を取り違える
		resetMockClerkUsers();
		// 表示名キャッシュ（#135）も落とす。前のテストで載った名前が残ると、
		// 「連打しても Clerk を 1 回しか叩かない」の検証が、実は前のテストの
		// キャッシュのおかげで通ってしまい、退行を見逃す。
		await clearDisplayNameCache();
	});

	describe("POST /issues/:id/help-offers", () => {
		it("認証済みなら表明でき、DB に永続化される", async () => {
			const res = await postOffer(ISSUE_ID);

			expect(res.status).toBe(201);
			const body = await readBody(res);
			expect(body.user_id).toBe(HELPER);
			expect(typeof body.id).toBe("string");
			expect(typeof body.created_at).toBe("string");

			// レスポンスを組み立てるだけの実装でも通らないよう、DB を直接見る
			expect(await countStoredOffers(ISSUE_ID)).toBe(1);
		});

		it("未認証なら 401 を返し、表明も作らない", async () => {
			setMockUserId(null);
			const res = await postOffer(ISSUE_ID);

			expect(res.status).toBe(401);
			// ステータスだけでなく副作用も見る。401 を返しつつ INSERT してしまう
			// 実装をここで落とす
			expect(await countStoredOffers(ISSUE_ID)).toBe(0);
		});

		it("セッション以外のトークン（OAuth トークン）では表明できない", async () => {
			// `requireAuth` はセッショントークンだけを通す（`middleware/auth.ts`）。
			// 表明も書き込みなので同じ扱いであることを確かめる
			setMockUserId(HELPER, "oauth_token");
			const res = await postOffer(ISSUE_ID);

			expect(res.status).toBe(401);
			expect(await countStoredOffers(ISSUE_ID)).toBe(0);
		});

		it("許可されていない Origin からは表明できない", async () => {
			const res = await postOffer(ISSUE_ID, "https://evil.example.com");

			expect(res.status).toBe(403);
			expect(await countStoredOffers(ISSUE_ID)).toBe(0);
		});

		it("同じユーザーが二重に表明しても件数は増えない", async () => {
			const first = await postOffer(ISSUE_ID);
			const second = await postOffer(ISSUE_ID);

			expect(first.status).toBe(201);
			expect(second.status).toBe(201);
			expect(await countStoredOffers(ISSUE_ID)).toBe(1);

			// 2 回目も同じ行を指していること（別の行が作られていない）
			const firstBody = await readBody(first);
			const secondBody = await readBody(second);
			expect(secondBody.id).toBe(firstBody.id);
			// 「最初に表明した時刻」が連打で上書きされない
			expect(secondBody.created_at).toBe(firstBody.created_at);
		});

		it("別のユーザーはそれぞれ表明できる", async () => {
			await postOffer(ISSUE_ID);
			setMockUserId(OTHER_HELPER);
			await postOffer(ISSUE_ID);

			expect(await countStoredOffers(ISSUE_ID)).toBe(2);
		});

		it("存在しない Issue への表明は 404 で、行も作らない", async () => {
			const missingId = "9999999999999999zzzzzzzzzzzzzzzz";
			const res = await postOffer(missingId);

			expect(res.status).toBe(404);
			const body = await readBody(res);
			expect(body.error).toBe("Issue not found");
			// 外部キーが効いていない環境でも、どこからも読めない行を作らないこと
			expect(await countStoredOffers(missingId)).toBe(0);
		});

		it("起票者自身も表明できる", async () => {
			// 自分の Issue に手を挙げること自体は禁じていない（共同で動く場合がある）。
			// 意図せず 403 を返すようになったら気付けるようにしておく
			setMockUserId(OWNER);
			const res = await postOffer(ISSUE_ID);

			expect(res.status).toBe(201);
		});
	});

	describe("GET /issues/:id/help-offers", () => {
		it("未ログインでも件数と表明者を読める", async () => {
			await postOffer(ISSUE_ID);
			setMockUserId(OTHER_HELPER);
			await postOffer(ISSUE_ID);

			setMockUserId(null);
			const res = await listOffers(ISSUE_ID);

			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.total).toBe(2);
			expect(body.data.map((offer: Body) => offer.user_id)).toEqual([
				HELPER,
				OTHER_HELPER,
			]);
		});

		// Clerk の初期化に失敗しても 500 に落ちないこと。
		//
		// 閲覧者の判定は `viewerUserId`（middleware/auth.ts）が担っていて、
		// `getAuth` の手前でコンテキストの有無を確かめている。このガードを
		// 外すと、キー不在時に `getAuth` が TypeError を投げて公開 GET が
		// 丸ごと 500 になる（`wrangler secret` の設定漏れで起きる）。
		//
		// ガードの有無は正常系のレスポンスに出ないため、他のテストでは
		// 外しても気付けない。`/issues/:id/viewer` にも同型のテストがある。
		it("Clerk のキーが無くても 200 を返す", async () => {
			await postOffer(ISSUE_ID);

			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);
			try {
				const res = await app.request(
					offerUrl(ISSUE_ID),
					{},
					{
						...env,
						CLERK_SECRET_KEY: "",
					},
				);

				expect(res.status).toBe(200);
				const body = await readBody(res);
				expect(body.total).toBe(1);
				// 認証できていない以上、閲覧者は「誰でもない人」として扱う
				expect(body.viewer_offered).toBe(false);
				expect(body.viewer_user_id).toBeNull();
			} finally {
				consoleError.mockRestore();
			}
		});

		it("表明が無ければ空の一覧を返す", async () => {
			const res = await listOffers(ISSUE_ID);

			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.total).toBe(0);
			expect(body.data).toEqual([]);
		});

		it("ログイン中は自分が表明済みかどうかを返す", async () => {
			const before = await readBody(await listOffers(ISSUE_ID));
			expect(before.viewer_offered).toBe(false);

			await postOffer(ISSUE_ID);

			const after = await readBody(await listOffers(ISSUE_ID));
			expect(after.viewer_offered).toBe(true);
		});

		it("他人の表明を自分の表明として数えない", async () => {
			// HELPER が表明した状態で、別のユーザーとして読む
			await postOffer(ISSUE_ID);
			setMockUserId(OTHER_HELPER);

			const body = await readBody(await listOffers(ISSUE_ID));
			expect(body.total).toBe(1);
			expect(body.viewer_offered).toBe(false);
		});

		it("未ログインなら viewer_offered は false", async () => {
			await postOffer(ISSUE_ID);
			setMockUserId(null);

			const body = await readBody(await listOffers(ISSUE_ID));
			expect(body.total).toBe(1);
			expect(body.viewer_offered).toBe(false);
		});

		it("別の Issue の表明を混ぜない", async () => {
			const otherIssueId = "2222222222222222bbbbbbbbbbbbbbbb";
			await insertIssue(otherIssueId);

			await postOffer(ISSUE_ID);

			const body = await readBody(await listOffers(otherIssueId));
			expect(body.total).toBe(0);
		});

		it("存在しない Issue の一覧は 404", async () => {
			const res = await listOffers("9999999999999999zzzzzzzzzzzzzzzz");

			expect(res.status).toBe(404);
			const body = await readBody(res);
			expect(body.error).toBe("Issue not found");
		});

		// 表示名（#108）。それまで画面は Clerk User ID の先頭 8 文字を
		// 並べていて、人に見せる情報として意味を持っていなかった。
		describe("表示名", () => {
			it("Clerk の表示名を display_name として返す", async () => {
				setMockClerkUsers([
					{
						id: HELPER,
						firstName: "花子",
						lastName: "山田",
						username: null,
					},
				]);
				await postOffer(ISSUE_ID);

				const body = await readBody(await listOffers(ISSUE_ID));

				expect(body.data).toHaveLength(1);
				expect(body.data[0].display_name).toBe("花子 山田");
			});

			it("姓名が無ければ username を使う", async () => {
				setMockClerkUsers([
					{ id: HELPER, firstName: null, lastName: null, username: "hanako" },
				]);
				await postOffer(ISSUE_ID);

				const body = await readBody(await listOffers(ISSUE_ID));
				expect(body.data[0].display_name).toBe("hanako");
			});

			// Clerk は表示名を必須にしていないので、この状態は普通に存在する。
			// ID の断片で埋め戻すと #108 で消したかった表示が復活する。
			it("表示名が一つも無いユーザーは display_name が null", async () => {
				setMockClerkUsers([
					{ id: HELPER, firstName: null, lastName: null, username: null },
				]);
				await postOffer(ISSUE_ID);

				const body = await readBody(await listOffers(ISSUE_ID));
				expect(body.data[0].display_name).toBeNull();
			});

			// 最重要（#108 の方針 2）。表示名は「あると嬉しい」情報でしかなく、
			// Clerk が落ちていることで困りごとの画面が見えなくなってはいけない。
			it("Clerk への問い合わせが失敗しても一覧は返る", async () => {
				setMockUserListError(new Error("Clerk is down"));
				await postOffer(ISSUE_ID);
				setMockUserId(OTHER_HELPER);
				await postOffer(ISSUE_ID);

				const consoleError = vi
					.spyOn(console, "error")
					.mockImplementation(() => undefined);
				try {
					const res = await listOffers(ISSUE_ID);

					expect(res.status).toBe(200);
					const body = await readBody(res);
					// 一覧そのものは欠けない。表示名だけが落ちる
					expect(body.total).toBe(2);
					expect(body.data.map((offer: Body) => offer.user_id)).toEqual([
						HELPER,
						OTHER_HELPER,
					]);
					expect(
						body.data.every((offer: Body) => offer.display_name === null),
					).toBe(true);
					// 失敗を握り潰していないこと（ログに残っていること）
					expect(consoleError).toHaveBeenCalled();
				} finally {
					consoleError.mockRestore();
				}
			});

			it("CLERK_SECRET_KEY が無くても一覧は返る", async () => {
				await postOffer(ISSUE_ID);

				const consoleError = vi
					.spyOn(console, "error")
					.mockImplementation(() => undefined);
				try {
					const res = await app.request(
						offerUrl(ISSUE_ID),
						{},
						{ ...env, CLERK_SECRET_KEY: "" },
					);

					expect(res.status).toBe(200);
					const body = await readBody(res);
					expect(body.total).toBe(1);
					expect(body.data[0].display_name).toBeNull();
					// キーが無い状態で Clerk を叩きに行っていないこと
					expect(getUserListCalls()).toHaveLength(0);
				} finally {
					consoleError.mockRestore();
				}
			});

			// 1 人ずつ問い合わせる実装にしないこと（#108 の方針 1）。
			// レート制限は本番インスタンスで 1000 リクエスト / 10 秒しかない。
			it("表明者が複数いても問い合わせは 1 回にまとめる", async () => {
				setMockClerkUsers([
					{ id: HELPER, firstName: "A", lastName: null, username: null },
					{ id: OTHER_HELPER, firstName: "B", lastName: null, username: null },
				]);
				await postOffer(ISSUE_ID);
				setMockUserId(OTHER_HELPER);
				await postOffer(ISSUE_ID);

				const body = await readBody(await listOffers(ISSUE_ID));

				expect(body.data.map((offer: Body) => offer.display_name)).toEqual([
					"A",
					"B",
				]);
				const calls = getUserListCalls();
				expect(calls).toHaveLength(1);
				expect(calls[0]).toEqual([HELPER, OTHER_HELPER]);
			});

			it("表明が無ければ Clerk に問い合わせない", async () => {
				const body = await readBody(await listOffers(ISSUE_ID));

				expect(body.total).toBe(0);
				expect(getUserListCalls()).toHaveLength(0);
			});

			// #135（このファイルの主眼）。無認証の第三者が同じ一覧を連打しても、
			// Clerk への問い合わせが回数分だけ増幅しないこと。増幅を放置すると
			// Clerk のレート制限を使い切り、認証（JWKS 取得）まで巻き添えになって
			// 全ユーザーのログインが止まりうる。KV キャッシュでこれを止める。
			it("同じ一覧を連打しても Clerk への問い合わせは増幅しない", async () => {
				setMockClerkUsers([
					{ id: HELPER, firstName: "花子", lastName: "山田", username: null },
				]);
				await postOffer(ISSUE_ID);

				// 未ログインの第三者として、続けて 3 回引く
				setMockUserId(null);
				const bodies = [
					await readBody(await listOffers(ISSUE_ID)),
					await readBody(await listOffers(ISSUE_ID)),
					await readBody(await listOffers(ISSUE_ID)),
				];

				// どの回も表示名は返る（キャッシュから解決される）
				for (const body of bodies) {
					expect(body.data[0].display_name).toBe("花子 山田");
				}
				// 3 回叩いても Clerk への getUserList は 1 回だけ。
				// キャッシュが無ければ 3 回になり、これが増幅そのものだった。
				expect(getUserListCalls()).toHaveLength(1);
			});

			// 名前を設定していない表明者でも、連打で増幅しないこと（ネガティブ
			// キャッシュ）。名前が無いと毎回 Clerk に聞き直す実装だと、ここが
			// 呼び出し回数分に増える。
			it("表示名が無い表明者でも連打で増幅しない", async () => {
				setMockClerkUsers([
					{ id: HELPER, firstName: null, lastName: null, username: null },
				]);
				await postOffer(ISSUE_ID);

				setMockUserId(null);
				const first = await readBody(await listOffers(ISSUE_ID));
				const second = await readBody(await listOffers(ISSUE_ID));

				expect(first.data[0].display_name).toBeNull();
				expect(second.data[0].display_name).toBeNull();
				expect(getUserListCalls()).toHaveLength(1);
			});

			// 生の User ID を新たに増やしていないこと（#108 の方針 4）。
			// 増えてよいのは表示名だけで、メールアドレス等が紛れ込んでいないか見る。
			it("公開されるフィールドは表示名しか増えていない", async () => {
				setMockClerkUsers([
					{ id: HELPER, firstName: "花子", lastName: null, username: null },
				]);
				await postOffer(ISSUE_ID);

				const body = await readBody(await listOffers(ISSUE_ID));

				expect(Object.keys(body.data[0]).sort()).toEqual([
					"created_at",
					"display_name",
					"id",
					"user_id",
				]);
			});
		});
	});

	describe("DELETE /issues/:id/help-offers", () => {
		it("自分の表明を取り消せる", async () => {
			await postOffer(ISSUE_ID);
			expect(await countStoredOffers(ISSUE_ID)).toBe(1);

			const res = await deleteOffer(ISSUE_ID);

			expect(res.status).toBe(204);
			expect(await countStoredOffers(ISSUE_ID)).toBe(0);
		});

		it("未認証なら 401 で、表明は残る", async () => {
			await postOffer(ISSUE_ID);

			setMockUserId(null);
			const res = await deleteOffer(ISSUE_ID);

			expect(res.status).toBe(401);
			// 401 を返しつつ削除してしまう実装をここで落とす
			expect(await countStoredOffers(ISSUE_ID)).toBe(1);
		});

		it("セッション以外のトークンでは取り消せない", async () => {
			await postOffer(ISSUE_ID);

			setMockUserId(HELPER, "oauth_token");
			const res = await deleteOffer(ISSUE_ID);

			expect(res.status).toBe(401);
			expect(await countStoredOffers(ISSUE_ID)).toBe(1);
		});

		it("許可されていない Origin からは取り消せない", async () => {
			await postOffer(ISSUE_ID);

			const res = await deleteOffer(ISSUE_ID, "https://evil.example.com");

			expect(res.status).toBe(403);
			expect(await countStoredOffers(ISSUE_ID)).toBe(1);
		});

		it("他人の表明は取り消せない", async () => {
			// HELPER が表明した状態で、OTHER_HELPER が取り消しを試みる。
			// 204 は返る（自分の表明が無い状態は成立している）が、
			// 他人の行が消えていないことが本題
			await postOffer(ISSUE_ID);

			setMockUserId(OTHER_HELPER);
			const res = await deleteOffer(ISSUE_ID);

			expect(res.status).toBe(204);
			expect(await countStoredOffers(ISSUE_ID)).toBe(1);

			// 消えていないのが HELPER の表明であること
			const body = await readBody(await listOffers(ISSUE_ID));
			expect(body.data.map((offer: Body) => offer.user_id)).toEqual([HELPER]);
		});

		it("表明していなくても 204（冪等）", async () => {
			const res = await deleteOffer(ISSUE_ID);

			expect(res.status).toBe(204);
		});

		it("取り消した後にもう一度表明できる", async () => {
			await postOffer(ISSUE_ID);
			await deleteOffer(ISSUE_ID);
			const res = await postOffer(ISSUE_ID);

			expect(res.status).toBe(201);
			expect(await countStoredOffers(ISSUE_ID)).toBe(1);
		});

		it("存在しない Issue への取り消しは 404", async () => {
			const res = await deleteOffer("9999999999999999zzzzzzzzzzzzzzzz");

			expect(res.status).toBe(404);
		});
	});

	describe("Issue 本体との関係", () => {
		it("表明を作っても Issue の公開レスポンスに内部フィールドが漏れない", async () => {
			await postOffer(ISSUE_ID);

			const res = await app.request(`/issues/${ISSUE_ID}`, {}, env);
			const body = await readBody(res);

			// `user_id` は `PUBLIC_ISSUE_COLUMNS` から意図的に外されている。
			// 表明機能を足したことで Issue 側の方針が崩れていないこと
			expect(body).not.toHaveProperty("user_id");
		});

		it("Issue を削除すると、その表明も残らない", async () => {
			await postOffer(ISSUE_ID);

			setMockUserId(OWNER);
			const res = await app.request(
				`/issues/${ISSUE_ID}`,
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);
			expect(res.status).toBe(200);

			// 親が消えた後に孤児の表明が残ると、Issue の ID が再利用されない
			// 前提に寄りかかることになる。件数の集計にも二度と現れない行が積む
			expect(await countStoredOffers(ISSUE_ID)).toBe(0);
		});
	});

	// `/issues/:id/help-offers` は親ルーターが `:id` をコンテキストへ移してから
	// 子ルーターへ委譲する形で組んでいる（`routes/issues.ts`）。
	// この繋ぎ込みは各ハンドラの中には現れないため、経路そのものを固定しておく。
	describe("ルーティング", () => {
		it("Issue の削除と表明の取り消しを取り違えない", async () => {
			// `DELETE /issues/:id` と `DELETE /issues/:id/help-offers` は
			// 前者のパターンが後者にも一致しうる形をしている。取り違えると
			// 「手伝いを取り消したつもりが Issue ごと消える」ことになる
			await postOffer(ISSUE_ID);

			const res = await deleteOffer(ISSUE_ID);
			expect(res.status).toBe(204);

			// Issue 本体は残っていること
			const issueRes = await app.request(`/issues/${ISSUE_ID}`, {}, env);
			expect(issueRes.status).toBe(200);
		});

		it("Issue ID が子ルーターへ渡っている", async () => {
			// 親から子へ `issueId` を移し損ねると、子側の存在確認が
			// 空文字で走って常に 404 になる。200 が返ること自体が
			// 受け渡しが繋がっている証拠になる
			const res = await listOffers(ISSUE_ID);

			expect(res.status).toBe(200);
		});

		it("help-offers の下の未定義パスは 404", async () => {
			// 子ルーターは `"/"` しか持たない。将来 `/:offerId` のような
			// ルートを足すまでは、ここに何を投げても 404 で返る
			const res = await app.request(
				`/issues/${ISSUE_ID}/help-offers/something`,
				{},
				env,
			);

			expect(res.status).toBe(404);
		});
	});
});

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `@hono/clerk-auth` ではなく、その内部が使う `@clerk/backend` をモックする。
// 詳細は helpers/clerk-mock.ts。
vi.mock("@clerk/backend", async () => {
	const { clerkBackendMockFactory } = await import("./helpers/clerk-mock");
	return clerkBackendMockFactory();
});

import { createApp } from "../src/index";
import { setMockUserId } from "./helpers/clerk-mock";
import { applyMigrations } from "./helpers/migrate";

const app = createApp();

const ALLOWED_ORIGIN = "http://localhost:3000";

/** マシントークンが「なりすます」対象のユーザー。 */
const VICTIM_USER_ID = "user_victim123";

const validIssue = {
	title: "Broken streetlight",
	description: "The streetlight on Main St is not working",
	scope: "community",
	latitude: 35.68,
	longitude: 139.76,
};

/**
 * 被害者本人が所有する Issue を 1 件用意して、その id を返す。
 *
 * マシントークンで「他人の Issue を触れるか」ではなく
 * 「所有者本人になりすまして触れるか」を見たいので、所有者は被害者にする。
 * 所有者チェック（`checkOwnership`）で弾かれる形だと、トークン種別の検証が
 * 無くても 403 になってしまい、このテストが何も証明しなくなる。
 */
async function seedVictimIssue(): Promise<string> {
	const row = await env.DB.prepare(
		"INSERT INTO issues (title, description, scope, latitude, longitude, user_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
	)
		.bind(
			"Victim's issue",
			"owned by the victim",
			validIssue.scope,
			validIssue.latitude,
			validIssue.longitude,
			VICTIM_USER_ID,
		)
		.first<{ id: string }>();
	if (!row) {
		throw new Error("failed to seed victim issue");
	}
	return row.id;
}

async function countIssues(title: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) as total FROM issues WHERE title = ?",
	)
		.bind(title)
		.first<{ total: number }>();
	return row?.total ?? 0;
}

async function issueExists(id: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT id FROM issues WHERE id = ?")
		.bind(id)
		.first();
	return row !== null;
}

/**
 * セッショントークン以外での書き込みを拒む。
 *
 * `clerkMiddleware()` は `acceptsToken: "any"` で認証するため、Clerk の
 * OAuth トークンや API キーでも `userId` の入った auth オブジェクトが返る
 * （`api_key` は `subject` が `user_` 始まりのとき、`oauth_token` は常に）。
 * `userId` の有無だけを見る認可はこれらを素通しさせ、スコープ限定のはずの
 * OAuth トークンで Issue の作成・改変・削除ができてしまう。
 *
 * しかも Bearer ヘッダで来るため `requireAllowedOrigin` の Origin 検証も
 * 免除される。`requireAuth` が唯一の関門になるので、ここで種別を見る。
 *
 * 各テストは Origin を付けずに叩く。これは「Origin 検証に助けられて
 * たまたま通らなかった」のではなく、`requireAuth` 自身が弾いていることを
 * 確かめるため。
 */
describe("Machine tokens must not pass requireAuth", () => {
	// スキーマは実マイグレーションから作る。手書きの CREATE TABLE を
	// 持たせると、`migrations/` にカラムが増えてもここだけ古いままになり、
	// このファイルのテストが本番と別物のスキーマに対して緑になる
	// （`schema.test.ts` が同じ理由で手書き定数を廃した）。
	beforeAll(async () => {
		// スキーマは実マイグレーションから作る。以前はここに手書きの
		// `CREATE TABLE` を置いていたが、`migrations/` と同期する仕組みが
		// 無いため、カラムを足すとこのファイルだけが古いスキーマのまま
		// 落ちる（#65 の `photo_key` で実際に落ちた）。理由の詳細は
		// `helpers/migrate.ts`。
		await applyMigrations();
	});

	beforeEach(async () => {
		await env.DB.exec("DELETE FROM issues");
	});

	for (const tokenType of ["oauth_token", "api_key"] as const) {
		describe(`with an ${tokenType}`, () => {
			beforeEach(() => {
				setMockUserId(VICTIM_USER_ID, tokenType);
			});

			it("rejects POST and creates nothing", async () => {
				const res = await app.request(
					"/issues",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: "Bearer machine-token",
						},
						body: JSON.stringify(validIssue),
					},
					env,
				);

				expect(res.status).toBe(401);
				const body = (await res.json()) as { error?: string };
				expect(body.error).toBe("Unauthorized");
				// ステータスだけでなく、実際に書き込まれていないこと
				expect(await countIssues(validIssue.title)).toBe(0);
			});

			it("rejects PATCH and leaves the row untouched", async () => {
				const id = await seedVictimIssue();

				const res = await app.request(
					`/issues/${id}`,
					{
						method: "PATCH",
						headers: {
							"Content-Type": "application/json",
							Authorization: "Bearer machine-token",
						},
						body: JSON.stringify({ title: "Hijacked" }),
					},
					env,
				);

				expect(res.status).toBe(401);
				const row = await env.DB.prepare(
					"SELECT title FROM issues WHERE id = ?",
				)
					.bind(id)
					.first<{ title: string }>();
				expect(row?.title).toBe("Victim's issue");
			});

			it("rejects DELETE and leaves the row in place", async () => {
				const id = await seedVictimIssue();

				const res = await app.request(
					`/issues/${id}`,
					{
						method: "DELETE",
						headers: { Authorization: "Bearer machine-token" },
					},
					env,
				);

				expect(res.status).toBe(401);
				expect(await issueExists(id)).toBe(true);
			});

			it("still serves public GET", async () => {
				// 種別の検証を入れたことで、読み取り専用の公開経路まで
				// 巻き込んで塞いでいないこと。
				const res = await app.request(
					"/issues",
					{ headers: { Authorization: "Bearer machine-token" } },
					env,
				);
				expect(res.status).toBe(200);
			});
		});
	}

	// 対になる確認。種別を見るようにしたことで、正規のセッションまで
	// 巻き添えで弾いていたら本末転倒なので、こちらは通ることを固定する。
	describe("with a session token", () => {
		beforeEach(() => {
			setMockUserId(VICTIM_USER_ID, "session_token");
		});

		it("allows POST", async () => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);

			expect(res.status).toBe(201);
			expect(await countIssues(validIssue.title)).toBe(1);
		});

		it("allows DELETE of an own issue", async () => {
			const id = await seedVictimIssue();

			const res = await app.request(
				`/issues/${id}`,
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);

			expect(res.status).toBe(200);
			expect(await issueExists(id)).toBe(false);
		});
	});
});

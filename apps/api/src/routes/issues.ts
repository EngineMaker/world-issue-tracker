import { getAuth } from "@hono/clerk-auth";
import {
	CreateIssueSchema,
	ListIssuesQuerySchema,
	UpdateIssueSchema,
} from "@world-issue-tracker/shared";
import { type Context, Hono } from "hono";
import type { Bindings } from "../index";
import { requireAuth } from "../middleware/auth";

export const issues = new Hono<{ Bindings: Bindings }>();

/**
 * 認証不要の GET が返してよいカラム。
 *
 * `user_id`（Clerk User ID）のような内部フィールドは意図的に含めていない。
 * カラムを追加したときは、ここに足すかどうかで「公開してよいか」を明示的に判断する。
 */
export const PUBLIC_ISSUE_COLUMNS = [
	"id",
	"title",
	"description",
	"scope",
	"status",
	"latitude",
	"longitude",
	"category",
	"created_at",
	"updated_at",
] as const;

type PublicIssue = Record<(typeof PUBLIC_ISSUE_COLUMNS)[number], unknown>;

/**
 * 公開 GET が返すカラムだけを並べた SELECT 句。
 * `SELECT *` にすると、カラムを追加した瞬間にそれが公開されてしまう。
 */
export const PUBLIC_SELECT = PUBLIC_ISSUE_COLUMNS.join(", ");

/**
 * DB の行から公開してよいカラムだけを取り出す。
 *
 * SELECT でカラムを絞ったうえで、返す直前にもここを通す二段構えにしている。
 * SELECT 句の書き漏れがあっても、内部フィールドはここで落ちる。
 */
export function toPublicIssue(row: Record<string, unknown>): PublicIssue {
	return Object.fromEntries(
		PUBLIC_ISSUE_COLUMNS.map((column) => [column, row[column]]),
	) as PublicIssue;
}

/**
 * `created_at` / `updated_at` に入れるタイムスタンプの SQL 式。
 *
 * テーブルの DEFAULT は `datetime('now')`（秒精度）だが、それだと
 * 「作成と更新が同一秒内に起きると `updated_at` が動かない」ため、
 * 更新されたかどうかを値から判別できない。連続した更新でも順序が付くよう、
 * アプリ経由の書き込みではミリ秒精度で明示的に入れる。
 *
 * 書式は `YYYY-MM-DD HH:MM:SS.SSS` で、秒精度の `YYYY-MM-DD HH:MM:SS` と
 * 先頭が共通するため、DEFAULT で入った既存行との辞書順比較も時系列順と一致する。
 */
const NOW_SQL = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

issues.onError((err, c) => {
	if (err instanceof SyntaxError) {
		return c.json({ error: "Invalid JSON" }, 400);
	}
	throw err;
});

// POST /issues — Create (auth required)
issues.post("/", requireAuth, async (c) => {
	const body = await c.req.json();
	const parsed = CreateIssueSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const { title, description, scope, latitude, longitude, category } =
		parsed.data;
	const auth = getAuth(c);
	const userId = auth?.userId;

	const result = await c.env.DB.prepare(
		`INSERT INTO issues (title, description, scope, latitude, longitude, category, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${NOW_SQL}, ${NOW_SQL})
     RETURNING *`,
	)
		.bind(
			title,
			description,
			scope,
			latitude,
			longitude,
			category ?? null,
			userId,
		)
		.first();

	return c.json(result, 201);
});

// GET /issues — List (public)
issues.get("/", async (c) => {
	const query = Object.fromEntries(new URL(c.req.url).searchParams);
	const parsed = ListIssuesQuerySchema.safeParse(query);
	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const { scope, status, limit, offset } = parsed.data;

	const conditions: string[] = [];
	const binds: unknown[] = [];

	if (scope) {
		conditions.push("scope = ?");
		binds.push(scope);
	}
	if (status) {
		conditions.push("status = ?");
		binds.push(status);
	}

	const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

	const countRow = await c.env.DB.prepare(
		`SELECT COUNT(*) as total FROM issues ${where}`,
	)
		.bind(...binds)
		.first<{ total: number }>();

	// 一覧は新しい順。`created_at` はミリ秒精度だが、同一ミリ秒に複数件作られると
	// それだけでは順序が決まらず、SQLite が返す順（実装依存）に委ねられてしまう。
	// 順序が不定だとページング境界で行の欠落・重複が起きるため、
	// 一意な `id` を第二キーに置いて全順序を確定させる。
	//
	// `id` は `lower(hex(randomblob(16)))` のランダム値なので、同一ミリ秒内の
	// 数件については「新しい順」ではなく安定した任意順になる。ここで保証したいのは
	// 時系列そのものではなく、ページを跨いでも順序がぶれないことなので、これで足りる。
	// 同一ミリ秒内まで時系列で並べたい場合は id を ULID / UUIDv7 に変える必要がある。
	const rows = await c.env.DB.prepare(
		`SELECT ${PUBLIC_SELECT} FROM issues ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
	)
		.bind(...binds, limit, offset)
		.all();

	return c.json({
		data: rows.results.map(toPublicIssue),
		total: countRow?.total ?? 0,
		limit,
		offset,
	});
});

// GET /issues/:id — Get by ID (public)
issues.get("/:id", async (c) => {
	const id = c.req.param("id");
	const row = await c.env.DB.prepare(
		`SELECT ${PUBLIC_SELECT} FROM issues WHERE id = ?`,
	)
		.bind(id)
		.first();

	if (!row) {
		return c.json({ error: "Issue not found" }, 404);
	}
	return c.json(toPublicIssue(row));
});

/**
 * Issue の所有者を確認する。
 * 存在しなければ 404、別ユーザーのものなら 403 のレスポンスを返す。
 * 操作してよい場合のみ null を返す。
 *
 * 一覧が公開されている以上 Issue の存在は秘匿できないので、
 * 404 で存在を隠すのではなく 403 を素直に返す方針にしている。
 */
async function checkOwnership(
	c: Context<{ Bindings: Bindings }>,
	id: string,
): Promise<Response | null> {
	const row = await c.env.DB.prepare("SELECT user_id FROM issues WHERE id = ?")
		.bind(id)
		.first<{ user_id: string | null }>();

	if (!row) {
		return c.json({ error: "Issue not found" }, 404);
	}

	const auth = getAuth(c);
	if (!row.user_id || row.user_id !== auth?.userId) {
		return c.json({ error: "Forbidden" }, 403);
	}

	return null;
}

// PATCH /issues/:id — Partial update (auth required, owner only)
issues.patch("/:id", requireAuth, async (c) => {
	const id = c.req.param("id");

	// 認可を入力バリデーションより先に行う（他人の Issue に対して
	// バリデーションエラーの詳細を返さないため）
	const denied = await checkOwnership(c, id);
	if (denied) {
		return denied;
	}

	const body = await c.req.json();
	const parsed = UpdateIssueSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const fields = parsed.data;
	const setClauses: string[] = [];
	const binds: unknown[] = [];

	for (const [key, value] of Object.entries(fields)) {
		setClauses.push(`${key} = ?`);
		binds.push(value ?? null);
	}
	setClauses.push(`updated_at = ${NOW_SQL}`);

	const auth = getAuth(c);

	// 所有者チェックとの間で行が変わる可能性に備え、UPDATE 自体にも所有者条件を入れる
	const result = await c.env.DB.prepare(
		`UPDATE issues SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ? RETURNING *`,
	)
		.bind(...binds, id, auth?.userId)
		.first();

	if (!result) {
		return c.json({ error: "Issue not found" }, 404);
	}
	return c.json(result);
});

// DELETE /issues/:id — Delete (auth required, owner only)
issues.delete("/:id", requireAuth, async (c) => {
	const id = c.req.param("id");

	const denied = await checkOwnership(c, id);
	if (denied) {
		return denied;
	}

	const auth = getAuth(c);

	// 所有者チェックとの間で行が変わる可能性に備え、DELETE 自体にも所有者条件を入れる
	const result = await c.env.DB.prepare(
		"DELETE FROM issues WHERE id = ? AND user_id = ? RETURNING *",
	)
		.bind(id, auth?.userId)
		.first();

	if (!result) {
		return c.json({ error: "Issue not found" }, 404);
	}
	return c.json(result);
});

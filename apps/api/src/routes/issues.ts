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
		`INSERT INTO issues (title, description, scope, latitude, longitude, category, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
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

	const rows = await c.env.DB.prepare(
		`SELECT * FROM issues ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
	)
		.bind(...binds, limit, offset)
		.all();

	return c.json({
		data: rows.results,
		total: countRow?.total ?? 0,
		limit,
		offset,
	});
});

// GET /issues/:id — Get by ID (public)
issues.get("/:id", async (c) => {
	const id = c.req.param("id");
	const row = await c.env.DB.prepare("SELECT * FROM issues WHERE id = ?")
		.bind(id)
		.first();

	if (!row) {
		return c.json({ error: "Issue not found" }, 404);
	}
	return c.json(row);
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
	setClauses.push("updated_at = datetime('now')");

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

import {
	CreateIssueSchema,
	ListIssuesQuerySchema,
	UpdateIssueSchema,
} from "@world-issue-tracker/shared";
import { Hono } from "hono";

type Bindings = {
	DB: D1Database;
};

export const issues = new Hono<{ Bindings: Bindings }>();

issues.onError((err, c) => {
	if (err instanceof SyntaxError) {
		return c.json({ error: "Invalid JSON" }, 400);
	}
	throw err;
});

// POST /issues — Create
issues.post("/", async (c) => {
	const body = await c.req.json();
	const parsed = CreateIssueSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const { title, description, scope, latitude, longitude, category } =
		parsed.data;

	const result = await c.env.DB.prepare(
		`INSERT INTO issues (title, description, scope, latitude, longitude, category)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING *`,
	)
		.bind(title, description, scope, latitude, longitude, category ?? null)
		.first();

	return c.json(result, 201);
});

// GET /issues — List
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

// GET /issues/:id — Get by ID
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

// PATCH /issues/:id — Partial update
issues.patch("/:id", async (c) => {
	const id = c.req.param("id");
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

	const result = await c.env.DB.prepare(
		`UPDATE issues SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`,
	)
		.bind(...binds, id)
		.first();

	if (!result) {
		return c.json({ error: "Issue not found" }, 404);
	}
	return c.json(result);
});

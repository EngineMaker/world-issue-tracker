import { getAuth } from "@hono/clerk-auth";
import {
	buildIssueCursor,
	CreateIssueSchema,
	escapeLikePattern,
	ListIssuesQuerySchema,
	parseIssueCursor,
	UpdateIssueSchema,
} from "@world-issue-tracker/shared";
import { type Context, Hono } from "hono";
import type { Bindings } from "../index";
import { requireAuth } from "../middleware/auth";
import { clerkAuth } from "../middleware/clerk";

export const issues = new Hono<{ Bindings: Bindings }>();

/**
 * レスポンスに載せてよいカラム。
 *
 * `user_id`（Clerk User ID）のような内部フィールドは意図的に含めていない。
 * カラムを追加したときは、ここに足すかどうかで「公開してよいか」を明示的に判断する。
 *
 * 書き込み系（POST / PATCH / DELETE）は認証必須だが、返しているのは GET と
 * 同じテーブルの行なので、公開してよいキーの集合も同じものを使う。
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
 * 一覧の SELECT が返す行のうち、カーソル組み立てに使う分だけを型付けしたもの。
 * 残りのカラムは `toPublicIssue` が拾うため、ここでは列挙しない。
 */
type CursorRow = Record<string, unknown> & { created_at: string; id: string };

/**
 * レスポンスに載せるカラムだけを並べた SELECT / RETURNING 句。
 * `SELECT *`・`RETURNING *` にすると、カラムを追加した瞬間にそれが公開されてしまう。
 */
export const PUBLIC_SELECT = PUBLIC_ISSUE_COLUMNS.join(", ");

/**
 * DB の行から公開してよいカラムだけを取り出す。
 *
 * SELECT / RETURNING でカラムを絞ったうえで、返す直前にもここを通す二段構えに
 * している。句の書き漏れがあっても、内部フィールドはここで落ちる。
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
 * 先頭が共通するため、DEFAULT で入った既存行との辞書順比較も概ね時系列順に並ぶ。
 * ただし同一秒内では `'...:00' < '...:00.000'` となり、DEFAULT で入った行が
 * 同じ瞬間のミリ秒精度の行より古い側に来る。順序は全順序として確定するので
 * カーソルページングの前提は崩れないが、同一秒内の並びは厳密な時系列ではない。
 */
const NOW_SQL = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

issues.onError((err, c) => {
	if (err instanceof SyntaxError) {
		return c.json({ error: "Invalid JSON" }, 400);
	}
	throw err;
});

// POST /issues — Create (auth required)
issues.post("/", clerkAuth(), requireAuth, async (c) => {
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
     RETURNING ${PUBLIC_SELECT}`,
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

	// INSERT が成功すれば RETURNING は必ず 1 行返すため、ここは実際には通らない。
	// `first()` の戻り値が null を含む型であることに対する処理で、
	// 握り潰して空の Issue を返さないよう 500 にしている。
	if (!result) {
		return c.json({ error: "Failed to create issue" }, 500);
	}
	return c.json(toPublicIssue(result), 201);
});

/**
 * クエリ文字列を検証用のオブジェクトに直す。
 *
 * `URLSearchParams` は同名キーを複数保持できるが、`Object.fromEntries` は
 * 後の値で上書きするため、重複が黙って握り潰されていた。その結果
 * `?limit=5&limit=abc` は 400、`?limit=abc&limit=5` は 200 という
 * 並び順に依存した挙動になっていた。どちらの値を採用するかを暗黙に
 * 決めるより、曖昧な入力として明示的に拒否する。
 *
 * 重複があれば、そのキー名を返す。無ければオブジェクトを返す。
 *
 * 蓄積先は `Object.create(null)` で作る。素の `{}` だと
 * `Object.prototype` のプロパティ名（`toString` / `constructor` /
 * `hasOwnProperty` など）が既存キーとして見えてしまい、1 回しか
 * 指定していない `?toString=x` を重複と誤判定する。加えて
 * `value["__proto__"] = ...` は通常のキーにならずプロトタイプの
 * 差し替えになり、値が黙って消える。プロトタイプを持たなければ
 * どちらも起きず、クエリのキーをそのまま素直に扱える。
 */
export function parseQueryParams(
	searchParams: URLSearchParams,
):
	| { ok: true; value: Record<string, string> }
	| { ok: false; duplicated: string[] } {
	const value: Record<string, string> = Object.create(null);
	const duplicated: string[] = [];

	for (const [key, param] of searchParams) {
		if (key in value) {
			if (!duplicated.includes(key)) {
				duplicated.push(key);
			}
			continue;
		}
		value[key] = param;
	}

	if (duplicated.length) {
		return { ok: false, duplicated };
	}
	return { ok: true, value };
}

// GET /issues — List (public)
issues.get("/", async (c) => {
	const query = parseQueryParams(new URL(c.req.url).searchParams);
	if (!query.ok) {
		return c.json(
			{
				error: {
					formErrors: [
						`Duplicated query parameters: ${query.duplicated.join(", ")}`,
					],
					fieldErrors: Object.fromEntries(
						query.duplicated.map((key) => [
							key,
							["must not be specified more than once"],
						]),
					),
				},
			},
			400,
		);
	}

	const parsed = ListIssuesQuerySchema.safeParse(query.value);
	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const { scope, status, category, q, sort, limit, offset, cursor } =
		parsed.data;

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
	if (category) {
		conditions.push("category = ?");
		binds.push(category);
	}
	// キーワードはタイトルと説明の部分一致。カテゴリは別のパラメータで
	// 絞れるので、ここでは本文だけを対象にする。
	//
	// SQLite の LIKE は既定で ASCII のみ大小文字を区別しない。日本語には
	// 大小の区別がなく、英字は区別せずに引ける方が探す側の期待に近いので、
	// そのままの挙動を使う。エスケープ文字は SQLite が既定で持たないため
	// `ESCAPE '\'` を明示する（付け忘れると `\%` の `\` が字面として残る）。
	//
	// コストについて: 前方一致でない LIKE はインデックスを使えず、
	// とくに下の COUNT は LIMIT が効かないため毎回全行を読む。D1 は
	// 読み取り行数で課金される（`0003_add_created_at_index.sql` 参照）ので、
	// 行数が増えると 1 回の検索コストが線形に増える。
	//
	// MVP（1 都市での実証）の規模では許容できると判断してこの形にした。
	// 全文検索が要る規模になったら FTS5 の仮想テーブルに移す。
	// `category` は完全一致なのでインデックスで解けるが、こちらも
	// まだ張っていない（絞り込みの利用実態を見てから判断する）。
	if (q) {
		const pattern = `%${escapeLikePattern(q)}%`;
		conditions.push(
			"(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')",
		);
		binds.push(pattern, pattern);
	}

	// フィルタ条件だけを使う COUNT と、カーソル条件も含む SELECT で
	// WHERE 句が変わるため、COUNT 用を先に固定しておく。
	const countWhere = conditions.length
		? `WHERE ${conditions.join(" AND ")}`
		: "";
	const countBinds = [...binds];

	// 並び順の向き。`newest` なら (created_at DESC, id DESC)、
	// `oldest` ならその完全な逆順。カーソル条件の不等号も同じ向きに
	// 揃えないと、次ページが「今見たページの手前」を指してしまう。
	const direction = sort === "oldest" ? "ASC" : "DESC";
	const cursorComparison = direction === "ASC" ? ">" : "<";

	// カーソルは「最後に見た行」そのものを指す。並び順が
	// (created_at, id) の全順序なので、その行より厳密に後ろにある行だけを取る。
	// created_at が同値のときに id で決着が付くため、同一秒に固まった行でも
	// 全順序が定まり、境界をまたぐ取りこぼしが起きない。
	if (cursor) {
		const { createdAt, id } = parseIssueCursor(cursor);
		conditions.push(
			`(created_at ${cursorComparison} ? OR (created_at = ? AND id ${cursorComparison} ?))`,
		);
		binds.push(createdAt, createdAt, id);
	}

	const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

	const countRow = await c.env.DB.prepare(
		`SELECT COUNT(*) as total FROM issues ${countWhere}`,
	)
		.bind(...countBinds)
		.first<{ total: number }>();

	// 一覧は既定で新しい順（`sort=oldest` でその逆順）。
	// `created_at` はミリ秒精度だが、同一ミリ秒に複数件作られると
	// それだけでは順序が決まらず、SQLite が返す順（実装依存）に委ねられてしまう。
	// 順序が不定だとページング境界で行の欠落・重複が起きるため、
	// 一意な `id` を第二キーに置いて全順序を確定させる。
	//
	// `id` は `lower(hex(randomblob(16)))` のランダム値なので、同一ミリ秒内の
	// 数件については「新しい順」ではなく安定した任意順になる。ここで保証したいのは
	// 時系列そのものではなく、ページを跨いでも順序がぶれないことなので、これで足りる。
	// 同一ミリ秒内まで時系列で並べたい場合は id を ULID / UUIDv7 に変える必要がある（#46）。
	//
	// 次ページの有無を判定するために 1 件多く読む。余った行はレスポンスに載せない。
	//
	// cursor と offset の併用はクエリ検証で弾いているため、cursor があるときの
	// offset は必ず既定値の 0 で、そのまま OFFSET に渡してよい。
	// `direction` は enum から導いた "ASC" / "DESC" のリテラルで、
	// 外部入力がそのまま SQL に入ることはない（スキーマを通らない値は 400）。
	const rows = await c.env.DB.prepare(
		`SELECT ${PUBLIC_SELECT} FROM issues ${where} ORDER BY created_at ${direction}, id ${direction} LIMIT ? OFFSET ?`,
	)
		.bind(...binds, limit + 1, offset)
		.all<CursorRow>();

	const hasMore = rows.results.length > limit;
	const page = hasMore ? rows.results.slice(0, limit) : rows.results;
	const lastRow = page.at(-1);

	return c.json({
		data: page.map(toPublicIssue),
		// フィルタ後の総件数。ページング UI はこれを見て最終ページを決める。
		total: countRow?.total ?? 0,
		limit,
		offset,
		// 既定値が効いたときに何で並んでいるかがレスポンスだけで分かるよう返す。
		sort,
		// 次ページが無いときは null。クライアントは null を見て打ち切れる。
		next_cursor: hasMore && lastRow ? buildIssueCursor(lastRow) : null,
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
issues.patch("/:id", clerkAuth(), requireAuth, async (c) => {
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
		`UPDATE issues SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ? RETURNING ${PUBLIC_SELECT}`,
	)
		.bind(...binds, id, auth?.userId)
		.first();

	if (!result) {
		return c.json({ error: "Issue not found" }, 404);
	}
	return c.json(toPublicIssue(result));
});

// DELETE /issues/:id — Delete (auth required, owner only)
issues.delete("/:id", clerkAuth(), requireAuth, async (c) => {
	const id = c.req.param("id");

	const denied = await checkOwnership(c, id);
	if (denied) {
		return denied;
	}

	const auth = getAuth(c);

	// 所有者チェックとの間で行が変わる可能性に備え、DELETE 自体にも所有者条件を入れる
	const result = await c.env.DB.prepare(
		`DELETE FROM issues WHERE id = ? AND user_id = ? RETURNING ${PUBLIC_SELECT}`,
	)
		.bind(id, auth?.userId)
		.first();

	if (!result) {
		return c.json({ error: "Issue not found" }, 404);
	}
	return c.json(toPublicIssue(result));
});

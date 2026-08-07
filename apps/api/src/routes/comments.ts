import { getAuth } from "@hono/clerk-auth";
import { CreateCommentSchema } from "@world-issue-tracker/shared";
import { type Context, Hono } from "hono";
import type { Bindings } from "../index";
import { requireAuth } from "../middleware/auth";
import { clerkAuth } from "../middleware/clerk";

/**
 * Issue のコメント。`/issues/:id/comments` にマウントされる（src/routes/issues.ts）。
 *
 * 親の Issue ID はパスパラメータ `:id` から引く。`mergeParams` を付けた
 * サブルーターにしているのは、issues.ts に直接足すとファイルが
 * 「Issue 自体の CRUD」と「その配下のリソース」で混ざるため。
 */
export const comments = new Hono<{ Bindings: Bindings }>();

/**
 * レスポンスに載せてよいカラム。
 *
 * `user_id`（Clerk User ID）は内部フィールドなので含めない。表示名が要るように
 * なったら、Clerk から引いた表示用の値を別途載せる（生の ID は公開しない）。
 */
export const PUBLIC_COMMENT_COLUMNS = [
	"id",
	"issue_id",
	"body",
	"created_at",
] as const;

type PublicComment = Record<(typeof PUBLIC_COMMENT_COLUMNS)[number], unknown>;

/**
 * レスポンスに載せるカラムだけを並べた SELECT / RETURNING 句。
 * `SELECT *` にすると、カラムを追加した瞬間にそれが公開されてしまう。
 */
export const PUBLIC_COMMENT_SELECT = PUBLIC_COMMENT_COLUMNS.join(", ");

/**
 * DB の行から公開してよいカラムだけを取り出す。
 * SELECT で絞ったうえで返す直前にも通す二段構え（issues.ts と同じ方針）。
 */
export function toPublicComment(row: Record<string, unknown>): PublicComment {
	return Object.fromEntries(
		PUBLIC_COMMENT_COLUMNS.map((column) => [column, row[column]]),
	) as PublicComment;
}

/**
 * `created_at` に入れるタイムスタンプの SQL 式。
 *
 * テーブルの DEFAULT は `datetime('now')`（秒精度）だが、コメントは
 * 同一秒に複数件付くことが普通にある。秒精度だと並び順のタイブレークが
 * `id`（ランダム値）だけになり、投稿順と表示順がずれる。
 * issues と同じくアプリ経由の書き込みではミリ秒精度で明示的に入れる。
 */
const NOW_SQL = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

comments.onError((err, c) => {
	if (err instanceof SyntaxError) {
		return c.json({ error: "Invalid JSON" }, 400);
	}
	throw err;
});

/**
 * 親の Issue が存在するか確かめる。
 *
 * 存在すればその ID を、存在しなければ 404 のレスポンスを返す。
 *
 * GET でも確認しているのは、存在しない Issue に対して空配列を返すと
 * 「コメントが 0 件の Issue」と区別が付かず、URL のタイプミスが
 * それらしい画面として表示されてしまうため。
 *
 * POST では外部キー制約と役割が重なるが、D1 は接続ごとに
 * `PRAGMA foreign_keys` の状態が変わりうるため、アプリ側でも確認する。
 * 制約違反を 500 として返すより、404 を明示的に返す方が意図が伝わる。
 *
 * 親 Issue の ID はここでまとめて読む。このルーターは `/issues/:id/comments`
 * にマウントされているため `:id` は実行時には必ず入るが、サブルーター側の型は
 * 親のパスパラメータを知らないので `string | undefined` になる。マウント先が
 * 変わったときに `undefined` が黙って SQL へ流れないよう、ここで弾いておく。
 */
async function findIssue(
	c: Context<{ Bindings: Bindings }>,
): Promise<{ issueId: string } | { response: Response }> {
	const issueId = c.req.param("id");
	if (!issueId) {
		return { response: c.json({ error: "Issue not found" }, 404) };
	}

	const row = await c.env.DB.prepare("SELECT id FROM issues WHERE id = ?")
		.bind(issueId)
		.first<{ id: string }>();

	if (!row) {
		return { response: c.json({ error: "Issue not found" }, 404) };
	}
	return { issueId };
}

// GET /issues/:id/comments — List (public)
comments.get("/", async (c) => {
	const found = await findIssue(c);
	if ("response" in found) {
		return found.response;
	}
	const { issueId } = found;

	// 一覧は古い順。Issue 一覧（新しい順）と逆にしているのは、コメントが
	// 会話であって「最新のお知らせ」ではないため。上から読めば議論の流れが追える。
	//
	// `created_at` はミリ秒精度だが、同一ミリ秒に複数件付くと順序が決まらず、
	// SQLite が返す順（実装依存）に委ねられる。一意な `id` を第二キーに置いて
	// 全順序を確定させる（issues の一覧と同じ理由）。
	//
	// ページングは付けていない。MVP の想定件数では 1 Issue に付くコメントが
	// 一画面に収まる範囲を大きく超えないため。件数が増えたら、
	// issues と同じカーソル方式を足す。
	const rows = await c.env.DB.prepare(
		`SELECT ${PUBLIC_COMMENT_SELECT} FROM comments WHERE issue_id = ? ORDER BY created_at ASC, id ASC`,
	)
		.bind(issueId)
		.all<Record<string, unknown>>();

	return c.json({
		data: rows.results.map(toPublicComment),
		total: rows.results.length,
	});
});

// POST /issues/:id/comments — Create (auth required)
comments.post("/", clerkAuth(), requireAuth, async (c) => {
	// 宛先の確認を入力バリデーションより先に行う。存在しない Issue に対して
	// 本文の検証結果を返す意味が無く、検証を通す前に INSERT へ進ませないため。
	const found = await findIssue(c);
	if ("response" in found) {
		return found.response;
	}
	const { issueId } = found;

	const body = await c.req.json();
	const parsed = CreateCommentSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	// `requireAuth` を通っているので `userId` は必ずある。
	// 型の上では `string | undefined` なので、万一 null のまま NOT NULL の
	// カラムへ流し込んで 500 になるより、ここで明示的に 401 にする。
	const userId = getAuth(c)?.userId;
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const result = await c.env.DB.prepare(
		`INSERT INTO comments (issue_id, user_id, body, created_at)
     VALUES (?, ?, ?, ${NOW_SQL})
     RETURNING ${PUBLIC_COMMENT_SELECT}`,
	)
		.bind(issueId, userId, parsed.data.body)
		.first();

	// INSERT が成功すれば RETURNING は必ず 1 行返すため、ここは実際には通らない。
	// `first()` の戻り値が null を含む型であることに対する処理で、
	// 握り潰して空のコメントを返さないよう 500 にしている。
	if (!result) {
		return c.json({ error: "Failed to create comment" }, 500);
	}
	return c.json(toPublicComment(result), 201);
});

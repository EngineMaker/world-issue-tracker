import { getAuth } from "@hono/clerk-auth";
import { CreateCommentSchema } from "@world-issue-tracker/shared";
import { type Context, Hono } from "hono";
import type { CommentRow, IssueRow } from "../db/rows";
import type { Bindings } from "../index";
import { fetchDisplayNames } from "../lib/display-names";
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
 * `user_id`（Clerk User ID）は内部フィールドなので含めない。画面に出す
 * 投稿者は、Clerk から引いた表示名を `display_name` として公開カラムの
 * **外側**で重ねる（#67。`PublicCommentWithAuthor`）。生の ID は公開しない。
 */
export const PUBLIC_COMMENT_COLUMNS = [
	"id",
	"issue_id",
	"body",
	"created_at",
] as const;

/**
 * レスポンスに載るコメント。`CommentRow` から公開カラムだけを取り出したもの
 * （`issues.ts` の `PublicIssue` と同じ導き方）。
 */
type PublicComment = Pick<CommentRow, (typeof PUBLIC_COMMENT_COLUMNS)[number]>;

/**
 * `toPublicComment` が受け取れる行。
 * 二段構えの 2 段目なので、`SELECT *` 相当の行も受けられるようにする
 * （`issues.ts` の `IssueRowLike` と同じ）。
 */
type CommentRowLike = PublicComment & Partial<CommentRow>;

/**
 * DB の行から公開してよいカラムだけを取り出す。
 * SELECT で絞ったうえで返す直前にも通す二段構え（issues.ts と同じ方針）。
 */
export function toPublicComment(row: CommentRowLike): PublicComment {
	return Object.fromEntries(
		PUBLIC_COMMENT_COLUMNS.map((column) => [column, row[column]]),
	) as PublicComment;
}

/**
 * 読み出しの SELECT には要るが、レスポンスには載せないカラム（#67）。
 *
 * `user_id` は投稿者の表示名を Clerk から引くために読む。返すのは
 * 引いた表示名だけで、ID そのものは `toPublicComment` が落とす
 * （`issues.ts` の `INTERNAL_AUTHOR_COLUMNS` と同じ扱い）。
 */
const INTERNAL_AUTHOR_COLUMNS = [
	"user_id",
] as const satisfies readonly (keyof CommentRow)[];

/**
 * 行を読む SELECT / RETURNING 句。公開カラムに `user_id` を足したもの。
 *
 * `SELECT *`・`RETURNING *` にすると、カラムを追加した瞬間にそれが
 * 公開されてしまう（`issues.ts` の `PUBLIC_SELECT` と同じ方針）。
 * ここで読む `user_id` は表示名を引くためのもので、返す直前に
 * `toPublicComment` が落とす。
 */
const READ_SELECT = [
	...PUBLIC_COMMENT_COLUMNS,
	...INTERNAL_AUTHOR_COLUMNS,
].join(", ");

/**
 * 読み出しで返るコメント。公開カラムに投稿者の表示を重ねたもの（#67）。
 *
 * `help-offers.ts` の `PublicHelpOfferWithName` と同じ構造で、
 * `PUBLIC_COMMENT_COLUMNS` の外側に足している。
 *
 * `is_anonymous` は「この投稿者を匿名として扱うか」。コメント自体に匿名の
 * 経路は無い（`user_id` は NOT NULL で、匿名で投稿する手段が無い）が、
 * **匿名で立てた Issue の起票者本人**が自分の Issue にコメントした場合だけ
 * 真になる。詳しくは `resolveCommentAuthors` を参照。
 *
 * `display_name` の `null` は「匿名扱い」「Clerk に表示名が無い」
 * 「Clerk へ問い合わせられなかった」の 3 通りを表す。画面は
 * `is_anonymous` で 1 つ目を見分け、残りをまとめて「名前未設定の方」と出す
 * （`packages/shared` の `getAuthorLabel`）。
 *
 * 一覧だけでなく投稿の POST もこの形で返す。理由は POST 側のコメントを参照
 * （`help-offers.ts` は POST に足していないが、あちらは作成直後の 1 件が
 * 画面上「あなた」と表示され、名前を引く必要が無いという違いがある）。
 */
type PublicCommentWithAuthor = PublicComment & {
	is_anonymous: boolean;
	display_name: string | null;
};

/**
 * コメントに投稿者の表示を重ねる（#67）。
 *
 * **匿名で立てられた Issue では、その起票者本人のコメントに表示名を出さない。**
 * コメントに匿名の経路は無いが、匿名で書いた人が自分の Issue に追記した
 * 瞬間だけ実名が出ると、その Issue で選んだ匿名がそこで崩れる。
 * 出さないだけでなく Clerk へ問い合わせもしない（`issues.ts` と同じ理由）。
 *
 * 逆に、**匿名の Issue でも第三者のコメントには表示名を出す**。ここで守って
 * いるのは「その Issue を匿名で書いた」という選択であって、別の人が自分の
 * 意思で発言することまでは覆わない（#108 が「手伝いますは自ら名乗り出る
 * 行為」として `user_id` を公開しているのと同じ考え方）。
 *
 * 問い合わせは 1 回にまとめる。コメント一覧はページングが無く全件返すため、
 * 100 件を超えると `fetchDisplayNames` が 100 件ずつに分割する
 * （1 人ずつにはしない。レート制限は本番で 1000 req / 10 秒しかない）。
 */
async function resolveCommentAuthors(
	c: Context<{ Bindings: Bindings }>,
	rows: CommentRowLike[],
	issue: Pick<IssueRow, "user_id" | "is_anonymous">,
): Promise<PublicCommentWithAuthor[]> {
	// 匿名として扱う投稿者。匿名で立てた Issue の起票者本人だけが該当する。
	// `user_id` が NULL の Issue（認証導入前の legacy 行）は誰のものでもない
	// ので、null 同士の一致で全員を匿名扱いにしないよう明示的に除く。
	const anonymousAuthorId =
		issue.is_anonymous !== 0 && issue.user_id ? issue.user_id : null;

	const isAnonymousComment = (row: CommentRowLike): boolean =>
		anonymousAuthorId !== null && row.user_id === anonymousAuthorId;

	const displayNames = await fetchDisplayNames(
		c.env.CLERK_SECRET_KEY,
		rows
			.filter((row) => !isAnonymousComment(row) && row.user_id)
			.map((row) => row.user_id as string),
	);

	return rows.map((row) => {
		const anonymous = isAnonymousComment(row);
		return {
			...toPublicComment(row),
			is_anonymous: anonymous,
			display_name:
				anonymous || !row.user_id
					? null
					: (displayNames.get(row.user_id) ?? null),
		};
	});
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
): Promise<{ issue: IssueOwner } | { response: Response }> {
	const issueId = c.req.param("id");
	if (!issueId) {
		return { response: c.json({ error: "Issue not found" }, 404) };
	}

	// 起票者と匿名かどうかも一緒に読む（#67）。一覧を返す際に「この Issue を
	// 匿名で立てた本人のコメントか」を判定するのに要る。存在確認のためだけに
	// もう一度 issues を引くより、同じ 1 回の SELECT で済ませる。
	const row = await c.env.DB.prepare(
		"SELECT id, user_id, is_anonymous FROM issues WHERE id = ?",
	)
		.bind(issueId)
		.first<IssueOwner>();

	if (!row) {
		return { response: c.json({ error: "Issue not found" }, 404) };
	}
	return { issue: row };
}

/** `findIssue` が返す親 Issue の情報。ID と、匿名の出し分けに要る 2 列。 */
type IssueOwner = Pick<IssueRow, "id" | "user_id" | "is_anonymous">;

// GET /issues/:id/comments — List (public)
comments.get("/", async (c) => {
	const found = await findIssue(c);
	if ("response" in found) {
		return found.response;
	}
	const { issue } = found;

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
		`SELECT ${READ_SELECT} FROM comments WHERE issue_id = ? ORDER BY created_at ASC, id ASC`,
	)
		.bind(issue.id)
		.all<CommentRowLike>();

	// 投稿者の表示名を Clerk からまとめて引いて重ねる（#67）。
	// ここは失敗しても throw しない（`fetchDisplayNames` の性質）。
	// 名前が引けないことでコメント欄そのものが消えてはいけない。
	const data = await resolveCommentAuthors(c, rows.results, issue);

	return c.json({
		data,
		total: data.length,
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
	const issueId = found.issue.id;

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

	// RETURNING に `user_id` を含めるのは、返す 1 件に投稿者の表示を
	// 重ねるため（#67）。値そのものは `toPublicComment` が落とす。
	const result = await c.env.DB.prepare(
		`INSERT INTO comments (issue_id, user_id, body, created_at)
     VALUES (?, ?, ?, ${NOW_SQL})
     RETURNING ${READ_SELECT}`,
	)
		.bind(issueId, userId, parsed.data.body)
		.first<CommentRowLike>();

	// INSERT が成功すれば RETURNING は必ず 1 行返すため、ここは実際には通らない。
	// `first()` の戻り値が null を含む型であることに対する処理で、
	// 握り潰して空のコメントを返さないよう 500 にしている。
	if (!result) {
		return c.json({ error: "Failed to create comment" }, 500);
	}

	// 一覧と同じ形で返す（#67）。画面は投稿に成功したコメントを手元の一覧へ
	// そのまま追記するので、ここだけ `display_name` が無いと「名前未設定の方」
	// として並び、再読み込みで初めて名前が出ることになる。
	// Issue の POST（`issues.ts`）に足していないのは、あちらの作成直後の
	// 遷移先が詳細ページで、追記先の一覧を持たないため。
	const [comment] = await resolveCommentAuthors(c, [result], found.issue);
	return c.json(comment, 201);
});

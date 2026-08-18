import { getAuth } from "@hono/clerk-auth";
import { type Context, Hono } from "hono";
import type { IssueRow, ReactionRow } from "../db/rows";
import type { Bindings } from "../index";
import {
	viewerUserId as getViewerUserId,
	requireAuth,
} from "../middleware/auth";
import { clerkAuth } from "../middleware/clerk";

/**
 * 「私も困っている」の表明を扱うルーターが動く環境。
 *
 * `Variables.issueId` は mount 元がパスパラメータから取り出した Issue ID
 * （`help-offers.ts` と同じ理由。`route()` は mount 先のパスパラメータを
 * 子へ引き継がない）。
 */
export type ReactionsEnv = {
	Bindings: Bindings;
	Variables: { issueId: string };
};

/**
 * 「私も困っている」の表明を扱うルート（#112）。
 *
 * `/issues/:id/reactions` に mount される（`routes/issues.ts`）。
 *
 * 「手伝います」（`help-offers.ts`）と対になる機能で、実装の形もほぼ同じだが、
 * 公開する情報が違う。あちらは「誰が表明したか」まで出すのに対し、
 * こちらは件数しか出さない（下の `PUBLIC_REACTION_COLUMNS` 参照）。
 */
export const reactions = new Hono<ReactionsEnv>();

/**
 * 反応 1 件の公開表現。
 *
 * **`user_id` を意図的に含めていない。** `help_offers` はこれを公開しているが、
 * あちらは「本人が自分の意思で名乗り出る行為」だから成り立つ扱いで、
 * こちらは性質が違う。「私も困っている」は生活圏の露出につながりえる
 * （「この人も同じ場所で困っている」）。Issue 本体を既定で匿名にした方針（#88）
 * とも整合させ、誰が押したかは公開しない。
 *
 * ここに `user_id` を足すと `test/schema.test.ts` の分類が落ちる。
 * 型では止まらない（実在するカラムなので `Pick` の制約を満たしてしまう）ので、
 * この判断はテストが守っている。
 *
 * この配列が使われるのは POST の RETURNING だけ。GET は行を返さず
 * 件数だけを返すため、SELECT 句の生成には使わない。
 */
export const PUBLIC_REACTION_COLUMNS = ["id", "created_at"] as const;

/**
 * レスポンスに載る反応。`ReactionRow` から公開カラムだけを取り出したもの
 * （`issues.ts` の `PublicIssue` と同じ導き方）。
 *
 * `issue_id` は URL から自明なので載せていない。`user_id` は上の理由で載せない。
 */
type PublicReaction = Pick<
	ReactionRow,
	(typeof PUBLIC_REACTION_COLUMNS)[number]
>;

/**
 * `toPublicReaction` が受け取れる行。
 * 二段構えの 2 段目なので、`SELECT *` 相当の行も受けられるようにする
 * （`help-offers.ts` の `HelpOfferRowLike` と同じ）。
 */
type ReactionRowLike = PublicReaction & Partial<ReactionRow>;

/** レスポンスに載せるカラムだけを並べた RETURNING 句。`*` は使わない。 */
const PUBLIC_SELECT = PUBLIC_REACTION_COLUMNS.join(", ");

/** `issues.ts` の `NOW_SQL` と同じ理由でミリ秒精度を明示的に入れる。 */
const NOW_SQL = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

/**
 * 行から公開してよいカラムだけを取り出す。
 *
 * RETURNING でカラムを絞ったうえで、返す直前にもここを通す二段構え
 * （`issues.ts` の `toPublicIssue` と同じ方針）。句の書き漏れがあっても
 * `user_id` はここで落ちる。
 */
function toPublicReaction(row: ReactionRowLike): PublicReaction {
	return Object.fromEntries(
		PUBLIC_REACTION_COLUMNS.map((column) => [column, row[column]]),
	) as PublicReaction;
}

/**
 * 対象の Issue が存在するか確かめる。存在しなければ 404 のレスポンスを返す。
 *
 * `reactions.issue_id` には外部キー制約を張っているが、D1 / SQLite の
 * 外部キー強制は接続ごとの `PRAGMA foreign_keys` に依存し、有効である保証が無い
 * （`help-offers.ts` の同名の関数と同じ理由）。
 */
async function requireIssue(
	c: Context<ReactionsEnv>,
	issueId: string,
): Promise<Response | null> {
	const row = await c.env.DB.prepare("SELECT id FROM issues WHERE id = ?")
		.bind(issueId)
		.first<Pick<IssueRow, "id">>();

	if (!row) {
		return c.json({ error: "Issue not found" }, 404);
	}
	return null;
}

/**
 * ある Issue の反応件数と、閲覧者自身が反応済みかを 1 クエリで数える。
 *
 * 件数と「自分が押したか」を別々のクエリで引くと、その間に他の人の反応が
 * 入ったときに両者が食い違う。押した直後に正しい値を見せたい画面なので、
 * 同じスナップショットから両方を出す。
 *
 * 未ログイン（`viewerUserId` が null）のとき `SUM` の条件は決して真にならず、
 * `viewer_reacted` は 0 になる。
 */
async function countReactions(
	c: Context<ReactionsEnv>,
	issueId: string,
	viewerUserId: string | null,
): Promise<{ total: number; viewerReacted: boolean }> {
	const row = await c.env.DB.prepare(
		`SELECT COUNT(*) AS total,
            SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS viewer_reacted
     FROM reactions WHERE issue_id = ?`,
	)
		.bind(viewerUserId, issueId)
		.first<{ total: number; viewer_reacted: number | null }>();

	return {
		total: row?.total ?? 0,
		// 0 件のとき SUM は NULL を返すため、真偽値への変換は 0 との比較で行う
		viewerReacted: (row?.viewer_reacted ?? 0) > 0,
	};
}

// GET /issues/:id/reactions — 件数と自分が押したか (public)
//
// 未ログインでも件数は見える。「何人が同じことで困っているか」は
// この Issue の状況そのものなので、読むのにログインを要求しない。
//
// **返すのは件数と真偽値だけで、反応した人の一覧は返さない。**
// 誰が押したかを公開しない方針（上の `PUBLIC_REACTION_COLUMNS` 参照）は、
// この経路からも抜けないようにする。`help-offers` が `data` 配列を持つのと
// 形が違うのはそのため。
//
// `clerkAuth()` を差しているのは認証を要求するためではなく、ログイン中なら
// 「自分が反応済みか」(`viewer_reacted`) を一緒に返すため。このミドルウェアは
// キー不在・認証失敗のいずれでも未認証のまま先へ進むので（`middleware/clerk.ts`）、
// 公開エンドポイントがログインの成否や Clerk の可用性に巻き込まれることはない。
reactions.get("/", clerkAuth(), async (c) => {
	const issueId = c.get("issueId");

	const missing = await requireIssue(c, issueId);
	if (missing) {
		return missing;
	}

	const { total, viewerReacted } = await countReactions(
		c,
		issueId,
		getViewerUserId(c),
	);

	return c.json({ total, viewer_reacted: viewerReacted });
});

// POST /issues/:id/reactions — 「私も困っている」と表明する (auth required)
reactions.post("/", clerkAuth(), requireAuth, async (c) => {
	const issueId = c.get("issueId");

	const missing = await requireIssue(c, issueId);
	if (missing) {
		return missing;
	}

	const auth = getAuth(c);
	const userId = auth?.userId;

	// 二重の反応は 409 ではなく、既存の行をそのまま返す（`help-offers.ts` と同じ）。
	//
	// この操作は「反応している」という状態を作るもので、押した回数に意味は無い。
	// 二重送信（連打、再送、複数タブ）で失敗を見せても利用者にできることが無く、
	// 実際の状態は望みどおりになっている。冪等に倒す。
	//
	// `DO UPDATE` で自分自身の列を書き戻すことで、衝突時も 1 クエリで既存行を
	// 取れる（`created_at` は据え置かれるので「最初に反応した時刻」が
	// 連打で上書きされることもない）。
	const result = await c.env.DB.prepare(
		`INSERT INTO reactions (issue_id, user_id, created_at)
     VALUES (?, ?, ${NOW_SQL})
     ON CONFLICT (issue_id, user_id) DO UPDATE SET created_at = created_at
     RETURNING ${PUBLIC_SELECT}`,
	)
		.bind(issueId, userId)
		.first<PublicReaction>();

	// INSERT / DO UPDATE のいずれでも RETURNING は 1 行返すため、ここは通らない。
	// `first()` が null を含む型であることへの処理で、握り潰して空の反応を
	// 返さないよう 500 にしている（`help-offers.ts` の POST と同じ方針）。
	if (!result) {
		return c.json({ error: "Failed to create reaction" }, 500);
	}
	return c.json(toPublicReaction(result), 201);
});

// DELETE /issues/:id/reactions — 反応を取り消す (auth required)
//
// 取り消せる対象は「自分の反応」だけなので、URL に反応の ID は取らない。
// `/reactions/:reactionId` にすると、他人の ID を指定して消せないことを
// 別途チェックする必要が出るうえ、クライアントは自分の反応の ID を
// 覚えておく必要がある。誰の反応を消すかは常にトークンから決まる。
//
// この機能では反応の ID を GET で返してすらいないので、URL に取る形は
// そもそも成立しない。
reactions.delete("/", clerkAuth(), requireAuth, async (c) => {
	const issueId = c.get("issueId");

	const missing = await requireIssue(c, issueId);
	if (missing) {
		return missing;
	}

	const auth = getAuth(c);
	const userId = auth?.userId;

	// WHERE に user_id を含めているので、他人の反応には届かない。
	//
	// 反応していない状態で取り消しても 404 にはしない。POST を冪等にしたのと
	// 対称で、望まれているのは「反応していない状態」であり、それは既に成立している。
	// 消せた場合と元から無かった場合で結果が変わらないため、レスポンスも分岐させず
	// 一律 204 を返す。
	await c.env.DB.prepare(
		"DELETE FROM reactions WHERE issue_id = ? AND user_id = ?",
	)
		.bind(issueId, userId)
		.run();

	return c.body(null, 204);
});

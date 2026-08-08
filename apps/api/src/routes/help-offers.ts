import { getAuth } from "@hono/clerk-auth";
import { type Context, Hono } from "hono";
import type { Bindings } from "../index";
import {
	viewerUserId as getViewerUserId,
	requireAuth,
} from "../middleware/auth";
import { clerkAuth } from "../middleware/clerk";

/**
 * 「手伝います」の表明を扱うルーターが動く環境。
 *
 * `Variables.issueId` は mount 元がパスパラメータから取り出した Issue ID。
 * このルーター自身は `/issues/:id` の下にぶら下がるだけで、自分では `:id` を知らない
 * （Hono の `route()` は mount 先のパスパラメータを子へ引き継がない）。
 */
export type HelpOffersEnv = {
	Bindings: Bindings;
	Variables: { issueId: string };
};

/**
 * 「手伝います」の表明を扱うルート。
 *
 * `/issues/:id/help-offers` に mount される（`routes/issues.ts`）。
 * Issue 本体とはライフサイクルも認可の形も違う（本体は所有者だけが編集できるが、
 * 表明は「所有者以外の誰か」が作るのが本来の使われ方）ため、ファイルを分けている。
 */
export const helpOffers = new Hono<HelpOffersEnv>();

/**
 * 表明 1 件の公開表現。
 *
 * `user_id`（Clerk User ID）を載せている。Issue 本体では
 * `PUBLIC_ISSUE_COLUMNS` から意図的に除外している値だが、ここでは公開する。
 *
 * 「表明した人数、および誰が表明したか」を出すのがこの機能の要件であり、
 * 「何人が動けるか」だけでは、起票者から見て次に何が起きるのか分からないため。
 * Issue 本体の `user_id` を隠しているのは「匿名で困りごとを書ける」ことを
 * 守るためで、こちらは逆に本人が自分の意思で名乗り出る行為なので、
 * 秘匿すべき対象が違う。
 *
 * ただし出せるのは Clerk の内部 ID までで、表示名やアバターは持っていない
 * （取得するには Clerk Backend API への追加の問い合わせが要る）。
 * 現状の画面は ID をそのまま並べるのではなく「自分が表明済みか」と件数の
 * 表示に使っている。表示名を出すのは別途対応が要る。
 */
export const PUBLIC_HELP_OFFER_COLUMNS = [
	"id",
	"user_id",
	"created_at",
] as const;

type PublicHelpOffer = Record<
	(typeof PUBLIC_HELP_OFFER_COLUMNS)[number],
	unknown
>;

/**
 * レスポンスに載せるカラムだけを並べた SELECT / RETURNING 句。
 * `issues.ts` の `PUBLIC_SELECT` と同じ方針で、`*` は使わない。
 */
const PUBLIC_SELECT = PUBLIC_HELP_OFFER_COLUMNS.join(", ");

/** `issues.ts` の `NOW_SQL` と同じ理由でミリ秒精度を明示的に入れる。 */
const NOW_SQL = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

function toPublicHelpOffer(row: Record<string, unknown>): PublicHelpOffer {
	return Object.fromEntries(
		PUBLIC_HELP_OFFER_COLUMNS.map((column) => [column, row[column]]),
	) as PublicHelpOffer;
}

/**
 * 対象の Issue が存在するか確かめる。存在しなければ 404 のレスポンスを返す。
 *
 * `help_offers.issue_id` には外部キー制約を張っているが、D1 / SQLite の
 * 外部キー強制は接続ごとの `PRAGMA foreign_keys` に依存し、有効である保証が無い。
 * 無効なら存在しない Issue への表明が黙って INSERT され、どこからも読めない
 * 行が残る。ここで明示的に確かめて 404 を返す。
 */
async function requireIssue(
	c: Context<HelpOffersEnv>,
	issueId: string,
): Promise<Response | null> {
	const row = await c.env.DB.prepare("SELECT id FROM issues WHERE id = ?")
		.bind(issueId)
		.first<{ id: string }>();

	if (!row) {
		return c.json({ error: "Issue not found" }, 404);
	}
	return null;
}

// GET /issues/:id/help-offers — List (public)
//
// 未ログインでも件数と表明者は見える。「何人が動こうとしているか」は
// この Issue の状況そのものなので、読むのにログインを要求しない。
//
// `clerkAuth()` を差しているのは認証を要求するためではなく、ログイン中なら
// 「自分が表明済みか」(`viewer_offered`) を一緒に返すため。このミドルウェアは
// キー不在・認証失敗のいずれでも未認証のまま先へ進むので（`middleware/clerk.ts`）、
// 公開エンドポイントがログインの成否や Clerk の可用性に巻き込まれることはない。
// `requireAuth` は差していない。
helpOffers.get("/", clerkAuth(), async (c) => {
	const issueId = c.get("issueId");

	const missing = await requireIssue(c, issueId);
	if (missing) {
		return missing;
	}

	// 表明が付く数は Issue あたり数十件の想定なので、ページングは付けていない。
	// 一覧が長くなるようなら `issues` と同じカーソル方式を足す。
	const rows = await c.env.DB.prepare(
		`SELECT ${PUBLIC_SELECT} FROM help_offers WHERE issue_id = ? ORDER BY created_at ASC, id ASC`,
	)
		.bind(issueId)
		.all<Record<string, unknown>>();

	const data = rows.results.map(toPublicHelpOffer);

	// 閲覧者自身が表明済みかどうかと、その閲覧者の User ID。
	//
	// `data` に自分の user_id が含まれるかはクライアント側でも判定できるが、
	// それには「自分の Clerk User ID」をクライアントが知っている必要がある。
	// ボタンの表示（「手伝います」/「取り消す」）を決めるのに毎回そこを
	// 突き合わせさせるより、サーバーが答えを返す方が食い違いが起きない。
	//
	// `viewer_user_id` も返しているのは、一覧の中のどれが自分の表明かを
	// 画面上で示せるようにするため（`viewer_offered` の真偽値だけでは
	// 「自分は表明済み」までしか分からず、行と対応付けられない）。
	// 返すのは自分自身の ID だけで、他人の身元がここから増えることはない。
	//
	// 未ログインなら `viewer_offered` は false、`viewer_user_id` は null。
	const viewerUserId = getViewerUserId(c);
	const viewerOffered =
		viewerUserId !== null &&
		data.some((offer) => offer.user_id === viewerUserId);

	// `total` は `data.length` から出す。別途 COUNT を打つと、
	// 二つのクエリの間に挿入が入ったとき件数と中身が食い違う。
	return c.json({
		data,
		total: data.length,
		viewer_offered: viewerOffered,
		viewer_user_id: viewerUserId,
	});
});

// POST /issues/:id/help-offers — 「手伝います」と表明する (auth required)
helpOffers.post("/", clerkAuth(), requireAuth, async (c) => {
	const issueId = c.get("issueId");

	const missing = await requireIssue(c, issueId);
	if (missing) {
		return missing;
	}

	const auth = getAuth(c);
	const userId = auth?.userId;

	// 二重表明は 409 ではなく、既存の行をそのまま 200 で返す。
	//
	// この操作は「表明している」という状態を作るもので、押した回数に意味は無い。
	// 二重送信（連打、再送、複数タブ）で失敗を見せても利用者にできることが無く、
	// 実際の状態は望みどおりになっている。冪等に倒す。
	//
	// `ON CONFLICT DO NOTHING` にすると RETURNING が何も返さず、既存行を
	// 引き直す往復が要る。`DO UPDATE` で自分自身の列を書き戻すことで、
	// 衝突時も 1 クエリで既存行を取れる（`created_at` は据え置かれるので
	// 「最初に表明した時刻」が連打で上書きされることもない）。
	//
	// 新規作成か既存かをレスポンスのステータスで区別していないのは、
	// クライアントがその違いで挙動を変える必要が無いため。
	const result = await c.env.DB.prepare(
		`INSERT INTO help_offers (issue_id, user_id, created_at)
     VALUES (?, ?, ${NOW_SQL})
     ON CONFLICT (issue_id, user_id) DO UPDATE SET created_at = created_at
     RETURNING ${PUBLIC_SELECT}`,
	)
		.bind(issueId, userId)
		.first();

	// INSERT / DO UPDATE のいずれでも RETURNING は 1 行返すため、ここは通らない。
	// `first()` が null を含む型であることへの処理で、握り潰して空の表明を
	// 返さないよう 500 にしている（`issues.ts` の POST と同じ方針）。
	if (!result) {
		return c.json({ error: "Failed to create help offer" }, 500);
	}
	return c.json(toPublicHelpOffer(result), 201);
});

// DELETE /issues/:id/help-offers — 表明を取り消す (auth required)
//
// 取り消せる対象は「自分の表明」だけなので、URL に表明の ID は取らない。
// `/help-offers/:offerId` にすると、他人の ID を指定して消せないことを
// 別途チェックする必要が出るうえ、クライアントは自分の表明の ID を
// 覚えておく必要がある。誰の表明を消すかは常にトークンから決まる。
helpOffers.delete("/", clerkAuth(), requireAuth, async (c) => {
	const issueId = c.get("issueId");

	const missing = await requireIssue(c, issueId);
	if (missing) {
		return missing;
	}

	const auth = getAuth(c);
	const userId = auth?.userId;

	// WHERE に user_id を含めているので、他人の表明には届かない。
	//
	// 表明していない状態で取り消しても 404 にはしない。POST を冪等にしたのと
	// 対称で、望まれているのは「表明していない状態」であり、それは既に成立している。
	// 消せた場合と元から無かった場合で結果が変わらないため、レスポンスも分岐させず
	// 一律 204 を返す。
	await c.env.DB.prepare(
		"DELETE FROM help_offers WHERE issue_id = ? AND user_id = ?",
	)
		.bind(issueId, userId)
		.run();

	return c.body(null, 204);
});

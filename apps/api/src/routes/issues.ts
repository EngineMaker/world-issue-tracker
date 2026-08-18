import { getAuth } from "@hono/clerk-auth";
import type { IssuePhotoContentType } from "@world-issue-tracker/shared";
import {
	buildIssueCursor,
	CreateIssueSchema,
	escapeLikePattern,
	ISSUE_PHOTO_CONTENT_TYPES,
	ISSUE_PHOTO_MAX_BYTES,
	isIssuePhotoContentType,
	ListIssuesQuerySchema,
	parseIssueCursor,
	UpdateIssueSchema,
} from "@world-issue-tracker/shared";
import { type Context, Hono } from "hono";
import type { IssueRow } from "../db/rows";
import type { Bindings } from "../index";
import { fetchDisplayNames } from "../lib/display-names";
import { requireAuth, viewerUserId } from "../middleware/auth";
import { clerkAuth } from "../middleware/clerk";
import { comments } from "./comments";
import { helpOffers } from "./help-offers";
import { reactions } from "./reactions";

/**
 * このルーターが動く環境。
 *
 * `Variables.issueId` は `/issues/:id/help-offers` へ委譲する際に、mount 元で
 * 取り出した Issue ID を子ルーターへ渡すための変数（`route()` はパスパラメータを
 * 引き継がない）。
 */
type IssuesEnv = {
	Bindings: Bindings;
	Variables: { issueId: string };
};

export const issues = new Hono<IssuesEnv>();

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
	// 匿名で起票されたかどうか（#88）。返すのは真偽値だけで、`user_id` は
	// ここに足さない。「誰が書いたか」を伏せる方針は変えず、
	// 「名乗っているかどうか」だけを画面が出し分けられるようにする。
	"is_anonymous",
] as const;

/**
 * SELECT には要るが、レスポンスには載せないカラム。
 *
 * `photo_key` は R2 のオブジェクトキーで、当てれば画像そのものが取れる
 * 内部の識別子。公開すると `GET /issues/:id/photo` を経由しない読み方が
 * 生まれ、将来の非公開化（通報対応）が効かない経路になる。
 * 画像の有無は `has_photo` という派生フィールドに畳んで返す。
 *
 * `photo_content_type` も同じ理由で載せない。画像の形式は配信側の
 * `Content-Type` が伝えるもので、Issue の行の属性として見せる意味が無い。
 */
const INTERNAL_PHOTO_COLUMNS = [
	"photo_key",
	"photo_content_type",
] as const satisfies readonly (keyof IssueRow)[];

/**
 * 読み出しの SELECT には要るが、レスポンスには載せないカラム（#67）。
 *
 * `user_id` は起票者の表示名を Clerk から引くために読む。返すのは
 * 引いた表示名（`display_name`）だけで、ID そのものは `toPublicIssue` が
 * 落とす。「誰が書いたか」を伏せる方針（`PUBLIC_ISSUE_COLUMNS` の説明）は
 * 変えていない。
 *
 * 書き込み系の RETURNING（`PUBLIC_SELECT`）には足していない。あちらは
 * 作成・更新した本人へ返すもので、表示名を引く場面が無いため
 * （`help-offers.ts` が POST のレスポンスに `display_name` を足していないのと同じ）。
 */
const INTERNAL_AUTHOR_COLUMNS = [
	"user_id",
] as const satisfies readonly (keyof IssueRow)[];

/**
 * JSON で真偽値として返すカラム。
 *
 * SQLite に真偽値型は無く、`is_anonymous` は INTEGER の 0/1 として
 * 返ってくる。そのまま載せると JSON にも 0/1 が出て、クライアント側で
 * `0` を falsy として扱うか数値として扱うかが実装ごとにぶれる。
 * 「匿名かどうか」は真偽値だという契約をレスポンスの形で固定する。
 */
const BOOLEAN_ISSUE_COLUMNS: ReadonlySet<string> = new Set(["is_anonymous"]);

/**
 * レスポンスに載る Issue。`IssueRow` から公開カラムだけを取り出し、
 * 写真の有無を表す派生フィールドを足したもの。
 *
 * 素の列は `PUBLIC_ISSUE_COLUMNS` から導いているので、あの配列に無いキー
 * （`user_id` など）はこの型にも現れない。逆に配列へカラムを足すと、
 * `IssueRow` に無い名前ならここで型エラーになる。
 *
 * ただし型が捕まえるのは「テーブルに存在しないカラム名」までで、
 * **`user_id` を配列に足す変更は型では止まらない**（実在するカラムなので
 * `Pick` の制約を満たしてしまう）。何を公開してよいかは人が決める判断であり、
 * 型で表現できない。そこを守っているのは `test/issues.test.ts` の
 * `Defence layers` で、実際に足すとあのテストが落ちる。
 * このリストを触るときは「型が通ったから安全」と判断しないこと。
 */
type PublicIssue = Omit<
	Pick<IssueRow, (typeof PUBLIC_ISSUE_COLUMNS)[number]>,
	"is_anonymous"
> & {
	/**
	 * この Issue に写真が添付されているか。
	 *
	 * 画面は写真があればそれを、無ければ地図（#63）を出す。その分岐に
	 * 必要なのは有無だけで、キーの中身は要らない。
	 */
	has_photo: boolean;

	/**
	 * この Issue に付いた「私も困っている」の件数（#112）。
	 *
	 * 一覧のカードに出すために行と一緒に返す。件数だけを別経路
	 * （`GET /issues/:id/reactions`）で引くと、一覧の 1 ページ分だけ
	 * 往復が要り、ページを開くたびに件数分のリクエストが飛ぶ。
	 *
	 * 素の列ではなく相関副問い合わせで数えた派生フィールドなので、
	 * `PUBLIC_ISSUE_COLUMNS`（＝ issues テーブルの公開カラム）には入れない。
	 * `has_photo` と同じ扱い。
	 *
	 * 誰が押したかは含まない。数だけを出すのがこの機能の決めごと
	 * （`routes/reactions.ts` 参照）。閲覧者自身が押したかどうかも
	 * ここには載せず、詳細ページが `/reactions` から取る。
	 */
	reaction_count: number;

	/**
	 * 匿名で起票されたか（#88）。
	 *
	 * `IssueRow` 側は SQLite の生の姿である `number`（0/1）だが、
	 * レスポンスでは真偽値として返す（`toPublicIssue` が変換する）。
	 * ここで `Omit` して上書きしているのはそのため。素の `Pick` のままだと
	 * 型が `number` になり、実際に返る値と食い違う。
	 */
	is_anonymous: boolean;
};

/**
 * `toPublicIssue` が受け取れる行。
 *
 * 二段構えの 2 段目は「SELECT が内部フィールドまで拾ってしまった行」を
 * 落とすためのものなので、`IssueRow` そのもの（= `SELECT *` 相当）も
 * 公開カラムだけに絞った行も受けられる必要がある。公開カラムだけを必須にし、
 * 残りは任意として扱う。
 *
 * 必須の側を `PublicIssue` ではなく `Pick` で書いているのは、
 * `PublicIssue` が派生フィールド（`has_photo`）を持つため。あれは
 * この関数が組み立てるものであって、入力の行には無い。
 */
type IssueRowLike = Pick<IssueRow, (typeof PUBLIC_ISSUE_COLUMNS)[number]> &
	Partial<IssueRow> & {
		/**
		 * 相関副問い合わせで数えた反応の件数（#112）。`issues` テーブルの
		 * カラムではないので `IssueRow` には無く、ここで足している。
		 *
		 * 任意なのは、この列を選んでいない SELECT（POST / PATCH / DELETE の
		 * RETURNING）もこの関数を通るため。付いていなければ 0 として返す。
		 */
		reaction_count?: number;
	};

/**
 * レスポンスに載せるカラムだけを並べた SELECT / RETURNING 句。
 * `SELECT *`・`RETURNING *` にすると、カラムを追加した瞬間にそれが公開されてしまう。
 *
 * `photo_key` はここに含める。値そのものは返さないが、`has_photo` を
 * 組み立てるために読む必要があるため（`toPublicIssue` が落とす）。
 */
export const PUBLIC_SELECT = [
	...PUBLIC_ISSUE_COLUMNS,
	...INTERNAL_PHOTO_COLUMNS,
].join(", ");

/**
 * 反応の件数（#112）を数える相関副問い合わせ。
 *
 * 行を読む SELECT に足して、Issue 1 件ごとの件数を一緒に取る。
 * `reactions` の UNIQUE (issue_id, user_id) が張る索引の先頭列が
 * `issue_id` なので、この集計はその索引で引ける。
 *
 * 反応が 1 件も無ければ COUNT は 0 を返す（NULL にはならない）ので、
 * 外側で結合するより値の形が安定する。
 */
const REACTION_COUNT_SQL =
	"(SELECT COUNT(*) FROM reactions WHERE reactions.issue_id = issues.id) AS reaction_count";

/**
 * 行の読み出し（GET）で使う SELECT 句。公開カラムに反応の件数を足したもの。
 *
 * 書き込み系の RETURNING では使わない。RETURNING は更新した行そのものしか
 * 見ないため副問い合わせを書けるとは限らず、そこで件数が要る場面も無い
 * （作った直後・消した直後の反応は 0 件、または画面が使わない）。
 *
 * export しているのはテストのため。実際に発行される句でクエリプランを
 * 確かめないと、副問い合わせが索引を使わなくなっても気付けない。
 */
export const PUBLIC_SELECT_WITH_COUNTS = `${PUBLIC_ISSUE_COLUMNS.map((column) => `issues.${column}`).join(", ")}, ${INTERNAL_PHOTO_COLUMNS.map((column) => `issues.${column}`).join(", ")}, ${INTERNAL_AUTHOR_COLUMNS.map((column) => `issues.${column}`).join(", ")}, ${REACTION_COUNT_SQL}`;

/**
 * DB の行から公開してよいカラムだけを取り出す。
 *
 * SELECT / RETURNING でカラムを絞ったうえで、返す直前にもここを通す二段構えに
 * している。句の書き漏れがあっても、内部フィールドはここで落ちる。
 *
 * `photo_key` は明示的に列挙から外し、有無だけを `has_photo` に畳む。
 * 空文字が入ることは無い想定だが、`Boolean()` ではなく null 比較にすると
 * 「キーはあるが空」を写真ありと誤って扱うため、真値判定に寄せている。
 */
export function toPublicIssue(row: IssueRowLike): PublicIssue {
	return {
		...(Object.fromEntries(
			PUBLIC_ISSUE_COLUMNS.map((column) => [
				column,
				// 真偽値のカラムだけ 0/1 を boolean に直す。NULL は「値が無い」
				// ではなく「匿名でない」に倒さないよう、Boolean() ではなく
				// 明示的に 0 との比較で判定する（NOT NULL なので通常は来ない）。
				BOOLEAN_ISSUE_COLUMNS.has(column) ? row[column] !== 0 : row[column],
			]),
			// 真偽値へ直したカラムがあるので、`IssueRow` そのままの形にはならない。
			// 変換後の形（＝レスポンスの形）で受ける
		) as Omit<PublicIssue, "has_photo" | "reaction_count">),
		has_photo: Boolean(row.photo_key),
		// 件数を選んでいない SELECT（書き込み系の RETURNING）から来た行は
		// 0 にする。undefined をそのまま返すと JSON からキーごと消え、
		// 「0 件」と「取れなかった」の区別が付かないレスポンスになる。
		reaction_count: row.reaction_count ?? 0,
	};
}

/**
 * 読み出しで返る Issue。公開カラムに起票者の表示名を重ねたもの（#67）。
 *
 * `display_name` は `issues` テーブルのカラムではないので
 * `PUBLIC_ISSUE_COLUMNS` には入れず、ここで足している
 * （`help-offers.ts` の `PublicHelpOfferWithName` と同じ構造）。
 *
 * `null` は 3 通りを表す。「匿名で起票された」「Clerk に表示名が無い」
 * 「Clerk へ問い合わせられなかった」。画面は前者を `is_anonymous` で
 * 見分けて「匿名の方」と出し、後ろ 2 つはまとめて「名前未設定の方」になる
 * （`packages/shared` の `getAuthorLabel`）。障害の内訳を返しても
 * 利用者にできることが無く、可用性の状態を外へ漏らす必要も無い。
 */
type PublicIssueWithName = PublicIssue & {
	display_name: string | null;
};

/**
 * 行の一覧に起票者の表示名を重ねる（#67）。
 *
 * **匿名を選んだ起票者の `user_id` は Clerk へ渡さない。** 出さないだけで
 * なく問い合わせもしないのは、匿名で書いた人の ID が「この一覧を開くたびに
 * 引かれる ID」として外部サービス側に残るのを避けるため。
 * `user_id` が NULL の行（認証導入前の legacy 行）も同じ扱いにする。
 *
 * 問い合わせは 1 回にまとめる（`fetchDisplayNames` が重複を落とし、
 * 100 件ずつに分割する）。一覧の上限は 100 件なので通常 1 往復で収まる。
 *
 * 失敗しても throw しない性質は `fetchDisplayNames` 側が持っている。
 * 引けなかった人は `display_name` が null になるだけで、一覧そのものは
 * 必ず返る。表示名は「あると嬉しい」情報であって、Clerk が落ちている
 * ことで困りごとの一覧が見えなくなってはいけない。
 */
async function withAuthorNames(
	c: Context<IssuesEnv>,
	rows: IssueRowLike[],
): Promise<PublicIssueWithName[]> {
	// 真偽値への変換を `toPublicIssue` に任せたいので、先に整形してから
	// 元の行（`user_id` を持つ）と組にして持ち回る。
	const shaped = rows.map((row) => ({ row, issue: toPublicIssue(row) }));

	const namedUserIds = shaped
		.filter(({ row, issue }) => !issue.is_anonymous && row.user_id)
		.map(({ row }) => row.user_id as string);

	const displayNames = await fetchDisplayNames(
		c.env.CLERK_SECRET_KEY,
		namedUserIds,
	);

	return shaped.map(({ row, issue }) => ({
		...issue,
		display_name:
			issue.is_anonymous || !row.user_id
				? null
				: (displayNames.get(row.user_id) ?? null),
	}));
}

/**
 * `created_at` / `updated_at` の書式について。
 *
 * テーブルの DEFAULT は `datetime('now')`（秒精度）だが、それだと
 * 「作成と更新が同一秒内に起きると `updated_at` が動かない」ため、
 * 更新されたかどうかを値から判別できない。連続した更新でも順序が付くよう、
 * アプリ経由の書き込みでは下の 2 つの式でミリ秒精度を明示的に入れる。
 *
 * 書式は `YYYY-MM-DD HH:MM:SS.SSS` で、秒精度の `YYYY-MM-DD HH:MM:SS` と
 * 先頭が共通するため、DEFAULT で入った既存行との辞書順比較も概ね時系列順に並ぶ。
 * ただし同一秒内では `'...:00' < '...:00.000'` となり、DEFAULT で入った行が
 * 同じ瞬間のミリ秒精度の行より古い側に来る。順序は全順序として確定するので
 * カーソルページングの前提は崩れないが、同一秒内の並びは厳密な時系列ではない。
 */

/**
 * 更新時に `updated_at` へ入れる式。必ず前の値より後になる。
 *
 * 現在時刻（`strftime('%Y-%m-%d %H:%M:%f','now')`）をそのまま入れると、
 * 前回の書き込みと同じミリ秒に収まったときに
 * 値が動かない。`'now'` の解像度はミリ秒だが、D1 への連続した書き込みは
 * それより速く終わりうる（実測で連続10クエリのうち2つが同じ値になった）。
 * 値が動かないと「更新されたか」を値から判別できず、`updated_at` を
 * 基準にした並び順やページングも同値の行を区別できない。
 *
 * そこで「現在時刻」と「前の値の 1 ミリ秒後」の遅い方を採る。
 * 時間が経っていれば現在時刻がそのまま入り、同一ミリ秒に収まったときだけ
 * 前の値 +1ms になる。どちらの場合も前の値より厳密に後になる。
 *
 * `max()` で文字列比較しないのは、秒精度（DEFAULT で入った既存行）と
 * ミリ秒精度が混在すると `'...:00' > '...:00.000'` と誤判定するため。
 * 一度 unixepoch に直してから比べ、同じ書式に整え直す。
 *
 * 1 行の UPDATE の中で完結するので、読んでから書くまでの間に
 * 別の更新が挟まる余地は無い（アプリ側で読み直して計算すると、
 * 同じ Issue への同時更新で値が巻き戻りうる）。
 */
const NEXT_UPDATED_AT_SQL = `
	strftime(
		'%Y-%m-%d %H:%M:%f',
		max(
			unixepoch('now', 'subsec'),
			unixepoch(updated_at, 'subsec') + 0.001
		),
		'unixepoch'
	)
`;

/**
 * 作成時に `created_at` へ入れる式。既存の最新行より必ず後になる。
 *
 * 理由は `NEXT_UPDATED_AT_SQL` と同じで、連続した作成が同一ミリ秒に
 * 収まると `created_at` が同値になる。一覧は
 * `ORDER BY created_at DESC, id DESC` で並べているため、同値になると
 * `id`（`randomblob` のランダム値）で決着が付いてしまい、
 * 利用者から見て「新しい順」にならない。
 *
 * そこで既存の最大値の 1 ミリ秒後と現在時刻の遅い方を採る。
 * テーブルが空なら `max()` が NULL を返すので `coalesce` で現在時刻に倒す。
 *
 * サブクエリが全行を走査しないよう、`created_at` の索引
 * （`idx_issues_created_at`）が効く形にしている。
 */
const NEXT_CREATED_AT_SQL = `
	strftime(
		'%Y-%m-%d %H:%M:%f',
		max(
			unixepoch('now', 'subsec'),
			coalesce(
				(SELECT unixepoch(created_at, 'subsec') + 0.001
				 FROM issues ORDER BY created_at DESC LIMIT 1),
				0
			)
		),
		'unixepoch'
	)
`;

issues.onError((err, c) => {
	if (err instanceof SyntaxError) {
		return c.json({ error: "Invalid JSON" }, 400);
	}
	throw err;
});

/**
 * 起票リクエストのボディを読む。JSON と multipart/form-data の両方を受ける。
 *
 * 写真（#65）は multipart でしか送れないが、写真を付けない経路まで
 * multipart に寄せると、既存のクライアントと API を叩くだけの利用者に
 * 破壊的変更を強いる。Content-Type で分けて両方を受ける。
 *
 * multipart のときは全フィールドが文字列で届くため、数値項目
 * （latitude / longitude）はここで数値に直してからスキーマへ渡す。
 * `Number("")` が 0 になるのを避けるため、空文字は undefined に倒して
 * 「未入力」としてスキーマの required エラーに落とす（web 側の
 * `toNumber` と同じ考え方）。
 *
 * 写真そのものは `photo` パートから取り出し、スキーマの検証対象には
 * しない（Zod は File を検証する用途に向かず、サイズと MIME の検査は
 * この後で個別に行う）。
 */
async function readCreateIssueBody(c: Context<IssuesEnv>): Promise<{
	fields: unknown;
	photo: UploadedPhoto | null;
	thumbnail: UploadedPhoto | null;
}> {
	const contentType = c.req.header("Content-Type") ?? "";

	if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
		return { fields: await c.req.json(), photo: null, thumbnail: null };
	}

	const form = await c.req.formData();

	const text = (name: string): string | undefined => {
		const value = form.get(name);
		if (typeof value !== "string") {
			return undefined;
		}
		return value;
	};
	const numeric = (name: string): number | undefined => {
		const value = text(name);
		// 空文字は「未入力」。0 に化けさせない
		return value === undefined || value.trim() === ""
			? undefined
			: Number(value);
	};

	const photo = toPhotoFile(form.get("photo"));
	// 一覧用のサムネイル（#125）。ブラウザが原寸と一緒に送ってくる派生物で、
	// 無くても構わない（配信側が原寸に倒す）。写真そのものが無いのに
	// サムネイルだけ来ることは無いので、その組み合わせは後段で捨てる
	const thumbnail = toPhotoFile(form.get("thumbnail"));

	return {
		fields: {
			title: text("title"),
			description: text("description"),
			scope: text("scope"),
			latitude: numeric("latitude"),
			longitude: numeric("longitude"),
			// カテゴリは任意。パート自体が無い場合と空文字の場合の両方を
			// 「未指定」として扱う（空文字のままだと `min(1)` に当たる）
			category: text("category")?.trim() || undefined,
		},
		photo,
		thumbnail,
	};
}

/**
 * アップロードされた画像として扱うのに必要な最小限の形。
 *
 * `File` 型を使っていないのは、`@cloudflare/workers-types` の
 * `FormData.get()` が `string | null` としか宣言されておらず、実行時に
 * 返る `File` を型で表現できないため（`File` は値としても存在しないので
 * `instanceof` も書けない）。ここで使うのはサイズ・MIME・バイト列の
 * 3 つだけなので、その形だけを要求する。
 */
type UploadedPhoto = {
	size: number;
	type: string;
	arrayBuffer(): Promise<ArrayBuffer>;
};

/**
 * `photo` パートを画像として取り出す。画像でなければ null。
 *
 * サイズ 0 を除いているのは、ファイルを選ばずに送信したときブラウザが
 * 空のファイルパート（filename="" / size 0）を付けることがあるため。
 * 「写真なし」として扱わないと、中身の無い画像を保存してしまう。
 *
 * 文字列のパート（フォームのテキスト項目）は画像ではないので null。
 * 上の型が示すとおり、判別は宣言された型ではなく実際の値の形で行う。
 */
function toPhotoFile(value: unknown): UploadedPhoto | null {
	if (value === null || typeof value !== "object") {
		return null;
	}
	const candidate = value as Partial<UploadedPhoto>;
	if (
		typeof candidate.size !== "number" ||
		typeof candidate.type !== "string" ||
		typeof candidate.arrayBuffer !== "function"
	) {
		return null;
	}
	return candidate.size > 0 ? (candidate as UploadedPhoto) : null;
}

/**
 * 添付された写真を検証する。問題があればエラーレスポンスを返す。
 *
 * ブラウザ側でも縮小と形式変換をしているが、それは利用者の失敗を
 * 減らすためのもので、防御にはならない（curl でも叩ける）。
 * サイズと MIME はここで必ず見る。
 *
 * MIME はクライアントが名乗る値でしかなく、中身が本当に画像である保証は
 * 無い。ここで担保しているのは「配信時に `Content-Type` として返して
 * 安全な値だけを保存する」ことで、SVG（スクリプトを埋め込める）や
 * `text/html` が同一オリジンで配信されるのを防ぐのが目的。
 * 中身の検査（マジックバイト、実際のデコード）は #65 の範囲外。
 */
function validatePhoto(
	photo: UploadedPhoto,
):
	| { ok: true; contentType: IssuePhotoContentType }
	| { ok: false; error: string } {
	if (photo.size > ISSUE_PHOTO_MAX_BYTES) {
		return {
			ok: false,
			error: `Photo must be ${ISSUE_PHOTO_MAX_BYTES} bytes or smaller`,
		};
	}

	// `image/jpeg; charset=binary` のようにパラメータが付くことがあるため、
	// `;` より前だけを見る。大小の揺れ（`IMAGE/JPEG`）も正規化する
	const contentType = (photo.type.split(";")[0] ?? "").trim().toLowerCase();
	if (!isIssuePhotoContentType(contentType)) {
		return {
			ok: false,
			error: `Photo must be one of: ${ISSUE_PHOTO_CONTENT_TYPES.join(", ")}`,
		};
	}

	return { ok: true, contentType };
}

/**
 * R2 に置く写真のオブジェクトキーを組み立てる。
 *
 * Issue 1 件につき写真は 1 枚（#65 の決定）なので `issues/<id>` で
 * 一意に定まる。拡張子は付けない。配信時の `Content-Type` は DB の
 * `photo_content_type` から取るため、キーから形式を復元する必要が無い。
 *
 * Issue の ID は `lower(hex(randomblob(16)))` の 16 進 32 文字なので、
 * キーに使えない文字が混ざる余地は無い。
 */
export function photoObjectKey(issueId: string): string {
	return `issues/${issueId}`;
}

/**
 * R2 に置く一覧用サムネイルのオブジェクトキーを組み立てる（#125）。
 *
 * 原寸のキー（`issues/<id>`）から機械的に導けるので、DB に列を足していない。
 * 「あるかどうか」は R2 を引けば分かり、無ければ原寸に倒すだけで済む。
 * 列を足すと、#65 より前に投稿された写真のために結局 NULL の分岐が要り、
 * 分岐が DB と R2 の 2 か所に増える。
 *
 * R2 のキー空間はフラットなので、`issues/<id>` と `issues/<id>/thumbnail` が
 * 親子として衝突することはない。
 */
export function photoThumbnailObjectKey(issueId: string): string {
	return `${photoObjectKey(issueId)}/thumbnail`;
}

/**
 * 起票の途中で失敗したときに、作りかけの行を取り消す。
 *
 * 呼ばれるのは写真の保存に失敗した経路だけで、この時点の行はまだ
 * レスポンスを返しておらず、誰にも ID を知らせていない。よって
 * 参照している他のレコード（コメント、表明）も存在しない。
 *
 * 後始末そのものが失敗しても呼び出し側は 500 を返すため、ここでは
 * ログに残すだけにする。投げ直すと、利用者に伝わるエラーが
 * 「写真の保存に失敗」から後始末の失敗にすり替わってしまう。
 */
async function deleteIssueRow(
	c: Context<IssuesEnv>,
	issueId: string,
): Promise<void> {
	try {
		await c.env.DB.prepare("DELETE FROM issues WHERE id = ?")
			.bind(issueId)
			.run();
	} catch (error) {
		console.error("Failed to roll back issue after photo failure", error);
	}
}

// POST /issues — Create (auth required)
//
// JSON と multipart/form-data の両方を受ける。写真（#65）を付けるときは
// multipart で、`photo` パートに画像を入れる。
issues.post("/", clerkAuth(), requireAuth, async (c) => {
	const { fields, photo, thumbnail } = await readCreateIssueBody(c);
	const parsed = CreateIssueSchema.safeParse(fields);
	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	// 写真の検査は本文の検証を通ってから。順序に強い理由は無いが、
	// 「必須項目が埋まっていない」の方が利用者にとって直したい情報として先に来る
	let photoContentType: IssuePhotoContentType | null = null;
	if (photo) {
		const validated = validatePhoto(photo);
		if (!validated.ok) {
			return c.json({ error: validated.error }, 400);
		}
		photoContentType = validated.contentType;
	}

	// サムネイル（#125）も原寸と同じ規則で検査する。派生物ではあるが、
	// 配信されるのは原寸と同じ経路（同一オリジンで `Content-Type` を名乗って
	// 返す）なので、SVG や `text/html` を通す穴にしてはいけない。
	//
	// 検査に落ちたら 400 にして黙って捨てない。送ってくるのは自前の
	// ブラウザ側だけで、そこは作れなかったときに送らない作りになっている
	// （`createThumbnailFile` が null を返す）。それでも届いたなら、
	// 想定と違うものが来ているということ。握り潰すと気付けなくなる。
	let thumbnailContentType: IssuePhotoContentType | null = null;
	// 写真そのものが無いのにサムネイルだけ来ても保存する先が無いので見ない
	if (photo && thumbnail) {
		const validated = validatePhoto(thumbnail);
		if (!validated.ok) {
			return c.json({ error: validated.error }, 400);
		}
		thumbnailContentType = validated.contentType;
	}

	const {
		title,
		description,
		scope,
		latitude,
		longitude,
		category,
		is_anonymous: isAnonymous,
	} = parsed.data;
	const auth = getAuth(c);
	const userId = auth?.userId;

	// タイムスタンプは CTE で 1 度だけ求めて両方の列に使う。
	// 式を2回書くと評価も2回になり、その間にミリ秒が進むと
	// `created_at` と `updated_at` が作成時点でずれる。
	const result = await c.env.DB.prepare(
		`WITH ts(v) AS (SELECT ${NEXT_CREATED_AT_SQL})
     INSERT INTO issues (title, description, scope, latitude, longitude, category, user_id, is_anonymous, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, v, v FROM ts
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
			// D1 に真偽値をそのまま渡せないため 0/1 に直す。
			// スキーマの `.default(true)` が効いているので undefined は来ない。
			isAnonymous ? 1 : 0,
		)
		.first<IssueRowLike>();

	// INSERT が成功すれば RETURNING は必ず 1 行返すため、ここは実際には通らない。
	// `first()` の戻り値が null を含む型であることに対する処理で、
	// 握り潰して空の Issue を返さないよう 500 にしている。
	if (!result) {
		return c.json({ error: "Failed to create issue" }, 500);
	}

	if (!photo || !photoContentType) {
		return c.json(toPublicIssue(result), 201);
	}

	/*
	 * 写真がある場合の書き込み順序について。
	 *
	 * R2 のキーには Issue の ID が要る（`photoObjectKey`）ので、行を作るのが先。
	 * そのうえで R2 に置き、成功したら `photo_key` を書き戻す。
	 *
	 * D1 と R2 にまたがる更新なので、途中で失敗すると片方だけが進む。
	 * どちらに倒すかを次のように決めた:
	 *
	 * - R2 への PUT が失敗 → 作った行を消して 500。
	 *   写真を付けて投稿したのに写真の無い Issue が残ると、利用者は
	 *   「付けたつもり」でいるのに説得力を欠いた Issue が公開される。
	 *   それより起票ごと失敗して、やり直せる方がよい。
	 * - 書き戻しの UPDATE が失敗 → 置いた画像を消して 500。同じ理由に加え、
	 *   どの行からも参照されない画像を R2 に残さないため。
	 *
	 * 後始末そのものが失敗する可能性は残る（その場合は孤児ファイルか
	 * 写真の無い行が残る）。分散トランザクションは持てないので、
	 * ここは「よくある失敗を綺麗に畳む」までで、完全性は保証しない。
	 * 後始末の失敗はログにだけ残す（利用者への応答はどちらにせよ 500）。
	 */
	const issueId = String(result.id);
	const key = photoObjectKey(issueId);

	try {
		await c.env.PHOTOS.put(key, await photo.arrayBuffer(), {
			httpMetadata: { contentType: photoContentType },
		});
	} catch (error) {
		console.error("Failed to store photo", error);
		await deleteIssueRow(c, issueId);
		return c.json({ error: "Failed to store photo" }, 500);
	}

	/*
	 * サムネイル（#125）は原寸と扱いを変える。置けなくても起票は成功させ、
	 * ログにだけ残す。
	 *
	 * 原寸の失敗を 500 にしているのは「写真を付けたつもりの Issue が
	 * 写真無しで公開される」のを避けるため。サムネイルにその問題は無い。
	 * 無ければ配信側が原寸に倒すので、利用者から見た欠落は起きず、
	 * 一覧がその 1 件だけ重くなるだけで済む。派生物が作れなかったことを
	 * 理由に起票をやり直させる方が損失が大きい。
	 */
	const thumbnailKey = photoThumbnailObjectKey(issueId);
	let thumbnailStored = false;
	if (thumbnail && thumbnailContentType) {
		try {
			await c.env.PHOTOS.put(thumbnailKey, await thumbnail.arrayBuffer(), {
				httpMetadata: { contentType: thumbnailContentType },
			});
			thumbnailStored = true;
		} catch (error) {
			console.error("Failed to store photo thumbnail", error);
		}
	}

	const updated = await c.env.DB.prepare(
		`UPDATE issues SET photo_key = ?, photo_content_type = ? WHERE id = ? RETURNING ${PUBLIC_SELECT}`,
	)
		.bind(key, photoContentType, issueId)
		.first<IssueRowLike>();

	if (!updated) {
		console.error("Failed to attach photo to issue", issueId);
		await c.env.PHOTOS.delete(key).catch((error: unknown) => {
			console.error("Failed to clean up orphaned photo", error);
		});
		// 置けたサムネイルも一緒に消す。行ごと消える以上、原寸と同じく
		// どこからも参照されない
		if (thumbnailStored) {
			await c.env.PHOTOS.delete(thumbnailKey).catch((error: unknown) => {
				console.error("Failed to clean up orphaned thumbnail", error);
			});
		}
		await deleteIssueRow(c, issueId);
		return c.json({ error: "Failed to store photo" }, 500);
	}

	// `updated_at` は動かさない。作成と同時の添付であって、
	// 利用者から見た「最終更新」は起票した時刻のままが正しい
	return c.json(toPublicIssue(updated), 201);
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

/**
 * Issue 一覧を返す。公開一覧（`GET /issues`）と自分の一覧（`GET /issues/mine`）で共有する。
 *
 * `ownerUserId` を渡すと、その所有者の Issue だけに絞る。渡さなければ全件。
 * クエリの検証・並び順・カーソル・件数の数え方をこの一本に寄せているのは、
 * 別々に書くと片方だけ limit の上限やページング境界の扱いが抜けるため。
 *
 * 絞り込みの条件は呼び出し側が決める。クエリ文字列から所有者を受け取る形には
 * していないので、他人の user_id を指定して覗くという経路が存在しない。
 */
async function listIssues(c: Context<IssuesEnv>, ownerUserId?: string) {
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

	// 所有者の条件は他の絞り込みより先に積む。SQL 上の順序に意味は無いが、
	// 「まず自分のものに限定し、その中で絞り込む」という読み順に合わせている。
	if (ownerUserId !== undefined) {
		conditions.push("user_id = ?");
		binds.push(ownerUserId);
	}
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
		`SELECT ${PUBLIC_SELECT_WITH_COUNTS} FROM issues ${where} ORDER BY created_at ${direction}, id ${direction} LIMIT ? OFFSET ?`,
	)
		.bind(...binds, limit + 1, offset)
		.all<IssueRowLike>();

	const hasMore = rows.results.length > limit;
	const page = hasMore ? rows.results.slice(0, limit) : rows.results;
	const lastRow = page.at(-1);

	return c.json({
		// 起票者の表示名を Clerk からまとめて引いて重ねる（#67）。
		// 匿名の Issue はここで除かれるため、Clerk へも渡らない。
		data: await withAuthorNames(c, page),
		// フィルタ後の総件数。ページング UI はこれを見て最終ページを決める。
		total: countRow?.total ?? 0,
		limit,
		offset,
		// 既定値が効いたときに何で並んでいるかがレスポンスだけで分かるよう返す。
		sort,
		// 次ページが無いときは null。クライアントは null を見て打ち切れる。
		next_cursor: hasMore && lastRow ? buildIssueCursor(lastRow) : null,
	});
}

// GET /issues — List (public)
issues.get("/", (c) => listIssues(c));

// GET /issues/mine — 自分が起票した Issue の一覧 (auth required)
//
// `/issues/:id` より前に登録する。Hono は登録順にマッチするため、後に置くと
// 「mine という id の Issue」として扱われ、常に 404 になる。
//
// 自分の Issue だけを返す以上、認証は必須。未認証を「全件」や「空」にフォールバック
// させると、ログインが切れていることに気付かないまま他人の一覧を見るか、
// 自分の投稿が消えたように見えるかのどちらかになる。
issues.get("/mine", clerkAuth(), requireAuth, (c) => {
	// `requireAuth` を通っているので userId は必ずある。
	// 型の上では null を含むため、空文字にフォールバックせず明示的に落とす
	// （フォールバックすると user_id が NULL の行と衝突しかねない）。
	const userId = getAuth(c)?.userId;
	if (!userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	return listIssues(c, userId);
});

/**
 * 「手伝います」の表明（`/issues/:id/help-offers`）を子ルーターに委譲する。
 *
 * `route()` は mount 先のパスパラメータを子へ引き継がない（子から見た
 * `c.req.param("id")` は undefined になる）ため、mount の手前で `:id` を
 * コンテキストに入れる。子ルーター側は `c.get("issueId")` で受ける。
 *
 * 子ルーターが持つのは `"/"` だけなので、ミドルウェアも
 * `/:id/help-offers` の一致だけで足りる（`/*` を足しても通る経路は増えない）。
 * 末尾スラッシュ付きの `/issues/xxx/help-offers/` は子側に対応するルートが
 * 無いため 404 になる。これは Issue 本体（`/issues/:id/`）も同じ扱いで、
 * 経路ごとに揺れないよう合わせている。
 *
 * `/:id` の各ハンドラより前に置いているのは「より具体的なパスを先に書く」形に
 * 揃えるため。Hono は登録順ではなくパターンの具体性で照合するので、
 * 順序を入れ替えても `DELETE /issues/:id` がここを横取りすることはない。
 */
issues.use("/:id/help-offers", async (c, next) => {
	// このミドルウェアは `:id` を含むパターンでしか登録していないため、
	// ここに来た時点で `id` は必ず取れる。`use()` は登録パターンから
	// パラメータの型を推論しないので `string | undefined` になるだけ。
	// 万一取れなければ空文字が入り、子ルーター側の存在確認で 404 になる。
	c.set("issueId", c.req.param("id") ?? "");
	await next();
});
issues.route("/:id/help-offers", helpOffers);

/**
 * 「私も困っている」の表明（`/issues/:id/reactions`）を子ルーターに委譲する（#112）。
 *
 * 委譲の仕方は上の `help-offers` と同じ（`route()` がパスパラメータを
 * 引き継がないため、mount の手前で `:id` をコンテキストに入れる）。
 */
issues.use("/:id/reactions", async (c, next) => {
	c.set("issueId", c.req.param("id") ?? "");
	await next();
});
issues.route("/:id/reactions", reactions);

/**
 * GET /issues/:id/viewer — 閲覧者とこの Issue の関係 (public)
 *
 * 今のところ返すのは「あなたがこの Issue の起票者か」だけ（Issue #62）。
 * ステータス変更の操作 UI を起票者にだけ出すために、画面が必要とする。
 *
 * `GET /issues/:id` に足さず別の経路にしているのは、あちらが
 * 「Issue の行そのもの」を返す契約で、公開キーの集合をテストで固定して
 * いるため（`Public response fields`）。行に属さない値を混ぜると、
 * 「返るキー = テーブルの公開カラム」という対応が崩れる。
 * help-offers が `viewer_offered` を同居させられるのは、あちらのレスポンスが
 * 最初から `{ data, total, ... }` というラップ済みの形をしているから。
 *
 * 返すのは真偽値だけで、起票者の user_id は載せない。誰が書いたかを
 * 伏せる方針（#67）は、この経路からも抜けないようにする。
 *
 * `requireAuth` は差していない。詳細ページは誰でも読める画面で、
 * 未ログインの閲覧者にとっての答えは false で確定しているため、
 * ここで 401 を返す意味が無い（`clerkAuth()` だけ差して、ログイン中なら
 * 判定に使う）。
 *
 * この値は表示の出し分けにしか使えない。UI を隠すことは保護ではなく、
 * 実際の権限は PATCH / DELETE 側の `WHERE ... AND user_id = ?` が強制する。
 */
issues.get("/:id/viewer", clerkAuth(), async (c) => {
	const id = c.req.param("id");
	const row = await c.env.DB.prepare("SELECT user_id FROM issues WHERE id = ?")
		.bind(id)
		.first<Pick<IssueRow, "user_id">>();

	if (!row) {
		return c.json({ error: "Issue not found" }, 404);
	}

	const viewer = viewerUserId(c);
	// `user_id` が NULL の行（認証導入前に入った legacy 行）は誰のものでもない。
	// null 同士の一致で true に倒すと、未ログインの閲覧者が起票者として扱われる
	return c.json({
		viewer_is_owner: viewer !== null && row.user_id === viewer,
	});
});

/**
 * GET /issues/:id/photo — 添付された写真そのものを返す (public)
 *
 * R2 のバケットは公開していないので、画像はこの経路からしか読めない。
 * Worker を必ず通すことで、通報された画像の非公開化（#65 の範囲外だが、
 * 決定事項として通報の仕組みは入る）を後から差し込む余地を残している。
 *
 * Issue 本体が公開なので、こちらも認証は要らない。
 *
 * `Content-Type` は DB の `photo_content_type` から返す。保存時に
 * `isIssuePhotoContentType` を通した値しか入らないため、ここから
 * `image/svg+xml` や `text/html` が出ることはない（同一オリジンで
 * 配信される以上、ここが XSS の入口にならないことは保存側で担保する）。
 *
 * `Content-Disposition: inline` を明示しているのは、万一想定外の
 * MIME が入っていた場合でもブラウザに文書として開かせないため…ではなく、
 * 逆に `attachment` の既定に倒れて毎回ダウンロードされるのを避けるため。
 * `<img>` から読む用途なので inline が正しい。
 */
/**
 * R2 のオブジェクトを画像のレスポンスとして返す。原寸とサムネイルで共有する。
 *
 * `contentType` は保存時に `validatePhoto` を通した値だけが渡る前提。
 * 無い（NULL の）ときは名乗らずにバイト列だけ返す。推測して間違った型を
 * 名乗るより安全側に倒す。
 *
 * `Content-Disposition: inline` を明示しているのは、`attachment` の既定に
 * 倒れて毎回ダウンロードされるのを避けるため。`<img>` から読む用途なので
 * inline が正しい。
 */
function photoResponse(
	object: R2ObjectBody,
	contentType: string | null | undefined,
): Response {
	const headers = new Headers();
	if (contentType) {
		headers.set("Content-Type", contentType);
	}
	headers.set("Content-Disposition", "inline");
	// 画像は差し替えられない（#65 の範囲外）ので、キーが同じなら中身も同じ。
	// 詳細ページを開くたびに R2 から読み直さずに済むよう長めに持たせる。
	// 通報による削除が入ったときは 404 に変わるが、それがキャッシュに
	// 反映されるまでの遅れは許容する（`private` にはしない ＝ 公開画像なので）
	headers.set("Cache-Control", "public, max-age=31536000, immutable");
	// R2 が返す ETag をそのまま通す。条件付きリクエストで 304 を返す
	// 実装はまだ無いが、中間のキャッシュが使える
	headers.set("ETag", object.httpEtag);

	return new Response(object.body, { headers });
}

/**
 * GET /issues/:id/photo/thumbnail — 一覧用の小さい写真を返す (public)
 *
 * 一覧（`/`, `/issues`）は 1 ページ 20 件並ぶ。詳細ページ用の原寸を
 * そのまま並べると 1 画面で数 MB を読むことになるため、投稿時に
 * ブラウザが作った 480px の派生物をここから配る（#125）。
 *
 * サムネイルが無いときは原寸に倒す。#125 より前に投稿された写真には
 * 派生物が存在せず、そこで 404 にすると「古い Issue だけ一覧から
 * 画像が消える」ことになる。重いのは我慢できるが、出ないのは
 * この Issue が直そうとしている症状そのものになってしまう。
 *
 * 「写真そのものが無い」は原寸と同じく 404。倒す先が無い。
 */
issues.get("/:id/photo/thumbnail", async (c) => {
	const id = c.req.param("id");
	const row = await c.env.DB.prepare(
		"SELECT photo_key, photo_content_type FROM issues WHERE id = ?",
	)
		.bind(id)
		.first<{ photo_key: string | null; photo_content_type: string | null }>();

	if (!row?.photo_key) {
		return c.json({ error: "Photo not found" }, 404);
	}

	// サムネイルのキーは原寸のキーから導ける（`photoThumbnailObjectKey`）。
	// DB に列を持たないので、あるかどうかは R2 に聞く
	const thumbnail = await c.env.PHOTOS.get(photoThumbnailObjectKey(id));
	if (thumbnail) {
		// 保存時に `validatePhoto` を通した MIME が `httpMetadata` に入っている。
		// 原寸と違って DB に控えが無いため、R2 のメタデータが唯一の出どころ
		return photoResponse(thumbnail, thumbnail.httpMetadata?.contentType);
	}

	const original = await c.env.PHOTOS.get(row.photo_key);
	if (!original) {
		console.error("Photo object missing in R2", row.photo_key);
		return c.json({ error: "Photo not found" }, 404);
	}
	return photoResponse(original, row.photo_content_type);
});

issues.get("/:id/photo", async (c) => {
	const id = c.req.param("id");
	const row = await c.env.DB.prepare(
		"SELECT photo_key, photo_content_type FROM issues WHERE id = ?",
	)
		.bind(id)
		.first<{ photo_key: string | null; photo_content_type: string | null }>();

	// Issue が無い場合と、Issue はあるが写真が無い場合。どちらも
	// 「その URL に画像は無い」で、区別して伝える意味が無いので同じ 404 にする
	if (!row?.photo_key) {
		return c.json({ error: "Photo not found" }, 404);
	}

	const object = await c.env.PHOTOS.get(row.photo_key);
	// 行はあるのに R2 に実体が無い状態。起票時のロールバックが途中で
	// 失敗したか、バケット側で消されたときに起きる。利用者から見れば
	// 画像が無いことに変わりないので 404 だが、原因を追えるようログに残す
	if (!object) {
		console.error("Photo object missing in R2", row.photo_key);
		return c.json({ error: "Photo not found" }, 404);
	}

	return photoResponse(object, row.photo_content_type);
});

// GET /issues/:id — Get by ID (public)
issues.get("/:id", async (c) => {
	const id = c.req.param("id");
	const row = await c.env.DB.prepare(
		`SELECT ${PUBLIC_SELECT_WITH_COUNTS} FROM issues WHERE id = ?`,
	)
		.bind(id)
		.first<IssueRowLike>();

	if (!row) {
		return c.json({ error: "Issue not found" }, 404);
	}
	// 一覧と同じ規則で表示名を重ねる（#67）。1 件でも経路を分けないのは、
	// 詳細だけ匿名の出し分けが抜ける、といった食い違いを作らないため。
	const [issue] = await withAuthorNames(c, [row]);
	return c.json(issue);
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
	c: Context<IssuesEnv>,
	id: string,
): Promise<Response | null> {
	const row = await c.env.DB.prepare("SELECT user_id FROM issues WHERE id = ?")
		.bind(id)
		.first<Pick<IssueRow, "user_id">>();

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
	setClauses.push(`updated_at = ${NEXT_UPDATED_AT_SQL}`);

	const auth = getAuth(c);

	// 所有者チェックとの間で行が変わる可能性に備え、UPDATE 自体にも所有者条件を入れる
	const result = await c.env.DB.prepare(
		`UPDATE issues SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ? RETURNING ${PUBLIC_SELECT}`,
	)
		.bind(...binds, id, auth?.userId)
		.first<IssueRowLike>();

	if (!result) {
		return c.json({ error: "Issue not found" }, 404);
	}
	return c.json(toPublicIssue(result));
});

// /issues/:id/comments — Issue に紐づくコメント（src/routes/comments.ts）
//
// `:id`（親の Issue ID）はサブルーター側で `c.req.param("id")` として読める。
// より限定的なパスなので `/:id` のハンドラより先に置く必要は無い
// （Hono は登録順ではなくパターンの一致で振り分ける）が、
// 対応関係が読めるようにルート定義の並びは URL の階層に合わせている。
issues.route("/:id/comments", comments);

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
		.first<IssueRowLike>();

	if (!result) {
		return c.json({ error: "Issue not found" }, 404);
	}

	// 行が消えた以上、その写真はどこからも参照されない。残すと R2 に
	// 孤児ファイルが積み上がる（署名URLを採らなかった理由と同じ話が、
	// 削除の側にもある）。
	//
	// 消すのは行の削除が確定してから。先に消すと、DELETE が 404 や 403 だった
	// ときに実在する Issue の画像を落としてしまう。
	//
	// R2 の削除に失敗しても DELETE そのものは成功として返す。利用者の要求
	// （Issue を消す）は果たされており、参照の切れた画像が残ることを理由に
	// 「削除できませんでした」と伝えるのは実態と合わない。掃除が要る状態に
	// なったことはログで追えるようにする。
	if (result.photo_key) {
		await c.env.PHOTOS.delete(String(result.photo_key)).catch(
			(error: unknown) => {
				console.error("Failed to delete photo for removed issue", error);
			},
		);
		// 一覧用のサムネイル（#125）も一緒に消す。DB に控えが無いので
		// 「あるか」は聞かずに消しに行く（R2 の delete は存在しないキーでも
		// エラーにならない）。残すと原寸と同じく孤児ファイルになる
		await c.env.PHOTOS.delete(photoThumbnailObjectKey(String(result.id))).catch(
			(error: unknown) => {
				console.error("Failed to delete thumbnail for removed issue", error);
			},
		);
	}

	return c.json(toPublicIssue(result));
});

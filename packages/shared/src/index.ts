import { z } from "zod";

/**
 * `issues.scope` が取りうる値。
 *
 * ここが唯一の宣言で、Zod スキーマ（`IssueScope`）はこの配列から作る。
 * DB 側には `migrations/0001_initial.sql` の `CHECK (scope IN (...))` として
 * 同じ集合が書かれており、**SQL とこの配列は手で同期する**。
 *
 * 手動同期を許しているのは、既存の生 SQL マイグレーションを書き換えない方針
 * （#29）のため。代わりに両者の一致は `apps/api/test/schema.test.ts` が
 * マイグレーション SQL の CHECK 句をパースして検証する。片方だけ変えると
 * そこが落ちるので、乖離したままマージされることはない。
 *
 * この配列を独立させている理由は、テストが「Zod が受け付ける値の集合」を
 * 素の文字列として取り出せるようにするため。`z.enum` の `.options` からでも
 * 取れるが、SQL と突き合わせる対象は Zod ではなく値の集合そのものなので、
 * 意図をこの名前で明示している。
 */
export const ISSUE_SCOPE_VALUES = [
	"personal",
	"community",
	"municipality",
	"national",
	"global",
] as const;

export const IssueScope = z.enum(ISSUE_SCOPE_VALUES);
export type IssueScope = z.infer<typeof IssueScope>;

/**
 * `issues.status` が取りうる値。
 *
 * `ISSUE_SCOPE_VALUES` と同じく、ここが唯一の宣言。DB 側の
 * `CHECK (status IN (...))` との一致は `schema.test.ts` が検証する。
 *
 * 並び順はライフサイクル（Open → Triaged → In Progress → Review →
 * Resolved → Closed）に合わせてある。画面のフィルタはこの順で並ぶため、
 * 値を足すときは意味的に正しい位置へ入れること。
 */
export const ISSUE_STATUS_VALUES = [
	"open",
	"triaged",
	"in_progress",
	"review",
	"resolved",
	"closed",
] as const;

export const IssueStatus = z.enum(ISSUE_STATUS_VALUES);
export type IssueStatus = z.infer<typeof IssueStatus>;

/**
 * トップページで「解決までの流れ」として見せる段階（B6）。
 *
 * `ISSUE_STATUS_VALUES` から `closed` を除いたもの。6 段階すべてを
 * 並べると、初めて来た人がまず読む場所に運用上の細かさが出すぎる。
 * 知りたいのは「書いたら直るのか」であって、状態の全一覧ではない。
 *
 * `closed` を選んだのは、あれが**解決までの道筋には乗っていない**ため。
 * 解決せずに終わる場合（対応しないと決まった、重複していた等）に使う出口で、
 * 「Issue が解決するまで」という節の流れとは意味が違う。
 *
 * **画面に出す段階を絞るだけで、状態そのものは 6 つのまま。**
 * 絞り込み（`IssueFilterForm`）と状態の変更（`StatusControl`）は
 * `ISSUE_STATUS_VALUES` を使い続ける。そちらから外すと、実際に存在する
 * 状態を選べなくなって運用できない。
 */
export const ISSUE_LIFECYCLE_HIGHLIGHT_VALUES = ISSUE_STATUS_VALUES.filter(
	(status) => status !== "closed",
);

/**
 * 公開する座標の小数点以下桁数（#124）。
 *
 * 3 桁は緯度で約 111m、日本の緯度における経度で約 91m にあたる。
 * 「どのあたりの困りごとか」を地図で見るには足りて、**建物や敷地を
 * 指すには足りない**、という境目としてこの桁を選んだ。
 *
 * 4 桁（約 11m）だと戸建ての敷地に収まってしまい、名前を伏せても
 * 家が分かる。2 桁（約 1.1km）まで落とすと、同じ通りの困りごとが
 * すべて 1 点に重なり、地図としての用途が失われる。
 *
 * この桁は**保存する値**にも**返す値**にも同じように効く
 * （`apps/api/src/routes/issues.ts`）。細かい値を持ったまま丸めて返す
 * 方式にしていないのは、持っていれば別の経路（管理用の SQL、将来の
 * 別エンドポイント、バックアップの流出）から出うるため。
 * 匿名を選んだ人の生活圏は、そもそも保存しないのが一番強い。
 */
export const ISSUE_COORDINATE_PRECISION = 3;

const COORDINATE_SCALE = 10 ** ISSUE_COORDINATE_PRECISION;

/**
 * 座標を `ISSUE_COORDINATE_PRECISION` 桁へ丸める（#124）。
 *
 * `null` / `undefined`（位置を出さない起票）はそのまま `null` を返す。
 * 有限でない数値も `null` に倒す。座標として使えない値を丸めても
 * 座標にはならず、地図に渡せば壊れるため。
 *
 * `Math.round(value * 1000) / 1000` は「整数 ÷ 1000」なので、
 * 結果の 10 進表現は必ず 3 桁以内に収まる（倍精度の最短表現が
 * 元の 3 桁小数へ戻るため）。JSON に 13 桁が復活することはない。
 *
 * 半端値（ちょうど 0.0005）の丸め方向は SQLite の `ROUND` と一致しない。
 * `Math.round` は +∞ 側へ、SQLite は 0 から遠い側へ倒すので、負の座標で
 * 1 桁分（0.001 = 約 100m）ずれることがある。既存行を丸めたマイグレーション
 * （`0010_coarsen_location.sql`）とここで、同じ入力から違う値が出るのは
 * その範囲。**どちらも 3 桁に収まるので、隠したい精度は同じだけ落ちる。**
 * 揃えるために片方へ寄せる処理は入れていない（丸めの目的は値の一致ではなく
 * 精度を落とすことで、境界のちょうど半端値は実データにまず現れない）。
 */
export function roundIssueCoordinate(
	value: number | null | undefined,
): number | null {
	if (value === null || value === undefined) return null;
	if (!Number.isFinite(value)) return null;
	return Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE;
}

/**
 * 緯度と経度が「両方ある」か「両方ない」かのどちらかであること（#124）。
 *
 * 片方だけの座標は地図に置けない。黙って捨てると、入力した側は
 * 位置を伝えたつもりでいるのに伝わっていない状態になるため、
 * 入力の誤りとして返す。
 */
export const LOCATION_PAIR_REQUIRED_MESSAGE =
	"latitude and longitude must be provided together";

/**
 * 起票で受け取る各項目。`CreateIssueSchema` から `superRefine` を外した形。
 *
 * 項目単位のスキーマ（`CreateIssueFields.shape.category` など）を引きたい
 * 場面があるため、素の `ZodObject` としても公開している。
 * **リクエストの検証には `CreateIssueSchema` の方を使うこと。**
 * こちらは緯度経度が揃っているかの検査を通らない。
 */
export const CreateIssueFields = z.object({
	title: z.string().min(1).max(200),
	description: z.string().min(1).max(5000),
	scope: IssueScope,
	/**
	 * 困りごとが起きている場所（#124）。**任意**。
	 *
	 * 必須だった頃は、位置を出したくない人に「起票しない」以外の
	 * 選択肢が無かった。匿名で書けても場所が残れば地図上の 1 点として
	 * 特定され得るため、名前を伏せる選択（#88）と釣り合っていなかった。
	 *
	 * 値そのものは保存前に `roundIssueCoordinate` を通す。ここで
	 * `.transform()` を掛けていないのは、**入力の検証と保存の加工を
	 * 混ぜないため**。このスキーマは web 側の入力チェックにも使われ
	 * （`apps/web/src/lib/api.ts`）、そこで丸めてしまうと「送った値」と
	 * 「画面が持っている値」が食い違う。丸めるのは保存する側の責務。
	 */
	latitude: z.number().min(-90).max(90).nullish(),
	longitude: z.number().min(-180).max(180).nullish(),
	category: z.string().min(1).max(100).optional(),
	/**
	 * 匿名で起票するかどうか。既定は匿名（#88）。
	 *
	 * 困りごとの投稿は生活圏を晒す側面があるため、安全側を既定にする。
	 * 匿名を既定にして後から名乗れるようにするのは容易だが、一度表示した
	 * ものを後から匿名化しても、既に見られた事実は消せない。
	 *
	 * `.optional()` ではなく `.default(true)` にしているのは、未指定の
	 * リクエストが DB のカラム既定値へ素通りするのではなく、この層で
	 * 匿名に確定させるため。DB 側（`0007_add_is_anonymous.sql` の
	 * `DEFAULT 1`）にも同じ既定値があり、どちらか片方が消えても匿名側に
	 * 倒れる二重の担保になっている。
	 */
	is_anonymous: z.boolean().default(true),
});

/**
 * 起票リクエストの検証スキーマ。
 *
 * 位置は任意だが（#124）、緯度と経度は対で意味を持つので、
 * 片方だけの指定は入力の誤りとして弾く。両方のフィールドに
 * エラーを付けるのは、画面がフィールドごとにエラーを出すため
 * （片方にしか出さないと、もう片方の欄が正常に見える）。
 */
export const CreateIssueSchema = CreateIssueFields.superRefine((data, ctx) => {
	const hasLatitude = data.latitude !== null && data.latitude !== undefined;
	const hasLongitude = data.longitude !== null && data.longitude !== undefined;
	if (hasLatitude === hasLongitude) return;

	for (const path of ["latitude", "longitude"] as const) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: [path],
			message: LOCATION_PAIR_REQUIRED_MESSAGE,
		});
	}
});
export type CreateIssue = z.infer<typeof CreateIssueSchema>;

/**
 * 添付できる写真の最大バイト数（#65）。
 *
 * ブラウザ側は送る前に縮小するので、通常はここに当たらない。それでも
 * サーバー側で必ず検査する。縮小は迂回できるため防御にはならず、
 * 上限が無いと Worker が任意サイズのボディを R2 へ書けてしまう。
 *
 * 5MB にしているのは、長辺 1600px の JPEG なら余裕をもって収まり、
 * かつ縮小をすり抜けた原寸の写真も概ね拾えるため。
 */
export const ISSUE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 一覧用サムネイルの最大バイト数（#125）。
 *
 * 原寸と同じ 5MB を当てると、上限としての意味をほとんど失う。
 * サムネイルは長辺 480px / JPEG 品質 0.7 で作るので実測 30〜60KB に
 * 収まり、5MB を通す口は「一覧を軽くするための派生物として 5MB を
 * 受け付ける」という矛盾になる。自前のクライアント以外が大きな画像を
 * `thumbnail` として送ると、一覧が原寸より重くなりうる。
 *
 * 512KB は、想定の 10 倍近い余裕を取りつつ原寸（5MB）とは 1 桁違う値。
 * 写真の少ない機種や将来サムネイルを大きくする場合に備えて広めに
 * 取ってあり、正常な派生物がここに当たることは無い。
 */
export const ISSUE_THUMBNAIL_MAX_BYTES = 512 * 1024;

/**
 * 受け付ける画像の MIME タイプ。
 *
 * ブラウザ側は JPEG に変換して送るので通常は `image/jpeg` だけだが、
 * 変換を経ない経路（curl、将来の別クライアント）も想定して、
 * ブラウザが確実に描画できる形式を並べている。
 *
 * SVG を含めていないのは、SVG がスクリプトを埋め込める文書形式であり、
 * 同一オリジンで配信すると XSS の経路になるため。配信側
 * （`GET /issues/:id/photo`）はこの集合に無い値を保存させない前提で
 * `Content-Type` を組み立てる。
 */
export const ISSUE_PHOTO_CONTENT_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
] as const;

export type IssuePhotoContentType = (typeof ISSUE_PHOTO_CONTENT_TYPES)[number];

/**
 * 保存してよい画像の MIME タイプかどうか。
 *
 * `Content-Type` は `image/jpeg; charset=binary` のようにパラメータが
 * 付くことがあるため、呼び出し側は `;` より前を取り出してから渡すこと。
 */
export function isIssuePhotoContentType(
	value: string,
): value is IssuePhotoContentType {
	return (ISSUE_PHOTO_CONTENT_TYPES as readonly string[]).includes(value);
}

export const UpdateIssueSchema = z
	.object({
		title: z.string().min(1).max(200).optional(),
		description: z.string().min(1).max(5000).optional(),
		scope: IssueScope.optional(),
		status: IssueStatus.optional(),
		category: z.string().min(1).max(100).nullable().optional(),
	})
	.refine((data) => Object.keys(data).length > 0, {
		message: "At least one field must be provided",
	});
export type UpdateIssue = z.infer<typeof UpdateIssueSchema>;

/**
 * コメント本文の最大長。
 *
 * Issue の `description`（5000）より短くしているのは、コメントが
 * 「議論を重ねる場」であって長文を一度に書き切る場所ではないため。
 * 数値を定数として出しているのは、画面側で文字数カウンタや
 * `maxLength` に同じ値を使うときに書き写さないで済むようにするため。
 */
export const COMMENT_BODY_MAX_LENGTH = 2000;

/**
 * コメントの投稿内容。
 *
 * 本文は前後の空白を落としてから検証する。`min(1)` だけだと空白しか
 * 入っていないコメントが通り、一覧に読めない行が増えるため。
 * `.trim()` を `.max()` より先に置いているのは、末尾の改行だけで
 * 上限を超えた入力を弾かないようにするため（見た目の文字数と一致させる）。
 */
export const CreateCommentSchema = z.object({
	body: z.string().trim().min(1).max(COMMENT_BODY_MAX_LENGTH),
});
export type CreateComment = z.infer<typeof CreateCommentSchema>;

/** 表示ラベルを提供するロケール。MVP のスコープに合わせて日本語・英語の2つ */
export const Locale = z.enum(["ja", "en"]);
export type Locale = z.infer<typeof Locale>;

export const DEFAULT_LOCALE: Locale = "ja";

/**
 * スコープの表示ラベルと、その階層が何を指すかの説明。
 * enum の生の値（`municipality` 等）はユーザー向けの語彙ではないため、
 * 画面に出す文字列はここで一元管理する。
 * Record のキーを enum 型にしているので、enum に値を足すとラベル漏れが型エラーになる。
 */
export const ISSUE_SCOPE_LABELS: Record<
	Locale,
	Record<IssueScope, { label: string; description: string }>
> = {
	ja: {
		personal: { label: "個人", description: "自分や家族の身の回りの困りごと" },
		community: {
			label: "コミュニティ",
			description: "近所や職場など、顔の見える範囲の課題",
		},
		municipality: {
			label: "自治体",
			description: "市区町村で解決すべき課題",
		},
		national: { label: "国", description: "国の制度や法律に関わる課題" },
		global: { label: "世界", description: "国境をまたいで取り組む課題" },
	},
	en: {
		personal: {
			label: "Personal",
			description: "Everyday problems around you and your family",
		},
		community: {
			label: "Community",
			description: "Issues within your neighborhood or workplace",
		},
		municipality: {
			label: "Municipality",
			description: "Issues your city or town should solve",
		},
		national: {
			label: "National",
			description: "Issues tied to national systems and laws",
		},
		global: {
			label: "Global",
			description: "Issues that cross national borders",
		},
	},
};

/** ステータスの表示ラベル。`in_progress` のような内部表現を画面に出さないための対応表 */
export const ISSUE_STATUS_LABELS: Record<
	Locale,
	Record<IssueStatus, string>
> = {
	ja: {
		open: "受付",
		triaged: "仕分け済み",
		in_progress: "対応中",
		review: "確認中",
		resolved: "解決",
		closed: "クローズ",
	},
	en: {
		open: "Open",
		triaged: "Triaged",
		in_progress: "In Progress",
		review: "In Review",
		resolved: "Resolved",
		closed: "Closed",
	},
};

/**
 * 名前を出せない人の表示ラベル（#88 / #67）。
 *
 * 画面に出る「人」は Issue の起票者・コメントの投稿者・「手伝います」の
 * 表明者の 3 種類あり、いずれも名前が出せない場合がある。そこで別々の文言を
 * 書くと、同じ人が画面ごとに違う顔になる（#59 と同じ理由）。対応表をここに
 * 一つ置いて、3 箇所すべてがここを引く。
 *
 * `anonymous` と `unnamed` を別の言葉にしているのが要点。
 *
 * - `anonymous` — 本人が「名前を出さない」を選んだ（#88 の `is_anonymous`）
 * - `unnamed` — 本人は名乗ったが、Clerk に表示名が登録されていない。
 *   Clerk への問い合わせ自体が失敗したときもこちらになる（#67 の論点 2）
 *
 * 後者を「匿名の方」に倒すと、名乗ることを選んだ人の意思を握り潰す。
 * 逆に前者を「名前未設定の方」と書くと、匿名を選んだ事実が消える。
 */
export const AUTHOR_LABELS: Record<
	Locale,
	{ anonymous: string; unnamed: string }
> = {
	ja: {
		anonymous: "匿名の方",
		unnamed: "名前未設定の方",
	},
	en: {
		anonymous: "Anonymous",
		unnamed: "Name not set",
	},
};

/**
 * 画面に出す人の名前を決める（#67）。
 *
 * 3 箇所（起票者・コメント投稿者・表明者）で同じ規則を使うため、
 * 出し分けの判断そのものをここに置く。呼び出し側で `??` を書き分けると、
 * 匿名を選んだ人が別の画面で実名になる事故がいつでも起きうる。
 *
 * 優先順位は「匿名の選択 → 表示名 → 名前未設定」。匿名が最優先なのは、
 * 一度表示したものを後から匿名化しても既に見られた事実は消せないため。
 *
 * @param author.isAnonymous 本人が匿名を選んだか
 * @param author.displayName Clerk から引いた表示名。未設定・取得失敗なら null
 */
export const getAuthorLabel = (
	author: { isAnonymous: boolean; displayName: string | null },
	locale: Locale = DEFAULT_LOCALE,
): string => {
	if (author.isAnonymous) {
		return AUTHOR_LABELS[locale].anonymous;
	}
	return author.displayName ?? AUTHOR_LABELS[locale].unnamed;
};

/** スコープの表示ラベルを引く。ロケール省略時は既定ロケール */
export const getIssueScopeLabel = (
	scope: IssueScope,
	locale: Locale = DEFAULT_LOCALE,
) => ISSUE_SCOPE_LABELS[locale][scope];

/** ステータスの表示ラベルを引く。ロケール省略時は既定ロケール */
export const getIssueStatusLabel = (
	status: IssueStatus,
	locale: Locale = DEFAULT_LOCALE,
) => ISSUE_STATUS_LABELS[locale][status];

/**
 * 10 進の整数表記だけを受け取って数値に直す。
 *
 * `z.coerce.number()` は内部で `Number(input)` を呼ぶため、
 * `Number("0x10") === 16` / `Number("") === 0` / `Number(" 5 ") === 5` の
 * ように 16 進・2 進・8 進・指数表記・空文字・空白付き・符号付きが
 * すべて通ってしまう。クエリ文字列は「10 進の整数」を受ける契約なので、
 * 表記を正規表現で先に縛ってから数値化する。
 *
 * 桁数の上限は付けていない（範囲は後段の `.min()` / `.max()` で見る）。
 */
const DecimalIntQueryParam = z
	.string()
	.regex(/^\d+$/, { message: "must be a decimal integer" })
	.transform(Number);

export const LIST_ISSUES_DEFAULT_LIMIT = 20;
export const LIST_ISSUES_DEFAULT_OFFSET = 0;

/**
 * 一覧の並び順。
 *
 * `newest` / `oldest` はどちらも `created_at` を主キーに、`id` を
 * タイブレークに使う。カーソルページングの前提（全順序が定まること）を
 * 保つため、方向を反転するときは両方のキーを同時に反転させる。
 */
export const IssueSort = z.enum(["newest", "oldest"]);
export type IssueSort = z.infer<typeof IssueSort>;

export const LIST_ISSUES_DEFAULT_SORT: IssueSort = "newest";

/** 並び順の表示ラベル。画面の選択肢に出す文言をここに一本化する */
export const ISSUE_SORT_LABELS: Record<Locale, Record<IssueSort, string>> = {
	ja: {
		newest: "新しい順",
		oldest: "古い順",
	},
	en: {
		newest: "Newest first",
		oldest: "Oldest first",
	},
};

/** 並び順の表示ラベルを引く。ロケール省略時は既定ロケール */
export const getIssueSortLabel = (
	sort: IssueSort,
	locale: Locale = DEFAULT_LOCALE,
) => ISSUE_SORT_LABELS[locale][sort];

/**
 * 画面に出す UI 文言の辞書（Issue #82）。
 *
 * `ISSUE_SCOPE_LABELS` / `ISSUE_STATUS_LABELS` と同じ `Record<Locale, ...>` の形を
 * そのまま広げている。スコープとステータスだけが多言語化されていて、周りの文言が
 * 各コンポーネントに直書きされていた状態を解消するのがこの辞書の役目。
 *
 * i18n ライブラリを入れていない理由は、対象が 200 行程度で、複数形・日付書式・
 * 名前空間分割といったライブラリの機能が要る規模ではないため（Issue #82 で決定済み）。
 *
 * **文字列キーの引き当て（`t("some.key")`）にしていない。** キーを文字列にすると、
 * 打ち間違いも翻訳漏れも実行時まで分からない。ここでは `ja` の辞書から型を導出して
 * `Record<Locale, UiMessages>` で縛っているので、`en` にキーが足りなければ
 * `bun run check` がコンパイルエラーとして落とす。
 *
 * 件数や ID のように文言へ値を差し込むものは関数にしてある。テンプレート文字列を
 * 呼び出し側で組み立てると語順の違う言語（`42 件中 1 件` / `Showing 1 of 42`）を
 * 表現できず、結局そこが直書きに戻るため。
 */
const JA_UI_MESSAGES = {
	/** サイト全体で使う文言 */
	common: {
		siteTitle: "World Issue Tracker",
		siteDescription: "地球のバグを、みんなで可視化して、みんなで直す",
		/** `<html lang>` に入れる値。ロケールと同じ綴りだが、用途が違うので分けて持つ */
		htmlLang: "ja",
		unexpectedError:
			"予期しないエラーが発生しました。時間をおいて再度お試しください。",
		signIn: "ログイン",
		submitting: "送信中…",
		/*
		 * ページ遷移中に出すフォールバックの文言（#146）。
		 *
		 * App Router のクライアント遷移では、遷移先の Server Component が
		 * 届くまで画面が前のまま据え置かれ、視覚的な手応えがゼロになる。
		 * ボタン操作には「送信中…」（`submitting`）で手応えを出しているのに、
		 * ページ遷移だけがこの原則から漏れていた。各ルートの `loading.tsx`
		 * （Suspense フォールバック）でこの文言を出し、押した瞬間に反応させる。
		 */
		loading: "読み込み中…",
	},

	/** 画面上部のヘッダ */
	header: {
		newIssue: "Issue を起票",
		/** 地図ダッシュボード（#113）。URL を知らないと辿れない画面にしない */
		map: "地図で見る",
		myIssues: "自分の Issue",
		/**
		 * Clerk のログインボタン（A3）。
		 *
		 * 以前は「既存の表示を変えない」ことを理由に、日本語ロケールでもここだけ
		 * 英語の "Sign In" のままだった。日本語で読んでいる人にはヘッダの中で
		 * ここだけが英語に見えるので、日本語にする。
		 *
		 * 日本語側は「ログイン」で統一している（`common.signIn` も同じ）。
		 * 同じ操作が画面によって「ログイン」「サインイン」と呼び分けられていると、
		 * 別の操作だと思わせる。キーが `signIn` のままなのは英語側の語に
		 * 由来する名前だからで、日本語の表記とは別の話
		 */
		signIn: "ログイン",
	},

	/** 言語切り替え（Issue #82） */
	localeSwitcher: {
		label: "言語",
		/** 各ロケールを、その言語自身の表記で出す。切り替え先が読めないと選べない */
		names: { ja: "日本語", en: "English" } satisfies Record<Locale, string>,
	},

	/** トップページ */
	home: {
		/*
		 * ヒーローの見出し（B1）。
		 *
		 * 元は「地球のバグを、みんなで可視化して、みんなで直す」（22 文字）だった。
		 * 見出しを大きくするのが B1 の狙いだが、22 文字のままだと狭い画面で
		 * 4 行に折り返してヒーローだけで画面が埋まる。字を大きくできない理由が
		 * 文言の長さにあったので、短くする。
		 *
		 * 落ちた「可視化」は `common.siteDescription` に残っている。あちらは
		 * OGP と検索結果に出る説明文なので、概念そのものが失われるわけではない。
		 * 見出しから落ちたぶんは `headingEyebrow` が受ける
		 */
		heading: "地球のバグを、みんなで直す。",
		/*
		 * 見出しの上に小さく置く一行（B1）。
		 *
		 * 見出しを短くしたことで「どこまでを扱うのか」が読めなくなる。
		 * 個人の困りごとから国際問題までを 1 つの場所で扱うことは、
		 * このサービスの前提そのものなので、見出しの手前で示す
		 */
		headingEyebrow: "個人から世界まで",
		aboutHeading: "これは何をするサービス？",
		/*
		 * ヒーローのリード文。仕組みの説明から、書いた後に何が起きるかの
		 * 説明に変えた。「Issue として投稿できる」ことより「誰かが手を挙げる」
		 * ことの方が、読み手にとっては先に知りたい
		 */
		aboutBody1:
			"壊れた街灯も、空き家も、国の制度も。困りごとを Issue として書けば、誰かが手を挙げるところから解決が始まります。",
		aboutBody2:
			"投稿された Issue には誰でもコメントでき、「手伝います」と手を挙げることで解決に向けて動き出します。犯人を探すのではなく、直すことが目的です。",
		actionsLabel: "主な操作",
		actionsHeading: "まずはここから",
		viewIssues: "Issue を見る",
		/*
		 * 導線の説明。以前は先頭に " — " が入っていたが、#95 でリンクと説明を
		 * 別々の行に置く形（.action-card）にしたので区切り文字は要らなくなった。
		 * 文言に区切りを含めると、置き場所を変えるたびに辞書を直すことになる
		 */
		viewIssuesHint: "投稿された困りごとを一覧で読む。ログインは不要です",
		writeIssue: "Issue を書く",
		writeIssueHint: "困っていることを投稿する。投稿にはログインが必要です",
		recentHeading: "最近の Issue",
		viewAll: "すべての Issue を見る",
		scopesHeading: "Issue の大きさ（スコープ）",
		scopesBody:
			"個人の悩みも世界の課題も、地続きにつながっています。Issue は次の5段階のどれかに位置づけて投稿します。",
		statusesHeading: "Issue が解決するまで",
		statusesBody: "投稿された Issue は、次の順に状態が変わっていきます。",
		/*
		 * 流れから外した「クローズ」の補足（B6）。
		 *
		 * 折りたたみにして、開いたときだけ読めるようにする。並びから
		 * 消すだけだと「クローズという状態が存在すること」自体が画面から
		 * 失われ、一覧の絞り込みに出てくる語の説明がどこにも無くなる
		 */
		statusesMoreLabel: "解決しなかったときは",
		statusesMoreBody:
			"対応しないと決まった Issue や、他の Issue と重複していた Issue は「クローズ」になります。解決までの道筋とは別の出口なので、上の流れには入れていません。",
		/*
		 * 解決の実例を見せる帯（B5）。
		 *
		 * ここに出すのは実際に解決した Issue で、文言は API から取れない
		 * 部分（見出しと導線）だけを持つ。事例そのものを文言として書かない
		 * のは、書いた瞬間に「実在しない事例」になるため。指示書も、見本に
		 * 載っていた草刈りの事例を架空だとして使用を禁じている
		 */
		solvedHeading: "実際に、直っています",
		/** 解決済みが 1 件も無いときに出す。空でも帯が成立するようにする */
		solvedEmpty: "最初の解決を待っています。",
		solvedEmptyAction: "Issue を書く",
		/** 解決済みの Issue へ送る導線 */
		solvedViewAll: "解決した Issue を見る",
		/** 1 件の事例に添える、状態の移り変わり */
		solvedFlow: "投稿された → 誰かが動いた → 解決した",
	},

	/** Issue 一覧（`IssueList`） */
	issueList: {
		fetchFailed:
			"Issue を取得できませんでした。時間をおいて再度お試しください。",
		empty: "まだ Issue がありません。最初の 1 件を起票してみてください。",
		/**
		 * 0 件のときに示す次の一歩（#95）。空の画面で行き止まりにしないための導線。
		 * `empty` の文中に含めず別のキーにしているのは、リンクにする範囲を
		 * 画面側で決めるため（文中の一部をリンクにすると訳文で位置が変わる）
		 */
		emptyAction: "最初の 1 件を起票する",
		/** ページ分割されていないときの件数表示 */
		countSummary: (total: number, shown: number) =>
			`${total} 件中 ${shown} 件を表示`,
		/** ページ分割されているときの範囲表示 */
		rangeSummary: (total: number, from: number, to: number) =>
			`${total} 件中 ${from} 〜 ${to} 件目を表示`,
	},

	/** 自分が起票した Issue の一覧（`MyIssueList`） */
	myIssueList: {
		signInRequired: "自分が起票した Issue を見るにはログインが必要です。",
		/*
		 * 「画面右上の〇〇から」と場所を名指しするので、ヘッダのボタンの
		 * 文言（`header.signIn`）と綴りを揃える必要がある。ここが「Sign In」の
		 * ままだと、画面には無い言葉を探させることになる
		 */
		signInHint:
			"画面右上の「ログイン」からログインすると、ここに表示されます。",
		empty: "まだ Issue を起票していません。",
		writeFirst: "最初の 1 件を書いてみる",
	},

	/** ページ送り（`IssuePagination`） */
	pagination: {
		label: "ページ送り",
		previous: "前のページ",
		next: "次のページ",
		/** 「2 / 3 ページ」のような現在位置 */
		position: (current: number, total: number) =>
			`${current} / ${total} ページ`,
	},

	/** 絞り込み・並べ替えフォーム（`IssueFilterForm`） */
	filterForm: {
		legend: "絞り込み・並べ替え",
		keyword: "キーワード",
		keywordHint: "タイトルと説明から探します。",
		keywordPlaceholder: "例: 街灯",
		scope: "スコープ",
		scopeHint: "どこまで広がる課題かで絞ります。",
		status: "ステータス",
		statusHint: "解決の進み具合で絞ります。",
		category: "カテゴリ",
		categoryHint: "起票時と同じ表記で完全一致します。候補から選ぶと確実です。",
		categoryPlaceholder: "例: 道路・交通",
		sort: "並べ替え",
		sortHint: "投稿された日時の順に並べます。",
		all: "すべて",
		submit: "絞り込む",
		clear: "条件をすべて解除",
	},

	/** Issue 一覧ページ（`/issues`） */
	issuesPage: {
		heading: "Issue 一覧",
		/*
		 * 絞り込みの結果 0 件（#95）。以前は `noMatch` と `noMatchSuffix` で
		 * 文を割り、その間に「条件をすべて解除」のリンクを挟んでいた。
		 * 語順が言語ごとに違うので文の途中にリンクを差し込む形は成立せず、
		 * 英語版は "Try loosening them, or " + リンク + "." と不自然な文に
		 * なっていた。文と導線を分けて、リンクは独立した次の一歩として出す
		 */
		noMatch:
			"条件に合う Issue はありませんでした。条件をゆるめてみてください。",
		writeIssue: "Issue を書く",
		backToHome: "トップへ戻る",
	},

	/** 自分の Issue 一覧ページ（`/my-issues`） */
	myIssuesPage: {
		heading: "自分が起票した Issue",
		writeIssue: "Issue を書く",
		viewAll: "すべての Issue を見る",
		backToHome: "トップへ戻る",
	},

	/** Issue 詳細ページ（`/issues/[id]`） */
	issueDetail: {
		/*
		 * 読み込み中の見出し（#146）。詳細ページは Issue タイトルが取得前で
		 * 分からないため、一覧のように既存の見出しを流用できない。遷移した
		 * 瞬間に「Issue を開いている」ことが伝わる汎用の見出しを別に持つ。
		 */
		loadingHeading: "Issue を読み込んでいます",
		unavailableHeading: "Issue を表示できませんでした",
		retryLater: "時間をおいて再度お試しください。",
		backToList: "Issue 一覧へ戻る",
		writeIssue: "Issue を書く",
		descriptionHeading: "説明",
		photoHeading: "写真",
		/** 写真の代替テキスト。読み上げで何の写真かが分かるよう題名を添える */
		photoAlt: (title: string) => `${title} の様子`,
		detailsHeading: "詳細",
		scope: "スコープ",
		status: "ステータス",
		category: "カテゴリ",
		categoryUnset: "未設定",
		/** 起票者（#88）。値は `getAuthorLabel` が出す（#67） */
		author: "起票者",
		location: "場所",
		/** 地図の下に残す座標の数値表示 */
		coordinates: (latitude: number, longitude: number) =>
			`緯度 ${latitude} / 経度 ${longitude}`,
		/**
		 * 位置を出さずに起票された Issue の「場所」欄（#124）。
		 *
		 * 「未設定」ではなく、書いた人が選んだ結果であることが伝わる書き方に
		 * している。入れ忘れたように読めると、他の人が場所を尋ねる流れになり、
		 * 出したくないという選択が守られない。
		 */
		locationUnset: "起票した方が位置情報を出さない選択をしています",
		/**
		 * 表示している座標がおおよそのものであることの注記（#124）。
		 *
		 * 保存している座標が約 100m の粗さに丸めてあるため、地図のピンは
		 * 実際の場所とずれる。断りが無いと、ピンの指す建物が現場だと
		 * 読まれてしまう。
		 */
		coordinatesApproximate:
			"位置はおよそ 100m の範囲に丸めてあります。地図のピンは実際の場所とずれます。",
		createdAt: "作成日時",
		updatedAt: "最終更新",
	},

	/** ステータスの表示と変更（`StatusControl`） */
	statusControl: {
		heading: "ステータス",
		unavailable:
			"ステータスを変更できるかどうかを確認できませんでした。この Issue を起票した方は、ページを再読み込みしてください。",
		current: "現在:",
		changeTo: "変更先",
		submit: "ステータスを更新",
		submitting: "更新中…",
		/** 更新完了の通知。ラベルは呼び出し側が `ISSUE_STATUS_LABELS` から引いて渡す */
		updated: (statusLabel: string) =>
			`ステータスを「${statusLabel}」に更新しました。`,
	},

	/**
	 * 「私も困っている」（`ReactionButton`、#112）。
	 *
	 * 「手伝います」と対にして置いている。あちらの見出しが「解決に動く人」で、
	 * こちらが「困っている人」。言葉の対で意味の違いを伝える（同じ画面に
	 * 2 つのボタンが並ぶため、どちらを押すべきかが文言だけで分かる必要がある）。
	 */
	reaction: {
		heading: "困っている人",
		fetchFailed: "反応を取得できませんでした。時間をおいて再度お試しください。",
		none: "まだ誰も反応していません。",
		count: (total: number) =>
			`${total} 人が「私も困っている」と反応しています。`,
		react: "私も困っている",
		withdraw: "反応を取り消す",
		signInHint: " — 反応するにはログインが必要です",
		youReacted: " — あなたはこの Issue に反応しています",
		/** 一覧のカードに出す件数（#112）。狭い場所なので数だけ */
		cardCount: (total: number) => `困っている人 ${total}`,
	},

	/** 「手伝います」（`HelpOfferButton`） */
	helpOffer: {
		heading: "解決に動く人",
		fetchFailed:
			"手伝いの表明を取得できませんでした。時間をおいて再度お試しください。",
		none: "まだ誰も手を挙げていません。",
		count: (total: number) => `${total} 人が「手伝います」と表明しています。`,
		offer: "手伝います",
		withdraw: "表明を取り消す",
		signInHint: " — 表明するにはログインが必要です",
		youOffered: " — あなたはこの Issue に手を挙げています",
		offerersHeading: "表明した人",
		you: "あなた",
		/**
		 * 表示名が取れなかった表明者の表記（#108）。
		 *
		 * 「匿名の方」（`AUTHOR_LABELS.anonymous`）とは別の文言にしている。
		 * 手伝いますの表明は本人が自分の意思で名乗り出る行為なので、
		 * 「名乗ったが Clerk に名前が登録されていない」状態を
		 * 「匿名を選んだ」と同じ言葉で書くと、本人の意思を取り違える。
		 *
		 * Clerk への問い合わせ自体が失敗したときもこの文言になる。
		 * 利用者から見ればどちらも「名前が分からない人が手を挙げている」で、
		 * 障害の内訳を画面で説明しても次の行動が変わらないため。
		 *
		 * 文字列を直接書かず `AUTHOR_LABELS` を引いているのは、同じ意味の
		 * 表記が起票者・コメント投稿者にも要るようになったため（#67）。
		 * 3 箇所で別々に書き換えられる状態にしておくと、いつか食い違う。
		 */
		unnamedOfferer: AUTHOR_LABELS.ja.unnamed,
		/**
		 * 表明した直後に出す、次の一手（#114）。
		 *
		 * ボタンを押すと「あなたはこの Issue に手を挙げています」と出るだけで、
		 * そこで止まっていた。話を進める場所（コメント欄）はすぐ下にあるのに、
		 * そこへ進んでよいことがどこにも書かれていなかった。
		 *
		 * 連絡先の交換のような閉じた場は作らないと決めているので（#114）、
		 * 行き先は公開のコメント欄一本にする。
		 */
		nextStep: "どう手伝えるかをコメント欄に書いてみましょう。",
		/** 上の文言から飛ぶリンクのラベル。 */
		nextStepLink: "コメント欄へ",
	},

	/** コメント欄（`CommentSection`） */
	comments: {
		heading: (count: number) => `コメント（${count}）`,
		guide:
			"誰かを責めるためではなく、直すために書く場所です。似た経験、現地の状況、使えそうな制度や連絡先など、解決に近づく情報を歓迎します。",
		fetchFailed:
			"コメントを取得できませんでした。時間をおいて再度お試しください。",
		empty: "まだコメントがありません。最初の一言を書いてみてください。",
		signInRequired: "コメントの投稿にはログインが必要です。",
		label: "コメント",
		lengthHint: (max: number) => `${max} 文字以内。`,
		placeholder:
			"例: 同じ場所で先週も転びそうになりました。市の窓口には〇〇という制度があるようです。",
		submit: "コメントする",

		/**
		 * コメントの削除（#99）。自分のコメントにだけ出る。
		 *
		 * 削除は物理削除で元に戻せないため、押してすぐには消さず、
		 * 同じカードの中で一度確認を挟む（`deleteConfirm`）。別画面の
		 * ダイアログにしないのは、どのコメントを消そうとしているのかが
		 * 目の前に残っている方が取り違えにくいため。
		 */
		delete: "削除",
		deleteConfirm: "このコメントを削除しますか？ 元に戻せません。",
		deleteConfirmYes: "削除する",
		deleteConfirmCancel: "やめる",
		deleting: "削除中…",
		deleteFailed:
			"コメントを削除できませんでした。時間をおいて再度お試しください。",
		/**
		 * 401 のときだけ出す文言。削除ボタンは自分のコメントにしか出ないので、
		 * ここに来るのは権限の問題ではなくログインが切れた場合。
		 * 「時間をおいて再度お試しください」では直らないため区別する。
		 */
		deleteSignInRequired:
			"ログインの有効期限が切れている可能性があります。ログインし直してから削除してください。",
	},

	/** 起票フォーム（`/issues/new`） */
	newIssue: {
		heading: "Issue を起票する",
		lead: "気づいた「地球のバグ」を登録します。",
		signInRequired: "投稿にはログインが必要です。",
		title: "タイトル",
		titleHint:
			"何が起きているかを一文で。場所と、いつから続いているかまで書くと伝わります。",
		titlePlaceholder: "例: 〇〇公園の街灯が3ヶ月間消えたまま",
		description: "説明",
		descriptionHint:
			"いつから / どこで / 誰が困っているか を書くと、解決に動く人が判断しやすくなります。試したこと（連絡先に問い合わせた等）があれば、それも書いてください。",
		descriptionPlaceholder:
			"例: 3ヶ月ほど前から公園南口の街灯が2本消えています。\n夜に子どもの下校路になっていて、保護者から不安の声が出ています。\n市の窓口には一度電話しましたが、その後の連絡はありません。",
		scope: "スコープ",
		/** 選択中のスコープの説明を添える。ラベルと説明は呼び出し側が渡す */
		scopeHint: (label: string, description: string) =>
			`どこまで広がる課題かを選びます。${label}: ${description}`,
		category: "カテゴリ（任意）",
		categoryHint:
			"入力欄をクリックするか文字を入力すると候補が出ます。当てはまるものが無ければ自由に入力してください。後から同じ種類の Issue を探すときの手がかりになります。",
		categoryPlaceholder: "例: 道路・交通",
		photo: "写真（任意）",
		photoHint:
			"困りごとが写っている写真を 1 枚まで添付できます。写真は文章より状況が伝わり、手伝う人が判断しやすくなります。大きい写真は送信前に自動で縮小されます。",
		photoProcessing: "写真を準備しています…",
		photoPreviewAlt: "選択した写真のプレビュー",
		photoRemove: "写真を外す",
		photoTooLarge:
			"写真のサイズが大きすぎます。別の写真を選ぶか、撮り直してください。",
		photoUnreadable:
			"この画像は読み込めませんでした。JPEG・PNG・WebP のいずれかの写真を選んでください。",
		photoNotReady: "写真を準備しています。完了までお待ちください。",
		locationLegend: "場所（任意）",
		/**
		 * 場所の入力の説明（#124 で任意になった）。
		 *
		 * 最初に「空欄でよい」と言い切っている。必須だと思ったまま読み進めると、
		 * 位置を出したくない人はそこで起票をやめてしまう。
		 * 丸めることも先に伝える。入力した値がそのまま公開されると思っている
		 * 人にとっては、それが入力するかどうかの判断材料になる。
		 */
		locationHint:
			"困りごとが起きている場所の座標です。空欄のままでも起票できます。入力した座標は、およそ 100m の範囲に丸めてから保存・公開します（建物までは特定できません）。「現在地から入力」を押すと、ブラウザが位置情報の使用許可を確認します（許可すると緯度経度が自動で入ります）。現地にいないときは、地図サービスで目的の地点を右クリックすると座標を調べられます。",
		latitude: "緯度",
		latitudeHint: "-90 〜 90（任意）",
		latitudePlaceholder: "例: 35.681236",
		longitude: "経度",
		longitudeHint: "-180 〜 180（任意）",
		longitudePlaceholder: "例: 139.767125",
		/** 入力した座標を消して「位置なし」に戻す（#124） */
		clearLocation: "位置情報を入力しない",
		useCurrentPosition: "現在地から入力",
		locating: "取得中…",
		geolocationFailed:
			"位置情報を取得できませんでした。緯度経度を直接入力してください。",
		/** 名乗るかどうか（#88）。既定は未チェック＝匿名 */
		showName: "名前を出す",
		showNameHint:
			"チェックしないと「匿名の方」として表示されます。困りごとは住んでいる場所が伝わることがあるため、既定では名前を出しません。投稿した後からは変更できないので、ここで決めてください。",
		validationFailed: "入力内容を確認してください。",
		submit: "起票する",
		viewIssues: "Issue 一覧を見る",
		myIssues: "自分が起票した Issue",
		backToHome: "トップへ戻る",
	},

	/** 起票完了の表示（`IssueCreated`） */
	issueCreated: {
		created: (id: string) => `起票しました（ID: ${id}）。`,
		viewCreated: "投稿した Issue を見る",
		myIssues: "自分が起票した Issue",
	},

	/** 地図（`IssueMap`） */
	map: {
		/** 地図全体の `aria-label`。座標そのものは呼び出し側の dl に残る */
		label: (title: string, latitude: number, longitude: number) =>
			`${title} の位置。緯度 ${latitude} / 経度 ${longitude}`,
	},

	/** 地図ダッシュボード（`/map`、#113） */
	mapPage: {
		heading: "地図で見る",
		lead: "投稿された Issue を地図の上に並べます。どこに何が集まっているかを見比べられます。",
		/** 地図に実際に描かれた件数。表示範囲の外にある Issue は含まない */
		plotted: (count: number) => `${count} 件を地図に表示しています`,
		/** 配信元が未設定で地図そのものを出せないとき */
		tilesUnavailable:
			"地図の配信元が設定されていないため、地図を表示できません。位置は一覧から確認できます。",
		/** 取得に失敗したとき。0 件と同じ見た目にしない */
		fetchFailed:
			"Issue を取得できませんでした。時間をおいて再度お試しください。",
		noIssues: "条件に合う Issue はありませんでした。",
		/**
		 * 位置情報を持たない Issue の件数（#124）。
		 *
		 * 地図に出ないものがあることを黙っていると、地図の上の点が
		 * 「条件に合う Issue の全部」だと読まれる。件数を出すことで、
		 * 一覧で見れば続きがあると分かる。
		 */
		withoutLocation: (count: number) =>
			`位置情報のない Issue が ${count} 件あります。地図には出ていないので、一覧で読めます。`,
		zoomLabel: "縮尺",
		zoomIn: "拡大",
		zoomOut: "縮小",
		panLabel: "表示位置",
		panNorth: "北へ",
		panSouth: "南へ",
		panEast: "東へ",
		panWest: "西へ",
		/** 自動で決めた視界へ戻す。動かしすぎて何も見えなくなったときの逃げ道 */
		resetView: "全体を表示",
		listHeading: "地図に出ている Issue",
		backToList: "一覧で見る",
		backToHome: "トップへ戻る",
	},
} as const;

/**
 * リテラル型を緩めつつ、キーの構造と値の種類（文字列か関数か）は保つ。
 *
 * `JA_UI_MESSAGES` は `as const` なので、そのままだと各文言が
 * 「その日本語の文字列そのもの」というリテラル型になり、`en` 側に
 * 別の文字列を書いた時点で型エラーになってしまう（翻訳できない）。
 *
 * かといって `Record<string, string>` まで緩めると、キーの過不足も
 * 打ち間違いも検出できなくなり、この辞書を型で縛る意味が消える。
 * ここで緩めるのは値のリテラルだけで、キーの集合はそのまま残す。
 *
 * 値を差し込む文言は関数なので、引数と戻り値の型はそのまま保つ。
 * `ja` が `(total: number) => string` のキーに `en` が文字列を置けば型エラーになる。
 */
type Translated<T> = T extends string
	? string
	: // biome-ignore lint/suspicious/noExplicitAny: 引数の型を保ったまま関数を通すため
		T extends (...args: any[]) => string
		? T
		: { [K in keyof T]: Translated<T[K]> };

/**
 * UI 文言の型。`ja` の辞書から導出しているので、`ja` にキーを足すと
 * `en` 側の不足が型エラーになる（＝翻訳漏れがコンパイル時に分かる）。
 * 余分なキーも、`en` 側にだけ書けば `excess property check` で落ちる。
 */
export type UiMessages = Translated<typeof JA_UI_MESSAGES>;

const EN_UI_MESSAGES: UiMessages = {
	common: {
		siteTitle: "World Issue Tracker",
		siteDescription: "Visualize the bugs of our planet, and fix them together",
		htmlLang: "en",
		unexpectedError: "Something went wrong. Please try again later.",
		signIn: "Sign in",
		submitting: "Submitting…",
		loading: "Loading…",
	},

	header: {
		newIssue: "New issue",
		map: "Map",
		myIssues: "My issues",
		signIn: "Sign In",
	},

	localeSwitcher: {
		label: "Language",
		names: { ja: "日本語", en: "English" },
	},

	home: {
		// 日本語側と同じ理由で短くしている（B1）。英語は日本語より 1 文字が
		// 細いぶん折り返しにくいが、見出しの長さを言語で変えると
		// 同じ画面が別物に見えるので、揃えて短くする
		heading: "Let’s fix the bugs of our planet.",
		headingEyebrow: "From personal to global",
		aboutHeading: "What is this service?",
		aboutBody1:
			"A broken streetlight, an abandoned house, a national policy. Write your problem down as an issue, and it starts getting solved the moment someone raises their hand.",
		aboutBody2:
			"Anyone can comment on a posted issue, and raising your hand with “I can help” starts moving it toward a fix. The goal is not to find someone to blame, but to fix things.",
		actionsLabel: "Main actions",
		actionsHeading: "Start here",
		viewIssues: "Browse issues",
		viewIssuesHint: "Read the posted problems. No sign-in required",
		writeIssue: "Write an issue",
		writeIssueHint: "Post what troubles you. Posting requires signing in",
		recentHeading: "Recent issues",
		viewAll: "See all issues",
		scopesHeading: "How far an issue reaches (scope)",
		scopesBody:
			"Personal worries and global problems are part of the same continuum. Every issue is posted at one of these five levels.",
		statusesHeading: "How an issue gets resolved",
		statusesBody: "A posted issue moves through these states in order.",
		statusesMoreLabel: "When an issue is not resolved",
		statusesMoreBody:
			"An issue is closed when we decide not to act on it, or when it duplicates another one. That is a different exit from the path above, so it is not part of the flow.",
		solvedHeading: "Things really do get fixed",
		solvedEmpty: "Waiting for the first one to be resolved.",
		solvedEmptyAction: "Write an issue",
		solvedViewAll: "See resolved issues",
		solvedFlow: "Posted → Someone stepped in → Resolved",
	},

	issueList: {
		fetchFailed: "Could not load issues. Please try again later.",
		empty: "No issues yet. Be the first to post one.",
		emptyAction: "Post the first issue",
		countSummary: (total: number, shown: number) =>
			`Showing ${shown} of ${total}`,
		rangeSummary: (total: number, from: number, to: number) =>
			`Showing ${from}–${to} of ${total}`,
	},

	myIssueList: {
		signInRequired: "Sign in to see the issues you posted.",
		signInHint: "Sign in from “Sign In” at the top right to see them here.",
		empty: "You have not posted any issues yet.",
		writeFirst: "Write your first one",
	},

	pagination: {
		label: "Pagination",
		previous: "Previous",
		next: "Next",
		position: (current: number, total: number) => `Page ${current} of ${total}`,
	},

	filterForm: {
		legend: "Filter and sort",
		keyword: "Keyword",
		keywordHint: "Searches titles and descriptions.",
		keywordPlaceholder: "e.g. streetlight",
		scope: "Scope",
		scopeHint: "Filter by how far the problem reaches.",
		status: "Status",
		statusHint: "Filter by how far along the fix is.",
		category: "Category",
		categoryHint:
			"Matches exactly what was typed when posting. Picking from the suggestions is safest.",
		categoryPlaceholder: "e.g. Roads and transport",
		sort: "Sort",
		sortHint: "Orders by the time of posting.",
		all: "All",
		submit: "Apply",
		clear: "Clear all filters",
	},

	issuesPage: {
		heading: "Issues",
		noMatch: "No issues matched your filters. Try loosening them.",
		writeIssue: "Write an issue",
		backToHome: "Back to home",
	},

	myIssuesPage: {
		heading: "Issues you posted",
		writeIssue: "Write an issue",
		viewAll: "See all issues",
		backToHome: "Back to home",
	},

	issueDetail: {
		loadingHeading: "Loading the issue",
		unavailableHeading: "Could not display this issue",
		retryLater: "Please try again later.",
		backToList: "Back to the issue list",
		writeIssue: "Write an issue",
		descriptionHeading: "Description",
		photoHeading: "Photo",
		photoAlt: (title: string) => `Photo of ${title}`,
		detailsHeading: "Details",
		scope: "Scope",
		status: "Status",
		category: "Category",
		categoryUnset: "Not set",
		/** 起票者（#88）。値は `getAuthorLabel` が出す（#67） */
		author: "Posted by",
		location: "Location",
		coordinates: (latitude: number, longitude: number) =>
			`Latitude ${latitude} / Longitude ${longitude}`,
		locationUnset: "The person who posted this chose not to share a location",
		coordinatesApproximate:
			"The location is rounded to about 100m, so the pin does not mark the exact spot.",
		createdAt: "Created",
		updatedAt: "Last updated",
	},

	statusControl: {
		heading: "Status",
		unavailable:
			"Could not check whether you may change the status. If you posted this issue, please reload the page.",
		current: "Current:",
		changeTo: "Change to",
		submit: "Update status",
		submitting: "Updating…",
		updated: (statusLabel: string) => `Status updated to “${statusLabel}”.`,
	},

	reaction: {
		heading: "People affected",
		fetchFailed: "Could not load reactions. Please try again later.",
		none: "Nobody has reacted yet.",
		count: (total: number) =>
			total === 1
				? "1 person also has this problem."
				: `${total} people also have this problem.`,
		react: "I have this problem too",
		withdraw: "Undo my reaction",
		signInHint: " — sign in to react",
		youReacted: " — you have reacted to this issue",
		cardCount: (total: number) => `${total} affected`,
	},

	helpOffer: {
		heading: "People moving to fix this",
		fetchFailed: "Could not load help offers. Please try again later.",
		none: "Nobody has raised their hand yet.",
		count: (total: number) =>
			total === 1
				? "1 person has offered to help."
				: `${total} people have offered to help.`,
		offer: "I can help",
		withdraw: "Withdraw my offer",
		signInHint: " — sign in to offer help",
		youOffered: " — you have raised your hand for this issue",
		offerersHeading: "People who offered",
		you: "You",
		/** 日本語側と同じく `AUTHOR_LABELS` から引く（#67）。 */
		unnamedOfferer: AUTHOR_LABELS.en.unnamed,
		nextStep: "Tell everyone how you can help, in the comments below.",
		nextStepLink: "Go to comments",
	},

	comments: {
		heading: (count: number) => `Comments (${count})`,
		guide:
			"This is a place to write in order to fix things, not to blame anyone. Similar experiences, conditions on the ground, useful programs or contacts — anything that brings a fix closer is welcome.",
		fetchFailed: "Could not load comments. Please try again later.",
		empty: "No comments yet. Be the first to say something.",
		signInRequired: "Sign in to post a comment.",
		label: "Comment",
		lengthHint: (max: number) => `${max} characters or fewer.`,
		placeholder:
			"e.g. I nearly tripped at the same spot last week. The city office seems to have a program for this.",
		submit: "Post comment",

		/** コメントの削除（#99）。日本語側のコメントを参照。 */
		delete: "Delete",
		deleteConfirm: "Delete this comment? This cannot be undone.",
		// 確認の前後でボタンの文字が変わるようにする。どちらも "Delete" だと、
		// 押したのに何も起きていないように見える（日本語側は「削除」→「削除する」）
		deleteConfirmYes: "Yes, delete",
		deleteConfirmCancel: "Keep it",
		deleting: "Deleting…",
		deleteFailed: "Could not delete the comment. Please try again later.",
		deleteSignInRequired:
			"Your session may have expired. Sign in again, then delete.",
	},

	newIssue: {
		heading: "Post an issue",
		lead: "Register a “bug of our planet” that you noticed.",
		signInRequired: "Sign in to post.",
		title: "Title",
		titleHint:
			"One sentence on what is happening. Adding where it is and how long it has lasted helps.",
		titlePlaceholder: "e.g. Streetlight at the park has been out for 3 months",
		description: "Description",
		descriptionHint:
			"Writing since when / where / who is affected helps people decide whether they can act. If you have already tried something (contacting an office, for example), include that too.",
		descriptionPlaceholder:
			"e.g. Two streetlights at the south entrance of the park have been out for about three months.\nChildren walk home along this path at night, and parents are worried.\nI called the city office once but have heard nothing since.",
		scope: "Scope",
		scopeHint: (label: string, description: string) =>
			`Choose how far the problem reaches. ${label}: ${description}`,
		category: "Category (optional)",
		categoryHint:
			"Click the field or start typing to see suggestions. If none fit, type your own. It becomes a clue when looking for similar issues later.",
		categoryPlaceholder: "e.g. Roads and transport",
		photo: "Photo (optional)",
		photoHint:
			"You can attach up to one photo showing the problem. A photo conveys the situation better than text and helps people decide whether they can act. Large photos are resized automatically before sending.",
		photoProcessing: "Preparing the photo…",
		photoPreviewAlt: "Preview of the selected photo",
		photoRemove: "Remove photo",
		photoTooLarge:
			"This photo is too large. Choose another photo, or take a new one.",
		photoUnreadable:
			"This image could not be read. Choose a JPEG, PNG, or WebP photo.",
		photoNotReady:
			"The photo is still being prepared. Please wait until it is done.",
		locationLegend: "Location (optional)",
		locationHint:
			"The coordinates of where the problem is. You can leave this empty and still post. Coordinates you enter are rounded to about 100m before they are stored and published, so no building can be pinpointed. Pressing “Use my location” asks the browser for permission to use your location (allowing it fills in the latitude and longitude). If you are not on site, right-click the spot in a map service to look up its coordinates.",
		latitude: "Latitude",
		latitudeHint: "-90 to 90 (optional)",
		latitudePlaceholder: "e.g. 35.681236",
		longitude: "Longitude",
		longitudeHint: "-180 to 180 (optional)",
		longitudePlaceholder: "e.g. 139.767125",
		clearLocation: "Post without a location",
		useCurrentPosition: "Use my location",
		locating: "Locating…",
		geolocationFailed:
			"Could not get your location. Please enter the coordinates directly.",
		/** 名乗るかどうか（#88）。既定は未チェック＝匿名 */
		showName: "Show my name",
		showNameHint:
			"If you leave this unchecked, you will be shown as “Anonymous”. Issues can reveal where you live, so names are hidden by default. This cannot be changed after posting, so please decide here.",
		validationFailed: "Please check what you entered.",
		submit: "Post issue",
		viewIssues: "Browse issues",
		myIssues: "Issues you posted",
		backToHome: "Back to home",
	},

	issueCreated: {
		created: (id: string) => `Posted (ID: ${id}).`,
		viewCreated: "View the issue you posted",
		myIssues: "Issues you posted",
	},

	map: {
		label: (title: string, latitude: number, longitude: number) =>
			`Location of ${title}. Latitude ${latitude} / Longitude ${longitude}`,
	},

	mapPage: {
		heading: "Map",
		lead: "Issues plotted on a map, so you can see where problems cluster.",
		plotted: (count: number) => `Showing ${count} issue(s) on the map`,
		tilesUnavailable:
			"No map tile source is configured, so the map cannot be shown. Locations are still listed below.",
		fetchFailed: "Could not load issues. Please try again later.",
		noIssues: "No issues matched your filters.",
		withoutLocation: (count: number) =>
			`${count} issue(s) have no location. They are not on the map, but you can read them in the list.`,
		zoomLabel: "Zoom",
		zoomIn: "Zoom in",
		zoomOut: "Zoom out",
		panLabel: "Pan",
		panNorth: "North",
		panSouth: "South",
		panEast: "East",
		panWest: "West",
		resetView: "Fit all",
		listHeading: "Issues on this map",
		backToList: "Browse as a list",
		backToHome: "Back to home",
	},
};

/**
 * UI 文言の辞書。`ja` を基準にして `en` を型で縛っている。
 *
 * `Record<Locale, UiMessages>` なので、`Locale` に言語を足したときも
 * 辞書の不足が型エラーになる。
 */
export const UI_MESSAGES: Record<Locale, UiMessages> = {
	ja: JA_UI_MESSAGES,
	en: EN_UI_MESSAGES,
};

/** UI 文言を引く。ロケール省略時は既定ロケール */
export const getUiMessages = (locale: Locale = DEFAULT_LOCALE): UiMessages =>
	UI_MESSAGES[locale];

/**
 * 任意の値をロケールとして読む。既知でなければ既定ロケールに倒す。
 *
 * ロケールの出どころは Cookie とクエリ文字列で、どちらも利用者が手で
 * 書き換えられる。壊れた値で `UI_MESSAGES[locale]` が `undefined` になり
 * 画面全体が落ちる、という壊れ方をさせない。
 */
export const parseLocale = (value: string | null | undefined): Locale => {
	const parsed = Locale.safeParse(value);
	return parsed.success ? parsed.data : DEFAULT_LOCALE;
};

/**
 * キーワード検索語の上限。
 *
 * 認証不要の公開エンドポイントなので、任意長の文字列を LIKE パターンに
 * 変換させない。カテゴリ（100 文字）とタイトル（200 文字）の両方を
 * 覆える長さがあれば実用上は足りる。
 */
export const ISSUE_SEARCH_MAX_LENGTH = 200;

/**
 * LIKE パターンのメタ文字をエスケープする。
 *
 * `%` `_` はそれぞれ「任意の文字列」「任意の 1 文字」として解釈されるため、
 * 利用者が入力した `100%` がそのままだと `100` で始まる何にでも当たる。
 * バインド値として渡していても SQL インジェクションにはならないが、
 * 検索結果としては入力と違うものが返る。
 *
 * エスケープ文字自身（`\`）を先に処理しないと、後段で付けた `\` を
 * さらにエスケープしてしまうため、順序を変えてはいけない。
 * 呼び出し側は SQL に `ESCAPE '\'` を明示すること（SQLite の LIKE は
 * 既定でエスケープ文字を持たない）。
 */
export function escapeLikePattern(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * 一覧のカーソル。「最後に見た行の created_at と id」を `|` で連結した文字列。
 *
 * created_at は SQLite が返す `YYYY-MM-DD HH:MM:SS[.SSS]` 書式なので、
 * `|` を含まないことが書式から保証される。よって**最初の** `|` が常に区切りで、
 * それ以降はすべて id とみなせる。id 側は `TEXT PRIMARY KEY` で書式の制約が無く
 * `|` を含みうるため、id に区切り文字を禁じると `buildIssueCursor` が発行した
 * カーソルを `IssueCursorSchema` が拒否する（= その行より古い Issue に
 * 到達できなくなる）。組み立てと分解を対称に保つため、id 側は非空とだけ決める。
 *
 * 値は WHERE 句のバインド値としてしか使わないので中身は信用しなくてよいが、
 * 区切りを欠いたカーソルを黙って「該当なし」にすると、クライアント側の
 * 組み立てミスが空ページとして素通りしてしまうため 400 で弾く。
 * 逆に「書式は妥当だが実在しない日付」までは検証しない（空ページになる）。
 *
 * 長さの上限は、認証不要の公開エンドポイントに任意長の文字列を投げ込ませない
 * ためのもの。`limit` の上限と同じく、レスポンスの形ではなくリソース保護が目的。
 * 実際の id（16 進 32 文字）に対しては十分な余裕がある。
 */
export const IssueCursorSchema = z
	.string()
	.max(256, "Invalid cursor")
	.regex(
		/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,3})?\|.+$/s,
		"Invalid cursor",
	);

/**
 * カーソル文字列を created_at と id に分解する。
 *
 * `IssueCursorSchema` を通っていない文字列を渡されても
 * もっともらしい壊れた値を返さないよう、区切りが無ければ投げる。
 */
export function parseIssueCursor(cursor: string): {
	createdAt: string;
	id: string;
} {
	const separator = cursor.indexOf("|");
	if (separator === -1) {
		throw new Error("Invalid cursor");
	}
	return {
		createdAt: cursor.slice(0, separator),
		id: cursor.slice(separator + 1),
	};
}

/**
 * 行から次ページ用のカーソル文字列を組み立てる。
 * `parseIssueCursor` と往復して同じ値に戻ることが前提。
 */
export function buildIssueCursor(row: {
	created_at: string;
	id: string;
}): string {
	return `${row.created_at}|${row.id}`;
}

/**
 * 未指定時の既定値は `.default()` ではなくオブジェクト側の `.transform()` で埋める。
 *
 * `.default()` は「変換前の入力型」に対して働くため、
 * `DecimalIntQueryParam.pipe(...).default(20)` は型が合わず、
 * `.default("20")` にすると未指定時だけ文字列 `"20"` がそのまま
 * パイプを通らずに出てくる（`limit` が number にならない）。
 * 未指定と「指定された値の検証」を分けるほうが挙動が読める。
 */
export const ListIssuesQuerySchema = z
	.object({
		scope: IssueScope.optional(),
		status: IssueStatus.optional(),
		// カテゴリは自由入力（`<datalist>` の候補は入力の補助でしかない）なので
		// enum では縛れない。保存時と同じ長さの上限だけを課して完全一致で引く。
		category: z.string().min(1).max(100).optional(),
		// キーワードは前後の空白を落としてから見る。フォームから空文字や
		// 空白だけが送られてくるのは「未指定」であって「空文字に一致する
		// Issue を探せ」ではないため、`undefined` に倒す。
		q: z
			.string()
			.max(ISSUE_SEARCH_MAX_LENGTH)
			.transform((value) => value.trim())
			.transform((value) => (value.length ? value : undefined))
			.optional(),
		sort: IssueSort.optional(),
		limit: DecimalIntQueryParam.pipe(
			z.number().int().min(1).max(100),
		).optional(),
		// offset にも上限が要る。無いと INT64 の範囲を超えた値がそのまま
		// SQL の OFFSET に渡り、D1 が SQLITE_MISMATCH を投げて 500 になる。
		// 深いページングは実用上意味がないので、limit(100) の 1 万ページ分で十分。
		offset: DecimalIntQueryParam.pipe(
			z.number().int().min(0).max(1_000_000),
		).optional(),
		cursor: IssueCursorSchema.optional(),
	})
	.transform((query) => ({
		...query,
		limit: query.limit ?? LIST_ISSUES_DEFAULT_LIMIT,
		offset: query.offset ?? LIST_ISSUES_DEFAULT_OFFSET,
		sort: query.sort ?? LIST_ISSUES_DEFAULT_SORT,
	}))
	// cursor と offset は位置の決め方が違うので併用できない。
	// 片方を黙って無視すると「offset が効いたつもりの空ページ」が返り、
	// クライアントからは残りの行が失われたようにしか見えない。
	// offset=0 は既定値と区別が付かないため、0 より大きいときだけ弾く。
	//
	// `.transform()` の後に置いているのは、既定値が埋まった後の値を見るため。
	// 前に置くと offset 未指定（undefined）と 0 の区別が付かない。
	.refine((data) => !(data.cursor && data.offset > 0), {
		message: "cursor and offset cannot be used together",
		path: ["cursor"],
	});
export type ListIssuesQuery = z.infer<typeof ListIssuesQuerySchema>;

/**
 * Clerk のキーが開発用インスタンスのものか（#98）。
 *
 * Clerk のキーは接頭辞で種別が分かる。publishable key は `pk_test_` /
 * `pk_live_`、secret key は `sk_test_` / `sk_live_` で始まり、`test` が
 * 開発用インスタンス、`live` が本番用インスタンスを指す。
 *
 * この判定を置いている理由は、開発用キーが本番に出ても**何も落ちない**から。
 * ローカルでも CI でも本番でも同じように認証が通り、テストも型検査も
 * ビルドも全部緑になる。実際 #98 は、本番サイトを人が操作していて
 * ブラウザのコンソールに出た Clerk 自身の警告で見つかっている。
 *
 * 開発用インスタンスには Clerk 側の利用者数上限があり、上限に達すると
 * サインインできなくなる。つまり「人が増えたら止まる」種類の不備で、
 * 出てから気付くのでは遅い。ビルド時に落とすための判定材料にする。
 *
 * 接頭辞で見ているのは、キーの本体（base64 のインスタンス識別子）を
 * 復号しなくても種別が確定するため。Clerk がこの接頭辞を変えた場合は
 * 判定が効かなくなるが、そのときは `null`（判定不能）を返して
 * 呼び出し側に委ねる。誤って「本番用」と断定して素通りさせるより、
 * 判定できないことが分かるほうが安全。
 */
export type ClerkKeyKind = "development" | "production";

export function clerkKeyKind(key: string | undefined): ClerkKeyKind | null {
	if (!key) {
		return null;
	}
	// `pk_test_` / `sk_test_` / `pk_live_` / `sk_live_` のいずれか。
	// 接頭辞だけを見て、本体の中身は問わない。
	const match = /^(?:pk|sk)_(test|live)_/.exec(key);
	if (!match) {
		return null;
	}
	return match[1] === "live" ? "production" : "development";
}

/**
 * 本番デプロイで使ってはいけないキーか（#98）。
 *
 * 判定不能（`null`）を「使ってよい」に倒していないことに注意。キーの形式が
 * 想定と違うなら、それは Clerk の仕様変更か設定ミスのどちらかで、
 * どちらも本番に黙って出してよい状態ではない。空文字・未設定も同様に弾く
 * （認証が丸ごと動かないビルドを本番へ出すことになるため）。
 */
export function isUnsafeForProduction(key: string | undefined): boolean {
	return clerkKeyKind(key) !== "production";
}

/**
 * 本番の入口となる Web のオリジン（#98）。
 *
 * ここが唯一の宣言。以前は同じ URL が web / api / CI / README の 12 箇所に
 * 直接書かれており、デプロイ先を変えるたびに全部を手で追う必要があった。
 * 実際 `ALLOWED_ORIGINS` には「Web のデプロイ先を変えたときはここも必ず
 * 更新すること」という申し送りが書かれている。更新が漏れると書き込みが 403 に
 * なる（CORS だけの頃と違い、Origin 検証で完全に遮断されるため）。
 *
 * `emaker.dev` は他のサービス（reactions.emaker.dev）と共有しているゾーン。
 * このサービスが育ったら独立したドメインへ移す想定で、そのとき書き換えるのは
 * ここだけで済むようにしてある。
 */
export const PRODUCTION_WEB_ORIGIN = "https://issues.emaker.dev";

/**
 * 切り替え前から使っている入口（#98）。
 *
 * 独自ドメインへ移したあとも消さない。DNS の伝播中（最大 48 時間）は
 * どちらからも来るし、旧 URL のブックマークや貼られたリンクも残る。
 * 「新しい方は動くのに古い方からは書き込めない」という分かりにくい壊れ方を
 * 避けるため、完全に移り終えたと判断できるまでは許可し続ける。
 */
export const LEGACY_WEB_ORIGINS = [
	"https://world-issue-tracker-web.mktoho.workers.dev",
	"https://world-issue-tracker.pages.dev",
] as const;

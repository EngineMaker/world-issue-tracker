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

export const CreateIssueSchema = z.object({
	title: z.string().min(1).max(200),
	description: z.string().min(1).max(5000),
	scope: IssueScope,
	latitude: z.number().min(-90).max(90),
	longitude: z.number().min(-180).max(180),
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
export type CreateIssue = z.infer<typeof CreateIssueSchema>;

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
 * 起票者の名乗りに関する表示ラベル（#88）。
 *
 * 匿名かどうかは真偽値でしかないが、画面に `true` / `false` を出すわけには
 * いかないので、スコープやステータスと同じ流儀で対応表をここに置く。
 * 一覧・詳細で別々に文言を書くと、同じ Issue が画面ごとに違う顔になる（#59）。
 *
 * 名乗っている側を「投稿者あり」という抽象的な表現に留めているのは、
 * 実際の表示名の取得（Clerk Backend API 連携）が #67 の範囲だから。
 * 名前が取れるようになったら、ここの `named` を実際の表示名に置き換える。
 */
export const ISSUE_ANONYMITY_LABELS: Record<
	Locale,
	{ anonymous: string; named: string }
> = {
	ja: {
		anonymous: "匿名の方",
		named: "投稿者あり",
	},
	en: {
		anonymous: "Anonymous",
		named: "Named author",
	},
};

/** 匿名かどうかの表示ラベルを引く。ロケール省略時は既定ロケール */
export const getIssueAnonymityLabel = (
	isAnonymous: boolean,
	locale: Locale = DEFAULT_LOCALE,
) => ISSUE_ANONYMITY_LABELS[locale][isAnonymous ? "anonymous" : "named"];

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

import { z } from "zod";

export const IssueScope = z.enum([
	"personal",
	"community",
	"municipality",
	"national",
	"global",
]);
export type IssueScope = z.infer<typeof IssueScope>;

export const IssueStatus = z.enum([
	"open",
	"triaged",
	"in_progress",
	"review",
	"resolved",
	"closed",
]);
export type IssueStatus = z.infer<typeof IssueStatus>;

export const CreateIssueSchema = z.object({
	title: z.string().min(1).max(200),
	description: z.string().min(1).max(5000),
	scope: IssueScope,
	latitude: z.number().min(-90).max(90),
	longitude: z.number().min(-180).max(180),
	category: z.string().min(1).max(100).optional(),
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

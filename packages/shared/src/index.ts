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

export const ListIssuesQuerySchema = z
	.object({
		scope: IssueScope.optional(),
		status: IssueStatus.optional(),
		limit: z.coerce.number().int().min(1).max(100).default(20),
		offset: z.coerce.number().int().min(0).default(0),
		cursor: IssueCursorSchema.optional(),
	})
	// cursor と offset は位置の決め方が違うので併用できない。
	// 片方を黙って無視すると「offset が効いたつもりの空ページ」が返り、
	// クライアントからは残りの行が失われたようにしか見えない。
	// offset=0 は既定値と区別が付かないため、0 より大きいときだけ弾く。
	.refine((data) => !(data.cursor && data.offset > 0), {
		message: "cursor and offset cannot be used together",
		path: ["cursor"],
	});
export type ListIssuesQuery = z.infer<typeof ListIssuesQuerySchema>;

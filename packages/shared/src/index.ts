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
		offset: DecimalIntQueryParam.pipe(z.number().int().min(0)).optional(),
	})
	.transform((query) => ({
		...query,
		limit: query.limit ?? LIST_ISSUES_DEFAULT_LIMIT,
		offset: query.offset ?? LIST_ISSUES_DEFAULT_OFFSET,
	}));
export type ListIssuesQuery = z.infer<typeof ListIssuesQuerySchema>;

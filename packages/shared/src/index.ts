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

export const ListIssuesQuerySchema = z.object({
	scope: IssueScope.optional(),
	status: IssueStatus.optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).default(0),
});
export type ListIssuesQuery = z.infer<typeof ListIssuesQuerySchema>;

import {
	CreateIssueSchema,
	UpdateIssueSchema,
} from "@world-issue-tracker/shared";
import { describe, expect, it } from "vitest";

/**
 * `packages/shared` のスキーマを直接叩く単体テスト。
 *
 * API 経由の HTTP テスト（`test/issues.test.ts`）だけだと、スキーマの制約が
 * 守られていることを API のどの経路を通したかに依存して確認することになる。
 * `packages/shared` は Web からも参照される前提の設計なので、ここが緩むと
 * フロントのクライアントサイド検証も同時に緩む。その保護を API の外側に置く。
 *
 * `packages/shared` 自体にはテストランナーが無いため、リポジトリのファイルを
 * 読むテストと同じ Node 環境（`vitest.node.config.ts`）に同居させている。
 */

const validIssue = {
	title: "Broken streetlight",
	description: "The streetlight on Main St is not working",
	scope: "community",
	latitude: 35.68,
	longitude: 139.76,
};

/** 検証エラーになったフィールド名の一覧。どのフィールドで落ちたかを見るために使う。 */
function errorFields(result: { success: boolean; error?: unknown }): string[] {
	if (result.success) {
		return [];
	}
	const error = result.error as { issues: { path: (string | number)[] }[] };
	return error.issues.map((issue) => String(issue.path[0]));
}

describe("CreateIssueSchema", () => {
	it("accepts a valid issue", () => {
		const result = CreateIssueSchema.safeParse(validIssue);
		expect(result.success).toBe(true);
	});

	describe("title", () => {
		it("rejects an empty string", () => {
			const result = CreateIssueSchema.safeParse({ ...validIssue, title: "" });
			expect(result.success).toBe(false);
			expect(errorFields(result)).toContain("title");
		});

		it("accepts the maximum length", () => {
			const result = CreateIssueSchema.safeParse({
				...validIssue,
				title: "a".repeat(200),
			});
			expect(result.success).toBe(true);
		});

		it("rejects one character over the maximum", () => {
			const result = CreateIssueSchema.safeParse({
				...validIssue,
				title: "a".repeat(201),
			});
			expect(result.success).toBe(false);
			expect(errorFields(result)).toContain("title");
		});

		it("rejects a non-string value", () => {
			const result = CreateIssueSchema.safeParse({ ...validIssue, title: 123 });
			expect(result.success).toBe(false);
			expect(errorFields(result)).toContain("title");
		});
	});

	describe("description", () => {
		it("rejects an empty string", () => {
			const result = CreateIssueSchema.safeParse({
				...validIssue,
				description: "",
			});
			expect(result.success).toBe(false);
			expect(errorFields(result)).toContain("description");
		});

		it("accepts the maximum length", () => {
			const result = CreateIssueSchema.safeParse({
				...validIssue,
				description: "d".repeat(5000),
			});
			expect(result.success).toBe(true);
		});

		it("rejects one character over the maximum", () => {
			const result = CreateIssueSchema.safeParse({
				...validIssue,
				description: "d".repeat(5001),
			});
			expect(result.success).toBe(false);
			expect(errorFields(result)).toContain("description");
		});
	});

	describe("category", () => {
		it("accepts being omitted", () => {
			const result = CreateIssueSchema.safeParse(validIssue);
			expect(result.success).toBe(true);
		});

		it("rejects an empty string", () => {
			const result = CreateIssueSchema.safeParse({
				...validIssue,
				category: "",
			});
			expect(result.success).toBe(false);
			expect(errorFields(result)).toContain("category");
		});

		it("accepts the maximum length", () => {
			const result = CreateIssueSchema.safeParse({
				...validIssue,
				category: "c".repeat(100),
			});
			expect(result.success).toBe(true);
		});

		it("rejects one character over the maximum", () => {
			const result = CreateIssueSchema.safeParse({
				...validIssue,
				category: "c".repeat(101),
			});
			expect(result.success).toBe(false);
			expect(errorFields(result)).toContain("category");
		});
	});
});

describe("UpdateIssueSchema", () => {
	it("accepts a single field", () => {
		const result = UpdateIssueSchema.safeParse({ title: "Updated" });
		expect(result.success).toBe(true);
	});

	it("rejects an empty object", () => {
		const result = UpdateIssueSchema.safeParse({});
		expect(result.success).toBe(false);
	});

	describe("title", () => {
		it("rejects an empty string", () => {
			const result = UpdateIssueSchema.safeParse({ title: "" });
			expect(result.success).toBe(false);
			expect(errorFields(result)).toContain("title");
		});

		it("accepts the maximum length", () => {
			const result = UpdateIssueSchema.safeParse({ title: "a".repeat(200) });
			expect(result.success).toBe(true);
		});

		it("rejects one character over the maximum", () => {
			const result = UpdateIssueSchema.safeParse({ title: "a".repeat(201) });
			expect(result.success).toBe(false);
			expect(errorFields(result)).toContain("title");
		});
	});

	describe("description", () => {
		it("rejects an empty string", () => {
			const result = UpdateIssueSchema.safeParse({ description: "" });
			expect(result.success).toBe(false);
			expect(errorFields(result)).toContain("description");
		});

		it("accepts the maximum length", () => {
			const result = UpdateIssueSchema.safeParse({
				description: "d".repeat(5000),
			});
			expect(result.success).toBe(true);
		});

		it("rejects one character over the maximum", () => {
			const result = UpdateIssueSchema.safeParse({
				description: "d".repeat(5001),
			});
			expect(result.success).toBe(false);
			expect(errorFields(result)).toContain("description");
		});
	});

	describe("category", () => {
		it("rejects an empty string", () => {
			const result = UpdateIssueSchema.safeParse({ category: "" });
			expect(result.success).toBe(false);
			expect(errorFields(result)).toContain("category");
		});

		it("accepts the maximum length", () => {
			const result = UpdateIssueSchema.safeParse({
				category: "c".repeat(100),
			});
			expect(result.success).toBe(true);
		});

		it("rejects one character over the maximum", () => {
			const result = UpdateIssueSchema.safeParse({
				category: "c".repeat(101),
			});
			expect(result.success).toBe(false);
			expect(errorFields(result)).toContain("category");
		});

		// null は明示的に許可されている（項目のクリア用）。
		// 長さ検証を足す際に null まで巻き込んで弾く退行を防ぐ。
		it("accepts null", () => {
			const result = UpdateIssueSchema.safeParse({ category: null });
			expect(result.success).toBe(true);
		});
	});
});

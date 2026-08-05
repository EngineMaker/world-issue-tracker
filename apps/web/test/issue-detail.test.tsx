import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueList } from "../src/app/components/IssueList";
import { fetchIssue } from "../src/lib/issues";

const sampleIssue = {
	id: "ebbcf9d7680ad57cedeeb513a90d461f",
	title: "駅前の街灯が切れている",
	description: "夜道が暗くて危ない",
	scope: "community",
	status: "open",
	latitude: 35.68,
	longitude: 139.76,
	category: "道路・交通",
	created_at: "2026-08-01 12:00:00.000",
	updated_at: "2026-08-01 12:00:00.000",
} as const;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** 呼ばれた URL を記録する `fetch` の代役。 */
function stubFetch(response: Response) {
	const calls: string[] = [];
	const impl = async (input: string | URL | Request): Promise<Response> => {
		calls.push(String(input));
		return response.clone();
	};
	return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

describe("fetchIssue", () => {
	it("Issue 1 件を取得する", async () => {
		const { impl, calls } = stubFetch(jsonResponse(sampleIssue));

		const result = await fetchIssue(sampleIssue.id, { fetchImpl: impl });

		expect(calls[0]).toContain(`/issues/${sampleIssue.id}`);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.issue.title).toBe("駅前の街灯が切れている");
		}
	});

	it("404 は notFound として区別する", async () => {
		// 「存在しない」と「API が落ちている」を同じ失敗にすると、
		// 障害中の Issue まで「存在しません」と断言してしまう
		const { impl } = stubFetch(jsonResponse({ error: "Issue not found" }, 404));

		const result = await fetchIssue("missing", { fetchImpl: impl });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.notFound).toBe(true);
		}
	});

	it("500 は notFound ではない失敗として返す", async () => {
		const { impl } = stubFetch(
			jsonResponse({ error: "Internal Server Error" }, 500),
		);

		const result = await fetchIssue(sampleIssue.id, { fetchImpl: impl });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.notFound).toBe(false);
		}
	});

	it("レスポンスの形が違えば失敗として返す", async () => {
		const { impl } = stubFetch(jsonResponse({ id: 1, title: "壊れた形" }));

		const result = await fetchIssue(sampleIssue.id, { fetchImpl: impl });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			// 形が違うだけで「存在しない」と言い切らないこと
			expect(result.notFound).toBe(false);
		}
	});

	it("Issue ID をエスケープしてパスに入れる", async () => {
		const { impl, calls } = stubFetch(jsonResponse(sampleIssue));

		await fetchIssue("a/b", { fetchImpl: impl });

		expect(calls[0]).toContain("/issues/a%2Fb");
	});

	it("通信そのものが失敗しても throw しない", async () => {
		const impl = (async () => {
			throw new Error("fetch failed");
		}) as unknown as typeof globalThis.fetch;

		const result = await fetchIssue(sampleIssue.id, { fetchImpl: impl });

		expect(result.ok).toBe(false);
	});
});

describe("IssueList から詳細への導線", () => {
	it("各 Issue のタイトルが詳細ページへのリンクになっている", () => {
		// 「手伝います」ボタンは詳細ページにあるため、ここに導線が無いと
		// 一覧から解決へ進む経路が存在しないことになる
		const html = renderToStaticMarkup(
			IssueList({ result: { ok: true, issues: [sampleIssue], total: 1 } }),
		);

		expect(html).toContain(`href="/issues/${sampleIssue.id}"`);
		expect(html).toContain("駅前の街灯が切れている");
	});
});

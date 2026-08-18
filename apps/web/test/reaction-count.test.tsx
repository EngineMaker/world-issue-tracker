/**
 * 一覧に出る「私も困っている」の件数のテスト（#112）。
 *
 * 検証したいのは 2 つの層が繋がっていること。
 *
 * 1. API のレスポンス（`reaction_count`）が `parsePublicIssue` を通ること
 * 2. 一覧のカードが実際にその数を描くこと
 *
 * 1 だけを見ても、カードが描かなければ画面には出ない。2 だけを見ても、
 * パーサが値を落とせば常に 0 になる。層ごとに独立して確かめる。
 *
 * 反応そのものの操作（押す・取り消す）は `reaction-button.test.tsx`、
 * 通信は `reactions.test.ts` の担当。
 */

import { describe, expect, it } from "bun:test";
import { getUiMessages } from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueCard } from "../src/app/components/IssueList";
import { type PublicIssue, parsePublicIssue } from "../src/lib/issues";

/** `GET /issues` が返す形の 1 件分。個々のテストで必要な項目だけ上書きする。 */
const sampleResponse = {
	id: "ebbcf9d7680ad57cedeeb513a90d461f",
	title: "駅前の街灯が切れている",
	description: "夜道が暗くて危ない",
	scope: "community",
	status: "open",
	latitude: 35.68,
	longitude: 139.76,
	category: "infrastructure",
	created_at: "2026-08-01 12:00:00.000",
	updated_at: "2026-08-01 12:00:00.000",
	is_anonymous: true,
	reaction_count: 4,
};

describe("parsePublicIssue の reaction_count", () => {
	it("件数をそのまま読む", () => {
		expect(parsePublicIssue(sampleResponse)?.reaction_count).toBe(4);
		expect(
			parsePublicIssue({ ...sampleResponse, reaction_count: 0 })
				?.reaction_count,
		).toBe(0);
	});

	// API がこの値を返さない（デプロイのズレ、古い API）ときに一覧ごと
	// 失敗させると、件数という付加的な情報のために画面全体が失われる。
	// `has_photo` と同じ扱いで、欠けていれば 0 として読む。
	it("欠けていれば 0 として読む（弾かない）", () => {
		const { reaction_count, ...withoutCount } = sampleResponse;
		const parsed = parsePublicIssue(withoutCount);

		expect(parsed).not.toBeNull();
		expect(parsed?.reaction_count).toBe(0);
	});

	// 描画できない値を通すと "NaN 人" のような表示になる。
	// 負の数は件数として成立しないので、来たなら想定と違うものが返っている。
	it("数値でない・有限でない・負の値は弾く", () => {
		for (const value of ["4", null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			expect(
				parsePublicIssue({ ...sampleResponse, reaction_count: value }),
				`reaction_count=${JSON.stringify(value)}`,
			).toBeNull();
		}
	});
});

describe("一覧カードの件数表示", () => {
	/** `PublicIssue` として 1 件組み立てる。 */
	function issue(count: number): PublicIssue {
		const parsed = parsePublicIssue({
			...sampleResponse,
			reaction_count: count,
		});
		if (!parsed) throw new Error("サンプルがパースできない");
		return parsed;
	}

	/** タグを落として、画面に見えるテキストだけを取り出す。 */
	function visibleText(html: string): string {
		return html.replace(/<[^>]*>/g, "");
	}

	it("件数があれば数を出す", () => {
		// これが出ないと、時系列に並んだだけの一覧から
		// 「どれが多くの人に効いているか」が読み取れない
		const text = visibleText(
			renderToStaticMarkup(<IssueCard issue={issue(7)} />),
		);

		expect(text).toContain("7");
		expect(text).toContain("困っている人");
	});

	// 0 は重みを持たないうえ、全件に「0」が並ぶと数のある行が埋もれる
	it("0 件なら何も出さない", () => {
		const text = visibleText(
			renderToStaticMarkup(<IssueCard issue={issue(0)} />),
		);

		expect(text).not.toContain("困っている人");
	});

	// 誰が押したかは出さない（#112 の決定 3）。API がそもそも返さないので
	// カードに出しようが無いが、`PublicIssue` に user_id を足す変更が
	// あったときに画面側でも気付けるようにしておく
	it("カードに反応した人の情報が出ない", () => {
		const markup = renderToStaticMarkup(<IssueCard issue={issue(3)} />);

		expect(markup).not.toContain("user_");
		expect(markup.toLowerCase()).not.toContain("user_id");
	});

	it("英語ロケールでも件数が出る", () => {
		const text = visibleText(
			renderToStaticMarkup(<IssueCard issue={issue(7)} locale="en" />),
		);

		expect(text).toContain("7");
		expect(text).toContain(getUiMessages("en").reaction.cardCount(7));
	});
});

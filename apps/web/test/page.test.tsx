// 表示言語を Cookie から読むため（Issue #82）、Server Component を直接呼ぶ
// このテストにはリクエストスコープが要る。テスト対象より先に評価させる
import "./helpers/mock-cookies";
import { describe, expect, it } from "bun:test";
import {
	DEFAULT_LOCALE,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
	IssueScope,
	IssueStatus,
} from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueCreated } from "../src/app/components/IssueCreated";
import { IssueFilterForm } from "../src/app/components/IssueFilterForm";
import {
	IssueList,
	scopeLabels,
	statusLabels,
} from "../src/app/components/IssueList";
import { IssuePagination } from "../src/app/components/IssuePagination";
import { MyIssueList } from "../src/app/components/MyIssueList";
import IssuesPage from "../src/app/issues/page";
import Home from "../src/app/page";
import {
	formatCreatedAt,
	toDateTimeTooltip,
	toIsoDateTime,
} from "../src/lib/datetime";
import {
	DEFAULT_ISSUE_FILTERS,
	type FetchIssuesResult,
	type FetchMyIssuesResult,
	type IssueFilters,
	parseIssueFilters,
	type RawSearchParams,
} from "../src/lib/issues";

const sampleIssue = {
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
} as const;

/**
 * Server Component を呼び出して静的 HTML にする。
 *
 * ページングの検証以外は limit / offset に関心が無いので、
 * 省略時は 1 ページ目（先頭 20 件）とみなす。
 */
function render(
	result:
		| (Omit<Extract<FetchIssuesResult, { ok: true }>, "limit" | "offset"> & {
				limit?: number;
				offset?: number;
		  })
		| Extract<FetchIssuesResult, { ok: false }>,
) {
	const filled: FetchIssuesResult = result.ok
		? { ...result, limit: result.limit ?? 20, offset: result.offset ?? 0 }
		: result;
	return renderToStaticMarkup(IssueList({ result: filled }));
}

describe("IssueList", () => {
	it("Issue のタイトル・スコープ・ステータス・作成日時を表示する", () => {
		const html = render({
			ok: true,
			issues: [sampleIssue],
			total: 1,
		});

		expect(html).toContain("駅前の街灯が切れている");
		// スコープとステータスは日本語ラベルで出す（詳細ページと同じ文言、Issue #59）。
		// 期待値は shared の定数から引く。ここに直書きすると、
		// ラベルを変えたときにテストだけが古い文言を守り続ける
		expect(html).toContain(ISSUE_SCOPE_LABELS[DEFAULT_LOCALE].community.label);
		expect(html).toContain(ISSUE_STATUS_LABELS[DEFAULT_LOCALE].open);
		// enum の生値がそのまま出ていないこと
		expect(html).not.toContain(">community<");
		// `dateTime` 属性ではなく、画面に見えるテキストとして日時が出ていること。
		// 属性値だけを見ると、表示から日時が消えても気付けない。
		//
		// 期待値は `formatCreatedAt` から引く（A5）。表示が相対表記になったので、
		// 文字列を直書きすると「9日前」が実行日によって変わって落ちる
		const visibleText = html.replace(/<[^>]*>/g, "");
		expect(visibleText).toContain(
			formatCreatedAt(sampleIssue.created_at, DEFAULT_LOCALE),
		);
		// 正確な時刻は `dateTime` 属性が ISO 8601 で持つ
		expect(html).toContain(
			`dateTime="${toIsoDateTime(sampleIssue.created_at)}"`,
		);
	});

	it("スコープ・ステータスの enum の生の値を画面に出さない", () => {
		// Issue #59。`municipality` / `open` がそのまま見えていた。
		// 属性値には含まれ得るので、タグを剥がした可視テキストだけを見る
		for (const scope of IssueScope.options) {
			for (const status of IssueStatus.options) {
				const html = render({
					ok: true,
					issues: [{ ...sampleIssue, scope, status }],
					total: 1,
				});
				const visibleText = html.replace(/<[^>]*>/g, "");

				expect(visibleText).not.toContain(scope);
				expect(visibleText).not.toContain(status);
			}
		}
	});

	it("全スコープ・全ステータスを shared のラベルで、この順に表示する", () => {
		const expectedScopeLabels = ISSUE_SCOPE_LABELS[DEFAULT_LOCALE];
		const expectedStatusLabels = ISSUE_STATUS_LABELS[DEFAULT_LOCALE];

		for (const scope of IssueScope.options) {
			for (const status of IssueStatus.options) {
				const html = render({
					ok: true,
					issues: [{ ...sampleIssue, scope, status }],
					total: 1,
				});
				const visibleText = html.replace(/<[^>]*>/g, "");

				/*
				 * 「含まれているか」だけを見ると、スコープとステータスを
				 * 逆の位置に出す実装を見逃す（どちらのラベルも画面には出るため）。
				 * 並び順まで固定する。
				 *
				 * #95 で区切り文字（" / "）を廃止し、ステータスをピルにして
				 * 先頭へ移した（一覧を眺めたときに進み具合が読み取れるように）。
				 * 区切り文字が消えても順序の検証は落とさないよう、
				 * 可視テキスト上の出現位置を比べる形に変えている
				 */
				const statusAt = visibleText.indexOf(expectedStatusLabels[status]);
				const scopeAt = visibleText.indexOf(expectedScopeLabels[scope].label);

				expect(statusAt, `${status} のラベルが出ていない`).toBeGreaterThan(-1);
				expect(scopeAt, `${scope} のラベルが出ていない`).toBeGreaterThan(-1);
				// ステータスが先、スコープが後
				expect(statusAt).toBeLessThan(scopeAt);
			}
		}
	});

	it("ラベルの対応表を shared から引いている（写していない）", () => {
		// ラベルを写した実装でも描画結果は同じになるため、描画では見分けられない。
		// 二重管理になると shared 側を直しても一覧だけ古いまま残る。
		// 中身の一致（toEqual）ではなく同一のオブジェクトであること（toBe）を見る
		expect(scopeLabels).toBe(ISSUE_SCOPE_LABELS[DEFAULT_LOCALE]);
		expect(statusLabels).toBe(ISSUE_STATUS_LABELS[DEFAULT_LOCALE]);
	});

	it("表示件数と総件数を取り違えずに出す", () => {
		const html = render({
			ok: true,
			issues: [sampleIssue],
			// 全 42 件のうち 1 件だけ受け取っている状況。
			// limit を総件数より大きくして、ページ分割されていない状態にする
			total: 42,
			limit: 100,
		});

		expect(html).toContain("42 件中 1 件を表示");
	});

	// 複数ページに分かれているときは、何件目を見ているかまで出す。
	// ページを送っても「N 件中 M 件」のままだと、どこにいるのか分からない
	it("複数ページに分かれているときは表示中の範囲を出す", () => {
		const html = render({
			ok: true,
			issues: [sampleIssue],
			total: 42,
			limit: 20,
			offset: 20,
		});

		expect(html).toContain("42 件中 21 〜 21 件目を表示");
	});

	// 1 ページ目とそれ以降で様式が変わると、ページを送った瞬間に
	// 表記が切り替わって見える
	it("複数ページの 1 ページ目でも範囲の様式で出す", () => {
		const html = render({
			ok: true,
			issues: [sampleIssue],
			total: 42,
			limit: 20,
			offset: 0,
		});

		expect(html).toContain("42 件中 1 〜 1 件目を表示");
	});

	it("複数件をすべて表示する", () => {
		const html = render({
			ok: true,
			issues: [
				sampleIssue,
				{
					...sampleIssue,
					id: "c5a2e9b38fda7955d1f82377881a646b",
					title: "ゴミ集積所があふれている",
				},
			],
			total: 2,
		});

		expect(html).toContain("駅前の街灯が切れている");
		expect(html).toContain("ゴミ集積所があふれている");
	});

	it("1 件も無いときは空であることを伝える文言を出す", () => {
		const html = render({ ok: true, issues: [], total: 0 });

		expect(html).toContain("まだ Issue がありません");
		// 白い画面にならないこと（何らかのテキストが出ている）
		expect(html.replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(0);
	});

	it("取得に失敗したときはエラーを伝える文言を出す", () => {
		const html = render({ ok: false, error: "接続できませんでした" });

		expect(html).toContain("Issue を取得できませんでした");
		expect(html.replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(0);
	});

	it("失敗時に「まだ Issue がありません」とは出さない（空と混同させない）", () => {
		const html = render({ ok: false, error: "接続できませんでした" });

		expect(html).not.toContain("まだ Issue がありません");
	});

	it("Issue の本文を HTML としてではなくテキストとして出す", () => {
		const html = render({
			ok: true,
			issues: [
				{
					...sampleIssue,
					title: "<script>alert(1)</script>",
					description: "<img src=x onerror=alert(1)>",
				},
			],
			total: 1,
		});

		// タグとして解釈される形では出さず、エスケープされた文字列として出す
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img ");
		expect(html).toContain("&lt;script&gt;");
	});
});

/**
 * 日時の表示（A5）。
 *
 * 基準時刻（`now`）を引数で渡してテストする。既定は「今」なので、
 * 固定しないと「9 日前」の期待値が明日には 10 日前になって落ちる。
 */
describe("formatCreatedAt", () => {
	/** 2026-08-10 03:00 UTC = JST 12:00。JST の昼を基準にする */
	const now = new Date("2026-08-10T03:00:00.000Z");

	it("1 分未満は「たった今」", () => {
		expect(formatCreatedAt("2026-08-10 02:59:30.000", "ja", now)).toBe(
			"たった今",
		);
	});

	it("1 時間未満は分で出す", () => {
		expect(formatCreatedAt("2026-08-10 02:30:00.000", "ja", now)).toBe(
			"30分前",
		);
	});

	it("同じ日のうちは時間で出す", () => {
		expect(formatCreatedAt("2026-08-10 00:00:00.000", "ja", now)).toBe(
			"3時間前",
		);
	});

	it("前日は「昨日」", () => {
		// JST の 8/9 23:00（= UTC 8/9 14:00）。経過は 13 時間だが暦日は 1 日前
		expect(formatCreatedAt("2026-08-09 14:00:00.000", "ja", now)).toBe("昨日");
	});

	it("30 日以内は日数で出す", () => {
		expect(formatCreatedAt("2026-08-01 03:00:00.000", "ja", now)).toBe("9日前");
		// 境界のすぐ内側（30 日前）も相対表記のまま
		expect(formatCreatedAt("2026-07-11 03:00:00.000", "ja", now)).toBe(
			"30日前",
		);
	});

	it("30 日を超えたら日付で出す", () => {
		// 境界のすぐ外側（31 日前）。ここから日付表記に切り替わる
		expect(formatCreatedAt("2026-07-10 03:00:00.000", "ja", now)).toBe(
			"7月10日",
		);
	});

	it("年をまたいだものには年を付ける", () => {
		expect(formatCreatedAt("2025-12-31 03:00:00.000", "ja", now)).toBe(
			"2025年12月31日",
		);
	});

	it("JST の暦日で判定する（UTC の日付でずらさない）", () => {
		// UTC では 6/30 だが JST では 7/1 の朝 8 時。日付表記は JST 側に従う
		expect(formatCreatedAt("2026-06-30 23:00:00.000", "ja", now)).toBe(
			"7月1日",
		);
	});

	it("英語ロケールでは英語で出す", () => {
		expect(formatCreatedAt("2026-08-01 03:00:00.000", "en", now)).toBe(
			"9 days ago",
		);
		expect(formatCreatedAt("2026-07-01 03:00:00.000", "en", now)).toBe(
			"July 1",
		);
	});

	it("秒精度の値（DEFAULT で入った古い行）も読める", () => {
		expect(formatCreatedAt("2026-07-01 03:00:00", "ja", now)).toBe("7月1日");
	});

	it("想定外の書式なら Invalid Date ではなく元の値を返す", () => {
		expect(formatCreatedAt("not a date", "ja", now)).toBe("not a date");
	});
});

/**
 * `<time datetime>` に入れる値（A5）。
 *
 * 表示は相対表記になったので、正確な時刻はこの属性だけが持つ。
 * API の生の値は ISO 8601 ではないため、そのまま入れてはいけない。
 */
describe("toIsoDateTime", () => {
	it("API の値を ISO 8601 に直す", () => {
		expect(toIsoDateTime("2026-08-01 12:00:00.000")).toBe(
			"2026-08-01T12:00:00.000Z",
		);
	});

	it("UTC として読む（実行環境のタイムゾーンでずらさない）", () => {
		// JST として解釈されると 03:00Z になってしまう
		expect(toIsoDateTime("2026-08-01 12:00:00")).toBe(
			"2026-08-01T12:00:00.000Z",
		);
	});

	it("解釈できない値では属性を出さない", () => {
		expect(toIsoDateTime("not a date")).toBeUndefined();
	});
});

/**
 * ツールチップに出す正確な日時（`title` 属性）。
 *
 * 表示が相対表記になったので、「9日前」が何月何日なのかを確かめる先が要る。
 * `datetime` は機械可読な値で、マウスを乗せても読めない。
 */
describe("toDateTimeTooltip", () => {
	it("JST の日時を年まで含めて出す", () => {
		// UTC 12:00 は JST 21:00。日付は跨がない
		expect(toDateTimeTooltip("2026-08-01 12:00:00.000", "ja")).toBe(
			"2026年8月1日 21:00（JST）",
		);
	});

	// 本文が今年の年を省くので、確かめる先であるここでは省いてはいけない
	it("今年の日付にも年を付ける", () => {
		expect(toDateTimeTooltip("2026-08-01 12:00:00.000", "ja")).toContain(
			"2026年",
		);
	});

	// UTC の日付のまま出すと、深夜の投稿が前日に見える
	it("JST に直してから出す（UTC の日付のまま出さない）", () => {
		// UTC では 7/31 23:00 だが、JST では 8/1 の朝 8 時
		expect(toDateTimeTooltip("2026-07-31 23:00:00.000", "ja")).toBe(
			"2026年8月1日 08:00（JST）",
		);
	});

	it("時刻を 2 桁に揃える", () => {
		// JST 09:05。「9:5」だと読めない
		expect(toDateTimeTooltip("2026-08-01 00:05:00.000", "ja")).toContain(
			"09:05",
		);
	});

	it("英語ロケールでは英語で出す", () => {
		expect(toDateTimeTooltip("2026-08-01 12:00:00.000", "en")).toBe(
			"August 1, 2026 21:00 (JST)",
		);
	});

	it("解釈できない値では属性を出さない", () => {
		expect(toDateTimeTooltip("not a date", "ja")).toBeUndefined();
	});
});

/**
 * 自分の Issue 一覧（Issue #68）。
 *
 * 「1 件も無い」「サインインが必要」「取得に失敗」を取り違えると、
 * 起票済みの人に「まだ投稿がありません」と見せることになる。
 * この 3 つの描き分けが主題。
 */
describe("MyIssueList", () => {
	const renderMine = (result: FetchMyIssuesResult) =>
		renderToStaticMarkup(MyIssueList({ result }));

	it("自分が起票した Issue を表示する", () => {
		const html = renderMine({ ok: true, issues: [sampleIssue], total: 1 });

		expect(html).toContain("駅前の街灯が切れている");
	});

	it("1 件も無いときは、まだ起票していないことを伝える", () => {
		const html = renderMine({ ok: true, issues: [], total: 0 });

		expect(html).toContain("まだ Issue を起票していません");
		// 行き止まりにしない（起票画面への導線がある）
		expect(html).toContain("/issues/new");
	});

	it("未ログインならログインを促し、取得失敗とは別の文言を出す", () => {
		const html = renderMine({
			ok: false,
			error: "ログインが必要です",
			unauthorized: true,
		});

		expect(html).toContain("ログイン");
		// 「時間をおいて再度お試しください」はサインインでは直らない案内なので出さない
		expect(html).not.toContain("時間をおいて");
	});

	it("未ログインを「まだ起票していません」と混同しない", () => {
		const html = renderMine({
			ok: false,
			error: "ログインが必要です",
			unauthorized: true,
		});

		expect(html).not.toContain("まだ Issue を起票していません");
	});

	it("取得に失敗したときはエラーを伝え、サインインの案内にはしない", () => {
		const html = renderMine({
			ok: false,
			error: "API が 500 を返しました",
			unauthorized: false,
		});

		expect(html).toContain("Issue を取得できませんでした");
		expect(html).not.toContain("まだ Issue を起票していません");
	});

	it("Issue の本文を HTML としてではなくテキストとして出す", () => {
		const html = renderMine({
			ok: true,
			issues: [
				{
					...sampleIssue,
					title: "<script>alert(1)</script>",
					description: "<img src=x onerror=alert(1)>",
				},
			],
			total: 1,
		});

		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img ");
		expect(html).toContain("&lt;script&gt;");
	});
});

/**
 * 起票完了時の導線（Issue #68 の本題）。
 *
 * 「起票しました（ID: xxx）」と ID を出すだけだと、起票者は自分の投稿を
 * 後から辿れない。完了の表示から自分の一覧へ繋がっていることを見る。
 */
describe("IssueCreated", () => {
	it("起票した ID を出す", () => {
		const html = renderToStaticMarkup(IssueCreated({ id: "abc123" }));

		expect(html).toContain("abc123");
	});

	it("自分が起票した Issue の一覧への導線を出す", () => {
		const html = renderToStaticMarkup(IssueCreated({ id: "abc123" }));

		expect(html).toContain('href="/my-issues"');
		// リンクの文言が空だと、あることに気付けない
		expect(html).toContain("自分が起票した Issue");
	});

	// 詳細画面 (#58) ができたので、今書いた 1 件へ直接向かう導線も出す。
	// 一覧へ送るだけだと、直前に自分が書いたものを探させることになる。
	it("投稿した Issue の詳細への導線を出す", () => {
		const html = renderToStaticMarkup(IssueCreated({ id: "abc123" }));

		expect(html).toContain('href="/issues/abc123"');
		const visibleText = html.replace(/<[^>]*>/g, "");
		expect(visibleText).toContain("投稿した Issue を見る");
	});
});

/**
 * トップページが実際に API を呼んで結果を描画しているかを見る。
 *
 * `fetchIssues` と `IssueList` が個別に正しくても、`page.tsx` が両者を
 * 繋いでいなければ Issue #30 の「API を一度も呼んでいない」状態に逆戻りする。
 * その結線だけは、ページを実際に描画してみないと確認できない。
 */
describe("トップページ", () => {
	/**
	 * `globalThis.fetch` を差し替えてページを描画する。呼ばれた URL を返す。
	 *
	 * トップページは 2 本投げる。一覧（`fetchIssues()`）と、
	 * 解決の実例（B5。`status=resolved` を付けた 1 件だけの取得）。
	 * 同じ `Response` を 2 回返すと 2 度目が `Body already used` で落ちるので、
	 * URL で振り分ける。`solved` を省いたときは 0 件を返す
	 * （帯が空状態になるだけで、一覧の検証には影響しない）。
	 */
	async function renderHome(response: Response, solved?: Response) {
		const originalFetch = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			calls.push(url);
			if (url.includes("status=resolved")) {
				return (
					solved ?? Response.json({ data: [], total: 0, limit: 1, offset: 0 })
				);
			}
			return response;
		}) as unknown as typeof globalThis.fetch;

		try {
			const html = renderToStaticMarkup(await Home());
			return { html, calls };
		} finally {
			globalThis.fetch = originalFetch;
		}
	}

	it("API を呼び、返ってきた Issue を描画する", async () => {
		const { html, calls } = await renderHome(
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		// API を呼んでいること（呼ばずに空を出す実装だとここで落ちる）。
		// 一覧と解決の実例（B5）で 2 本投げる
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("/issues");
		expect(
			calls.some((url) => url.includes("status=resolved")),
			"解決の実例を取りに行っていない",
		).toBe(true);
		// 返ってきた内容が実際に描画されていること
		expect(html).toContain("駅前の街灯が切れている");
		expect(html).not.toContain("まだ Issue がありません");
	});

	it("API が 0 件を返したら空の案内を出す", async () => {
		const { html } = await renderHome(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		expect(html).toContain("まだ Issue がありません");
	});

	/*
	 * 解決の実例の帯（B5）。
	 *
	 * 事例は API から取る。文言として書くと、書いた瞬間に「実在しない事例」に
	 * なる（指示書も、見本の草刈りの事例を架空だとして使用を禁じている）。
	 * 描画された事例が、返ってきた Issue そのものであることを見る。
	 */
	it("解決済みの Issue を実例として帯に出す", async () => {
		const solvedIssue = {
			...sampleIssue,
			id: "5f1c9a24b7e34d80a1f6c2d3e4b5a678",
			title: "公園のベンチが壊れていた",
			status: "resolved",
		};
		const { html } = await renderHome(
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
			Response.json({ data: [solvedIssue], total: 1, limit: 1, offset: 0 }),
		);

		expect(html).toContain("公園のベンチが壊れていた");
		// 詳細への入口になっていること
		expect(html).toContain(`/issues/${solvedIssue.id}`);
		// 空状態の文言は出さない
		expect(html).not.toContain("最初の解決を待っています");
	});

	// 解決済みがまだ 1 件も無い状態。帯を出さないのではなく、空として成立させる
	it("解決済みが無いときは帯を空状態にする", async () => {
		const { html } = await renderHome(
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
			Response.json({ data: [], total: 0, limit: 1, offset: 0 }),
		);

		expect(html).toContain("最初の解決を待っています");
		// 見出しは残す（帯そのものが消えると面のコントラストが無くなる）
		expect(html).toContain("実際に、直っています");
	});

	/*
	 * 帯の取得に失敗しても、トップページの主役である一覧は出し切る。
	 * 補助的な帯のために「取得できませんでした」を出す価値が無い
	 */
	it("実例の取得に失敗しても一覧は描く", async () => {
		const { html } = await renderHome(
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
			new Response("boom", { status: 500 }),
		);

		expect(html).toContain("駅前の街灯が切れている");
		// 失敗を帯の中で報告しない
		expect(html).not.toContain("取得できませんでした");
	});

	it("API が落ちていたらエラーの案内を出す", async () => {
		const originalError = console.error;
		console.error = () => {};
		try {
			const { html } = await renderHome(new Response("boom", { status: 500 }));

			expect(html).toContain("Issue を取得できませんでした");
			expect(html).not.toContain("まだ Issue がありません");
		} finally {
			console.error = originalError;
		}
	});
});

describe("IssueFilterForm", () => {
	function renderForm(filters: IssueFilters = DEFAULT_ISSUE_FILTERS) {
		return renderToStaticMarkup(IssueFilterForm({ filters }));
	}

	// GET フォームでなければ、送信しても URL に条件が載らない。
	// `searchParams` で状態を持つ設計そのものが成立しなくなる
	it("GET メソッドで /issues に送るフォームである", () => {
		const html = renderForm();

		expect(html).toContain('method="get"');
		expect(html).toContain('action="/issues"');
	});

	it("スコープの選択肢を表示ラベルで出す", () => {
		const html = renderForm();

		// 生の enum 値ではなく、トップページの説明と同じ日本語ラベルで出す
		expect(html).toContain('value="municipality"');
		expect(html).toContain("自治体");
		expect(html).toContain("コミュニティ");
	});

	it("ステータスの選択肢を表示ラベルで出す", () => {
		const html = renderForm();

		expect(html).toContain('value="in_progress"');
		expect(html).toContain("対応中");
	});

	it("並べ替えの選択肢を出す", () => {
		const html = renderForm();

		expect(html).toContain('value="oldest"');
		expect(html).toContain("古い順");
		expect(html).toContain("新しい順");
	});

	it("カテゴリの候補を起票フォームと同じ一覧から出す", () => {
		const html = renderForm();

		expect(html).toContain("道路・交通");
		expect(html).toContain("衛生・ごみ");
	});

	it("入力欄の name が API のクエリ名と一致している", () => {
		const html = renderForm();

		for (const name of ["q", "scope", "status", "category", "sort"]) {
			expect(html).toContain(`name="${name}"`);
		}
	});

	// フォームに offset を含めると、条件を変えたときに前のページ位置が
	// 残り「絞り込んだのに空に見える」状態になる
	it("offset をフォームに含めない（条件変更で 1 ページ目に戻る）", () => {
		const html = renderForm({ ...DEFAULT_ISSUE_FILTERS, offset: 40 });

		expect(html).not.toContain('name="offset"');
	});

	it("いま適用されている条件を入力欄の初期値として復元する", () => {
		const html = renderForm({
			scope: "national",
			status: "resolved",
			category: "道路・交通",
			q: "街灯",
			sort: "oldest",
			offset: 0,
		});

		// 再送信したときに条件が消えないこと
		expect(html).toContain('value="街灯"');
		expect(html).toMatch(/<option value="national"[^>]*selected/);
		expect(html).toMatch(/<option value="resolved"[^>]*selected/);
		expect(html).toMatch(/<option value="oldest"[^>]*selected/);
	});

	it("条件が付いているときだけ解除の導線を出す", () => {
		expect(renderForm()).not.toContain("条件をすべて解除");
		expect(renderForm({ ...DEFAULT_ISSUE_FILTERS, scope: "global" })).toContain(
			"条件をすべて解除",
		);
	});
});

describe("IssuePagination", () => {
	function renderPagination({
		filters = DEFAULT_ISSUE_FILTERS,
		total,
		limit = 20,
		offset = 0,
	}: {
		filters?: IssueFilters;
		total: number;
		limit?: number;
		offset?: number;
	}) {
		// 1 ページに収まるときは null を返す。`renderToStaticMarkup` は
		// null をそのまま受け取って空文字を返すので、そのまま渡してよい
		return renderToStaticMarkup(
			IssuePagination({ filters, total, limit, offset }),
		);
	}

	it("1 ページに収まるならページ送りを出さない", () => {
		expect(renderPagination({ total: 20, limit: 20 })).toBe("");
		expect(renderPagination({ total: 3, limit: 20 })).toBe("");
	});

	it("次のページがあればリンクを出す", () => {
		const html = renderPagination({ total: 45, limit: 20, offset: 0 });

		expect(html).toContain("次のページ");
		expect(html).toContain('href="/issues?offset=20"');
	});

	it("先頭ページでは「前のページ」をリンクにしない", () => {
		const html = renderPagination({ total: 45, limit: 20, offset: 0 });

		// リンクとして出ていたら、押しても同じページに戻るだけの導線になる
		expect(html).not.toContain('href="/issues?offset=-20"');
		expect(html).not.toMatch(/<a[^>]*>前のページ<\/a>/);
	});

	it("最終ページでは「次のページ」をリンクにしない", () => {
		const html = renderPagination({ total: 45, limit: 20, offset: 40 });

		expect(html).not.toMatch(/<a[^>]*>次のページ<\/a>/);
		expect(html).toMatch(/<a[^>]*>前のページ<\/a>/);
	});

	// 総件数が limit の倍数ちょうどのとき、最終ページの次は必ず空になる。
	// 境界の判定を 1 つずらすと、ここだけリンクが出て空ページに飛ぶ
	it("総件数が limit の倍数ちょうどでも、最終ページに「次のページ」を出さない", () => {
		const html = renderPagination({ total: 40, limit: 20, offset: 20 });

		expect(html).toContain("2 / 2 ページ");
		expect(html).not.toMatch(/<a[^>]*>次のページ<\/a>/);
		expect(html).not.toContain("offset=40");
	});

	it("倍数ちょうどの手前のページには「次のページ」を出す", () => {
		const html = renderPagination({ total: 40, limit: 20, offset: 0 });

		expect(html).toMatch(/<a[^>]*>次のページ<\/a>/);
		expect(html).toContain('href="/issues?offset=20"');
	});

	it("いま何ページ目かを出す", () => {
		const html = renderPagination({ total: 45, limit: 20, offset: 20 });

		expect(html).toContain("2 / 3 ページ");
	});

	// ページを送った瞬間に絞り込みが外れると、一覧としては使い物にならない
	it("ページ送りのリンクが絞り込み条件を引き継ぐ", () => {
		const html = renderPagination({
			filters: parseIssueFilters({
				scope: "global",
				q: "街灯",
				sort: "oldest",
			}),
			total: 45,
			limit: 20,
			offset: 0,
		});

		const href = html.match(/href="([^"]*offset=20[^"]*)"/)?.[1];
		expect(href).toBeDefined();
		const url = new URL(
			(href ?? "").replaceAll("&amp;", "&"),
			"https://x.test",
		);
		expect(url.searchParams.get("scope")).toBe("global");
		expect(url.searchParams.get("q")).toBe("街灯");
		expect(url.searchParams.get("sort")).toBe("oldest");
	});
});

/**
 * 一覧ページが searchParams を実際に読んで API に渡しているかを見る。
 *
 * `parseIssueFilters` と `fetchIssues` が個別に正しくても、`page.tsx` が
 * 両者を繋いでいなければ「フィルタ UI はあるのに何も絞られない」状態になる。
 * その結線はページを描画してみないと確認できない。
 */
describe("Issue 一覧ページ", () => {
	async function renderIssuesPage(
		searchParams: RawSearchParams,
		response: Response,
	) {
		const originalFetch = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			calls.push(typeof input === "string" ? input : input.toString());
			return response;
		}) as unknown as typeof globalThis.fetch;

		try {
			const html = renderToStaticMarkup(
				await IssuesPage({ searchParams: Promise.resolve(searchParams) }),
			);
			return { html, calls };
		} finally {
			globalThis.fetch = originalFetch;
		}
	}

	it("URL の絞り込み条件を API のクエリに渡す", async () => {
		const { calls } = await renderIssuesPage(
			{
				scope: "municipality",
				status: "open",
				category: "道路・交通",
				q: "街灯",
				sort: "oldest",
				offset: "20",
			},
			Response.json({ data: [], total: 0, limit: 20, offset: 20 }),
		);

		expect(calls).toHaveLength(1);
		const url = new URL(calls[0] ?? "");
		expect(url.searchParams.get("scope")).toBe("municipality");
		expect(url.searchParams.get("status")).toBe("open");
		expect(url.searchParams.get("category")).toBe("道路・交通");
		expect(url.searchParams.get("q")).toBe("街灯");
		expect(url.searchParams.get("sort")).toBe("oldest");
		expect(url.searchParams.get("offset")).toBe("20");
	});

	it("条件が無ければ絞り込み無しで取得する", async () => {
		const { calls, html } = await renderIssuesPage(
			{},
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		const url = new URL(calls[0] ?? "");
		expect(url.searchParams.get("scope")).toBeNull();
		expect(url.searchParams.get("q")).toBeNull();
		expect(html).toContain("駅前の街灯が切れている");
	});

	it("絞り込みフォームを表示する", async () => {
		const { html } = await renderIssuesPage(
			{},
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		expect(html).toContain("絞り込み・並べ替え");
		expect(html).toContain('name="scope"');
		expect(html).toContain('name="q"');
	});

	// 「投稿が 1 件も無い」と「条件に合わなかった」は原因も次の行動も違う
	it("絞り込みで 0 件になったときは条件のせいだと伝える", async () => {
		const { html } = await renderIssuesPage(
			{ q: "見つからない語" },
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		expect(html).toContain("条件に合う Issue はありませんでした");
		expect(html).not.toContain("まだ Issue がありません");
	});

	it("条件無しで 0 件なら、まだ投稿が無いことを伝える", async () => {
		const { html } = await renderIssuesPage(
			{},
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		expect(html).toContain("まだ Issue がありません");
		expect(html).not.toContain("条件に合う Issue はありませんでした");
	});

	it("総件数が 1 ページを超えるならページ送りを出す", async () => {
		const { html } = await renderIssuesPage(
			{},
			Response.json({ data: [sampleIssue], total: 45, limit: 20, offset: 0 }),
		);

		expect(html).toContain("次のページ");
		expect(html).toContain("1 / 3 ページ");
	});

	it("1 ページに収まるならページ送りを出さない", async () => {
		const { html } = await renderIssuesPage(
			{},
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		expect(html).not.toContain("次のページ");
	});

	it("2 ページ目では表示中の範囲を出す", async () => {
		const { html } = await renderIssuesPage(
			{ offset: "20" },
			Response.json({ data: [sampleIssue], total: 45, limit: 20, offset: 20 }),
		);

		expect(html).toContain("45 件中 21 〜 21 件目を表示");
	});

	// URL は手で編集できる。壊れた値で 500 を返さず、既定の一覧として成立させる
	it("壊れたクエリでもエラーにせず既定の一覧を出す", async () => {
		const { html, calls } = await renderIssuesPage(
			{ scope: "galactic", offset: "-1", sort: "random" },
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		const url = new URL(calls[0] ?? "");
		expect(url.searchParams.get("scope")).toBeNull();
		expect(url.searchParams.get("sort")).toBeNull();
		expect(url.searchParams.get("offset")).toBeNull();
		expect(html).toContain("駅前の街灯が切れている");
	});

	it("API が落ちていてもフォームは出す（条件を変えて再試行できる）", async () => {
		const originalError = console.error;
		console.error = () => {};
		try {
			const { html } = await renderIssuesPage(
				{ q: "街灯" },
				new Response("boom", { status: 500 }),
			);

			expect(html).toContain("Issue を取得できませんでした");
			expect(html).toContain("絞り込み・並べ替え");
		} finally {
			console.error = originalError;
		}
	});
});

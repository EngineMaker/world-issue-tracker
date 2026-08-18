/**
 * 起票時の匿名選択と、その画面表示のテスト（#88）。
 *
 * 検証したいのは 3 つの層が繋がっていること。
 *
 * 1. 起票フォームに「名前を出す」があり、**既定でチェックが入っていない**
 * 2. API のレスポンス（`is_anonymous`）が `parsePublicIssue` を素通りせず、
 *    欠けていれば匿名として読まれる
 * 3. 一覧・詳細が匿名かどうかを実際に描き分ける
 *
 * 1 だけを見ても、2 が「常に false」を返せば全員が名乗ることになる。
 * 逆に 2 だけを見ても、フォームの既定が「名前を出す」なら意味が無い。
 * どの層が抜けても匿名性は守られないので、層ごとに独立して確かめる。
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { AUTHOR_LABELS, getAuthorLabel } from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueCard } from "../src/app/components/IssueList";
import NewIssuePage from "../src/app/issues/new/page";
import { validateIssueForm } from "../src/lib/api";
import { type PublicIssue, parsePublicIssue } from "../src/lib/issues";

const ANONYMOUS_LABEL = AUTHOR_LABELS.ja.anonymous;
/** 名乗ったが Clerk に表示名が無い人の文言（#67）。匿名とは別の言葉。 */
const UNNAMED_LABEL = AUTHOR_LABELS.ja.unnamed;
/** 名乗った人の表示名として使うサンプル（#67）。 */
const DISPLAY_NAME = "花子 山田";

/** `GET /issues/:id` が返す形の 1 件分。個々のテストで必要な項目だけ上書きする。 */
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
};

describe("起票フォームの「名前を出す」", () => {
	// フォームを実際に描画して、チェックボックスの初期状態を見る。
	// `INITIAL_VALUES` を直接読むと、定数が正しくても入力欄に
	// 繋がっていない実装（`checked` を渡し忘れる等）を見逃す。
	//
	// ページは Server Component（表示言語を Cookie から読むため #82 で
	// 非同期になった）なので、呼び出しを await してから描画する
	// （`my-issues-page.test.tsx` と同じ形）。describe の直下では await
	// できないため、`beforeAll` で 1 度だけ組み立てて各 it で使い回す。
	let markup = "";
	beforeAll(async () => {
		markup = renderToStaticMarkup(await NewIssuePage());
	});

	it("チェックボックスが存在する", () => {
		expect(markup).toContain('id="show-name"');
		expect(markup).toContain('type="checkbox"');
		expect(markup).toContain("名前を出す");
	});

	// この Issue の中心。既定が「名前を出す」側に倒れると、
	// 名乗るつもりのなかった人が既定のまま名乗ってしまう。
	it("既定ではチェックが入っていない（＝匿名）", () => {
		// React は `checked={true}` のときだけ `checked` 属性を出力する。
		// チェックボックスは 1 つしか無いので、属性の有無で判定できる。
		const checkbox = markup.slice(markup.indexOf('id="show-name"'));
		const tagEnd = checkbox.indexOf(">");
		expect(checkbox.slice(0, tagEnd)).not.toContain("checked");
	});

	// チェックボックスは見た目だけでは何が起きるか分からない。
	// 「チェックしないと匿名になる」ことを文章でも伝える
	it("チェックしないと匿名になることを説明する", () => {
		expect(markup).toContain('id="show-name-hint"');
		expect(markup).toContain(ANONYMOUS_LABEL);
	});
});

describe("フォームの値を API の is_anonymous へ反転する", () => {
	const base = {
		title: "街灯",
		description: "切れている",
		scope: "community",
		latitude: "35.5",
		longitude: "139.5",
		category: "",
	};

	// 画面の「名前を出す」と API の「匿名かどうか」は逆向き。
	// 両方向を見ないと、常に true / 常に false を返す実装が通ってしまう。
	it("未チェックなら is_anonymous=true", () => {
		const result = validateIssueForm({ ...base, showName: false });
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.is_anonymous).toBe(true);
	});

	it("チェック済みなら is_anonymous=false", () => {
		const result = validateIssueForm({ ...base, showName: true });
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.is_anonymous).toBe(false);
	});
});

describe("parsePublicIssue の is_anonymous", () => {
	it("true / false をそのまま読む", () => {
		expect(parsePublicIssue(sampleResponse)?.is_anonymous).toBe(true);
		expect(
			parsePublicIssue({ ...sampleResponse, is_anonymous: false })
				?.is_anonymous,
		).toBe(false);
	});

	// API がこの値を返さない（デプロイのズレ、古い API）ときに
	// 「名乗っている」に倒すと、名乗るつもりのなかった投稿を晒す。
	// 一覧ごと失敗させる（null を返す）のも、画面から Issue が
	// 消えるだけで誰も匿名性の問題に気づけないので選ばない。
	it("欠けていれば匿名として読む（弾かない）", () => {
		const { is_anonymous, ...withoutFlag } = sampleResponse;
		const parsed = parsePublicIssue(withoutFlag);

		expect(parsed).not.toBeNull();
		expect(parsed?.is_anonymous).toBe(true);
	});

	// SQLite の 0/1 が boolean に変換されずに出てきた場合。
	// truthy 判定で読むと `0` が匿名でない扱いになり、意味がちょうど逆になる。
	// 黙って解釈するより形の不一致として弾く。
	it("boolean 以外の値は弾く", () => {
		for (const value of [0, 1, "true", "false", null]) {
			expect(
				parsePublicIssue({ ...sampleResponse, is_anonymous: value }),
				`is_anonymous=${JSON.stringify(value)}`,
			).toBeNull();
		}
	});
});

describe("一覧カードの表示", () => {
	/** `PublicIssue` として 1 件組み立てる。 */
	function issue(
		isAnonymous: boolean,
		displayName: string | null = null,
	): PublicIssue {
		const parsed = parsePublicIssue({
			...sampleResponse,
			is_anonymous: isAnonymous,
			display_name: displayName,
		});
		if (!parsed) throw new Error("サンプルがパースできない");
		return parsed;
	}

	it("匿名なら「匿名の方」と出す", () => {
		const markup = renderToStaticMarkup(<IssueCard issue={issue(true)} />);
		expect(markup).toContain(ANONYMOUS_LABEL);
		expect(markup).not.toContain(UNNAMED_LABEL);
	});

	it("匿名でなければ起票者の表示名を出す（#67）", () => {
		const markup = renderToStaticMarkup(
			<IssueCard issue={issue(false, DISPLAY_NAME)} />,
		);
		expect(markup).toContain(DISPLAY_NAME);
		expect(markup).not.toContain(ANONYMOUS_LABEL);
	});

	// 表示名が出せるようになった後も（#67）、匿名を選んだ人の名前は
	// 出ないままであること。API 側は匿名の user_id を Clerk へ渡さないので
	// 通常は表示名が届かないが、万一届いても匿名が優先される。
	// 一度表示したものは、後から匿名化しても見られた事実を消せない。
	it("匿名なら表示名が付いていても出さない", () => {
		const markup = renderToStaticMarkup(
			<IssueCard issue={issue(true, DISPLAY_NAME)} />,
		);
		expect(markup).toContain(ANONYMOUS_LABEL);
		expect(markup).not.toContain(DISPLAY_NAME);
	});

	// ラベル定義の側でも同じことを押さえる。描画のテストは JSX の
	// 組み立てを、こちらは出し分けの規則そのものを見ている。
	it("匿名のラベルは表示名を含まない", () => {
		expect(
			getAuthorLabel({ isAnonymous: true, displayName: DISPLAY_NAME }),
		).toBe(ANONYMOUS_LABEL);
		// 「匿名を選んだ」と「名乗ったが名前が無い」が別物であること
		// （同じ文字列だと出し分けが意味を失う）
		expect(ANONYMOUS_LABEL).not.toBe(UNNAMED_LABEL);
	});
});

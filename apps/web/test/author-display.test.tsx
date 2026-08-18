/**
 * 起票者とコメント投稿者の表示（#67）。
 *
 * API が返す `display_name` / `is_anonymous` を、画面がどう文言へ変えるかを見る。
 * 守りたい規則は 3 つで、いずれも 3 箇所（起票者・コメント投稿者・
 * 「手伝います」の表明者）で同じでなければならない。
 *
 * 1. 匿名を選んだ人には表示名を出さない
 * 2. 表示名が未設定・取得失敗なら、匿名とは**別の**専用の文言を出す
 * 3. 文言は ja / en の両方にある
 *
 * API 側の出し分け（そもそも Clerk へ問い合わせない等）は
 * `apps/api/test/author-display.test.ts` が見ている。
 */

import { describe, expect, it, mock } from "bun:test";
import {
	AUTHOR_LABELS,
	getAuthorLabel,
	getUiMessages,
	Locale,
} from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueCard } from "../src/app/components/IssueList";
import { type PublicComment, parsePublicComment } from "../src/lib/comments";
import { type PublicIssue, parsePublicIssue } from "../src/lib/issues";

// `CommentSection` は Client Component で `@clerk/nextjs` の `useAuth` を呼ぶ。
// 実物はブラウザの Provider を前提にしていて `renderToStaticMarkup` では
// 動かないため、フックとサインインボタンだけを差し替える
// （`help-offer-button.test.tsx` と同じ形）。
mock.module("@clerk/nextjs", () => ({
	useAuth: () => ({
		isLoaded: true,
		isSignedIn: true,
		getToken: async () => "tok_test",
	}),
	SignInButton: ({ children }: { children: React.ReactNode }) => children,
}));

// 静的 import は巻き上げられて `mock.module` より先に解決されるため、
// テスト対象は動的 import で読み込む。
const { CommentSection } = await import("../src/app/components/CommentSection");

const ANONYMOUS_LABEL = AUTHOR_LABELS.ja.anonymous;
const UNNAMED_LABEL = AUTHOR_LABELS.ja.unnamed;

/** `GET /issues/:id` が返す形の 1 件分。 */
const issueResponse = {
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
	display_name: null,
};

function issue(overrides: Record<string, unknown>): PublicIssue {
	const parsed = parsePublicIssue({ ...issueResponse, ...overrides });
	if (!parsed) throw new Error("サンプルがパースできない");
	return parsed;
}

/** `GET /issues/:id/comments` が返す形の 1 件分。 */
const commentResponse = {
	id: "c1",
	issue_id: issueResponse.id,
	body: "近所でも同じことが起きています",
	created_at: "2026-08-01 12:30:00.000",
	is_anonymous: false,
	display_name: null,
};

function comment(overrides: Record<string, unknown>): PublicComment {
	const parsed = parsePublicComment({ ...commentResponse, ...overrides });
	if (!parsed) throw new Error("サンプルがパースできない");
	return parsed;
}

function renderComments(comments: PublicComment[]): string {
	return renderToStaticMarkup(
		<CommentSection
			issueId={issueResponse.id}
			initialResult={{ ok: true, comments, total: comments.length }}
		/>,
	);
}

describe("表示ラベルの規則（getAuthorLabel）", () => {
	it("匿名を選んだ人には、表示名があっても匿名表記を出す", () => {
		// API 側で匿名の user_id は Clerk へ渡さないので通常は届かないが、
		// 万一表示名が付いて返ってきても匿名が優先されること。
		// 一度表示したものは、後から匿名化しても消せない
		expect(
			getAuthorLabel({ isAnonymous: true, displayName: "花子 山田" }),
		).toBe(ANONYMOUS_LABEL);
	});

	it("名乗っている人には表示名をそのまま出す", () => {
		expect(
			getAuthorLabel({ isAnonymous: false, displayName: "花子 山田" }),
		).toBe("花子 山田");
	});

	it("名乗ったが表示名が無い人には、匿名とは別の専用の文言を出す", () => {
		expect(getAuthorLabel({ isAnonymous: false, displayName: null })).toBe(
			UNNAMED_LABEL,
		);
		// 同じ文字列だと「匿名を選んだ」と「名乗ったが名前が無い」が
		// 区別できず、本人の意思を取り違える
		expect(UNNAMED_LABEL).not.toBe(ANONYMOUS_LABEL);
	});

	it("ja / en の両方に文言がある", () => {
		for (const locale of Locale.options) {
			const labels = AUTHOR_LABELS[locale];
			expect(labels.anonymous.length).toBeGreaterThan(0);
			expect(labels.unnamed.length).toBeGreaterThan(0);
			expect(labels.unnamed).not.toBe(labels.anonymous);

			expect(
				getAuthorLabel({ isAnonymous: true, displayName: "花子" }, locale),
			).toBe(labels.anonymous);
			expect(
				getAuthorLabel({ isAnonymous: false, displayName: null }, locale),
			).toBe(labels.unnamed);
		}
	});

	// 「手伝います」の表明者（#108）も同じ文言を使う。3 箇所で別々の
	// 文字列を持つと、同じ人が画面ごとに違う顔になる
	it("「手伝います」の表明者と同じ文言を共有している", () => {
		for (const locale of Locale.options) {
			expect(getUiMessages(locale).helpOffer.unnamedOfferer).toBe(
				AUTHOR_LABELS[locale].unnamed,
			);
		}
	});
});

describe("一覧カードの起票者", () => {
	it("匿名なら表示名を出さない", () => {
		const markup = renderToStaticMarkup(
			<IssueCard issue={issue({ is_anonymous: true, display_name: null })} />,
		);
		expect(markup).toContain(ANONYMOUS_LABEL);
		expect(markup).not.toContain(UNNAMED_LABEL);
	});

	it("名乗っていれば表示名を出す", () => {
		const markup = renderToStaticMarkup(
			<IssueCard
				issue={issue({ is_anonymous: false, display_name: "花子 山田" })}
			/>,
		);
		expect(markup).toContain("花子 山田");
		expect(markup).not.toContain(ANONYMOUS_LABEL);
	});

	it("名乗っていても表示名が無ければ専用の文言を出す", () => {
		const markup = renderToStaticMarkup(
			<IssueCard issue={issue({ is_anonymous: false, display_name: null })} />,
		);
		expect(markup).toContain(UNNAMED_LABEL);
		expect(markup).not.toContain(ANONYMOUS_LABEL);
	});
});

describe("コメントの投稿者", () => {
	it("投稿者の表示名が出る", () => {
		const markup = renderComments([comment({ display_name: "次郎 佐藤" })]);
		expect(markup).toContain("次郎 佐藤");
		// 本文と日時だけだった状態からの回帰を防ぐ
		expect(markup).toContain(commentResponse.body);
	});

	it("匿名扱いの投稿者には表示名を出さない", () => {
		const markup = renderComments([
			comment({ is_anonymous: true, display_name: null }),
		]);
		expect(markup).toContain(ANONYMOUS_LABEL);
		expect(markup).not.toContain(UNNAMED_LABEL);
	});

	it("表示名が無い投稿者には専用の文言を出す", () => {
		const markup = renderComments([comment({ display_name: null })]);
		expect(markup).toContain(UNNAMED_LABEL);
		expect(markup).not.toContain(ANONYMOUS_LABEL);
	});

	it("投稿者ごとに別の名前が出る", () => {
		const markup = renderComments([
			comment({ id: "c1", display_name: "次郎 佐藤" }),
			comment({ id: "c2", display_name: "花子 山田" }),
		]);
		expect(markup).toContain("次郎 佐藤");
		expect(markup).toContain("花子 山田");
	});
});

describe("parsePublicIssue の display_name", () => {
	it("文字列をそのまま読む", () => {
		expect(issue({ display_name: "花子 山田" }).display_name).toBe("花子 山田");
	});

	it("欠けていれば null として読む（弾かない）", () => {
		// 表示名は「あると嬉しい」情報でしかない。API 側が返さない
		// （デプロイのズレ、Clerk 障害）ときに一覧ごと消えてはいけない
		const { display_name: _omitted, ...withoutName } = issueResponse;
		const parsed = parsePublicIssue(withoutName);
		expect(parsed).not.toBeNull();
		expect(parsed?.display_name).toBeNull();
	});

	it("文字列でも null でもない値は弾く", () => {
		expect(parsePublicIssue({ ...issueResponse, display_name: 42 })).toBeNull();
	});
});

describe("parsePublicComment の display_name / is_anonymous", () => {
	it("両方をそのまま読む", () => {
		const parsed = comment({ is_anonymous: true, display_name: null });
		expect(parsed.is_anonymous).toBe(true);
		expect(parsed.display_name).toBeNull();
	});

	it("display_name が欠けていれば null として読む", () => {
		const { display_name: _omitted, ...withoutName } = commentResponse;
		const parsed = parsePublicComment(withoutName);
		expect(parsed).not.toBeNull();
		expect(parsed?.display_name).toBeNull();
	});

	// 欠けたときに倒す先が `is_anonymous` だけ逆。`parsePublicIssue` と
	// 同じく、値が無いなら安全側（名前を出さない）に倒す
	it("is_anonymous が欠けていれば匿名として読む", () => {
		const { is_anonymous: _omitted, ...withoutFlag } = commentResponse;
		const parsed = parsePublicComment(withoutFlag);
		expect(parsed).not.toBeNull();
		expect(parsed?.is_anonymous).toBe(true);
	});

	it("boolean 以外の is_anonymous は弾く", () => {
		expect(
			parsePublicComment({ ...commentResponse, is_anonymous: "yes" }),
		).toBeNull();
	});

	it("文字列でも null でもない display_name は弾く", () => {
		expect(
			parsePublicComment({ ...commentResponse, display_name: 42 }),
		).toBeNull();
	});
});

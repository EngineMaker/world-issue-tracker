/**
 * 一覧に写真のサムネイルを出すこと（Issue #125）のテスト。
 *
 * 本番の利用者から「画像がまったくないので殺風景に見える」という感想が
 * 届いた。調べると写真の機能そのものは動いていて、**一覧に出していない
 * だけ**だった（8 件中 4 件が写真を持つのに、一覧の HTML に画像が 0 個）。
 *
 * 一覧の API は `has_photo` を返しており、写真の有無を知る手段は前から
 * あった。ここで見るのは「その値を実際に使って画像を出しているか」と、
 * 出し方が一覧の読み込みを重くしていないか。
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LOCALE, getUiMessages } from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueCard, IssueList } from "../src/app/components/IssueList";
import type { FetchIssuesResult, PublicIssue } from "../src/lib/issues";
import { issuePhotoThumbnailUrl, issuePhotoUrl } from "../src/lib/issues";

const sampleIssue: PublicIssue = {
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
	has_photo: true,
	is_anonymous: true,
	display_name: null,
	reaction_count: 0,
};

const withoutPhoto: PublicIssue = { ...sampleIssue, has_photo: false };

function renderCard(issue: PublicIssue): string {
	return renderToStaticMarkup(IssueCard({ issue }));
}

function renderList(issues: PublicIssue[]): string {
	const result: FetchIssuesResult = {
		ok: true,
		issues,
		total: issues.length,
		limit: 20,
		offset: 0,
	};
	return renderToStaticMarkup(IssueList({ result }));
}

describe("一覧のカード — 写真", () => {
	it("写真を持つ Issue では画像を出す（#125 の症状そのもの）", () => {
		const html = renderCard(sampleIssue);
		expect(html).toContain("<img");
	});

	it("画像は詳細ページと同じ Issue の写真を指す", () => {
		const html = renderCard(sampleIssue);
		expect(html).toContain(issuePhotoThumbnailUrl(sampleIssue.id));
	});

	it("元画像をそのまま並べない（サムネイルの経路を使う）", () => {
		// 受け入れ条件の「一覧の読み込みが目に見えて遅くならない」。
		// 一覧は 20 件並ぶので、詳細ページ用の原寸をそのまま並べると
		// 表示 1 回で数 MB を読むことになる
		const html = renderCard(sampleIssue);
		expect(html).not.toContain(`src="${issuePhotoUrl(sampleIssue.id)}"`);
	});

	it("画面の外にある画像を先に読みに行かない", () => {
		const html = renderCard(sampleIssue);
		expect(html).toContain('loading="lazy"');
	});

	it("写真が無い Issue では画像を出さない", () => {
		expect(renderCard(withoutPhoto)).not.toContain("<img");
	});

	/*
	 * 一覧のサムネイルは `alt` を空にする（レビューで指摘）。
	 *
	 * 真下の見出しが同じタイトルを持っており、代替テキストもそのタイトルから
	 * 機械的に作った文字列でしかない。両方を読み上げると 1 件につき
	 * タイトルを 2 回読むことになり、20 件並ぶ画面では邪魔にしかならない。
	 *
	 * `alt` 属性そのものが無いのは別の意味（代替テキスト未設定）になるので、
	 * 「空の alt がある」ことまで見る。
	 */
	it("代替テキストは空にする（隣の見出しと重複させない）", () => {
		const html = renderCard(sampleIssue);
		expect(html).toContain('alt=""');
		expect(html).not.toContain(
			getUiMessages(DEFAULT_LOCALE).issueDetail.photoAlt(sampleIssue.title),
		);
	});

	// 詳細ページ側は逆に、写真が主役なので代替テキストを名乗ったまま。
	// 一覧の都合で両方とも空にしてしまっていないことを確かめる
	it("詳細ページの代替テキストは空にしていない", () => {
		const messages = getUiMessages(DEFAULT_LOCALE);
		expect(messages.issueDetail.photoAlt(sampleIssue.title)).not.toBe("");
	});

	it("写真のある Issue と無い Issue が混ざっても、画像は写真のある分だけ", () => {
		const html = renderList([
			sampleIssue,
			{ ...withoutPhoto, id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
			{ ...sampleIssue, id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
		]);
		expect(html.match(/<img/g)?.length).toBe(2);
	});
});

/**
 * カードのレイアウト（#125）。
 *
 * 写真を左、文章を右に並べる指定が消えても描画結果の HTML は変わらない
 * ので、DOM を見るテストでは検出できない（レビューで指摘）。CSS の宣言を
 * 直接見る。ここが消えると、写真が文章の上に積まれて 1 件が画面を
 * 占領するか、長い URL で一覧全体に横スクロールが出る。
 */
describe("一覧のカードのレイアウト（CSS）", () => {
	const css = readFileSync(
		join(import.meta.dir, "../src/app/globals.css"),
		"utf8",
	);
	/** ブロックコメントを外す。コメント中の記述を宣言と取り違えないため */
	const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

	/** セレクタに対応する宣言ブロックをすべて集める */
	function rulesFor(selector: string): string {
		const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(
			`(?:^|[{},])\\s*((?:[^{}]*?,\\s*)?${escaped}\\s*(?:,[^{}]*?)?)\\{([^}]*)\\}`,
			"g",
		);
		return [...cssWithoutComments.matchAll(pattern)]
			.map((match) => match[2])
			.join("\n");
	}

	it("写真と文章を横に並べる", () => {
		expect(rulesFor(".issue-card")).toMatch(/display\s*:\s*flex/);
	});

	it("写真は縮まない（潰れた画像は情報を失う）", () => {
		expect(rulesFor(".issue-card-photo")).toMatch(/flex\s*:\s*none/);
	});

	it("写真の枠は縦横比によらず一定（タイトルの開始位置が揃う）", () => {
		const rules = rulesFor(".issue-card-photo");
		expect(rules).toMatch(/object-fit\s*:\s*cover/);
		expect(rules).toMatch(/width\s*:/);
		expect(rules).toMatch(/height\s*:/);
	});

	/*
	 * flex の子は既定で内容より縮まない。説明文に折り返せない長い URL が
	 * 入ると文章側の列が押し広げられ、一覧全体に横スクロールが出る
	 * （`body` の overflow-wrap は折り返しの許可であって、
	 * flex の最小幅までは変えない）
	 */
	it("文章側が長い URL で押し広げられない", () => {
		expect(rulesFor(".issue-card-body")).toMatch(/min-width\s*:\s*0/);
	});
});

/**
 * 起票フォームがサムネイルを作って送っているか（#125）。
 *
 * `createThumbnailFile` は `createImageBitmap` と `<canvas>` に依存し、
 * bun のテスト環境には無い（`photo.test.tsx` 冒頭の説明と同じ事情）。
 * 呼び出しごと消しても描画結果は変わらないため、ソースの形で見る
 * （`web-issue-form-guidance.test.ts` と同じ手）。
 *
 * ここが無いと、フォームがサムネイルを作らなくなっても、送らなくなっても
 * テストは全部通る（レビューで実際に確認された穴）。そうなると一覧は
 * 全件が原寸へのフォールバックになり、受け入れ条件が黙って壊れる。
 */
describe("起票フォーム — サムネイルの生成", () => {
	const source = readFileSync(
		join(import.meta.dir, "../src/app/components/NewIssueForm.tsx"),
		"utf8",
	);
	/** コメントを落とす。「コメントに書いただけ」で通らないようにする */
	const body = source
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");

	/*
	 * 名前が出てくるだけでは足りない。import に残っていれば通ってしまい、
	 * 呼び出しを消した変異体を検出できなかった。呼び出しの形まで見る
	 */
	it("縮小した写真からサムネイルを作る", () => {
		expect(body).toMatch(/createThumbnailFile\(/);
	});

	it("作ったサムネイルを createIssue に渡す", () => {
		expect(body).toMatch(/createIssue\([\s\S]*?thumbnail[\s\S]*?\)/);
	});
});

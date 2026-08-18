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

	it("代替テキストにタイトルを含める", () => {
		const messages = getUiMessages(DEFAULT_LOCALE);
		const html = renderCard(sampleIssue);
		expect(html).toContain(messages.issueDetail.photoAlt(sampleIssue.title));
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

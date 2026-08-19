import { getUiMessages } from "@world-issue-tracker/shared";
import Link from "next/link";
import { getLocale } from "../lib/locale";

/**
 * 見つからないページ（404）の受け皿（Issue #145）。
 *
 * このファイルが無いと、Next.js は英語・無装飾・戻り導線なしの既定 404
 * （"This page could not be found."）を出す。他の画面が metadata・
 * `html lang`・全 UI 文言まで ja/en を出し分けているのに、404 だけが
 * 英語のまま行き止まりになるのを防ぐ。
 *
 * このパスは実際に踏まれる:
 * - 共有した Issue の URL（`/issues/<id>`）が、渡した後に削除される
 *   （詳細ページが `notFound()` を呼ぶ経路が実在する）。
 * - URL の打ち間違い・古いブックマーク・未定義パス（`/foo` 等）。
 *
 * 詳細ページの「取得失敗」時（`issues/[id]/page.tsx`）と同じく、Server
 * Component として Cookie からロケールを読む（`getLocale`）。ここは Next.js
 * が例外境界として描くため、レイアウト（`layout.tsx`）の中に入り、ヘッダは
 * 親レイアウトが出す。ここでは本文と導線だけを出す。
 *
 * 「消えた」と断定しすぎない。削除されたのか URL 違いなのかはこちらでは
 * 区別できないので、両方の可能性を伝えて、次に行ける場所を並べる。
 */
export default async function NotFound() {
	const locale = await getLocale();
	const messages = getUiMessages(locale);

	return (
		<main>
			<h1>{messages.notFound.heading}</h1>
			{/*
			  失敗の赤（.error-block）ではなく、案内の .notice-block を使う。
			  ページが無いのはシステム障害ではなく、利用者は一覧やトップから
			  やり直せる。赤で出すと「何か壊れた」と過度に身構えさせる
			*/}
			<div className="notice-block">
				<p className="block-message">{messages.notFound.body}</p>
			</div>
			{/* 行き止まりにしない。一覧・起票・トップの 3 つへ逃がす */}
			<p className="page-nav">
				<Link href="/issues">{messages.notFound.browseIssues}</Link>
				<Link href="/issues/new">{messages.notFound.writeIssue}</Link>
				<Link href="/">{messages.notFound.backToHome}</Link>
			</p>
		</main>
	);
}

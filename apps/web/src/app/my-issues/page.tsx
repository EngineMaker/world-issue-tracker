import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { fetchMyIssues } from "../../lib/issues";
import { MyIssueList } from "../components/MyIssueList";

/**
 * 自分が起票した Issue の一覧ページ（Issue #68）。
 *
 * 他の一覧と同じく Server Component として取得する（理由は app/page.tsx）。
 * ただしこちらは認証が要るため、Clerk のセッショントークンを
 * `auth().getToken()` で取り出して `Authorization: Bearer` で API へ渡す。
 * Web と API は別オリジンなので、Clerk の Cookie は API へ届かない。
 *
 * 未サインインでもページ自体は 200 で返し、サインインを促す文言を出す。
 * リダイレクトで弾くと、ヘッダのリンクを押した人が何の画面なのか分からないまま
 * サインインを求められることになる。
 */
export default async function MyIssuesPage() {
	// `auth()` はリクエストごとに評価されるため、このページは動的レンダリングになる。
	// 一覧の内容が利用者ごとに違う以上、静的化してはいけない画面でもある。
	const { getToken } = await auth();
	const result = await fetchMyIssues({ token: await getToken() });

	return (
		<main>
			<h1>自分が起票した Issue</h1>
			<MyIssueList result={result} />
			<p>
				<Link href="/issues/new">Issue を書く</Link>
				{" / "}
				<Link href="/issues">すべての Issue を見る</Link>
				{" / "}
				<Link href="/">トップへ戻る</Link>
			</p>
		</main>
	);
}

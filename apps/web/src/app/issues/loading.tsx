import { getUiMessages } from "@world-issue-tracker/shared";
import { getLocale } from "../../lib/locale";
import { LoadingState } from "../components/LoadingState";

/**
 * Issue 一覧の読み込み中フォールバック（Issue #146）。
 *
 * 絞り込み・並べ替え・ページ送りはいずれも `/issues` への遷移で、その都度
 * API を叩いてから描画される。`loading.tsx` が無いと、押しても遷移先の RSC が
 * 届くまで画面が前のまま無反応になる。ここで見出しと「読み込み中…」を即座に
 * 出し、押した手応えを返す。
 *
 * 見出しは本体（`page.tsx`）と同じものを使う。骨格が保たれたまま中身だけが
 * フォールバックに切り替わるので、遷移していることが分かりやすい。表示言語は
 * 本体と同じく Cookie から読む（#82）。
 */
export default async function IssuesLoading() {
	const locale = await getLocale();
	const messages = getUiMessages(locale);

	return (
		<main>
			<h1>{messages.issuesPage.heading}</h1>
			<LoadingState message={messages.common.loading} />
		</main>
	);
}

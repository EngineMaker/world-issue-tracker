import { getUiMessages } from "@world-issue-tracker/shared";
import { getLocale } from "../../lib/locale";
import { LoadingState } from "../components/LoadingState";

/**
 * 自分の Issue 一覧の読み込み中フォールバック（Issue #146）。
 *
 * このページは `auth()` でトークンを取り出してから API を叩く（`page.tsx`）。
 * `loading.tsx` が無いと、ヘッダのリンクを押しても遷移先が届くまで画面が
 * 前のまま無反応になる。見出しと「読み込み中…」を即座に出して手応えを返す。
 *
 * 見出しは本体と同じものを使い、骨格を保つ。表示言語は Cookie から読む（#82）。
 */
export default async function MyIssuesLoading() {
	const locale = await getLocale();
	const messages = getUiMessages(locale);

	return (
		<main>
			<h1>{messages.myIssuesPage.heading}</h1>
			<LoadingState message={messages.common.loading} />
		</main>
	);
}

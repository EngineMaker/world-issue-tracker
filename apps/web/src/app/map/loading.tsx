import { getUiMessages } from "@world-issue-tracker/shared";
import { getLocale } from "../../lib/locale";
import { LoadingState } from "../components/LoadingState";

/**
 * 地図ダッシュボードの読み込み中フォールバック（Issue #146）。
 *
 * 地図は最大 100 件を取得してから描画する（`page.tsx`）。絞り込みやパン・
 * ズームの操作はすべて `/map` への遷移で、その都度 API を叩く。`loading.tsx`
 * が無いと押しても画面が前のまま無反応になるので、見出しと「読み込み中…」を
 * 即座に出す。
 *
 * 見出しと導入文は本体と同じものを使い、骨格を保つ。表示言語は Cookie から
 * 読む（#82）。
 */
export default async function MapLoading() {
	const locale = await getLocale();
	const messages = getUiMessages(locale);

	return (
		<main>
			<h1>{messages.mapPage.heading}</h1>
			<p className="section-lead">{messages.mapPage.lead}</p>
			<LoadingState message={messages.common.loading} />
		</main>
	);
}

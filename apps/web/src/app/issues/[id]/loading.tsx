import { getUiMessages } from "@world-issue-tracker/shared";
import { getLocale } from "../../../lib/locale";
import { LoadingState } from "../../components/LoadingState";

/**
 * Issue 詳細の読み込み中フォールバック（Issue #146）。
 *
 * 詳細ページは本体・コメント・手伝い・反応の 4 本の fetch を待ってから
 * 描画する（`page.tsx`）。遅い回線やコールドスタートでは、この待ち時間に
 * `loading.tsx` が無いと画面が前のまま無反応になり、二度押しや離脱を招く。
 *
 * 一覧と違い、遷移した時点では Issue のタイトルが分からないため、本体の
 * 見出しを流用できない。汎用の見出し（`loadingHeading`）で「Issue を
 * 開いている」ことを示す。表示言語は Cookie から読む（#82）。
 */
export default async function IssueDetailLoading() {
	const locale = await getLocale();
	const messages = getUiMessages(locale);

	return (
		<main>
			<h1>{messages.issueDetail.loadingHeading}</h1>
			<LoadingState message={messages.common.loading} />
		</main>
	);
}

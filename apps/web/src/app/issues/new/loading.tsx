import { getUiMessages } from "@world-issue-tracker/shared";
import { getLocale } from "../../../lib/locale";
import { LoadingState } from "../../components/LoadingState";

/**
 * 起票ページの読み込み中フォールバック（Issue #146）。
 *
 * このページ自体は fetch を持たず（`getLocale()` のみ）体感遅延は小さいが、
 * `loading.tsx` を置く理由は別にある。親の `issues/loading.tsx`（見出し
 * 「Issue 一覧」）は Next.js の伝播で `/issues/new` にも降るため、置かないと
 * 起票ページへの遷移中に「Issue 一覧」という誤った見出しが一瞬出る。より近い
 * 境界としてここで上書きし、本体（`NewIssueForm`）と同じ見出しを出す。
 */
export default async function NewIssueLoading() {
	const locale = await getLocale();
	const messages = getUiMessages(locale);

	return (
		<main>
			<h1>{messages.newIssue.heading}</h1>
			<LoadingState message={messages.common.loading} />
		</main>
	);
}

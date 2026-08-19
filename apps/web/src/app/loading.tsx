import { getUiMessages } from "@world-issue-tracker/shared";
import { getLocale } from "../lib/locale";
import { LoadingState } from "./components/LoadingState";

/**
 * ルート全体の読み込み中フォールバック（Issue #146）。
 *
 * app 直下の `loading.tsx` なので、**個別の `loading.tsx` を持たないすべての
 * ルートの既定フォールバック**になる（トップ `/`、`design-direction` など）。
 * トップページは一覧と解決の実例で `fetchIssues()` を 2 本待つため、ここが
 * 無いと遷移時に「押しても何も起きない」がそのまま起きる。
 *
 * サブツリー全体へ降る性質上、特定ページの見出しは持たせない。トップの見出しを
 * 入れると、他のルートのフォールバックにまでトップの見出しが出てしまう。見出しを
 * 出したい個別ルート（issues / issues/[id] / issues/new / map / my-issues）は、
 * それぞれの `loading.tsx` がより近い境界として上書きする。
 */
export default async function RootLoading() {
	const locale = await getLocale();
	const messages = getUiMessages(locale);

	return (
		<main>
			<LoadingState message={messages.common.loading} />
		</main>
	);
}

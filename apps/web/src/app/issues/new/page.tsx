import { getLocale } from "../../../lib/locale";
import { NewIssueForm } from "../../components/NewIssueForm";

/**
 * 起票ページ。
 *
 * フォームの本体は `NewIssueForm`（Client Component）にある。Clerk の hooks と
 * 入力の state が要るため。このページを Server Component として残しているのは、
 * 表示言語（Cookie）を読むため（Issue #82）。`cookies()` は Server Component
 * 側の API なので、Client Component からは読めない。
 */
export default async function NewIssuePage() {
	return <NewIssueForm locale={await getLocale()} />;
}

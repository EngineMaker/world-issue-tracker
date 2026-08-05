import type { FetchIssuesResult, PublicIssue } from "../../lib/issues";

/**
 * API が返す `created_at` を表示用の文字列にする。
 *
 * 値は SQLite の `strftime('%Y-%m-%d %H:%M:%f', 'now')`（UTC、`apps/api/src/routes/issues.ts`）
 * で、タイムゾーン指定が付いていない。そのまま `new Date()` に渡すと処理系によって
 * ローカル時刻と解釈され 9 時間ずれるため、`T` と `Z` を補って明示的に UTC として読む。
 *
 * 表示は UTC 固定にしている。サーバーとブラウザでタイムゾーンが違うと
 * ハイドレーション時に文言が食い違うため、Server Component 側で決め切る。
 */
export function formatCreatedAt(createdAt: string): string {
	const date = new Date(`${createdAt.replace(" ", "T")}Z`);
	if (Number.isNaN(date.getTime())) {
		// 想定外の書式でも「Invalid Date」を出さない
		return createdAt;
	}
	return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function IssueCard({ issue }: { issue: PublicIssue }) {
	return (
		<li
			style={{
				border: "1px solid #eee",
				borderRadius: "6px",
				padding: "0.75rem 1rem",
				marginBottom: "0.75rem",
				listStyle: "none",
			}}
		>
			<h3 style={{ margin: "0 0 0.25rem", fontSize: "1rem" }}>{issue.title}</h3>
			<p style={{ margin: "0 0 0.5rem", color: "#444" }}>{issue.description}</p>
			<p style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}>
				<span>{issue.scope}</span>
				{" / "}
				<span>{issue.status}</span>
				{issue.category ? (
					<>
						{" / "}
						<span>{issue.category}</span>
					</>
				) : null}
				{" / "}
				<time dateTime={issue.created_at}>
					{formatCreatedAt(issue.created_at)}
				</time>
			</p>
		</li>
	);
}

/**
 * Issue 一覧を描画する。
 *
 * 取得結果を props で受け取り、成功・0 件・失敗の 3 状態をすべて描き分ける。
 * 取得そのものは呼び出し側（`page.tsx`）が行う。
 */
export function IssueList({ result }: { result: FetchIssuesResult }) {
	if (!result.ok) {
		return (
			<div style={{ color: "#b00", padding: "0.5rem 0" }}>
				<p style={{ margin: "0 0 0.25rem" }}>
					Issue を取得できませんでした。時間をおいて再度お試しください。
				</p>
				<p style={{ margin: 0, fontSize: "0.85rem" }}>{result.error}</p>
			</div>
		);
	}

	if (result.issues.length === 0) {
		return (
			<p style={{ color: "#666" }}>
				まだ Issue がありません。最初の 1 件を起票してみてください。
			</p>
		);
	}

	// 複数ページに分かれているときは「N 件中 M 件」だけではどこを見ているのか
	// 分からないため、範囲（何件目から何件目か）を出す。
	//
	// 判定は `offset > 0` ではなく `total > limit` にしている。前者だと
	// 1 ページ目だけ様式が変わり、ページを送った瞬間に表記が切り替わって見える。
	// ページが 1 つしか無いときは範囲を出しても情報が増えないので、件数だけにする。
	const isPaged = result.total > result.limit;
	const from = result.offset + 1;
	const to = result.offset + result.issues.length;

	return (
		<>
			<p style={{ color: "#666", fontSize: "0.85rem" }}>
				{isPaged
					? `${result.total} 件中 ${from} 〜 ${to} 件目を表示`
					: `${result.total} 件中 ${result.issues.length} 件を表示`}
			</p>
			<ul style={{ padding: 0, margin: 0 }}>
				{result.issues.map((issue) => (
					<IssueCard key={issue.id} issue={issue} />
				))}
			</ul>
		</>
	);
}

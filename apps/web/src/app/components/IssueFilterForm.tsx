import {
	DEFAULT_LOCALE,
	getUiMessages,
	ISSUE_SCOPE_LABELS,
	ISSUE_SEARCH_MAX_LENGTH,
	ISSUE_SORT_LABELS,
	ISSUE_STATUS_LABELS,
	IssueScope,
	IssueSort,
	IssueStatus,
	type Locale,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { ISSUE_CATEGORY_SUGGESTIONS } from "../../lib/api";
import { hasActiveFilters, type IssueFilters } from "../../lib/issues";

/**
 * 一覧の絞り込み・並べ替えフォーム。
 *
 * `method="get"` の素の HTML フォームにしている。送信するとブラウザが
 * 入力値をクエリ文字列に組み立てて `/issues` へ遷移するので、
 * Client Component にせずに（＝JS 無効でも）絞り込みが成立する。
 * ページ側は `searchParams` を読むだけで済む。
 *
 * `offset` の入力欄は置いていない。条件を変えたら 1 ページ目に戻るのが
 * 期待される挙動で、フォームに含めると「3 ページ目のまま条件だけ変わって
 * 空に見える」状態を作ってしまうため。ページ送りは `IssuePagination` が
 * リンクとして受け持つ。
 *
 * 空の選択肢（「すべて」）は `value=""` にしてある。ブラウザは値が空の
 * コントロールもクエリに載せる（`?scope=`）が、API 側は空文字を
 * 未指定として扱う（`q`）か、そもそもこちらで落としてから送る
 * （`parseIssueFilters`）ので、絞り込み無しとして成立する。
 */
export function IssueFilterForm({
	filters,
	locale = DEFAULT_LOCALE,
}: {
	filters: IssueFilters;
	locale?: Locale;
}) {
	const messages = getUiMessages(locale);
	const scopeLabels = ISSUE_SCOPE_LABELS[locale];
	const statusLabels = ISSUE_STATUS_LABELS[locale];
	const sortLabels = ISSUE_SORT_LABELS[locale];

	return (
		/*
		 * `issue-form` は起票フォーム専用の見た目ではなく、入力要素の
		 * スタイルを閉じ込めるスコープとして機能している（#86）。
		 * 素の要素セレクタ（`input { ... }`）は Clerk のモーダルにも当たるため、
		 * 入力要素の指定はすべて `.issue-form` の子孫に置かれている。
		 * つまりこのクラスが無いと、中の input と select にスタイルが
		 * 1 つも当たらない（#93 のコメント欄と同じ症状が、直された後も
		 * この画面に残っていた）。
		 */
		<form method="get" action="/issues" className="issue-form issue-filters">
			<fieldset>
				<legend>{messages.filterForm.legend}</legend>

				<p className="form-field">
					<label htmlFor="filter-q" className="field-label">
						{messages.filterForm.keyword}
					</label>
					<span className="field-hint" id="filter-q-hint">
						{messages.filterForm.keywordHint}
					</span>
					<input
						id="filter-q"
						type="search"
						name="q"
						defaultValue={filters.q ?? ""}
						maxLength={ISSUE_SEARCH_MAX_LENGTH}
						placeholder={messages.filterForm.keywordPlaceholder}
						aria-describedby="filter-q-hint"
					/>
				</p>

				<p className="form-field">
					<label htmlFor="filter-scope" className="field-label">
						{messages.filterForm.scope}
					</label>
					<span className="field-hint" id="filter-scope-hint">
						{messages.filterForm.scopeHint}
					</span>
					<select
						id="filter-scope"
						name="scope"
						defaultValue={filters.scope ?? ""}
						aria-describedby="filter-scope-hint"
					>
						<option value="">{messages.filterForm.all}</option>
						{IssueScope.options.map((scope) => (
							<option key={scope} value={scope}>
								{scopeLabels[scope].label}
							</option>
						))}
					</select>
				</p>

				<p className="form-field">
					<label htmlFor="filter-status" className="field-label">
						{messages.filterForm.status}
					</label>
					<span className="field-hint" id="filter-status-hint">
						{messages.filterForm.statusHint}
					</span>
					<select
						id="filter-status"
						name="status"
						defaultValue={filters.status ?? ""}
						aria-describedby="filter-status-hint"
					>
						<option value="">{messages.filterForm.all}</option>
						{IssueStatus.options.map((status) => (
							<option key={status} value={status}>
								{statusLabels[status]}
							</option>
						))}
					</select>
				</p>

				<p className="form-field">
					<label htmlFor="filter-category" className="field-label">
						{messages.filterForm.category}
					</label>
					<span className="field-hint" id="filter-category-hint">
						{messages.filterForm.categoryHint}
					</span>
					{/*
					  起票フォームと同じ `<datalist>` を使う。候補に無いカテゴリで
					  起票された Issue も探せるよう、自由入力は残す。

					  候補そのものは翻訳していない。API に保存されているカテゴリは
					  起票時の文字列そのままで、完全一致で絞り込むため。訳した候補を
					  出すと、選んでも 1 件も引っかからない検索になる（Issue #82 の
					  範囲外として PR に記載）
					*/}
					<input
						id="filter-category"
						type="text"
						name="category"
						defaultValue={filters.category ?? ""}
						maxLength={100}
						list="filter-category-suggestions"
						placeholder={messages.filterForm.categoryPlaceholder}
						aria-describedby="filter-category-hint"
					/>
					<datalist id="filter-category-suggestions">
						{ISSUE_CATEGORY_SUGGESTIONS.map((suggestion) => (
							<option key={suggestion} value={suggestion} />
						))}
					</datalist>
				</p>

				<p className="form-field">
					<label htmlFor="filter-sort" className="field-label">
						{messages.filterForm.sort}
					</label>
					<span className="field-hint" id="filter-sort-hint">
						{messages.filterForm.sortHint}
					</span>
					<select
						id="filter-sort"
						name="sort"
						defaultValue={filters.sort}
						aria-describedby="filter-sort-hint"
					>
						{IssueSort.options.map((sort) => (
							<option key={sort} value={sort}>
								{sortLabels[sort]}
							</option>
						))}
					</select>
				</p>

				<p>
					<button type="submit" className="button-primary">
						{messages.filterForm.submit}
					</button>
					{/*
					  条件が付いているときだけ解除の導線を出す。
					  素のリンクなので、フォームの入力状態に関係なく
					  「条件なしの一覧」へ戻れる
					*/}
					{hasActiveFilters(filters) ? (
						<>
							{" "}
							<Link href="/issues">{messages.filterForm.clear}</Link>
						</>
					) : null}
				</p>
			</fieldset>
		</form>
	);
}

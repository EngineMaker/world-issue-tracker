import {
	DEFAULT_LOCALE,
	ISSUE_SCOPE_LABELS,
	ISSUE_SEARCH_MAX_LENGTH,
	ISSUE_SORT_LABELS,
	ISSUE_STATUS_LABELS,
	IssueScope,
	IssueSort,
	IssueStatus,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { ISSUE_CATEGORY_SUGGESTIONS } from "../../lib/api";
import { hasActiveFilters, type IssueFilters } from "../../lib/issues";

const SCOPE_LABELS = ISSUE_SCOPE_LABELS[DEFAULT_LOCALE];
const STATUS_LABELS = ISSUE_STATUS_LABELS[DEFAULT_LOCALE];
const SORT_LABELS = ISSUE_SORT_LABELS[DEFAULT_LOCALE];

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
export function IssueFilterForm({ filters }: { filters: IssueFilters }) {
	return (
		<form method="get" action="/issues" className="issue-filters">
			<fieldset>
				<legend>絞り込み・並べ替え</legend>

				<p className="form-field">
					<label htmlFor="filter-q" className="field-label">
						キーワード
					</label>
					<span className="field-hint" id="filter-q-hint">
						タイトルと説明から探します。
					</span>
					<input
						id="filter-q"
						type="search"
						name="q"
						defaultValue={filters.q ?? ""}
						maxLength={ISSUE_SEARCH_MAX_LENGTH}
						placeholder="例: 街灯"
						aria-describedby="filter-q-hint"
					/>
				</p>

				<p className="form-field">
					<label htmlFor="filter-scope" className="field-label">
						スコープ
					</label>
					<span className="field-hint" id="filter-scope-hint">
						どこまで広がる課題かで絞ります。
					</span>
					<select
						id="filter-scope"
						name="scope"
						defaultValue={filters.scope ?? ""}
						aria-describedby="filter-scope-hint"
					>
						<option value="">すべて</option>
						{IssueScope.options.map((scope) => (
							<option key={scope} value={scope}>
								{SCOPE_LABELS[scope].label}
							</option>
						))}
					</select>
				</p>

				<p className="form-field">
					<label htmlFor="filter-status" className="field-label">
						ステータス
					</label>
					<span className="field-hint" id="filter-status-hint">
						解決の進み具合で絞ります。
					</span>
					<select
						id="filter-status"
						name="status"
						defaultValue={filters.status ?? ""}
						aria-describedby="filter-status-hint"
					>
						<option value="">すべて</option>
						{IssueStatus.options.map((status) => (
							<option key={status} value={status}>
								{STATUS_LABELS[status]}
							</option>
						))}
					</select>
				</p>

				<p className="form-field">
					<label htmlFor="filter-category" className="field-label">
						カテゴリ
					</label>
					<span className="field-hint" id="filter-category-hint">
						起票時と同じ表記で完全一致します。候補から選ぶと確実です。
					</span>
					{/*
					  起票フォームと同じ `<datalist>` を使う。候補に無いカテゴリで
					  起票された Issue も探せるよう、自由入力は残す
					*/}
					<input
						id="filter-category"
						type="text"
						name="category"
						defaultValue={filters.category ?? ""}
						maxLength={100}
						list="filter-category-suggestions"
						placeholder="例: 道路・交通"
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
						並べ替え
					</label>
					<span className="field-hint" id="filter-sort-hint">
						投稿された日時の順に並べます。
					</span>
					<select
						id="filter-sort"
						name="sort"
						defaultValue={filters.sort}
						aria-describedby="filter-sort-hint"
					>
						{IssueSort.options.map((sort) => (
							<option key={sort} value={sort}>
								{SORT_LABELS[sort]}
							</option>
						))}
					</select>
				</p>

				<p>
					<button type="submit" className="button-primary">
						絞り込む
					</button>
					{/*
					  条件が付いているときだけ解除の導線を出す。
					  素のリンクなので、フォームの入力状態に関係なく
					  「条件なしの一覧」へ戻れる
					*/}
					{hasActiveFilters(filters) ? (
						<>
							{" "}
							<Link href="/issues">条件をすべて解除</Link>
						</>
					) : null}
				</p>
			</fieldset>
		</form>
	);
}

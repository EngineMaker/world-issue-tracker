import { DEFAULT_LOCALE, type Locale } from "@world-issue-tracker/shared";

/**
 * 日時の表示（A5）。
 *
 * 以前は `2026-08-17 15:51 UTC` をそのまま出していた。記録としては正確だが、
 * 読む側は「それが今からどれくらい前か」を毎回頭の中で計算することになる。
 * しかも基準が UTC なので、日本から読むと日付が 1 日ずれて見えることがある
 * （深夜の投稿が前日の日付で出る）。
 *
 * ここでは表示を JST の相対表記（「昨日」「9 日前」「8月2日」）にする。
 * 機械可読な値は `<time datetime>` に ISO 8601 で残すので、正確な時刻は
 * 失われない（人が読む文字列と、機械が読む属性を分ける）。
 */

/** 日本標準時のオフセット（UTC+9）。ミリ秒 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * 相対表記をやめて日付表記に切り替える境界（日）。
 *
 * 30 日にしているのは GitHub に合わせたため。`relative-time` 要素の既定の
 * しきい値が `P30D`（30 日）で、これを超えると絶対日付に切り替わる。
 * この値は実装・README・テストのいずれにも書かれていて確認できる
 * （github/relative-time-element、Primer のガイドラインも同じ）。
 *
 * 「7 日が一般的」という説をよく見かけるが、一次情報が見つからない。
 * 実際の各社は 24 時間（X）から 30 日（GitHub）まで幅があり、
 * 統一された基準というものは存在しない。
 *
 * その中で 30 日を選ぶ理由は、このサービスが Issue Tracker であること。
 * 同じ「Issue の一覧を眺めて日時を読む」経験を既に GitHub で積んでいる
 * 人が多く、そこと挙動を揃えるのが読み手にとって一番驚きが少ない。
 *
 * これより古いものは日付で出す。「45 日前」と言われても、それが何月なのかは
 * 結局分からず、読む側が指を折って数えることになる。
 */
const RELATIVE_LIMIT_DAYS = 30;

/**
 * API が返す日時文字列を `Date` にする。
 *
 * 値は SQLite の `strftime('%Y-%m-%d %H:%M:%f', 'now')`（UTC、
 * `apps/api/src/routes/issues.ts`）で、タイムゾーン指定が付いていない。
 * そのまま `new Date()` に渡すと処理系によってはローカル時刻と解釈され
 * 9 時間ずれるため、`T` と `Z` を補って明示的に UTC として読む。
 *
 * 解釈できない値では `null` を返す。呼び出し側が「Invalid Date」を
 * 画面に出さずに済むようにするため。
 */
export function parseApiDate(value: string): Date | null {
	const date = new Date(`${value.replace(" ", "T")}Z`);
	return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * `<time datetime>` に入れる値（ISO 8601）。
 *
 * API の生の値（`2026-08-17 15:51:00.000`）は空白区切りで、ISO 8601 では
 * ないうえタイムゾーンも書かれていない。属性としては無効なので、
 * ここで正規化する。解釈できない値のときは属性を出さない（`undefined`）。
 * 誤った日時を機械可読な形で主張するより、無い方がよい。
 */
export function toIsoDateTime(value: string): string | undefined {
	return parseApiDate(value)?.toISOString();
}

/**
 * ツールチップ（`title` 属性）に入れる、正確な日時の文字列。
 *
 * 表示を相対表記にすると、「9 日前」が何月何日なのかを確かめる手段が
 * 画面から無くなる。`datetime` 属性には ISO 8601 が入っているが、
 * あれは機械可読な値で、マウスを乗せても読めない。
 *
 * 相対表記を採っている実装は、境界の日数こそ揃っていないものの、
 * 「`<time datetime>` に加えて `title` で絶対値も読めるようにする」点は
 * ほぼ共通している。ここもそれに倣う。
 *
 * 年を必ず入れるのは、本文（`formatCreatedAt`）が今年の日付から年を
 * 省くため。省いた情報を確かめる先がここなので、ここでは省かない。
 * 解釈できない値のときは属性を出さない（`undefined`）。
 */
export function toDateTimeTooltip(
	value: string,
	locale: Locale = DEFAULT_LOCALE,
): string | undefined {
	const date = parseApiDate(value);
	if (!date) {
		return undefined;
	}

	const { year, month, day, hour, minute } = jstParts(date);
	// 時刻は 2 桁に揃える。「9:5」では読めない
	const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

	// 日本語と英語で日付の並びが違うので、組み立てを分ける。
	// どちらも JST 基準なので、その旨を添えて誤読を防ぐ
	return locale === "ja"
		? `${year}年${month}月${day}日 ${time}（JST）`
		: `${EN_MONTHS[month - 1]} ${day}, ${year} ${time} (JST)`;
}

/**
 * JST での暦日（1970-01-01 からの日数）。
 *
 * 「昨日」かどうかは経過時間ではなく暦日の差で決まる。23 時の投稿を
 * 翌 1 時に見たときの経過は 2 時間だが、日付は変わっているので「昨日」。
 * UTC の値に JST のオフセットを足してから日数に落とすことで、
 * 実行環境のタイムゾーンに依存せず JST の暦日を得る。
 */
function jstDayNumber(date: Date): number {
	return Math.floor((date.getTime() + JST_OFFSET_MS) / DAY_MS);
}

/**
 * JST に直した日付の各部分。日付の表示とツールチップに使う。
 *
 * オフセットを足したうえで `getUTC*` で読むのは、実行環境のタイムゾーンに
 * 依存させないため。`getMonth()` 等を使うと、サーバーとブラウザで
 * タイムゾーンが違ったときに別の日付になる。
 */
function jstParts(date: Date): {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
} {
	const shifted = new Date(date.getTime() + JST_OFFSET_MS);
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
		hour: shifted.getUTCHours(),
		minute: shifted.getUTCMinutes(),
	};
}

/**
 * 表示用の文字列を組み立てる。
 *
 * `now` を引数にしているのは、テストで時刻を固定できるようにするため。
 * 既定は呼び出し時刻。Server Component から呼ばれるので、基準は
 * サーバーの時計になる（クライアントとずれてもハイドレーションで
 * 文言が食い違わない。これは UTC 表記のときと同じ考え方）。
 */
export function formatCreatedAt(
	createdAt: string,
	locale: Locale = DEFAULT_LOCALE,
	now: Date = new Date(),
): string {
	const date = parseApiDate(createdAt);
	if (!date) {
		// 想定外の書式でも「Invalid Date」を出さず、受け取った値をそのまま返す
		return createdAt;
	}

	const elapsed = now.getTime() - date.getTime();

	// 未来の日時は相対表記にしない。「-3 分前」のような表記になるうえ、
	// 起票日時が未来になるのは時計のずれなので、日付で出す方が誤解が少ない
	if (elapsed < 0) {
		return absoluteDate(date, now, locale);
	}

	if (elapsed < MINUTE_MS) {
		return locale === "ja" ? "たった今" : "just now";
	}

	if (elapsed < HOUR_MS) {
		const minutes = Math.floor(elapsed / MINUTE_MS);
		return locale === "ja"
			? `${minutes}分前`
			: `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	}

	const dayDiff = jstDayNumber(now) - jstDayNumber(date);

	// 同じ暦日のうちは時間で出す。「今日」だけだと、朝の投稿と
	// 数分前の投稿が同じ文言になって並び順の理由が読めなくなる
	if (dayDiff === 0) {
		const hours = Math.floor(elapsed / HOUR_MS);
		return locale === "ja"
			? `${hours}時間前`
			: `${hours} hour${hours === 1 ? "" : "s"} ago`;
	}

	if (dayDiff === 1) {
		return locale === "ja" ? "昨日" : "yesterday";
	}

	if (dayDiff <= RELATIVE_LIMIT_DAYS) {
		return locale === "ja" ? `${dayDiff}日前` : `${dayDiff} days ago`;
	}

	return absoluteDate(date, now, locale);
}

/**
 * 日付そのものの表記。
 *
 * 同じ年の間は年を出さない（「8月2日」）。年をまたいだものだけ年を付ける
 * （「2025年8月2日」）。今年の日付に毎回 4 桁の年が付くと、
 * 一覧を眺めたときに年だけが並んで日付が読み取りにくくなる。
 */
function absoluteDate(date: Date, now: Date, locale: Locale): string {
	const { year, month, day } = jstParts(date);
	const currentYear = jstParts(now).year;

	if (locale === "ja") {
		return year === currentYear
			? `${month}月${day}日`
			: `${year}年${month}月${day}日`;
	}

	const monthName = EN_MONTHS[month - 1];
	return year === currentYear
		? `${monthName} ${day}`
		: `${monthName} ${day}, ${year}`;
}

/**
 * 英語の月名。`Intl.DateTimeFormat` を使わないのは、タイムゾーンと
 * ロケールデータの両方が実行環境に依存するため。Workers とテスト環境で
 * 同じ文字列になることを優先して、対応表を持つ。
 */
const EN_MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

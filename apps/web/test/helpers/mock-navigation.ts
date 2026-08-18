import { mock } from "bun:test";
import * as actual from "next/navigation";

/**
 * `next/navigation` の `usePathname` / `useSearchParams` をテスト用に差し替える。
 *
 * `LocaleSwitcher`（Issue #82）は戻り先のパスを知るためにこの 2 つを呼ぶ。
 * `renderToStaticMarkup` で直接描画するこのリポジトリのテスト手法では
 * Next.js のルーターコンテキストが無く、`useSearchParams()` が null を返して
 * 描画そのものが落ちる。
 *
 * **実物を丸ごと取り込んでから、必要な 2 つだけを上書きしている。**
 * `mock.module` はモジュール全体を差し替えるため、ここに書かなかった export は
 * 「存在しない」ことになる。`next/navigation` は `notFound`（詳細ページ）や
 * `redirect`（Clerk）も出しており、それらが消えると
 * `Export named 'notFound' not found in module` で落ちる。
 * `next/headers` のモックで実際に CI が落ちた形（`mock-cookies.ts` のコメント参照）を
 * 繰り返さないための書き方。
 *
 * `mock.module` はモジュール解決より前に評価される必要があるため、
 * テスト対象の import より先にこのモジュールを import すること。
 */

/** 現在のテストが「どのパスで描画されているか」。各テストから差し替える。 */
let pathname = "/";
let searchParams = new URLSearchParams();

/**
 * `router.replace` に渡された URL の記録（Issue #118）。
 *
 * `IssuesMap` は MapLibre で地図を動かし終えたときに URL を書き換えて
 * 「いま見ている場所」を共有できる状態を保つ。その書き換えが本当に
 * 起きるかを見るために、呼ばれた URL を残す。
 */
let navigations: string[] = [];

/** テストの中で現在地を差し替える。指定しなければルート・クエリ無し。 */
export function setTestLocation(path: string, query = ""): void {
	pathname = path;
	searchParams = new URLSearchParams(query);
}

/** 前のテストの現在地を持ち越さないためのリセット。 */
export function clearTestLocation(): void {
	pathname = "/";
	searchParams = new URLSearchParams();
	navigations = [];
}

/** `router.replace` / `router.push` に渡された URL を、呼ばれた順に返す。 */
export function recordedNavigations(): readonly string[] {
	return navigations;
}

mock.module("next/navigation", () => ({
	...actual,
	usePathname: () => pathname,
	useSearchParams: () => searchParams,
	// `useRouter` の実物はルーターコンテキストが無いと例外を投げる
	// （`invariant expected app router to be mounted`）。`IssuesMap` が
	// 地図の移動を URL へ反映するのに使うので、記録だけする代役を置く
	useRouter: () => ({
		replace: (url: string) => {
			navigations.push(url);
		},
		push: (url: string) => {
			navigations.push(url);
		},
		back: () => {},
		forward: () => {},
		refresh: () => {},
		prefetch: () => {},
	}),
}));
